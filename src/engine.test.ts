import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runEngineProcess,
  codexProposalJsonSchema,
  engineProcessEnv,
  normalizeCodexProposal,
  proposalJsonSchema,
  isEngineReady,
  sanitizedEngineEnv,
  platformSupportsProcessIsolation,
  type EngineRunRequest,
} from "./engine.js";
import {
  CLAUDE_REQUIRED_FLAGS,
  claudeArgs,
  claudeCapabilityProbeArgs,
  claudeCapabilityProbePassed,
} from "./engines/claude.js";
import {
  CODEX_DISABLED_FEATURES,
  activeCodexFeatures,
  codexArgs,
  codexFeatureProbeArgs,
  readCodexResultFile,
} from "./engines/codex.js";
import { RunnerFault } from "./errors.js";
import { parseAgentProposal } from "./protocol.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function request(prompt = "TOP SECRET FROZEN CONTEXT"): EngineRunRequest {
  const workingDirectory = mkdtempSync(join(tmpdir(), "engager-engine-test-"));
  dirs.push(workingDirectory);
  return {
    prompt,
    lane: "triage",
    model: "test-model",
    workingDirectory,
    timeoutMs: 1_000,
  };
}

describe("tool-less engine argv", () => {
  it("treats uncertified capability state as execution-blocking even when auth is present", () => {
    expect(
      isEngineReady({ name: "codex", installed: true, supported: false, authenticated: true }),
    ).toBe(false);
  });

  it("locks Claude to safe mode, empty MCP, zero tools, stdin, and no persistence", () => {
    const run = request();
    const args = claudeArgs(run);
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args.join(" ")).not.toContain(run.prompt);
    expect(args.join(" ")).not.toMatch(/Bearer|runner:execute|apiKey/i);
  });

  it("probes Claude's real parser and accepts only the deliberate final sentinel", () => {
    const sentinel = "--engager-capability-probe-test";
    const args = claudeCapabilityProbeArgs(sentinel);
    for (const flag of CLAUDE_REQUIRED_FLAGS) expect(args).toContain(flag);
    expect(args.at(-2)).toBe(sentinel);
    expect(
      claudeCapabilityProbePassed(
        { status: 1, stdout: "", stderr: `error: unknown option '${sentinel}'`, error: undefined },
        sentinel,
      ),
    ).toBe(true);
    expect(
      claudeCapabilityProbePassed(
        { status: 1, stdout: "", stderr: "error: unknown option '--max-turns'", error: undefined },
        sentinel,
      ),
    ).toBe(false);
  });

  it("locks Codex to ignored user/rules, ephemeral read-only mode, and disabled capabilities", () => {
    const run = request();
    const args = codexArgs(run, "/tmp/schema.json", "/tmp/result.json");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    for (const feature of CODEX_DISABLED_FEATURES) {
      expect(args.some((value, index) => value === "--disable" && args[index + 1] === feature)).toBe(true);
    }
    expect(args.join(" ")).not.toContain(run.prompt);
    const probe = codexFeatureProbeArgs();
    expect(probe).not.toContain("--ignore-user-config");
    for (const feature of CODEX_DISABLED_FEATURES) {
      expect(probe.some((value, index) => value === "--disable" && probe[index + 1] === feature)).toBe(true);
    }
  });

  it("fails closed when Codex reports an unknown active capability or an unknown format", () => {
    expect(activeCodexFeatures("shell_tool under development false\nnew_power stable true\n")).toEqual([
      "new_power",
    ]);
    expect(activeCodexFeatures("shell_tool stable false\nmalformed row\n")).toBeNull();
    expect(activeCodexFeatures("not a recognized capability table")).toBeNull();
  });

  it("rejects fabricated web-research provenance from a tool-less engine", () => {
    const item = {
      lane: "draft",
      items: [
        {
          candidateId: 1,
          text: "A grounded comment",
          webSearched: true,
          sources: [{ url: "https://example.com", title: "Invented source" }],
        },
      ],
    };
    expect(() => parseAgentProposal(item, "draft")).toThrow(/web research|external sources/);
    expect(
      parseAgentProposal(
        {
          ...item,
          items: [{ candidateId: 1, text: "A grounded comment", webSearched: false, sources: [] }],
        },
        "draft",
      ),
    ).toMatchObject({ lane: "draft" });
  });

  it("puts lane-specific hard item bounds in the provider JSON schema", () => {
    const items = (lane: "triage" | "draft" | "reply") => {
      const schema = proposalJsonSchema(lane);
      const properties = schema.properties as Record<string, unknown>;
      return properties.items as Record<string, unknown>;
    };
    expect(items("triage").maxItems).toBe(50);
    expect(items("draft").maxItems).toBe(50);
    expect(items("reply").maxItems).toBe(100);
  });

  it("encodes triage/reply conditionals and makes every Codex object property required", () => {
    const triage = proposalJsonSchema("triage") as {
      properties: { items: { items: { anyOf: Array<{ required: string[] }> } } };
    };
    expect(triage.properties.items.items.anyOf.map((variant) => variant.required)).toEqual([
      ["candidateId", "verdict", "score"],
      ["candidateId", "verdict", "reason"],
    ]);
    const reply = proposalJsonSchema("reply") as {
      properties: { items: { items: { anyOf: Array<{ required: string[] }> } } };
    };
    expect(reply.properties.items.items.anyOf.map((variant) => variant.required)).toEqual([
      ["incomingCommentId", "decision", "text"],
      ["incomingCommentId", "decision", "reason"],
    ]);
    assertStrictStructuredObjects(codexProposalJsonSchema("draft"));
    assertStrictStructuredObjects(codexProposalJsonSchema("triage"));
    assertStrictStructuredObjects(codexProposalJsonSchema("reply"));
  });

  it("drops Codex nullable placeholders before the final lane parser", () => {
    const normalized = normalizeCodexProposal({
      lane: "reply",
      note: null,
      items: [
        {
          incomingCommentId: 7,
          decision: "reply",
          text: "A direct answer.",
          sensitivityHold: null,
          rationale: null,
        },
      ],
    });
    expect(parseAgentProposal(normalized, "reply")).toEqual({
      lane: "reply",
      items: [{ incomingCommentId: 7, decision: "reply", text: "A direct answer." }],
    });
  });

  it("bounds Codex result-file reads and rejects symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "engager-codex-result-test-"));
    dirs.push(directory);
    const oversized = join(directory, "oversized.json");
    writeFileSync(oversized, "x".repeat(257));
    expect(() => readCodexResultFile(oversized, 256)).toThrow(/no larger than 256 bytes/);
    const target = join(directory, "target.json");
    const link = join(directory, "proposal.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    expect(() => readCodexResultFile(link, 256)).toThrow(/regular file/);
  });
});

