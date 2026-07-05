import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Thin typed wrapper over the hosted Engager MCP (streamable HTTP + bearer key).
 * This is the runner's NO-LLM data plane: preflight reads, discovery top-ups,
 * skill installs, post-session verification. Drafting never happens here — that
 * is the headless agent session's job.
 *
 * The shapes below are structural pick-outs of what the tools return — only the
 * fields the runner actually consumes, everything else passes through untyped.
 */

export type CampaignRow = {
  id: number;
  name: string;
  status: string;
  draftingMode: "agent" | "server";
  hourlyCommentCap: number;
  autoReply?: { enabled?: boolean } | null;
};

export type CampaignQueue = {
  campaignId: number;
  campaignName: string;
  draftingMode: "agent" | "server";
  pendingScheduled: number;
  proposedAwaitingApproval: number;
  dailyCapacity: number;
  runwayDays: number;
  recommendedBatchSize: number;
  needsRefill: boolean;
  candidatePool: { size: number; target: number; agingOutSoon: number; sufficient: boolean };
};

export type IncomingComment = {
  id: number;
  campaignId: number | null;
  commenterName: string | null;
  text: string;
  receivedAt: number;
  status: string;
};

export type RunnerDirective = {
  directive: "run" | "idle" | "stop";
  reason: string;
};

/** Heartbeat payload for report_runner_status (mirrors ~/.engager/status.json). */
export type HeartbeatPayload = {
  runnerId: string;
  state: string;
  hostname?: string;
  version?: string;
  campaignId?: number;
  intervalMinutes?: number;
  lastCycleAt?: number;
  lastOutcome?: { ran: boolean; ok: boolean; note: string };
  consecutiveFailures?: number;
  sessionsToday?: number;
  nextWakeAt?: number;
};

export type OpsSummary = {
  killSwitch: boolean;
  pausedReason: string | null;
  pausedUntil: number | null;
};

export type SkillManifestFile = { path: string; sha256: string };
export type SkillManifest = {
  name: string;
  version: string;
  files: SkillManifestFile[];
};

export class EngagerMcp {
  private client: Client | null = null;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } },
    });
    const client = new Client({ name: "engager-agent", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  /** Call a tool and parse its single JSON text payload; tool errors throw. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("not connected");
    const res = (await this.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`${name}: ${truncate(text, 400)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${name}: non-JSON tool response: ${truncate(text, 200)}`);
    }
  }

  listCampaigns(): Promise<CampaignRow[]> {
    return this.call<CampaignRow[]>("list_campaigns");
  }

  async campaignQueue(campaignId: number): Promise<CampaignQueue> {
    return this.call<CampaignQueue>("get_queue_status", { campaignId });
  }

  listIncoming(campaignId?: number): Promise<IncomingComment[]> {
    return this.call<IncomingComment[]>("list_incoming_comments", {
      status: "new",
      ...(campaignId != null ? { campaignId } : {}),
    });
  }

  /** Stateless page-1 top-up sweep (no LLM, no server drafting side effects). */
  discover(campaignId: number): Promise<unknown> {
    return this.call("discover", { campaignId });
  }

  /**
   * Heartbeat: upsert this runner's liveness row and get back the server's
   * control directive. The caller MUST obey it (run/idle/stop).
   */
  async reportStatus(hb: HeartbeatPayload): Promise<RunnerDirective> {
    const res = await this.call<{ directive: RunnerDirective["directive"]; reason: string }>(
      "report_runner_status",
      hb,
    );
    return { directive: res.directive, reason: res.reason };
  }

  /** Kill-switch / org-pause flags (fallback directive source for old servers). */
  opsSummary(): Promise<OpsSummary> {
    return this.call<OpsSummary>("get_ops_summary");
  }

  async skillManifests(): Promise<SkillManifest[]> {
    const res = await this.call<{ skills?: SkillManifest[] } | SkillManifest[]>("list_skills");
    return Array.isArray(res) ? res : (res.skills ?? []);
  }

  async skillManifest(name: string): Promise<SkillManifest | null> {
    return (await this.skillManifests()).find((s) => s.name === name) ?? null;
  }

  async skillFile(name: string, path: string): Promise<string> {
    if (!this.client) throw new Error("not connected");
    const res = (await this.client.callTool({ name: "get_skill_file", arguments: { name, path } })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`get_skill_file ${name}/${path}: ${truncate(text, 200)}`);
    return unwrapSkillFile(text, name, path);
  }
}

/**
 * The server's get_skill_file wraps the file as JSON {name, path, content}
 * (that's what jsonResult produces); accept a bare-text body too so a future
 * verbatim server also verifies. The unwrap is STRICT (name+path must echo the
 * request) so a skill file whose own content happens to be JSON with a
 * `content` field can never be mis-unwrapped. Discovered the hard way: sha256
 * verification failed on every fresh install because the CLI hashed the
 * envelope, not the file — invisible on machines where the skills already
 * existed with matching hashes (sync skips the download entirely).
 */
export function unwrapSkillFile(text: string, name: string, path: string): string {
  try {
    const parsed = JSON.parse(text) as { name?: unknown; path?: unknown; content?: unknown };
    if (parsed && parsed.name === name && parsed.path === path && typeof parsed.content === "string") {
      return parsed.content;
    }
  } catch {
    /* bare text */
  }
  return text;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
