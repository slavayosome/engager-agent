import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { desktopConfigPath, MCP_NAME, type DesktopConfig } from "./register.js";

/**
 * First-run endpoint detection: a normal user should never have to know an MCP
 * URL exists. Sources, in trust order — an entry that already carries a working
 * key beats one that doesn't, anything found on the machine beats the cloud
 * default, and manual entry is always the escape hatch:
 *
 *   1. Claude Desktop config  (mcp-remote bridge entry: URL + API key)
 *   2. Claude Code user config (~/.claude.json http entry: URL + key header)
 *   3. A local dev server     (probe localhost — only shown when it responds)
 *   4. The Engager Cloud default
 */

export const DEFAULT_CLOUD_URL = "https://mcp.getengager.com/mcp";
/** apps/mcp defaults to ENGAGER_MCP_HTTP_PORT=8788 in the monorepo. */
export const LOCAL_CANDIDATE_URLS = ["http://localhost:8788/mcp"];

export type EndpointSource = "saved-config" | "claude-desktop" | "claude-code" | "local-dev" | "cloud";

export type DetectedEndpoint = {
  url: string;
  /** Present when the source stores credentials we can reuse (skips the key prompt). */
  apiKey?: string;
  source: EndpointSource;
};

const BEARER = /^Authorization:\s*Bearer\s+(\S+)$/i;

/** Claude Desktop's mcp-remote bridge entry carries both URL and key in args. */
export function desktopEndpoint(config: DesktopConfig | null): DetectedEndpoint | null {
  const entry = config?.mcpServers?.[MCP_NAME];
  if (!entry) return null;
  const url = entry.args?.find((a) => /^https?:\/\//.test(a));
  if (!url) return null;
  const key = entry.args?.map((a) => BEARER.exec(a)?.[1]).find(Boolean);
  return { url, ...(key ? { apiKey: key } : {}), source: "claude-desktop" };
}

/** Claude Code stores user-scope http servers in ~/.claude.json. The shape is
 *  undocumented — parse defensively and treat any surprise as "not found". */
export function codeConfigEndpoint(json: unknown): DetectedEndpoint | null {
  try {
    const entry = (
      json as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }
    )?.mcpServers?.[MCP_NAME];
    if (!entry?.url || !/^https?:\/\//.test(entry.url)) return null;
    const auth = entry.headers?.["Authorization"] ?? entry.headers?.["authorization"];
    const key = auth ? /^Bearer\s+(\S+)$/i.exec(auth)?.[1] : undefined;
    return { url: entry.url, ...(key ? { apiKey: key } : {}), source: "claude-code" };
  } catch {
    return null;
  }
}

/** Any HTTP response (401 included — the server is fail-closed) means alive;
 *  connection refused/timeout means there is no local server to offer. */
export async function probeLocal(
  urls: string[] = LOCAL_CANDIDATE_URLS,
): Promise<DetectedEndpoint | null> {
  for (const url of urls) {
    try {
      await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1500) });
      return { url, source: "local-dev" };
    } catch (e) {
      // AbortError/TypeError(fetch failed) = nothing listening; anything that
      // produced an HTTP response would have resolved above.
      void e;
    }
  }
  return null;
}

/** Ordered, URL-deduped options for the wizard select. Keyed entries win the
 *  dedupe so a Desktop entry with a key beats a Code entry without one. */
export function buildEndpointOptions(found: (DetectedEndpoint | null)[]): DetectedEndpoint[] {
  const withDefault: DetectedEndpoint[] = [
    ...found.filter((f): f is DetectedEndpoint => f != null),
    { url: DEFAULT_CLOUD_URL, source: "cloud" },
  ];
  const byUrl = new Map<string, DetectedEndpoint>();
  for (const e of withDefault) {
    const prev = byUrl.get(e.url);
    if (!prev || (!prev.apiKey && e.apiKey)) byUrl.set(e.url, prev ? { ...e } : e);
  }
  return [...byUrl.values()].sort((a, b) => rank(a) - rank(b));
}

const rank = (e: DetectedEndpoint): number =>
  e.source === "saved-config" ? 0 : e.apiKey ? 1 : e.source === "cloud" ? 3 : 2;

export function describeSource(e: DetectedEndpoint): string {
  switch (e.source) {
    case "saved-config":
      return "current config";
    case "claude-desktop":
      return "found in Claude Desktop";
    case "claude-code":
      return "found in Claude Code";
    case "local-dev":
      return "local dev server";
    case "cloud":
      return "Engager Cloud";
  }
}

/** Gather every detectable endpoint on this machine (never throws). */
export async function detectEndpoints(existing?: {
  mcpUrl?: string;
  apiKey?: string;
}): Promise<DetectedEndpoint[]> {
  const found: (DetectedEndpoint | null)[] = [];
  if (existing?.mcpUrl) {
    found.push({
      url: existing.mcpUrl,
      ...(existing.apiKey ? { apiKey: existing.apiKey } : {}),
      source: "saved-config",
    });
  }
  try {
    const path = desktopConfigPath();
    if (path && existsSync(path)) {
      found.push(desktopEndpoint(JSON.parse(readFileSync(path, "utf8")) as DesktopConfig));
    }
  } catch {
    /* unreadable Desktop config → skip source */
  }
  try {
    const codePath = join(homedir(), ".claude.json");
    if (existsSync(codePath)) {
      found.push(codeConfigEndpoint(JSON.parse(readFileSync(codePath, "utf8"))));
    }
  } catch {
    /* unreadable Code config → skip source */
  }
  found.push(await probeLocal());
  return buildEndpointOptions(found);
}
