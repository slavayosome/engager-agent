import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  configPath,
  configFileMode,
  configPathPresent,
  loadConfig,
  sameConfigSnapshot,
  type AgentConfig,
} from "./config.js";
import {
  advanceDisconnectTransition,
  clearDisconnectTransition,
  credentialFingerprint,
  disconnectReceiptHash,
  DisconnectReceiptSchema,
  DisconnectStartSchema,
  readDisconnectTransition,
  readSanitizedDisconnectReceipt,
  RUNNER_DISCONNECT_PROTOCOL_VERSION,
  writeDisconnectTransition,
  writeSanitizedDisconnectReceipt,
  safeDisconnectProgress,
  type DisconnectSafeProgress,
  type DisconnectStart,
  type DisconnectTransition,
} from "./disconnect-transition.js";
import { removePathDurably } from "./durable.js";
import { RunnerFault, sanitizeSensitiveText } from "./errors.js";
import { MAX_DEVICE_AUTH_RESPONSE_BYTES, readBoundedJson } from "./http.js";
import { journalPath } from "./journal.js";
import {
  acquireMaintenanceLock,
  acquireRunnerLock,
  inspectRunnerLock,
  isLockOwnerLive,
  type RunnerLock,
} from "./lock.js";
import { haltPath, pausePath } from "./markers.js";
import { logEvent, redactionSecrets } from "./log.js";
import {
  serviceDisabledState,
  setServiceDisabled,
  serviceState,
  startServiceWithMaintenanceToken,
  stopService,
  uninstallService,
  type ServiceState,
} from "./service.js";
import { sessionUsagePath } from "./session-usage.js";
import { statusPath } from "./status.js";
import { hasUpgradeTransition } from "./upgrade-transition.js";

