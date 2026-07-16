import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, invalidateDisconnectReceiptBeforeCredentialMint, loadConfig, saveConfig, type AgentConfig } from "./config.js";
import {
  disconnectAgent,
  REAL_DISCONNECT_DEPS,
  type DisconnectDeps,
} from "./disconnect.js";
import {
  credentialFingerprint,
  advanceDisconnectTransition,
  disconnectReceiptPath,
  disconnectReceiptHash,
  readDisconnectTransition,
  type DisconnectStart,
} from "./disconnect-transition.js";
import { RunnerFault } from "./errors.js";
import { haltPath, pausePath } from "./markers.js";
import { statusPath } from "./status.js";
import { upgradeTransitionPath } from "./upgrade-transition.js";
import { runDoctor } from "./doctor.js";
import { statusCommand } from "./commands.js";

const IDS = {
  request: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  key: "33333333-3333-4333-8333-333333333333",
  receipt: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555",
};

const config: AgentConfig = {
  configVersion: 2,
  mcpUrl: "https://engager.test/mcp",
  apiKey: "runner-secret-value",
  credentialProfile: "runner",
  runnerId: "runner-disconnect-test",
  engine: "claude",
  enginePath: "/opt/homebrew/bin/claude",
  model: "sonnet",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-disconnect-test-"));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function startBody(clientRequestId: string): DisconnectStart {
  return {
    protocolVersion: 1,
    status: "pending",
    requestId: IDS.request,
    clientRequestId,
    organizationId: IDS.organization,
    runnerId: config.runnerId,
    credentialKeyId: IDS.key,
    credentialFingerprint: credentialFingerprint(config.apiKey),
    deviceCode: `engrd_${"a".repeat(43)}`,
    userCode: "ABCDE-23456",
    verificationUri: "https://engager.test/runner-disconnect?code=ABCDE-23456",
    expiresAt: Date.now() + 900_000,
    intervalSec: 5,
  };
}

function approvedBody(start: ReturnType<typeof startBody>) {
  const receipt = {
    receiptVersion: 1 as const,
    receiptId: IDS.receipt,
    requestId: start.requestId,
    clientRequestId: start.clientRequestId,
    organizationId: start.organizationId,
    runnerId: start.runnerId,
    credentialKeyId: start.credentialKeyId,
    credentialFingerprint: start.credentialFingerprint,
    credentialWasActive: true,
    credentialRevokedAt: Date.now(),
    cancelledWorkOrderIds: [] as string[],
    legacyCancelledWorkOrderIds: [] as string[],
    approvedByUserId: IDS.user,
    approvedAt: Date.now(),
  };
  return {
    protocolVersion: 1,
    status: "approved",
    receipt: {
      ...receipt,
      receiptHash: disconnectReceiptHash(receipt),
    },
    ackToken: `engra_${"c".repeat(43)}`,
  };
}

function fixture(
  request: DisconnectDeps["request"],
  options: {
    loaded?: boolean;
    entryExists?: boolean;
    disabled?: boolean | null;
    load?: DisconnectDeps["load"];
  } = {},
) {
  const started = vi.fn(() => ({ ok: true, note: "restored" }));
  const stopped = vi.fn(() => ({ ok: true, note: "stopped" }));
  const uninstalled = vi.fn(() => ({ ok: true, note: "removed" }));
  const setDisabled = vi.fn(() => ({ ok: true, note: "intent restored" }));
  const maintenanceRelease = vi.fn();
  const executionRelease = vi.fn();
  const deps: DisconnectDeps = {
    ...REAL_DISCONNECT_DEPS,
    load: options.load ?? (() => config),
    service: () => ({
      supported: true,
      installed: true,
      entryExists: options.entryExists ?? true,
      loaded: options.loaded ?? true,
      pid: 777,
    }),
    serviceDisabled: () => options.disabled ?? false,
    setDisabled,
    stop: stopped,
    start: started,
    uninstall: uninstalled,
    maintenance: (runnerId) => ({
      path: "/test/maintenance",
      owner: { pid: process.pid, token: "maintenance-token", runnerId, startedAt: 1, processIdentity: "test" },
      release: maintenanceRelease,
    }),
    execution: (runnerId) => ({
      path: "/test/execution",
      owner: { pid: process.pid, token: "execution-token", runnerId, startedAt: 1, processIdentity: "test" },
      release: executionRelease,
    }),
    owner: () => ({ state: "absent" }),
    ownerLive: () => false,
    signal: vi.fn(),
    request,
    pause: async () => undefined,
    remove: vi.fn(),
    receipt: vi.fn(),
  };
  return { deps, started, stopped, uninstalled, setDisabled };
}

