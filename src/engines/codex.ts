import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexProposalJsonSchema,
  engineProcessEnv,
  normalizeCodexProposal,
  resolveEngineExecutable,
  runEngineProcess,
  type AgentEngine,
  type EngineDetection,
  type EngineRunRequest,
  type EngineRunResult,
  type ProcessResult,
} from "../engine.js";
import { RunnerFault } from "../errors.js";
import { parseAgentProposal } from "../protocol.js";

export const CODEX_CERTIFIED_VERSION = /^0\.135\./;
export const MAX_CODEX_RESULT_BYTES = 256 * 1024;

/** Every optional current Codex capability is disabled; shell/unified_exec are
 * the load-bearing pair. Unknown/removed flags fail the process closed. */
export const CODEX_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "enable_request_compression",
  "fast_mode",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "personality",
  "plugins",
  "plugin_sharing",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "terminal_resize_reflow",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
] as const;

export function codexArgs(request: EngineRunRequest, schemaPath: string, resultPath: string): string[] {
  const args = [
    "exec",
    "-",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--strict-config",
    "-C",
    request.workingDirectory,
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "--output-schema",
    schemaPath,
    "-o",
    resultPath,
    "--json",
    "--color",
    "never",
  ];
  for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  if (request.model) args.push("-m", request.model);
  return args;
}

export function codexFeatureProbeArgs(): string[] {
  // `--ignore-user-config` is exec-only in Codex 0.135. The capability probe
  // instead runs under a fresh CODEX_HOME, which has no user configuration.
  const args: string[] = [];
  for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  args.push("features", "list");
  return args;
}

export function activeCodexFeatures(output: string): string[] | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const rows = lines
    .map((line) => /^(\S+)\s+(.+?)\s+(true|false)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match != null);
  if (rows.length === 0 || rows.length !== lines.length) return null;
  return rows
    .filter((match) => match[3] === "true" && match[2] !== "removed")
    .map((match) => match[1]!);
}

export class CodexEngine implements AgentEngine {
  readonly name = "codex" as const;
  private cachedDetection: { at: number; value: EngineDetection } | null = null;

  constructor(
    private readonly configuredPath?: string,
    private readonly configuredConfigDir?: string,
  ) {}

  async detect(): Promise<EngineDetection> {
    if (this.cachedDetection && Date.now() - this.cachedDetection.at < 30 * 60_000) {
      return this.cachedDetection.value;
    }
    const executable = resolveEngineExecutable(this.name, this.configuredPath);
    if (!executable) {
      return this.cache({ name: this.name, installed: false, supported: false, authenticated: false });
    }
    const env = engineProcessEnv(
      this.name,
      this.configuredConfigDir,
      process.env,
    );
    const versionResult = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env,
    });
    if (versionResult.error || versionResult.status !== 0) {
      return this.cache({ name: this.name, installed: false, supported: false, authenticated: false });
    }
    const versionLine = firstLine(versionResult.stdout || versionResult.stderr);
    const version = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(versionLine ?? "")?.[1];
    if (!version || !CODEX_CERTIFIED_VERSION.test(version)) {
      return this.cache({
        name: this.name,
        installed: true,
        supported: false,
        authenticated: null,
        version,
        detail: `unsupported Codex CLI ${version ?? "version"}; this closed-beta runner certifies 0.135.x`,
      });
    }
    const probeHome = mkdtempSync(join(tmpdir(), "engager-codex-probe-"));
    let featureDetail: string | undefined;
    try {
      const features = spawnSync(executable, codexFeatureProbeArgs(), {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...env, CODEX_HOME: probeHome },
      });
      const active = features.status === 0 ? activeCodexFeatures(features.stdout) : null;
      if (active == null) featureDetail = "Codex capability probe failed closed; this CLI output is not certified";
      else if (active.length > 0) featureDetail = `Codex has uncertified active capabilities: ${active.join(", ")}`;
    } finally {
      rmSync(probeHome, { recursive: true, force: true });
    }
    if (featureDetail) {
      return this.cache({
        name: this.name,
        installed: true,
        supported: false,
        authenticated: null,
        version,
        detail: featureDetail,
      });
    }
    // Override the one field older/newer user configs commonly make invalid;
    // execution itself ignores user config completely.
    const auth = spawnSync(
      executable,
      ["-c", 'model_reasoning_effort="xhigh"', "login", "status"],
      { encoding: "utf8", timeout: 10_000, env },
    );
    const authText = `${auth.stdout ?? ""}\n${auth.stderr ?? ""}`;
    const authenticated = auth.status === 0
      ? /logged in|chatgpt|api key/i.test(authText)
      : /not logged in|unauth/i.test(authText)
        ? false
        : null;
    return this.cache({
      name: this.name,
      installed: true,
      supported: true,
      authenticated,
      version,
      executablePath: executable,
      ...(auth.status !== 0 && authenticated == null
        ? { detail: "authentication status could not be verified; execution still ignores user config" }
        : {}),
    });
  }

  private cache(value: EngineDetection): EngineDetection {
    this.cachedDetection = { at: Date.now(), value };
    return value;
  }

  async run(request: EngineRunRequest): Promise<EngineRunResult> {
    const probe = await this.detect();
    if (!probe.installed) {
      throw new RunnerFault("ENGINE_NOT_FOUND", "codex is not installed or not on PATH", {
        impact: "This machine cannot execute the claimed work order.",
        recovery: "Install Codex CLI, authenticate it, then run `engager-agent doctor`.",
      });
    }
    if (!probe.supported || !probe.version || !CODEX_CERTIFIED_VERSION.test(probe.version)) {
      throw new RunnerFault("ENGINE_UNSUPPORTED_VERSION", probe.detail ?? "Codex version is not certified", {
        impact: "The runner refused to expose an unverified Codex tool boundary.",
        recovery: "Use Codex 0.135.x or upgrade engager-agent after the newer adapter is certified.",
      });
    }
    if (probe.authenticated !== true) {
      throw new RunnerFault("ENGINE_AUTH_REQUIRED", "Codex is not authenticated", {
        impact: "Claimed cognition work cannot run on this machine.",
        recovery: "Run `codex login`, then `engager-agent doctor`.",
      });
    }
    const executable = probe.executablePath;
    if (!executable) {
      throw new RunnerFault("ENGINE_NOT_FOUND", "the configured Codex executable is unavailable", {
        impact: "The claimed work order was not executed.",
        recovery: "Run `engager-agent setup` to pin a trusted Codex installation.",
      });
    }

    const schemaPath = join(request.workingDirectory, "proposal.schema.json");
    const resultPath = join(request.workingDirectory, "proposal.json");
    writeFileSync(schemaPath, JSON.stringify(codexProposalJsonSchema(request.lane)), { mode: 0o600 });
    chmodSync(schemaPath, 0o600);
    const started = Date.now();
    const result = await runEngineProcess({
      command: executable,
      args: codexArgs(request, schemaPath, resultPath),
      cwd: request.workingDirectory,
      env: {
        ...engineProcessEnv(
          this.name,
          this.configuredConfigDir,
          process.env,
        ),
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (result.code !== 0) throw classifyCodexFailure(result);

    let candidate: unknown;
    try {
      candidate = JSON.parse(readCodexResultFile(resultPath));
    } catch (error) {
      throw invalidOutput("Codex did not write a valid schema-constrained result", error);
    }
    try {
      const proposal = parseAgentProposal(normalizeCodexProposal(candidate), request.lane);
      return {
        proposal,
        ...(request.model ? { model: request.model } : {}),
        quotaState: { status: "healthy", observedAt: Date.now() },
        durationMs: Date.now() - started,
      };
    } catch (error) {
      throw invalidOutput("Codex output violated the runner proposal contract", error);
    }
  }
}

export function readCodexResultFile(
  path: string,
  maxBytes: number = MAX_CODEX_RESULT_BYTES,
): string {
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error("result is not a regular file");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("result exceeds the byte ceiling");
      const bytes = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < bytes.length) {
        const read = readSync(fd, bytes, total, bytes.length - total, null);
        if (read === 0) break;
        total += read;
      }
      if (total > maxBytes) throw new Error("result exceeded the byte ceiling while reading");
      return bytes.subarray(0, total).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw invalidOutput(`Codex result must be a regular file no larger than ${maxBytes} bytes`, error);
  }
}