const PollPendingSchema = z.object({
  protocolVersion: z.literal(1),
  status: z.literal("pending"),
  expiresAt: z.number().int().nonnegative(),
  intervalSec: z.literal(5),
}).strict();
const PollTerminalSchema = z.union([
  z.object({ protocolVersion: z.literal(1), status: z.enum(["denied", "expired"]) }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
]);
const PollApprovedSchema = z.object({
  protocolVersion: z.literal(1),
  status: z.enum(["approved", "acknowledged"]),
  receipt: DisconnectReceiptSchema,
  ackToken: z.string().regex(/^engra_[A-Za-z0-9_-]{43}$/),
}).strict();
const PollResponseSchema = z.union([PollPendingSchema, PollTerminalSchema, PollApprovedSchema]);
const AckResponseSchema = z.union([
  z.object({ status: z.literal("acknowledged"), receiptId: z.string().uuid() }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
]);

export type DisconnectResult = {
  ok: true;
  status: "disconnected";
  receiptId: string;
  recoveredFromReceipt?: boolean;
};

export type DisconnectDeps = {
  load: typeof loadConfig;
  configMode: typeof configFileMode;
  configPresent: typeof configPathPresent;
  read: typeof readDisconnectTransition;
  write: typeof writeDisconnectTransition;
  advance: typeof advanceDisconnectTransition;
  clear: typeof clearDisconnectTransition;
  receipt: typeof writeSanitizedDisconnectReceipt;
  completedReceipt: typeof readSanitizedDisconnectReceipt;
  maintenance: typeof acquireMaintenanceLock;
  execution: (runnerId: string, maintenanceToken: string) => RunnerLock;
  service: () => ServiceState;
  serviceDisabled: () => boolean | null;
  setDisabled: typeof setServiceDisabled;
  stop: typeof stopService;
  start: typeof startServiceWithMaintenanceToken;
  uninstall: typeof uninstallService;
  owner: typeof inspectRunnerLock;
  ownerLive: typeof isLockOwnerLive;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  request: (url: URL, init: RequestInit) => Promise<Response>;
  now: () => number;
  pause: (milliseconds: number) => Promise<void>;
  remove: (path: string) => void;
  onProgress?: (progress: DisconnectSafeProgress) => void;
};

export const REAL_DISCONNECT_DEPS: DisconnectDeps = {
  load: loadConfig,
  configMode: configFileMode,
  configPresent: configPathPresent,
  read: readDisconnectTransition,
  write: writeDisconnectTransition,
  advance: advanceDisconnectTransition,
  clear: clearDisconnectTransition,
  receipt: writeSanitizedDisconnectReceipt,
  completedReceipt: readSanitizedDisconnectReceipt,
  maintenance: acquireMaintenanceLock,
  execution: (runnerId, maintenanceToken) => acquireRunnerLock(runnerId, undefined, maintenanceToken),
  service: serviceState,
  serviceDisabled: serviceDisabledState,
  setDisabled: setServiceDisabled,
  stop: stopService,
  start: startServiceWithMaintenanceToken,
  uninstall: uninstallService,
  owner: inspectRunnerLock,
  ownerLive: isLockOwnerLive,
  signal: (pid, signal) => process.kill(pid, signal),
  request: (url, init) => fetch(url, init),
  now: Date.now,
  pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  remove: removePathDurably,
};

export async function disconnectAgent(
  deps: DisconnectDeps = REAL_DISCONNECT_DEPS,
): Promise<DisconnectResult> {
  let transition: DisconnectTransition | null;
  try {
    transition = deps.read();
  } catch (error) {
    throw protocolFault(`local disconnect journal could not be read safely: ${bounded(error)}`);
  }
  if (!transition && !deps.load() && deps.configMode() == null && !deps.configPresent()) {
    let completed: ReturnType<typeof readSanitizedDisconnectReceipt>;
    try {
      completed = deps.completedReceipt();
    } catch (error) {
      throw cleanupFault(`sanitized disconnect receipt is unsafe: ${bounded(error)}`, error);
    }
    if (completed) {
      return {
        ok: true,
        status: "disconnected",
        receiptId: completed.receiptId,
        recoveredFromReceipt: true,
      };
    }
  }
  if (!transition) transition = prepare(deps);
  if (transition.phase === "prepared") transition = quiesce(transition, deps);
  if (transition.phase === "quiesced") transition = await startRequest(transition, deps);
  if (transition.phase === "pending") {
    deps.onProgress?.(safeDisconnectProgress(transition));
    transition = await awaitDecision(transition, deps);
    if (transition.phase === "pending") {
      throw pendingFault(transition);
    }
  }
  if (transition.phase === "approved") transition = await acknowledge(transition, deps);
  if (transition.phase === "acknowledged") return finishCleanup(transition, deps);
  throw protocolFault(`unsupported local disconnect phase ${transition.phase}`);
}

export function disconnectAgentWithProgress(
  onProgress: (progress: DisconnectSafeProgress) => void,
): Promise<DisconnectResult> {
  return disconnectAgent({ ...REAL_DISCONNECT_DEPS, onProgress });
}

function prepare(deps: DisconnectDeps): DisconnectTransition {
  const configSnapshot = deps.load();
  if (!configSnapshot) {
    throw new RunnerFault("RUNNER_NOT_CONFIGURED", "no runner credential is available to start disconnect", {
      impact: "No revocation request was sent and no local state was changed.",
      recovery: "Run `engager-agent setup`, or preserve and repair agent.json if disconnect is still required.",
    });
  }
  if (hasUpgradeTransition()) {
    throw new RunnerFault("RUNNER_ALREADY_ACTIVE", "an upgrade transition must be recovered before disconnect", {
      impact: "No disconnect request was started against an ambiguous runtime payload.",
      recovery: "Complete `engager-agent upgrade` or `engager-agent service repair`, then retry disconnect.",
      retryable: true,
    });
  }
  const maintenance = deps.maintenance(configSnapshot.runnerId);
  try {
    if (hasUpgradeTransition()) {
      throw new RunnerFault("RUNNER_ALREADY_ACTIVE", "an upgrade transition started before disconnect could establish its fence", {
        impact: "No disconnect request was started against an ambiguous runtime payload.",
        recovery: "Complete the upgrade recovery, then retry disconnect.",
        retryable: true,
      });
    }
    const config = deps.load();
    if (!config || !sameConfigSnapshot(configSnapshot, config)) {
      throw new RunnerFault(
        "RUNNER_NOT_CONFIGURED",
        "runner configuration changed while disconnect was acquiring maintenance",
        {
          impact: "No disconnect fence or revocation request was created from the stale credential snapshot.",
          recovery: "Inspect `engager-agent status`, then retry disconnect from the current binding.",
          retryable: true,
        },
      );
    }
    const existing = deps.read();
    if (existing) throw pendingFault(existing);
    const state = deps.service();
    const disabled = deps.serviceDisabled();
    if (state.loaded && (!state.installed || !state.entryExists || disabled == null)) {
      throw new RunnerFault(
        "SERVICE_ENTRY_MISSING",
        "the loaded background service does not have a fully restorable entry and launchd intent",
        {
          impact: "Disconnect did not stop the service or send a revocation request.",
          recovery: "Run `engager-agent service repair`, verify `engager-agent doctor`, then retry disconnect.",
        },
      );
    }
    const prepared = deps.write({
      schemaVersion: 1,
      protocolVersion: RUNNER_DISCONNECT_PROTOCOL_VERSION,
      phase: "prepared",
      createdAt: deps.now(),
      clientRequestId: randomUUID(),
      mcpUrl: new URL(config.mcpUrl).toString(),
      runnerId: config.runnerId,
      credentialFingerprint: credentialFingerprint(config.apiKey),
      priorService: {
        supported: state.supported,
        installed: state.installed,
        entryExists: state.entryExists,
        loaded: state.loaded,
        disabled,
      },
    });
    recordTransition(prepared);
    return prepared;
  } catch (error) {
    if (error instanceof RunnerFault) throw error;
    throw protocolFault(`disconnect preparation could not be committed safely: ${bounded(error)}`);
  } finally {
    maintenance.release();
  }
}

function quiesce(transition: DisconnectTransition, deps: DisconnectDeps): DisconnectTransition {
  const maintenance = deps.maintenance(transition.runnerId);
  let barrier: RunnerLock | null = null;
  try {
    const current = deps.read();
    if (!current) throw new Error("disconnect transition disappeared before quiesce");
    if (current.clientRequestId !== transition.clientRequestId) {
      throw new Error("a different disconnect transition owns local recovery");
    }
    if (current.phase !== "prepared") return current;
    transition = current;
    const currentService = deps.service();
    if (currentService.supported && currentService.loaded) {
      const stopped = deps.stop();
      if (!stopped.ok) throw new Error(stopped.note);
    }
    const owner = deps.owner(transition.runnerId);
    if (owner.state === "invalid") throw new Error(`execution lock is unsafe: ${owner.detail}`);
    if (owner.state === "valid" && deps.ownerLive(owner.owner)) {
      deps.signal(owner.owner.pid, "SIGTERM");
    }
    barrier = acquireBarrier(deps, transition.runnerId, maintenance.owner.token);
    const next = deps.advance(transition, "quiesced");
    recordTransition(next);
    return next;
  } catch (error) {
    try {
      rollbackPreStart(transition, maintenance, deps);
    } catch (rollbackError) {
      throw new RunnerFault("DISCONNECT_PROTOCOL_ERROR", `${bounded(error)}; prior service restoration is incomplete: ${bounded(rollbackError)}`, {
        impact: "No revocation request was sent, but the disconnect fence remains active because prior service intent could not be restored safely.",
        recovery: "Repair the lifecycle issue, then rerun `engager-agent disconnect` to recover the prepared transition.",
        retryable: true,
        cause: rollbackError,
      });
    }
    throw new RunnerFault("DISCONNECT_PROTOCOL_ERROR", bounded(error), {
      impact: "No revocation request was sent; the disconnect fence was cleared after attempting to restore prior service intent.",
      recovery: "Run `engager-agent doctor`, repair the reported lifecycle issue, then retry disconnect.",
      cause: error,
    });
  } finally {
    barrier?.release();
    maintenance.release();
  }
}

function acquireBarrier(deps: DisconnectDeps, runnerId: string, token: string): RunnerLock {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return deps.execution(runnerId, token);
    } catch (error) {
      last = error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  throw new Error(`execution did not quiesce: ${bounded(last)}`);
}

async function startRequest(
  transition: DisconnectTransition,
  deps: DisconnectDeps,
): Promise<DisconnectTransition> {
  // A replacement credential cannot safely restore the prior service: that
  // service would boot with the replacement authority exactConfig rejected.
  // Keep the quiesced fence until the exact original agent.json is restored.
  const config: AgentConfig = exactConfig(transition, deps.load());
  const response = await remote(
    new URL("/runner-disconnect/start", transition.mcpUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        clientRequestId: transition.clientRequestId,
        runnerId: transition.runnerId,
        clientName: "engager-agent",
      }),
    },
    deps,
    true,
  );
  if (!response.ok) {
    if (response.safeToRollbackStart) {
      const current = restoreAfterTerminal(transition, "quiesced", deps);
      if (current) return current;
    }
    throw response.fault;
  }
  const parsed = DisconnectStartSchema.safeParse(response.body);
  if (!parsed.success) throw protocolFault("disconnect start response failed strict schema validation");
  validateStartBinding(transition, parsed.data, deps.now());
  const next = commitPhase(transition, "pending", { start: parsed.data }, deps);
  recordTransition(next);
  deps.onProgress?.(safeDisconnectProgress(next));
  return next;
}

