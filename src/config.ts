import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { writePrivateJsonDurably } from "./durable.js";
import type { EngineName } from "./engine.js";

/**
 * Organization-level runner configuration. Campaign assignment, item IDs,
 * demand, priority, and cadence are server decisions in protocol v2.1.
 */
export type AgentConfig = {
  configVersion: 2;
  mcpUrl: string;
  apiKey: string;
  credentialProfile: "runner";
  runnerId: string;
  engine: EngineName;
  /** Exact executable selected during setup; never resolve from service PATH. */
  enginePath: string;
  /** Optional non-default provider auth/config directory selected during setup.
   * The engine adapter restores only this one engine-specific environment value. */
  engineConfigDir?: string;
  /** Omit to let the provider CLI use its supported default. */
  model?: string;
  /** Claude turn ceiling; ignored by adapters that do not expose one. */
  maxTurns: number;
  /** Local provider-capacity guard. Persisted counters prevent restart bypass. */
  dailySessionCap: number;
  /** Model process deadline; leases are renewed while this runs. */
  sessionTimeoutMinutes: number;
  /** Local setup intent only. While present, this credential may claim only
   * setup-proof work for the exact organization. It is removed only after an
   * accepted proof receipt; it never grants or broadens server authority. */
  pendingSetupProofOrganizationId?: string;
  /** Sealed 0.8.x bridge only; never consulted by v2.1. */
  legacy?: {
    campaignId: number;
    intervalMinutes: number;
  };
};

export type PendingDeviceAck = {
  deviceCode: string;
  ackToken: string;
  deliveryExpiresAt: number;
};

export type StoredConfig = Partial<AgentConfig> & {
  /** v0.8.x fields accepted only for one-way migration. */
  cli?: "claude";
  campaignId?: number;
  intervalMinutes?: number;
  /** A protocol-2 key is temporary until this durable ACK is replayed. */
  pendingDeviceAck?: PendingDeviceAck;
};

export const CONFIG_DEFAULTS = {
  engine: "claude" as const,
  model: "sonnet",
  maxTurns: 4,
  dailySessionCap: 24,
  sessionTimeoutMinutes: 20,
};

export function isValidRunnerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{3,200}$/.test(value);
}

export function isValidSetupProofOrganizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function agentHome(): string {
  return process.env.ENGAGER_AGENT_HOME ?? join(homedir(), ".engager");
}

export function configPath(): string {
  return join(agentHome(), "agent.json");
}

function normalizeConfig(raw: StoredConfig): AgentConfig | null {
  if (
    raw.pendingDeviceAck !== undefined ||
    !raw.mcpUrl ||
    !isSafeMcpUrl(raw.mcpUrl) ||
    !raw.apiKey ||
    raw.credentialProfile !== "runner" ||
    !isValidRunnerId(raw.runnerId)
  ) {
    return null;
  }
  const engine: EngineName = raw.engine ?? raw.cli ?? CONFIG_DEFAULTS.engine;
  if (engine !== "claude" && engine !== "codex") return null;
  if (!isSafeExecutablePath(raw.enginePath)) return null;
  if (raw.engineConfigDir !== undefined && !isSafeEngineConfigDir(raw.engineConfigDir)) {
    return null;
  }
  if (
    raw.pendingSetupProofOrganizationId !== undefined &&
    !isValidSetupProofOrganizationId(raw.pendingSetupProofOrganizationId)
  ) {
    return null;
  }
  const legacy = raw.legacy ??
    (Number.isSafeInteger(raw.campaignId) && Number(raw.campaignId) > 0
      ? {
          campaignId: Number(raw.campaignId),
          intervalMinutes:
            Number.isFinite(raw.intervalMinutes) && Number(raw.intervalMinutes) >= 15
              ? Math.round(Number(raw.intervalMinutes))
              : 60,
        }
      : undefined);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  return {
    configVersion: 2,
    mcpUrl: raw.mcpUrl,
    apiKey: raw.apiKey,
    credentialProfile: "runner",
    runnerId: raw.runnerId,
    engine,
    enginePath: raw.enginePath,
    ...(raw.engineConfigDir ? { engineConfigDir: raw.engineConfigDir } : {}),
    ...(model ? { model } : engine === "claude" ? { model: CONFIG_DEFAULTS.model } : {}),
    maxTurns: boundedInt(raw.maxTurns, CONFIG_DEFAULTS.maxTurns, 1, 20),
    dailySessionCap: boundedInt(raw.dailySessionCap, CONFIG_DEFAULTS.dailySessionCap, 1, 100),
    sessionTimeoutMinutes: boundedInt(
      raw.sessionTimeoutMinutes,
      CONFIG_DEFAULTS.sessionTimeoutMinutes,
      1,
      60,
    ),
    ...(raw.pendingSetupProofOrganizationId
      ? { pendingSetupProofOrganizationId: raw.pendingSetupProofOrganizationId.toLowerCase() }
      : {}),
    ...(legacy ? { legacy } : {}),
  };
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function loadConfig(): AgentConfig | null {
  const path = configPath();
  if (!existsSync(path) || !isPrivateConfig(path)) return null;
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as StoredConfig);
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentConfig): void {
  const normalized = normalizeConfig(config);
  if (!normalized) throw new Error("refusing to persist an invalid runner configuration");
  writeConfig(normalized);
}