describe("runner disconnect recovery", () => {
  it("proves service quiescence before sending any bearer revocation request", async () => {
    let stopped: ReturnType<typeof vi.fn> | undefined;
    const request = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(stopped).toHaveBeenCalledOnce();
      const body = JSON.parse(String(init.body));
      return response({ ...startBody(body.clientRequestId), runnerId: "different-runner" });
    });
    const test = fixture(request);
    stopped = test.stopped;
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rechecks upgrade ownership after maintenance acquisition before creating a fence", async () => {
    const request = vi.fn();
    const test = fixture(request);
    const acquire = test.deps.maintenance;
    test.deps.maintenance = (runnerId) => {
      writeFileSync(upgradeTransitionPath(), "{}\n", { mode: 0o600 });
      return acquire(runnerId);
    };
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "RUNNER_ALREADY_ACTIVE" });
    expect(readDisconnectTransition()).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not prepare from a config snapshot changed while acquiring maintenance", async () => {
    let reads = 0;
    const rotated = { ...config, apiKey: "eng_live_rotated-before-prepare" };
    const request = vi.fn();
    const test = fixture(request, { load: () => (++reads <= 2 ? config : rotated) });
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "RUNNER_NOT_CONFIGURED" });
    expect(readDisconnectTransition()).toBeNull();
    expect(test.stopped).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps execution quiesced when config rotates after prepare but before start", async () => {
    let reads = 0;
    const rotated = { ...config, apiKey: "eng_live_rotated-before-start" };
    const request = vi.fn();
    const test = fixture(request, { load: () => (++reads <= 3 ? config : rotated) });
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("quiesced");
    expect(test.stopped).toHaveBeenCalledOnce();
    expect(test.started).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("reuses the stable client request after a lost start response", async () => {
    const starts: string[] = [];
    let fail = true;
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        starts.push(body.clientRequestId);
        if (fail) {
          fail = false;
          throw new Error("lost start response");
        }
        return response(startBody(body.clientRequestId));
      }
      const transition = readDisconnectTransition()!;
      if (url.pathname.endsWith("/poll")) return response(approvedBody(transition.start!));
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const { deps } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "SERVER_UNREACHABLE" });
    expect(readDisconnectTransition()?.phase).toBe("quiesced");
    await expect(disconnectAgent(deps)).resolves.toMatchObject({ ok: true, receiptId: IDS.receipt });
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(starts[1]);
  });

  it("rolls back a confirmed pre-start rejection and restores prior service", async () => {
    const request = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${config.apiKey}`);
      return response({ error: "invalid runner disconnect start request" }, 400);
    });
    const { deps, started, uninstalled } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()).toBeNull();
    expect(started).toHaveBeenCalledWith("maintenance-token");
    expect(uninstalled).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous auth rejection fenced for stable-id recovery", async () => {
    const request = vi.fn(async () =>
      response({ error: "runner credential inactive", code: "runner_credential_inactive" }, 403));
    const { deps, started } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("quiesced");
    expect(started).not.toHaveBeenCalled();
  });

  it.each([403, 409])("never erases concurrently approved recovery after a stale HTTP %s", async (status) => {
    const request = vi.fn(async () => {
      const quiesced = readDisconnectTransition()!;
      const start = startBody(quiesced.clientRequestId);
      const pending = advanceDisconnectTransition(quiesced, "pending", { start });
      const approved = approvedBody(start);
      advanceDisconnectTransition(pending, "approved", {
        approval: { receipt: approved.receipt, ackToken: approved.ackToken },
      });
      return response({ error: "stale concurrent start response" }, status);
    });
    const { deps, started } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("approved");
    expect(started).not.toHaveBeenCalled();
  });

  it("keeps concurrently approved authority when a stale safe-to-rollback HTTP 400 arrives", async () => {
    const request = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/start")) {
        const quiesced = readDisconnectTransition()!;
        const start = startBody(quiesced.clientRequestId);
        const pending = advanceDisconnectTransition(quiesced, "pending", { start });
        const approved = approvedBody(start);
        advanceDisconnectTransition(pending, "approved", {
          approval: { receipt: approved.receipt, ackToken: approved.ackToken },
        });
        return response({ error: "stale invalid-body response" }, 400);
      }
      throw new Error("ACK temporarily unavailable");
    });
    const { deps, started } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(readDisconnectTransition()?.phase).toBe("approved");
    expect(started).not.toHaveBeenCalled();
  });

  it("keeps concurrently approved authority when a stale denied poll arrives", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) {
        const pending = readDisconnectTransition()!;
        const approved = approvedBody(pending.start!);
        advanceDisconnectTransition(pending, "approved", {
          approval: { receipt: approved.receipt, ackToken: approved.ackToken },
        });
        return response({ protocolVersion: 1, status: "denied" });
      }
      throw new Error("ACK temporarily unavailable");
    });
    const { deps, started } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(readDisconnectTransition()?.phase).toBe("approved");
    expect(started).not.toHaveBeenCalled();
  });

  it("does not trust or poll a start response bound to another runner", async () => {
    const request = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return response({ ...startBody(body.clientRequestId), runnerId: "different-runner" });
    });
    const { deps, uninstalled } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("quiesced");
    expect(request).toHaveBeenCalledOnce();
    expect(uninstalled).not.toHaveBeenCalled();
  });

  it("recovers a lost poll response without sending bearer authority", async () => {
    let lost = true;
    const headers: Array<Headers> = [];
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      headers.push(new Headers(init.headers));
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) {
        if (lost) {
          lost = false;
          throw new Error("lost poll response");
        }
        return response(approvedBody(readDisconnectTransition()!.start!));
      }
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const { deps } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "SERVER_UNREACHABLE" });
    expect(readDisconnectTransition()?.phase).toBe("pending");
    await disconnectAgent(deps);
    expect(headers[0]!.get("authorization")).toBe(`Bearer ${config.apiKey}`);
    for (const header of headers.slice(1)) expect(header.has("authorization")).toBe(false);
  });

  it("persists approval before ACK and resumes without config after a lost ACK", async () => {
    let lostAck = true;
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) return response(approvedBody(readDisconnectTransition()!.start!));
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      if (lostAck) {
        lostAck = false;
        throw new Error("lost ACK response");
      }
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const first = fixture(request);
    await expect(disconnectAgent(first.deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(readDisconnectTransition()?.phase).toBe("approved");
    const recovered = fixture(request, { load: () => null });
    await expect(disconnectAgent(recovered.deps)).resolves.toMatchObject({ ok: true });
  });

  it("resumes acknowledged local cleanup without config after an uninstall crash", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) return response(approvedBody(readDisconnectTransition()!.start!));
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const first = fixture(request);
    first.deps.uninstall = vi.fn(() => ({ ok: false, note: "simulated uninstall crash" }));
    await expect(disconnectAgent(first.deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(readDisconnectTransition()?.phase).toBe("acknowledged");

    const recovered = fixture(request, { load: () => null });
    await expect(disconnectAgent(recovered.deps)).resolves.toMatchObject({ ok: true, receiptId: IDS.receipt });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("fails closed when an acknowledged transition vanishes without its exact sanitized receipt", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) return response(approvedBody(readDisconnectTransition()!.start!));
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const test = fixture(request);
    const read = test.deps.read;
    test.deps.read = () => {
      const current = read();
      if (current?.phase === "acknowledged") {
        test.deps.clear();
        return null;
      }
      return current;
    };
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(test.uninstalled).not.toHaveBeenCalled();
  });

  it.each(["denied", "expired"] as const)("clears the fence and restores prior loaded service on %s", async (status) => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      return response({ protocolVersion: 1, status });
    });
    const { deps, started } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toBeInstanceOf(RunnerFault);
    expect(readDisconnectTransition()).toBeNull();
    expect(started).toHaveBeenCalledWith("maintenance-token");
  });

  it("restores enabled-but-stopped launchd intent without starting the service", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      return response({ protocolVersion: 1, status: "denied" });
    });
    const { deps, started, stopped, setDisabled } = fixture(request, { loaded: false });
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_DENIED" });
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(setDisabled).toHaveBeenCalledWith(false);
  });

  it("restores disabled-but-loaded launchd intent after restarting the prior service", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      return response({ protocolVersion: 1, status: "denied" });
    });
    const { deps, started, setDisabled } = fixture(request, { disabled: true });
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_DENIED" });
    expect(started).toHaveBeenCalledWith("maintenance-token");
    expect(setDisabled).toHaveBeenCalledWith(true);
  });

  it("refuses disconnect before quiesce when a loaded service entry cannot be restored", async () => {
    const request = vi.fn();
    const { deps, stopped } = fixture(request, { entryExists: false });
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "SERVICE_ENTRY_MISSING" });
    expect(readDisconnectTransition()).toBeNull();
    expect(stopped).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("retains the fence when terminal service restoration cannot be verified", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      return response({ protocolVersion: 1, status: "denied" });
    });
    const { deps } = fixture(request);
    deps.start = vi.fn(() => ({ ok: false, note: "simulated restore failure" }));
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("pending");
  });

  it("retains the prepared fence when quiesce rollback cannot restore service", async () => {
    const request = vi.fn();
    const { deps } = fixture(request);
    deps.stop = vi.fn(() => ({ ok: false, note: "simulated stop failure" }));
    deps.start = vi.fn(() => ({ ok: false, note: "simulated restore failure" }));
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("prepared");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a mismatched receipt and keeps cleanup authority fenced", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      const approved = approvedBody(readDisconnectTransition()!.start!);
      approved.receipt.credentialKeyId = "66666666-6666-4666-8666-666666666666";
      return response(approved);
    });
    const { deps, uninstalled } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("pending");
    expect(uninstalled).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose canonical payload no longer matches its hash", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      const approved = approvedBody(readDisconnectTransition()!.start!);
      approved.receipt.approvedAt += 1;
      return response(approved);
    });
    const { deps } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("pending");
  });

  it("keeps approved recovery authority when ACK returns the wrong receipt", async () => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) return response(approvedBody(readDisconnectTransition()!.start!));
      return response({ status: "acknowledged", receiptId: "77777777-7777-4777-8777-777777777777" });
    });
    const { deps } = fixture(request);
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_CLEANUP_REQUIRED" });
    expect(readDisconnectTransition()?.phase).toBe("approved");
  });

  it.each(["not_found", "pending"] as const)("fails closed when a committed challenge becomes %s ambiguously", async (status) => {
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        const start = startBody(body.clientRequestId);
        if (status === "pending") start.expiresAt = 10;
        return response(start);
      }
      return response(status === "pending"
        ? { protocolVersion: 1, status: "pending", expiresAt: 10, intervalSec: 5 }
        : { status: "not_found" });
    });
    const { deps, started } = fixture(request);
    if (status === "pending") {
      let clockReads = 0;
      deps.now = () => ++clockReads < 3 ? 0 : 10;
    }
    await expect(disconnectAgent(deps)).rejects.toMatchObject({ code: "DISCONNECT_PROTOCOL_ERROR" });
    expect(readDisconnectTransition()?.phase).toBe("pending");
    expect(started).not.toHaveBeenCalled();
  });

  it("removes credential and unsafe local markers only after ACK, retaining a sanitized receipt", async () => {
    saveConfig(config);
    writeFileSync(haltPath(), "{}\n", { mode: 0o600 });
    writeFileSync(pausePath(), "{}\n", { mode: 0o600 });
    writeFileSync(statusPath(), "{}\n", { mode: 0o600 });
    const request = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname.endsWith("/start")) {
        const body = JSON.parse(String(init.body));
        return response(startBody(body.clientRequestId));
      }
      if (url.pathname.endsWith("/poll")) return response(approvedBody(readDisconnectTransition()!.start!));
      return response({ status: "acknowledged", receiptId: IDS.receipt });
    });
    const test = fixture(request, { load: loadConfig });
    test.deps.remove = REAL_DISCONNECT_DEPS.remove;
    test.deps.receipt = REAL_DISCONNECT_DEPS.receipt;
    await disconnectAgent(test.deps);
    for (const path of [configPath(), haltPath(), pausePath(), statusPath()]) expect(existsSync(path)).toBe(false);
    const receipt = readFileSync(disconnectReceiptPath(), "utf8");
    expect(receipt).toContain(IDS.receipt);
    expect(receipt).not.toContain(config.apiKey);
    expect(receipt).not.toContain("engrd_");
    expect(receipt).not.toContain("engra_");
    await expect(disconnectAgent(test.deps)).resolves.toEqual({
      ok: true,
      status: "disconnected",
      receiptId: IDS.receipt,
      recoveredFromReceipt: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
    const doctor = await runDoctor(null);
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "disconnect-receipt", status: "pass", detail: expect.stringContaining(IDS.receipt) }),
      expect.objectContaining({ name: "configuration", status: "pass" }),
    ]));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      statusCommand(true);
      expect(JSON.parse(output.mock.calls.map(([value]) => String(value)).join(""))).toMatchObject({
        verdict: expect.stringContaining("disconnected"),
        disconnectReceipt: { receiptId: IDS.receipt },
      });
    } finally {
      output.mockRestore();
    }
    mkdirSync(configPath());
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "RUNNER_NOT_CONFIGURED" });
    rmSync(configPath(), { recursive: true });

    // The tombstone is invalidated before a later device flow can mint a key,
    // even if the process crashes before that key is saved locally.
    invalidateDisconnectReceiptBeforeCredentialMint();
    expect(existsSync(disconnectReceiptPath())).toBe(false);
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "RUNNER_NOT_CONFIGURED" });

    // Any durable credential commit also invalidates a stale receipt. Losing
    // that later config cannot resurrect evidence from the previous binding.
    writeFileSync(disconnectReceiptPath(), receipt, { mode: 0o600 });
    saveConfig({ ...config, apiKey: "eng_live_new-generation-secret" });
    expect(existsSync(disconnectReceiptPath())).toBe(false);
    REAL_DISCONNECT_DEPS.remove(configPath());
    await expect(disconnectAgent(test.deps)).rejects.toMatchObject({ code: "RUNNER_NOT_CONFIGURED" });
  });
});