async function awaitDecision(
  transition: DisconnectTransition,
  deps: DisconnectDeps,
): Promise<DisconnectTransition> {
  let current = transition;
  for (;;) {
    const start = current.start!;
    const response = await remote(
      new URL("/runner-disconnect/poll", current.mcpUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      },
      deps,
      false,
    );
    if (!response.ok) throw response.fault;
    const parsed = PollResponseSchema.safeParse(response.body);
    if (!parsed.success) throw protocolFault("disconnect poll response failed strict schema validation");
    if (parsed.data.status === "pending") {
      if (parsed.data.expiresAt !== start.expiresAt) {
        throw protocolFault("disconnect poll expiry changed from the committed challenge");
      }
      if (deps.now() >= start.expiresAt) {
        throw protocolFault("disconnect server still reports pending after the committed expiry");
      }
      await deps.pause(Math.max(1_000, parsed.data.intervalSec * 1_000));
      continue;
    }
    if (parsed.data.status === "not_found") {
      throw protocolFault("disconnect challenge disappeared after a committed start response");
    }
    if (parsed.data.status === "denied" || parsed.data.status === "expired") {
      const status = parsed.data.status;
      const concurrentlyAdvanced = restoreAfterTerminal(current, "pending", deps);
      if (concurrentlyAdvanced) return concurrentlyAdvanced;
      throw new RunnerFault(status === "denied" ? "DISCONNECT_DENIED" : "DISCONNECT_EXPIRED", `runner disconnect was ${parsed.data.status}`, {
        impact: "The disconnect fence was cleared and prior service intent was restored; the credential was not accepted as revoked.",
        recovery: status === "denied" ? "Retry only if disconnect is still intended." : "Run `engager-agent disconnect` for a new approval challenge.",
      });
    }
    if (parsed.data.status !== "approved" && parsed.data.status !== "acknowledged") {
      throw protocolFault("disconnect poll returned an unsupported terminal state");
    }
    validateReceiptBinding(current, parsed.data.receipt);
    current = commitPhase(current, "approved", {
      approval: { receipt: parsed.data.receipt, ackToken: parsed.data.ackToken },
    }, deps);
    recordTransition(current);
    return current;
  }
}

