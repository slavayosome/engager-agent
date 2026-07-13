// src/errors.ts
import { randomUUID } from "node:crypto";
var RunnerFault = class extends Error {
  code;
  impact;
  recovery;
  retryable;
  reference;
  remoteCode;
  discardJournal;
  engineAttempted;
  constructor(code, message, options) {
    super(message, { cause: options.cause });
    this.name = "RunnerFault";
    this.code = code;
    this.impact = options.impact;
    this.recovery = options.recovery;
    this.retryable = options.retryable ?? false;
    this.reference = options.reference ?? randomUUID();
    this.remoteCode = options.remoteCode;
    this.discardJournal = options.discardJournal ?? false;
    this.engineAttempted = options.engineAttempted ?? false;
  }
};
function asRunnerFault(error) {
  if (error instanceof RunnerFault) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RunnerFault("INTERNAL_ERROR", message || "runner operation failed", {
    impact: "The current runner action stopped before it could be verified.",
    recovery: "Run `engager-agent doctor`; retry only after the reported problem is resolved.",
    cause: error
  });
}

// src/engine.ts
import { fork, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
function runEngineProcessDirect(spec) {
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
    let child;
    try {
      const command = spec.startPaused ? "/bin/sh" : spec.command;
      const args = spec.startPaused ? [
        "-c",
        'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$@"',
        "engager-engine",
        spec.command,
        ...spec.args
      ] : spec.args;
      child = spawn(command, args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== "win32",
        stdio: spec.startPaused ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
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
    let termination = null;
    let forceTimer;
    let groupPoll;
    let childClosed = false;
    let closeCode = null;
    let closeSignal = null;
    let settled = false;
    const startGate = spec.startPaused ? child.stdio[3] : null;
    let startGateClosed = false;
    startGate?.on("error", () => {
    });
    const closeStartGate = (open) => {
      if (!startGate || startGateClosed) return;
      startGateClosed = true;
      if (open) startGate.end("go\n");
      else startGate.end();
    };
    const killGroup = (signal) => {
      if (child.pid == null) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
        }
      }
    };
    const terminate = (reason) => {
      if (termination || !reason) return;
      termination = reason;
      closeStartGate(false);
      killGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        forceTimer = void 0;
        killGroup("SIGKILL");
        waitForTerminatedGroup();
      }, spec.terminationGraceMs ?? 5e3);
    };
    const groupAlive = () => {
      if (child.pid == null) return false;
      try {
        if (process.platform === "win32") return !childClosed;
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const finishTermination = () => {
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
          new RunnerFault("ENGINE_TIMEOUT", `engine exceeded ${Math.ceil(spec.timeoutMs / 6e4)} minutes`, {
            impact: "The lease was not trusted after the model session timed out; no unverified result was submitted.",
            recovery: "Retry after reducing provider load, or select another supported engine.",
            retryable: true
          })
        );
      } else if (termination === "aborted") {
        reject(abortedEngineFault());
      } else {
        reject(
          new RunnerFault("ENGINE_OUTPUT_INVALID", `engine output exceeded ${outputLimit} bytes`, {
            impact: "The oversized response was discarded before parsing or submission.",
            recovery: "Retry once; if this repeats, change engine/model and run `engager-agent doctor`."
          })
        );
      }
    };
    const waitForTerminatedGroup = () => {
      if (!childClosed || settled || !termination) return;
      if (!groupAlive()) {
        finishTermination();
        return;
      }
      if (!groupPoll) {
        groupPoll = setTimeout(() => {
          groupPoll = void 0;
          waitForTerminatedGroup();
        }, 20);
      }
    };
    const timer = setTimeout(() => terminate("timeout"), spec.timeoutMs);
    timer.unref();
    const onAbort = () => terminate("aborted");
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) onAbort();
    const append = (target, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > outputLimit) {
        terminate("output");
        return;
      }
      if (target === "stdout") stdout += stdoutDecoder.write(chunk);
      else stderr += stderrDecoder.write(chunk);
    };
    const flushDecoders = () => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
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
    });
    void Promise.resolve(child.pid == null ? void 0 : spec.onSpawn?.(child.pid)).then(() => {
      if (termination || settled) return;
      closeStartGate(true);
      child.stdin?.end(spec.stdin);
    }).catch(() => terminate("aborted"));
  });
}
function isExecutableCommand(command, cwd, env) {
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [join(cwd, command)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
function unsupportedIsolationFault() {
  return new RunnerFault("ENGINE_SANDBOX_DENIED", "safe descendant-process termination is not certified on Windows", {
    impact: "The provider process was not started.",
    recovery: "Run engager-agent on macOS or Linux for this release."
  });
}
function platformSupportsProcessIsolation(platform = process.platform) {
  return platform !== "win32";
}
function abortedEngineFault() {
  return new RunnerFault("LEASE_LOST", "engine stopped because its server lease could not be maintained", {
    impact: "The current proposal was discarded and no late write was attempted.",
    recovery: "Wait for the server to requeue eligible work, then run again.",
    retryable: true
  });
}
function spawnFault(command, error) {
  const code = error?.code;
  if (code === "ENOENT") {
    return new RunnerFault("ENGINE_NOT_FOUND", `${command} is not installed or not on PATH`, {
      impact: "This machine cannot execute claimed cognition work.",
      recovery: `Install ${command}, authenticate it, then run \`engager-agent doctor\`.`,
      cause: error
    });
  }
  return new RunnerFault("ENGINE_FAILED", `${command} could not start`, {
    impact: "The current work order was not executed.",
    recovery: "Run `engager-agent doctor` and fix the local engine installation.",
    cause: error
  });
}

// src/engine-watchdog.ts
var controller = new AbortController();
var started = false;
var finished = false;
var spawnAck = null;
process.on("disconnect", () => {
  controller.abort();
  if (!started) process.exit(0);
});
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
process.on("message", (message) => {
  if (typeof message === "object" && message != null && !Array.isArray(message) && message.type === "abort") {
    controller.abort();
    if (!started) process.exit(0);
    return;
  }
  if (typeof message === "object" && message != null && !Array.isArray(message) && message.type === "spawn_ack" && typeof message.pid === "number") {
    const pid = Number(message.pid);
    if (spawnAck?.pid === pid) {
      const ack = spawnAck;
      spawnAck = null;
      ack.resolve();
    }
    return;
  }
  if (!isStartMessage(message) || started) return;
  started = true;
  void run(message.spec);
});
if (!process.send || !process.connected) {
  process.exitCode = 2;
} else {
  send({ type: "ready" });
}
async function run(spec) {
  try {
    const result = await runEngineProcessDirect({
      ...spec,
      signal: controller.signal,
      onSpawn: (pid) => new Promise((resolve, reject) => {
        spawnAck = { pid, resolve, reject };
        send({ type: "started", pid });
        if (controller.signal.aborted) reject();
        else controller.signal.addEventListener("abort", reject, { once: true });
      })
    });
    finish({ type: "result", result });
  } catch (error) {
    const fault = asRunnerFault(error);
    finish({
      type: "fault",
      fault: {
        code: fault.code,
        message: fault.message,
        impact: fault.impact,
        recovery: fault.recovery,
        retryable: fault.retryable,
        reference: fault.reference,
        remoteCode: fault.remoteCode,
        discardJournal: fault.discardJournal,
        engineAttempted: fault.engineAttempted
      }
    });
  }
}
function finish(message) {
  if (finished) return;
  finished = true;
  if (!process.connected) {
    process.exit(0);
    return;
  }
  process.send?.(message, () => {
    process.disconnect?.();
    process.exit(0);
  });
}
function send(message) {
  if (process.connected) process.send?.(message);
}
function isStartMessage(value) {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const message = value;
  const spec = message.spec;
  if (message.type !== "start" || typeof spec !== "object" || spec == null || Array.isArray(spec)) return false;
  const candidate = spec;
  return typeof candidate.command === "string" && Array.isArray(candidate.args) && candidate.args.every((arg) => typeof arg === "string") && typeof candidate.cwd === "string" && typeof candidate.env === "object" && candidate.env != null && typeof candidate.stdin === "string" && typeof candidate.timeoutMs === "number";
}
