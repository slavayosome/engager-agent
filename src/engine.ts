import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  RUNNER_MAX_DRAFT_ITEMS,
  RUNNER_MAX_REPLY_ITEMS,
  RUNNER_MAX_TRIAGE_ITEMS,
  type RunnerLane,
} from "@engager/runner-contract";
import {
  engineConfigDirFromEnvironment,
  engineConfigEnvironmentName,
  isSafeEngineConfigDir,
} from "./config.js";
import { RUNNER_ERROR_CODES, RunnerFault, type RunnerErrorCode } from "./errors.js";
import type { AgentProposal } from "./protocol.js";

export type EngineName = "claude" | "codex";

export type EngineDetection = {
  name: EngineName;
  installed: boolean;
  /** False when the executable exists but its version/capability boundary is not certified. */
  supported: boolean;
  authenticated: boolean | null;
  version?: string;
  detail?: string;
  executablePath?: string;
};

export type EngineUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type EngineRunRequest = {
  prompt: string;
  lane: RunnerLane;
  model?: string;
  workingDirectory: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type EngineRunResult = {
  proposal: AgentProposal;
  model?: string;
  usage?: EngineUsage;
  quotaState?: Record<string, unknown>;
  durationMs: number;
};

export interface AgentEngine {
  readonly name: EngineName;
  detect(): Promise<EngineDetection>;
  run(request: EngineRunRequest): Promise<EngineRunResult>;
}

export function resolveEngineExecutable(
  name: EngineName,
  preferred?: string,
): string | null {
  let raw = preferred ?? "";
  if (!preferred) {
    try {
      const probe = spawnSync("/usr/bin/which", [name], {
        encoding: "utf8",
        timeout: 2_000,
      });
      raw = typeof probe.stdout === "string" ? probe.stdout.trim() : "";
    } catch {
      raw = "";
    }
  }
  if (!raw || !isAbsolute(raw)) return null;
  try {
    const path = realpathSync(raw);
    accessSync(path, constants.X_OK);
    if (/(?:^|\/)(?:_npx|\.hermes|Caches?|tmp|\.cache)(?:\/|$)/i.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

export type ProcessSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /** Test/dev override. Production resolves the audited sibling bundle. */
  watchdogPath?: string;
  /** Internal watchdog hook; never serialized to the provider process. */
  onSpawn?: (pid: number) => void | Promise<void>;
  /** Internal watchdog gate: a static shell blocks on fd 3 before exec until
   * the supervisor acknowledges the process-group ID. */
  startPaused?: boolean;
};

export type ProcessResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/**
 * Run an engine as its own process group. Timeout/abort first sends SIGTERM,
 * waits for the whole group to exit, then escalates to SIGKILL. No retry can
 * begin while a resistant model process is still alive.
 */
export function runEngineProcess(spec: ProcessSpec): Promise<ProcessResult> {
  if (!platformSupportsProcessIsolation()) {
    return Promise.reject(unsupportedIsolationFault());
  }
  if (spec.signal?.aborted) return Promise.reject(abortedEngineFault());
  let watchdogPath: string;
  try {
    watchdogPath = resolveWatchdogPath(spec.watchdogPath);
  } catch (error) {
    return Promise.reject(
      new RunnerFault("ENGINE_SANDBOX_DENIED", "audited engine watchdog is missing", {
        impact: "The provider process was not started because parent-death cleanup could not be guaranteed.",
        recovery: "Reinstall or rebuild engager-agent, then run `engager-agent doctor`.",
        cause: error,
      }),
    );
  }
  const {
    signal,
    watchdogPath: _watchdogPath,
    onSpawn: _onSpawn,
    startPaused: _startPaused,
    ...wireSpec
  } = spec;
  return new Promise((resolve, reject) => {
    let watchdog: ChildProcess;
    try {
      watchdog = fork(watchdogPath, [], {
        env: sanitizedEngineEnv(process.env),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      reject(watchdogFault("engine watchdog could not start", error));
      return;
    }
    let settled = false;
    let watchdogReady = false;
    let providerStarted = false;
    let providerAcknowledged = false;
    let providerPid: number | null = null;
    let containmentPending = false;
    let startupFault: RunnerFault | null = null;
    const startupTimer = setTimeout(() => {
      if (providerAcknowledged || settled) return;
      startupFault = watchdogFault(
        watchdogReady
          ? "engine provider did not complete the containment handshake"
          : "engine watchdog did not become ready",
      );
      if (watchdog.connected) watchdog.send({ type: "abort" });
      else failAfterContainment(startupFault);
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = (): void => {
      if (watchdog.connected) watchdog.send({ type: "abort" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    watchdog.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.type !== "string") return;
      if (message.type === "ready") {
        if (watchdogReady || settled) return;
        watchdogReady = true;
        watchdog.send({ type: "start", spec: { ...wireSpec, startPaused: true } });
        if (signal?.aborted) onAbort();
        return;
      }
      if (message.type === "started" && typeof message.pid === "number") {
        if (providerStarted || settled) return;
        providerStarted = true;
        providerPid = message.pid;
        void Promise.resolve(spec.onSpawn?.(message.pid))
          .then(() => {
            if (settled || startupFault) return;
            providerAcknowledged = true;
            clearTimeout(startupTimer);
            if (watchdog.connected) watchdog.send({ type: "spawn_ack", pid: message.pid });
          })
          .catch((error) => {
            startupFault = watchdogFault("engine provider containment acknowledgement failed", error);
            if (watchdog.connected) watchdog.send({ type: "abort" });
            else failAfterContainment(startupFault);
          });
        return;
      }
      const result = message.result;
      if (message.type === "result" && isProcessResult(result)) {
        settle(() => (startupFault ? reject(startupFault) : resolve(result)));
        return;
      }
      if (message.type === "fault") {
        settle(() => reject(startupFault ?? deserializeFault(message.fault)));
      }
    });
    watchdog.once("error", (error) => {
      failAfterContainment(watchdogFault("engine watchdog failed", error));
    });
    watchdog.once("exit", (code, exitSignal) => {
      failAfterContainment(
        startupFault ??
          watchdogFault(
            `engine watchdog exited before a verified result (${code ?? "signal"}/${exitSignal ?? "none"})`,
          ),
      );
    });

    function failAfterContainment(fault: RunnerFault): void {
      if (settled || containmentPending) return;
      containmentPending = true;
      cleanup();
      void terminateKnownProcessGroup(providerPid, spec.terminationGraceMs ?? 5_000).then(() => {
        settle(() => reject(fault));
      });
    }
  });
}

/** Runs only inside the audited watchdog child. Keeping the process-group
 * implementation here gives timeout, output, and parent-death cleanup one
 * identical path. */
export function runEngineProcessDirect(spec: ProcessSpec): Promise<ProcessResult> {
  if (!platformSupportsProcessIsolation()) {
    return Promise.reject(unsupportedIsolationFault());
  }
  if (spec.signal?.aborted) return Promise.reject(abortedEngineFault());
  if (spec.startPaused && !isExecutableCommand(spec.command, spec.cwd, spec.env)) {
    const missing = Object.assign(new Error(`${spec.command} was not found`), { code: "ENOENT" });
    return Promise.reject(spawnFault(spec.command, missing));
  }
  const outputLimit = spec.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      const command = spec.startPaused ? "/bin/sh" : spec.command;
      const args = spec.startPaused
        ? [
            "-c",
            'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$@"',
            "engager-engine",
            spec.command,
            ...spec.args,
          ]
        : spec.args;
      child = spawn(command, args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== "win32",
        stdio: spec.startPaused
          ? ["pipe", "pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(spawnFault(spec.command, error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersFlushed = false;
    let termination: "timeout" | "aborted" | "output" | "cleanup" | null = null;
    let forceTimer: NodeJS.Timeout | undefined;
    let groupPoll: NodeJS.Timeout | undefined;
    let childClosed = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let settled = false;
    const startGate = spec.startPaused
      ? (child.stdio[3] as NodeJS.WritableStream | null)
      : null;
    let startGateClosed = false;

    startGate?.on("error", () => {
      /* provider exit/termination carries the authoritative result */
    });

    const closeStartGate = (open: boolean): void => {
      if (!startGate || startGateClosed) return;
      startGateClosed = true;
      if (open) startGate.end("go\n");
      else startGate.end();
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* process already exited */
        }
      }
    };

    const terminate = (reason: typeof termination): void => {
      if (termination || !reason) return;
      termination = reason;
      closeStartGate(false);
      killGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        forceTimer = undefined;
        killGroup("SIGKILL");
        waitForTerminatedGroup();
      }, spec.terminationGraceMs ?? 5_000);
    };

    const groupAlive = (): boolean => {
      if (child.pid == null) return false;
      try {
        if (process.platform === "win32") return !childClosed;
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const finishTermination = (): void => {
      if (settled || !termination) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (groupPoll) clearTimeout(groupPoll);
      spec.signal?.removeEventListener("abort", onAbort);
      if (termination === "cleanup") {
        resolve({ code: closeCode ?? 1, signal: closeSignal, stdout, stderr });
      } else if (termination === "timeout") {
        reject(
          new RunnerFault("ENGINE_TIMEOUT", `engine exceeded ${Math.ceil(spec.timeoutMs / 60_000)} minutes`, {
            impact: "The lease was not trusted after the model session timed out; no unverified result was submitted.",
            recovery: "Retry after reducing provider load, or select another supported engine.",
            retryable: true,
          }),
        );
      } else if (termination === "aborted") {
        reject(abortedEngineFault());
      } else {
        reject(
          new RunnerFault("ENGINE_OUTPUT_INVALID", `engine output exceeded ${outputLimit} bytes`, {
            impact: "The oversized response was discarded before parsing or submission.",
            recovery: "Retry once; if this repeats, change engine/model and run `engager-agent doctor`.",
          }),
        );
      }
    };

    const waitForTerminatedGroup = (): void => {
      if (!childClosed || settled || !termination) return;
      if (!groupAlive()) {
        finishTermination();
        return;
      }
      if (!groupPoll) {
        groupPoll = setTimeout(() => {
          groupPoll = undefined;
          waitForTerminatedGroup();
        }, 20);
      }
    };

    const timer = setTimeout(() => terminate("timeout"), spec.timeoutMs);
    timer.unref();
    const onAbort = (): void => terminate("aborted");
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) onAbort();

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > outputLimit) {
        terminate("output");
        return;
      }
      if (target === "stdout") stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    };
    const flushDecoders = (): void => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      flushDecoders();
      closeStartGate(false);
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (groupPoll) clearTimeout(groupPoll);
      spec.signal?.removeEventListener("abort", onAbort);
      reject(spawnFault(spec.command, error));
    });
    child.once("close", (code, signal) => {
      closeStartGate(false);
      flushDecoders();
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      clearTimeout(timer);
      if (termination) {
        if (!groupAlive()) finishTermination();
        else waitForTerminatedGroup();
        return;
      }
      if (groupAlive()) {
        // A provider CLI may exit after spawning a detached/background helper.
        // Drain the entire inherited process group before accepting even a
        // successful leader exit or allowing the next cycle to start.
        terminate("cleanup");
        waitForTerminatedGroup();
        return;
      }
      if (settled) return;
      settled = true;
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({ code: closeCode ?? 1, signal: closeSignal, stdout, stderr });
    });

    child.stdin?.on("error", () => {
      /* close/error will carry the actual process result */
    });
    void Promise.resolve(child.pid == null ? undefined : spec.onSpawn?.(child.pid))
      .then(() => {
        if (termination || settled) return;
        closeStartGate(true);
        child.stdin?.end(spec.stdin);
      })
      .catch(() => terminate("aborted"));
  });
}

function isExecutableCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes("/")
      ? [join(cwd, command)]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function terminateKnownProcessGroup(pid: number | null, graceMs: number): Promise<void> {
  if (!pid || process.platform === "win32") return;
  const alive = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  };
  send("SIGTERM");
  const gracefulDeadline = Date.now() + Math.max(0, graceMs);
  while (alive() && Date.now() < gracefulDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (alive()) send("SIGKILL");
  while (alive()) await new Promise((resolve) => setTimeout(resolve, 20));
}

function resolveWatchdogPath(override?: string): string {
  const candidates = [
    override,
    process.argv[1] ? join(dirname(realpathSync(process.argv[1])), "engine-watchdog.mjs") : undefined,
    fileURLToPath(new URL("../bundle/engine-watchdog.mjs", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    accessSync(path, constants.R_OK);
    return path;
  }
  throw new Error("engine-watchdog.mjs was not found beside the runner bundle");
}

function unsupportedIsolationFault(): RunnerFault {
  return new RunnerFault("ENGINE_SANDBOX_DENIED", "safe descendant-process termination is not certified on Windows", {
    impact: "The provider process was not started.",
    recovery: "Run engager-agent on macOS or Linux for this release.",
  });
}

function watchdogFault(message: string, cause?: unknown): RunnerFault {
  return new RunnerFault("ENGINE_SANDBOX_DENIED", message, {
    impact: "The runner could not prove provider-process containment, so no result was trusted.",
    recovery: "Reinstall or rebuild engager-agent, then run `engager-agent doctor`.",
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isProcessResult(value: unknown): value is ProcessResult {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    (value.signal === null || typeof value.signal === "string") &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}

function deserializeFault(value: unknown): RunnerFault {
  if (!isRecord(value)) return watchdogFault("engine watchdog returned an invalid failure");
  const code =
    typeof value.code === "string" && RUNNER_ERROR_CODES.includes(value.code as RunnerErrorCode)
      ? (value.code as RunnerErrorCode)
      : "ENGINE_FAILED";
  return new RunnerFault(
    code,
    typeof value.message === "string" ? value.message : "engine watchdog reported a failure",
    {
      impact: typeof value.impact === "string" ? value.impact : "No unverified provider result was submitted.",
      recovery: typeof value.recovery === "string" ? value.recovery : "Run `engager-agent doctor`.",
      retryable: value.retryable === true,
      ...(typeof value.reference === "string" ? { reference: value.reference } : {}),
      ...(typeof value.remoteCode === "string" ? { remoteCode: value.remoteCode } : {}),
      discardJournal: value.discardJournal === true,
      engineAttempted: value.engineAttempted === true,
    },
  );
}

export function platformSupportsProcessIsolation(platform = process.platform): boolean {
  return platform !== "win32";
}

export function isEngineReady(detection: EngineDetection): boolean {
  return detection.installed && detection.supported && detection.authenticated === true;
}

function abortedEngineFault(): RunnerFault {
  return new RunnerFault("LEASE_LOST", "engine stopped because its server lease could not be maintained", {
    impact: "The current proposal was discarded and no late write was attempted.",
    recovery: "Wait for the server to requeue eligible work, then run again.",
    retryable: true,
  });
}

function spawnFault(command: string, error: unknown): RunnerFault {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new RunnerFault("ENGINE_NOT_FOUND", `${command} is not installed or not on PATH`, {
      impact: "This machine cannot execute claimed cognition work.",
      recovery: `Install ${command}, authenticate it, then run \`engager-agent doctor\`.`,
      cause: error,
    });
  }
  return new RunnerFault("ENGINE_FAILED", `${command} could not start`, {
    impact: "The current work order was not executed.",
    recovery: "Run `engager-agent doctor` and fix the local engine installation.",
    cause: error,
  });
}

export function sanitizedEngineEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safe = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of safe) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Restore only the selected provider's config directory. The general allowlist
 * deliberately excludes both provider variables so the other provider's local
 * state is never exposed to this cognition process. */
export function engineProcessEnv(
  engine: EngineName,
  configuredConfigDir: string | undefined,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = sanitizedEngineEnv(source);
  const configDir =
    configuredConfigDir ?? engineConfigDirFromEnvironment(engine, source);
  if (configDir !== undefined) {
    if (!isSafeEngineConfigDir(configDir)) {
      throw new RunnerFault(
        "ENGINE_SANDBOX_DENIED",
        `${engineConfigEnvironmentName(engine)} is not a safe absolute path`,
        {
          impact:
            "The provider process was not started with ambiguous authentication state.",
          recovery:
            "Rerun setup with a valid absolute provider config directory.",
        },
      );
    }
    env[engineConfigEnvironmentName(engine)] = configDir;
  }
  return env;
}

/** JSON Schema shared by both engines; the contract package remains the final parser. */
export function proposalJsonSchema(lane: RunnerLane): Record<string, unknown> {
  const maxItems =
    lane === "triage"
      ? RUNNER_MAX_TRIAGE_ITEMS
      : lane === "reply"
        ? RUNNER_MAX_REPLY_ITEMS
        : RUNNER_MAX_DRAFT_ITEMS;
  const string = (maxLength?: number) => ({
    type: "string",
    minLength: 1,
    ...(maxLength ? { maxLength } : {}),
  });
  const common = {
    type: "object",
    additionalProperties: false,
    required: ["lane", "items"],
    properties: {
      lane: { const: lane },
      note: string(400),
    },
  } as const;
  if (lane === "triage") {
    return {
      ...common,
      properties: {
        ...common.properties,
        items: {
          type: "array",
          minItems: 1,
          maxItems,
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["candidateId", "verdict", "score"],
                properties: {
                  candidateId: { type: "integer", minimum: 1 },
                  verdict: { const: "match" },
                  score: { type: "number", minimum: 0, maximum: 1 },
                  reason: string(200),
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["candidateId", "verdict", "reason"],
                properties: {
                  candidateId: { type: "integer", minimum: 1 },
                  verdict: { const: "reject" },
                  score: { type: "number", minimum: 0, maximum: 1 },
                  reason: string(200),
                },
              },
            ],
          },
        },
      },
    };
  }
  if (lane === "reply") {
    return {
      ...common,
      properties: {
        ...common.properties,
        items: {
          type: "array",
          minItems: 1,
          maxItems,
          items: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["incomingCommentId", "decision", "text"],
                properties: {
                  incomingCommentId: { type: "integer", minimum: 1 },
                  decision: { const: "reply" },
                  text: string(1_250),
                  sensitivityHold: { type: "boolean" },
                  rationale: { type: "string", maxLength: 400 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["incomingCommentId", "decision", "reason"],
                properties: {
                  incomingCommentId: { type: "integer", minimum: 1 },
                  decision: { const: "dismiss" },
                  reason: string(200),
                },
              },
            ],
          },
        },
      },
    };
  }
  return {
    ...common,
    properties: {
      ...common.properties,
      items: {
        type: "array",
        minItems: 1,
        maxItems,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["candidateId", "text"],
          properties: {
            candidateId: { type: "integer", minimum: 1 },
            text: string(1_250),
            commentType: { enum: ["promo", "neutral"] },
            lengthTier: { enum: ["ultra_short", "short", "medium", "long"] },
            lengthWhy: { type: "string", maxLength: 300 },
            slopSelfScore: { type: "number", minimum: 0, maximum: 1 },
            slopStrictness: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 400 },
            webSearched: { const: false },
            sources: { type: "array", maxItems: 0 },
          },
        },
      },
    },
  };
}

/** OpenAI Structured Outputs requires every declared object property to be
 * required. Preserve optional contract fields by making those properties
 * nullable, then remove null-valued object fields before the final parser. */
export function codexProposalJsonSchema(lane: RunnerLane): Record<string, unknown> {
  return strictStructuredOutputSchema(proposalJsonSchema(lane)) as Record<string, unknown>;
}

export function normalizeCodexProposal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCodexProposal);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, normalizeCodexProposal(item)]),
  );
}

function strictStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictStructuredOutputSchema);
  if (!isRecord(value)) return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, strictStructuredOutputSchema(item)]),
  ) as Record<string, unknown>;
  if (value.type !== "object" || !isRecord(value.properties)) return result;

  const originallyRequired = new Set(
    Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([key, schema]) => {
      const strict = strictStructuredOutputSchema(schema);
      return [
        key,
        originallyRequired.has(key)
          ? strict
          : { anyOf: [strict, { type: "null" }] },
      ];
    }),
  );
  result.properties = properties;
  result.required = Object.keys(properties);
  result.additionalProperties = false;
  return result;
}