async function acknowledge(
  transition: DisconnectTransition,
  deps: DisconnectDeps,
): Promise<DisconnectTransition> {
  const start = transition.start!;
  const approval = transition.approval!;
  const response = await remote(
    new URL("/runner-disconnect/ack", transition.mcpUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceCode: start.deviceCode,
        receiptId: approval.receipt.receiptId,
        ackToken: approval.ackToken,
      }),
    },
    deps,
    false,
  );
  if (!response.ok) throw cleanupFault(response.fault.message, response.fault);
  const parsed = AckResponseSchema.safeParse(response.body);
  if (!parsed.success || parsed.data.status !== "acknowledged" || parsed.data.receiptId !== approval.receipt.receiptId) {
    throw cleanupFault("disconnect ACK response failed exact receipt binding validation");
  }
  const next = commitPhase(transition, "acknowledged", {}, deps);
  recordTransition(next);
  return next;
}

function finishCleanup(transition: DisconnectTransition, deps: DisconnectDeps): DisconnectResult {
  const maintenance = deps.maintenance(transition.runnerId);
  try {
    const current = deps.read();
    if (!current) {
      const expectedReceiptId = transition.approval!.receipt.receiptId;
      const completed = deps.completedReceipt();
      if (!completed || completed.receiptId !== expectedReceiptId) {
        throw cleanupFault("disconnect transition disappeared before exact sanitized completion evidence was committed");
      }
      return { ok: true, status: "disconnected", receiptId: expectedReceiptId };
    }
    if (current.clientRequestId !== transition.clientRequestId) {
      throw cleanupFault("a different disconnect transition owns local cleanup");
    }
    transition = current;
    const state = deps.service();
    if (state.supported && state.installed) {
      const removed = deps.uninstall();
      if (!removed.ok) throw cleanupFault(removed.note);
    }
    for (const path of [
      configPath(),
      journalPath(),
      haltPath(),
      pausePath(),
      statusPath(),
      sessionUsagePath(),
    ]) {
      deps.remove(path);
    }
    deps.receipt(transition);
    const receiptId = transition.approval!.receipt.receiptId;
    deps.clear();
    logEvent({
      event: "disconnect.result",
      level: "info",
      runnerId: transition.runnerId,
      phase: "complete",
      detail: `disconnect receipt ${receiptId} acknowledged and local teardown completed`,
    });
    return { ok: true, status: "disconnected", receiptId };
  } catch (error) {
    if (error instanceof RunnerFault) throw error;
    throw cleanupFault(bounded(error), error);
  } finally {
    maintenance.release();
  }
}