function classifyCodexFailure(result: ProcessResult): RunnerFault {
  const events = parseEvents(result.stdout);
  const raw = `${JSON.stringify(events)}\n${result.stderr}`;
  if (/usage_limit_exceeded|quota|rate[_ -]?limit|credits?/i.test(raw)) {
    return new RunnerFault("ENGINE_QUOTA", "Codex provider allowance is exhausted", {
      impact: "No proposal was submitted; leased work remains server-controlled.",
      recovery: "Wait for the provider reset or add provider capacity, then run `engager-agent resume`.",
      retryable: true,
    });
  }
  if (/unauthorized|not logged in|invalid.*(?:key|token)|\b401\b/i.test(raw)) {
    return new RunnerFault("ENGINE_AUTH_REQUIRED", "Codex authentication was rejected", {
      impact: "No proposal was submitted.",
      recovery: "Run `codex login`, then `engager-agent doctor`.",
    });
  }
  if (/server_overloaded|overloaded|\b529\b/i.test(raw)) {
    return new RunnerFault("ENGINE_OVERLOADED", "Codex is temporarily overloaded", {
      impact: "The current proposal was not submitted.",
      recovery: "Retry later or select Claude as the runner engine.",
      retryable: true,
    });
  }
  if (/http_connection_failed|network|connection|dns|tls|socket/i.test(raw)) {
    return new RunnerFault("ENGINE_NETWORK", "Codex could not reach its provider", {
      impact: "The current proposal was not submitted.",
      recovery: "Restore provider connectivity, then retry.",
      retryable: true,
    });
  }
  if (/context_window_exceeded|context window|prompt.*too long/i.test(raw)) {
    return new RunnerFault("ENGINE_CONTEXT_LIMIT", "Codex rejected the bounded work context", {
      impact: "No item from this work order was submitted.",
      recovery: "Report the work-order reference; the server context bound needs adjustment.",
    });
  }
  if (/sandbox_error|sandbox.*denied|operation not permitted/i.test(raw)) {
    return new RunnerFault("ENGINE_SANDBOX_DENIED", "Codex could not establish the tool-less sandbox", {
      impact: "Execution stopped before the model could produce a proposal.",
      recovery: "Run `engager-agent doctor`; do not weaken the sandbox to work around this error.",
    });
  }
  return new RunnerFault("ENGINE_FAILED", `Codex exited with code ${result.code}`, {
    impact: "The current proposal was discarded before submission.",
    recovery: "Run `engager-agent doctor`; retry with another engine if the failure persists.",
    retryable: true,
  });
}

function parseEvents(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function invalidOutput(message: string, cause?: unknown): RunnerFault {
  return new RunnerFault("ENGINE_OUTPUT_INVALID", message, {
    impact: "Untrusted or malformed model output was discarded before any server mutation.",
    recovery: "Retry once; if it repeats, select another engine/model and report the work reference.",
    cause,
  });
}

function firstLine(value: string): string | undefined {
  return value.trim().split("\n")[0] || undefined;
}