function assertStrictStructuredObjects(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertStrictStructuredObjects(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object" && record.properties && typeof record.properties === "object") {
    const keys = Object.keys(record.properties as Record<string, unknown>);
    expect(record.required).toEqual(keys);
    expect(record.additionalProperties).toBe(false);
  }
  for (const item of Object.values(record)) assertStrictStructuredObjects(item);
}

describe("process isolation", () => {
  it("fails closed on Windows until descendant-tree termination is certified", () => {
    expect(platformSupportsProcessIsolation("win32")).toBe(false);
    expect(platformSupportsProcessIsolation("darwin")).toBe(true);
    expect(platformSupportsProcessIsolation("linux")).toBe(true);
  });
  it("passes context through stdin and only the explicit environment", async () => {
    const script = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify({stdin:s,argv:process.argv.slice(1),secret:process.env.SHOULD_NOT_EXIST,ok:process.env.ALLOWED})))`;
    const result = await runEngineProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ALLOWED: "yes" },
      stdin: "frozen context",
      timeoutMs: 2_000,
    });
    expect(JSON.parse(result.stdout.trim())).toEqual({
      stdin: "frozen context",
      argv: [],
      ok: "yes",
    });
  });

  it("preserves UTF-8 code points split across separate stdout and stderr chunks", async () => {
    const expectedStdout = "Draft 🧠 café 中文";
    const expectedStderr = "Reply 👩🏽‍💻 مرحبا";
    const stdoutBytes = Buffer.from(expectedStdout);
    const stderrBytes = Buffer.from(expectedStderr);
    const stdoutSplit = stdoutBytes.indexOf(Buffer.from("🧠")) + 1;
    const stderrSplit = stderrBytes.indexOf(Buffer.from("👩")) + 2;
    const script = [
      `const out=Buffer.from(${JSON.stringify(stdoutBytes.toString("base64"))},"base64")`,
      `const err=Buffer.from(${JSON.stringify(stderrBytes.toString("base64"))},"base64")`,
      `process.stdout.write(out.subarray(0,${stdoutSplit}))`,
      `process.stderr.write(err.subarray(0,${stderrSplit}))`,
      `setTimeout(()=>{process.stdout.write(out.subarray(${stdoutSplit}));process.stderr.write(err.subarray(${stderrSplit}));},25)`,
    ].join(";");
    const result = await runEngineProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdin: "",
      timeoutMs: 2_000,
    });
    expect(result.stdout).toBe(expectedStdout);
    expect(result.stderr).toBe(expectedStderr);
  });

  it("rejects output amplification", async () => {
    await expect(
      runEngineProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(10000))'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdin: "",
        timeoutMs: 2_000,
        maxOutputBytes: 100,
        terminationGraceMs: 20,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_OUTPUT_INVALID" });
  });

  it("waits for a resistant process group to die before returning timeout", async () => {
    const started = Date.now();
    await expect(
      runEngineProcess({
        command: process.execPath,
        args: ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdin: "",
        timeoutMs: 30,
        terminationGraceMs: 30,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("does not spawn an engine for an already-aborted lease signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runEngineProcess({
        command: "definitely-must-not-be-spawned",
        args: [],
        cwd: process.cwd(),
        env: {},
        stdin: "",
        timeoutMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("kills a resistant descendant before returning from timeout", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "engager-engine-descendant-"));
    dirs.push(directory);
    const pidPath = join(directory, "descendant.pid");
    const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const leader = [
      'const {spawn}=require("node:child_process")',
      'const fs=require("node:fs")',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"})`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
      'process.on("SIGTERM",()=>process.exit(0))',
      'setInterval(()=>{},1000)',
    ].join(";");
    await expect(
      runEngineProcess({
        command: process.execPath,
        args: ["-e", leader],
        cwd: directory,
        env: { PATH: process.env.PATH },
        stdin: "",
        timeoutMs: 80,
        terminationGraceMs: 40,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" });
    expect(existsSync(pidPath)).toBe(true);
    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    // A killed orphan can remain observable briefly as a non-executing zombie
    // until the OS reaps it; use the same bounded disappearance check as the
    // normal-leader and parent-death containment regressions below.
    await waitUntil(() => !pidIsAlive(descendantPid), 1_000);
  });

  it("drains a resistant background descendant after a normal leader exit", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "engager-engine-normal-descendant-"));
    dirs.push(directory);
    const pidPath = join(directory, "descendant.pid");
    const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const leader = [
      'const {spawn}=require("node:child_process")',
      'const fs=require("node:fs")',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"})`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid))`,
      "setTimeout(()=>process.exit(0),20)",
    ].join(";");
    const result = await runEngineProcess({
      command: process.execPath,
      args: ["-e", leader],
      cwd: directory,
      env: { PATH: process.env.PATH },
      stdin: "",
      timeoutMs: 2_000,
      terminationGraceMs: 40,
    });
    expect(result.code).toBe(0);
    const descendantPid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(() => !pidIsAlive(descendantPid), 1_000);
  });

  it("kills the resistant provider group when its parent is SIGKILLed", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "engager-engine-parent-death-"));
    dirs.push(directory);
    const leaderPidPath = join(directory, "leader.pid");
    const descendantPidPath = join(directory, "descendant.pid");
    const harnessPath = join(directory, "parent-harness.mjs");
    const watchdogPath = join(process.cwd(), "bundle", "engine-watchdog.mjs");
    const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const leader = [
      'const {spawn}=require("node:child_process")',
      'const fs=require("node:fs")',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"})`,
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid))`,
      'process.on("SIGTERM",()=>{})',
      'setInterval(()=>{},1000)',
    ].join(";");
    writeFileSync(
      harnessPath,
      [
        'import { fork } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const watchdog=fork(${JSON.stringify(watchdogPath)},[],{stdio:["ignore","ignore","ignore","ipc"]});`,
        'watchdog.on("message",message=>{',
        '  if(message?.type==="ready") watchdog.send({type:"start",spec:{',
        `    command:process.execPath,args:["-e",${JSON.stringify(leader)}],cwd:${JSON.stringify(directory)},`,
        '    env:{PATH:process.env.PATH},stdin:"",timeoutMs:60000,terminationGraceMs:40',
        '  }});',
        `  if(message?.type==="started"){ writeFileSync(${JSON.stringify(leaderPidPath)},String(message.pid)); watchdog.send({type:"spawn_ack",pid:message.pid}); }`,
        '});',
        'setInterval(()=>{},1000);',
      ].join("\n"),
    );
    const harness = spawn(process.execPath, [harnessPath], { stdio: "ignore" });
    let leaderPid = 0;
    let descendantPid = 0;
    try {
      await waitUntil(() => existsSync(leaderPidPath) && existsSync(descendantPidPath), 2_000);
      leaderPid = Number(readFileSync(leaderPidPath, "utf8"));
      descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
      expect(pidIsAlive(leaderPid)).toBe(true);
      expect(pidIsAlive(descendantPid)).toBe(true);
      harness.kill("SIGKILL");
      await new Promise<void>((resolve) => harness.once("close", () => resolve()));
      await waitUntil(() => !pidIsAlive(leaderPid) && !pidIsAlive(descendantPid), 3_000);
    } finally {
      if (harness.pid && pidIsAlive(harness.pid)) harness.kill("SIGKILL");
      if (leaderPid && pidIsAlive(leaderPid)) {
        try {
          process.kill(-leaderPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 8_000);

  it("kills a resistant provider that SIGKILLs its watchdog parent", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "engager-engine-watchdog-death-"));
    dirs.push(directory);
    const pidPath = join(directory, "provider.pid");
    const hostile = [
      'const fs=require("node:fs")',
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid))`,
      'process.on("SIGTERM",()=>{})',
      'setTimeout(()=>process.kill(process.ppid,"SIGKILL"),20)',
      'setInterval(()=>{},1000)',
    ].join(";");
    await expect(
      runEngineProcess({
        command: process.execPath,
        args: ["-e", hostile],
        cwd: directory,
        env: { PATH: process.env.PATH },
        stdin: "",
        timeoutMs: 5_000,
        terminationGraceMs: 40,
      }),
    ).rejects.toMatchObject({ code: "ENGINE_SANDBOX_DENIED" });
    const pid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(() => !pidIsAlive(pid), 2_000);
  }, 5_000);

  it("does not inherit Engager, provider, or workspace secrets", () => {
    const source = {
      HOME: "/home/test",
      PATH: "/bin",
      CODEX_HOME: "/home/test/.codex",
      CLAUDE_CONFIG_DIR: "/home/test/.claude",
      OPENAI_API_KEY: "drop",
      ANTHROPIC_API_KEY: "drop",
      ENGAGER_MCP_KEY: "drop",
      GITHUB_TOKEN: "drop",
    };
    const env = sanitizedEngineEnv(source);
    expect(env).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();

    expect(engineProcessEnv("codex", undefined, source)).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      CODEX_HOME: "/home/test/.codex",
    });
    expect(engineProcessEnv("claude", undefined, source)).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/home/test/.claude",
    });
    expect(
      engineProcessEnv("codex", "/srv/selected-codex", source),
    ).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      CODEX_HOME: "/srv/selected-codex",
    });
  });

  it("returns a stable missing-engine code", async () => {
    await expect(
      runEngineProcess({
        command: "definitely-not-an-engine-command",
        args: [],
        cwd: process.cwd(),
        env: {},
        stdin: "",
        timeoutMs: 100,
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof RunnerFault && error.code === "ENGINE_NOT_FOUND");
  });
});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