function rollbackPreStart(
  transition: DisconnectTransition,
  maintenance: RunnerLock,
  deps: DisconnectDeps,
): void {
  restorePriorService(transition, maintenance, deps);
  deps.clear();
}

function restoreAfterTerminal(
  transition: DisconnectTransition,
  expectedPhase: "quiesced" | "pending",
  deps: DisconnectDeps,
): DisconnectTransition | null {
  const maintenance = deps.maintenance(transition.runnerId);
  try {
    const current = deps.read();
    if (!current) return null;
    if (current.clientRequestId !== transition.clientRequestId) {
      throw protocolFault("a different disconnect transition owns local recovery");
    }
    // A concurrent process may have committed the accepted start response or
    // owner approval while this caller received a stale rejection/decision.
    // Newer durable authority always wins; never restart or erase it.
    if (current.phase !== expectedPhase) return current;
    restorePriorService(current, maintenance, deps);
    deps.clear();
    return null;
  } catch (error) {
    if (error instanceof RunnerFault) throw error;
    throw new RunnerFault("DISCONNECT_PROTOCOL_ERROR", `terminal disconnect restoration is incomplete: ${bounded(error)}`, {
      impact: "The terminal decision is known, but execution remains fenced until captured service intent is restored.",
      recovery: "Repair the service lifecycle issue, then rerun `engager-agent disconnect` to finish terminal recovery.",
      retryable: true,
      cause: error,
    });
  } finally {
    maintenance.release();
  }
}