function writeConfig(value: unknown): void {
  writePrivateJsonDurably(configPath(), value);
}

/** Whatever is stored, complete or not; setup uses this to resume browser auth. */
export function loadPartialConfig(): StoredConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
    return isPrivateConfig(path)
      ? raw
      : { ...raw, apiKey: undefined, pendingDeviceAck: undefined };
  } catch {
    return null;
  }
}

export function configFileMode(): number | null {
  try {
    const stat = lstatSync(configPath());
    return stat.isFile() ? stat.mode & 0o777 : null;
  } catch {
    return null;
  }
}

export function savePartialConfig(partial: StoredConfig): void {
  writeConfig(partial);
}

/** Complete protocol-2 delivery only when the remaining configuration is
 * valid. Keeping the pending ACK record on validation failure makes replay
 * possible and avoids losing the only durable delivery authority. */
export function finalizeAcknowledgedDeviceConfig(
  stored: StoredConfig,
): AgentConfig | null {
  const { pendingDeviceAck: _pending, ...candidate } = stored;
  const normalized = normalizeConfig(candidate);
  if (!normalized) return null;
  writeConfig(normalized);
  return normalized;
}

export function withoutPendingSetupProof(config: AgentConfig): AgentConfig {
  const { pendingSetupProofOrganizationId: _pending, ...settled } = config;
  return settled;
}

export function createRunnerId(): string {
  const host = (hostname().split(".")[0] || "runner")
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .slice(0, 180);
  return `${host}-${randomBytes(3).toString("hex")}`;
}

export function isSafeMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export function isSafeExecutablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !/(?:^|\/)(?:_npx|\.hermes|Caches?|tmp|\.cache)(?:\/|$)/i.test(value)
  );
}

export function engineConfigEnvironmentName(
  engine: EngineName,
): "CLAUDE_CONFIG_DIR" | "CODEX_HOME" {
  return engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
}

export function isSafeEngineConfigDir(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2_000 &&
    isAbsolute(value) &&
    !value.includes("\0")
  );
}

/** Capture only the selected provider's explicit config-directory override.
 * API keys, proxy settings, shell hooks, and unrelated provider state stay out. */
export function engineConfigDirFromEnvironment(
  engine: EngineName,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = engineConfigEnvironmentName(engine);
  const value = source[name];
  if (value == null || value === "") return undefined;
  if (!isSafeEngineConfigDir(value)) {
    throw new Error(`${name} must be an absolute path no longer than 2000 characters`);
  }
  return value;
}

function isPrivateConfig(path: string): boolean {
  try {
    if (process.platform === "win32") return false;
    const stat = lstatSync(path);
    const mode = stat.mode & 0o777;
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    return stat.isFile() && owned && (mode & 0o077) === 0 && (mode & 0o400) !== 0;
  } catch {
    return false;
  }
}