function commitPhase(
  transition: DisconnectTransition,
  phase: DisconnectTransition["phase"],
  patch: Partial<Pick<DisconnectTransition, "start" | "approval">>,
  deps: DisconnectDeps,
): DisconnectTransition {
  const maintenance = deps.maintenance(transition.runnerId);
  try {
    const current = deps.read();
    if (!current || current.clientRequestId !== transition.clientRequestId) {
      throw protocolFault("disconnect recovery ownership changed before a phase commit");
    }
    if (current.phase !== transition.phase) return current;
    return deps.advance(current, phase, patch);
  } catch (error) {
    if (error instanceof RunnerFault) throw error;
    throw protocolFault(`disconnect phase ${phase} could not be committed safely: ${bounded(error)}`);
  } finally {
    maintenance.release();
  }
}

function restorePriorService(
  transition: DisconnectTransition,
  maintenance: RunnerLock,
  deps: DisconnectDeps,
): void {
  if (!transition.priorService.supported || !transition.priorService.installed) return;
  if (transition.priorService.loaded) {
    const restored = deps.start(maintenance.owner.token);
    if (!restored.ok) {
      throw new Error(`prior service state could not be restored: ${restored.note}`);
    }
    if (transition.priorService.disabled != null) {
      const intent = deps.setDisabled(transition.priorService.disabled);
      if (!intent.ok) throw new Error(`prior service intent could not be restored: ${intent.note}`);
    }
    return;
  }
  if (transition.priorService.disabled != null) {
    const restored = deps.setDisabled(transition.priorService.disabled);
    if (!restored.ok) throw new Error(`prior service intent could not be restored: ${restored.note}`);
  }
}

function exactConfig(transition: DisconnectTransition, config: AgentConfig | null): AgentConfig {
  if (
    !config ||
    new URL(config.mcpUrl).toString() !== transition.mcpUrl ||
    config.runnerId !== transition.runnerId ||
    credentialFingerprint(config.apiKey) !== transition.credentialFingerprint
  ) {
    throw new RunnerFault("DISCONNECT_PROTOCOL_ERROR", "the saved credential no longer matches the prepared disconnect binding", {
      impact: "No start request was sent with replacement or ambiguous authority.",
      recovery: "Restore the exact original private agent.json and rerun disconnect, or preserve the transition for support.",
    });
  }
  return config;
}

function validateStartBinding(transition: DisconnectTransition, start: DisconnectStart, now: number): void {
  if (
    start.clientRequestId !== transition.clientRequestId ||
    start.runnerId !== transition.runnerId ||
    start.credentialFingerprint !== transition.credentialFingerprint
  ) {
    throw protocolFault("disconnect start response did not match the committed credential challenge");
  }
  const verification = new URL(start.verificationUri);
  if (
    verification.username ||
    verification.password ||
    verification.hash ||
    verification.pathname !== "/runner-disconnect" ||
    verification.searchParams.size !== 1 ||
    verification.searchParams.get("code") !== start.userCode ||
    (verification.protocol !== "https:" && !(verification.protocol === "http:" && isLoopbackHost(verification.hostname)))
  ) {
    throw protocolFault("disconnect verification URL is not HTTPS or loopback HTTP");
  }
  if (start.expiresAt <= now || start.expiresAt > now + 30 * 60_000) {
    throw protocolFault("disconnect challenge expiry is outside the v1 safety window");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateReceiptBinding(transition: DisconnectTransition, receipt: z.infer<typeof DisconnectReceiptSchema>): void {
  const start = transition.start!;
  if (
    receipt.requestId !== start.requestId ||
    receipt.clientRequestId !== start.clientRequestId ||
    receipt.organizationId !== start.organizationId ||
    receipt.runnerId !== start.runnerId ||
    receipt.credentialKeyId !== start.credentialKeyId ||
    receipt.credentialFingerprint !== start.credentialFingerprint
  ) {
    throw protocolFault("disconnect receipt did not match the exact committed request and credential");
  }
  const { receiptHash, ...payload } = receipt;
  if (disconnectReceiptHash(payload) !== receiptHash) {
    throw protocolFault("disconnect receipt hash did not authenticate the exact returned payload");
  }
}

type RemoteResult =
  | { ok: true; body: unknown }
  | { ok: false; fault: RunnerFault; safeToRollbackStart: boolean };

async function remote(
  url: URL,
  init: RequestInit,
  deps: DisconnectDeps,
  start: boolean,
): Promise<RemoteResult> {
  try {
    const response = await deps.request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readBoundedJson(response, MAX_DEVICE_AUTH_RESPONSE_BYTES);
    if (response.ok) return { ok: true, body };
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const remoteCode = typeof record.code === "string" ? safeRemoteString(record.code, deps, 80) : undefined;
    const message = typeof record.error === "string" ? safeRemoteString(record.error, deps, 300) : `HTTP ${response.status}`;
    return {
      ok: false,
      // Only a request-body rejection proves this invocation did not enter the
      // server state machine. Auth/conflict responses can race another caller
      // that already committed pending or approved authority.
      safeToRollbackStart: start && response.status === 400,
      fault: new RunnerFault("DISCONNECT_PROTOCOL_ERROR", `disconnect endpoint rejected the request: ${message}`, {
        impact: start ? "No local credential was deleted." : "The durable disconnect recovery fence remains active.",
        recovery: start && response.status === 400
          ? "The pre-start fence was rolled back; fix configuration/server compatibility before retrying."
          : "Rerun `engager-agent disconnect`; the stable request and recovery authority will be replayed.",
        retryable: response.status >= 500,
        ...(remoteCode ? { remoteCode } : {}),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      safeToRollbackStart: false,
      fault: new RunnerFault("SERVER_UNREACHABLE", "runner disconnect endpoint is temporarily unreachable", {
        impact: "The durable disconnect fence remains active; no ambiguous retry used a new request identity.",
        recovery: "Rerun `engager-agent disconnect`; recovery reuses the committed request or bearerless challenge.",
        retryable: true,
        cause: error,
      }),
    };
  }
}

function pendingFault(transition: DisconnectTransition): RunnerFault {
  return new RunnerFault("DISCONNECT_PENDING", `runner disconnect recovery is pending at phase ${transition.phase}`, {
    impact: "Execution and lifecycle mutations remain fenced until disconnect reaches a terminal result.",
    recovery: "Rerun `engager-agent disconnect` to resume the same crash-safe transition.",
    retryable: true,
  });
}

function protocolFault(message: string): RunnerFault {
  return new RunnerFault("DISCONNECT_PROTOCOL_ERROR", message, {
    impact: "The response was not trusted and the durable disconnect fence remains active.",
    recovery: "Preserve the transition and rerun after server/runner compatibility is repaired.",
  });
}

function cleanupFault(message: string, cause?: unknown): RunnerFault {
  return new RunnerFault("DISCONNECT_CLEANUP_REQUIRED", message, {
    impact: "The credential may already be revoked, but local teardown remains safely recoverable without it.",
    recovery: "Rerun `engager-agent disconnect`; it resumes receipt ACK and cleanup without the bearer.",
    retryable: true,
    cause,
  });
}

function bounded(error: unknown): string {
  return sanitizeSensitiveText(
    error instanceof Error ? error.message : String(error),
    redactionSecrets(),
  ).slice(0, 300) || "disconnect operation failed";
}

function safeRemoteString(value: string, deps: DisconnectDeps, max: number): string {
  return sanitizeSensitiveText(value, [...redactionSecrets(), deps.load()?.apiKey]).slice(0, max);
}

function recordTransition(transition: DisconnectTransition): void {
  logEvent({
    event: "disconnect.transition",
    level: transition.phase === "approved" || transition.phase === "acknowledged" ? "warn" : "info",
    runnerId: transition.runnerId,
    phase: transition.phase,
    detail: `runner disconnect advanced to ${transition.phase}`,
  });
}
