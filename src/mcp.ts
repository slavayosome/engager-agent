import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DraftReceiptSchema,
  ReplyReceiptSchema,
  RunnerClaimInputSchema,
  RunnerClaimResponseSchema,
  RunnerCompleteWorkInputSchema,
  RunnerCompletionResponseSchema,
  RunnerErrorEnvelopeSchema,
  RunnerHeartbeatInputSchema,
  RunnerLeaseInputSchema,
  RunnerLeaseResponseSchema,
  RunnerSubmitBatchInputSchema,
  RunnerSubmitRepliesInputSchema,
  RunnerSubmitTriageInputSchema,
  RunnerValidateBatchInputSchema,
  RunnerValidateBatchResponseSchema,
  RunnerWorkContextInputSchema,
  RunnerWorkContextResponseSchema,
  TriageReceiptSchema,
  type DraftReceipt,
  type ReplyReceipt,
  type RunnerClaimInput,
  type RunnerClaimResponse,
  type RunnerCompleteWorkInput,
  type RunnerCompletionResponse,
  type RunnerErrorEnvelope,
  type RunnerHeartbeatInput,
  type RunnerLeaseInput,
  type RunnerLeaseResponse,
  type RunnerSubmitBatchInput,
  type RunnerSubmitRepliesInput,
  type RunnerSubmitTriageInput,
  type RunnerValidateBatchInput,
  type RunnerValidateBatchResponse,
  type RunnerWorkContextInput,
  type RunnerWorkContextResponse,
  type TriageReceipt,
} from "@engager/runner-contract";
import { RunnerFault, redact, sanitizeTerminalText } from "./errors.js";
import { isSafeMcpUrl } from "./config.js";
import { boundedFetch } from "./http.js";
import {
  RUNNER_SETUP_PROOF_TOOL_NAMES,
  classifyRunnerSurface,
  isV2RunnerSurface,
  parseNegotiatedDirective,
  type NegotiatedDirective,
  type RunnerSurface,
} from "./protocol.js";

type CallResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

export type RunnerMcpSession = {
  connect(options?: McpRequestOptions): Promise<void>;
  close(): Promise<void>;
  listTools(options?: McpRequestOptions): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: McpRequestOptions,
  ): Promise<unknown>;
};

type McpRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
  maxTotalTimeout?: number;
};

export type RunnerMcpSessionFactory = () => RunnerMcpSession;

export class EngagerMcp {
  private client: RunnerMcpSession | null = null;
  private surfaceValue: RunnerSurface | null = null;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly runnerVersion = "0",
    private readonly sessionFactory: RunnerMcpSessionFactory = () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } },
        fetch: boundedFetch,
      });
      const client = new Client({ name: "engager-agent", version: this.runnerVersion });
      return {
        connect: (options) => client.connect(transport, options),
        close: () => client.close(),
        listTools: (options) => client.listTools(undefined, options),
        callTool: (input, options) => client.callTool(input, undefined, options),
      };
    },
    private readonly signal?: AbortSignal,
  ) {
    if (!isSafeMcpUrl(url)) {
      throw new RunnerFault("RUNNER_NOT_CONFIGURED", "Engager endpoint must use HTTPS", {
        impact: "The runner credential was not sent over an unsafe transport.",
        recovery: "Use an HTTPS endpoint; HTTP is allowed only for localhost development.",
      });
    }
  }

  get surface(): RunnerSurface | null {
    return this.surfaceValue;
  }

  async connect(): Promise<RunnerSurface> {
    if (this.client) return this.surfaceValue!;
    const client = this.sessionFactory();
    try {
      await client.connect(this.requestOptions(20_000));
      const tools = await client.listTools(this.requestOptions(20_000));
      this.surfaceValue = classifyRunnerSurface(tools.tools.map((tool) => tool.name));
      this.client = client;
      return this.surfaceValue;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw transportFault(error, [this.apiKey]);
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.surfaceValue = null;
  }

  async reconnect(): Promise<RunnerSurface> {
    await this.close();
    return this.connect();
  }

  /**
   * A cohort runner first sees bootstrap tools. The heartbeat persists v2.1
   * capability; registration is immutable for that server instance, so close
   * and reconnect before any claim.
   */
  async negotiate(heartbeat: RunnerHeartbeatInput): Promise<NegotiatedDirective> {
    RunnerHeartbeatInputSchema.parse(heartbeat);
    await this.connect();
    const negotiated = parseNegotiatedDirective(
      await this.callJson("report_runner_status", heartbeat as unknown as Record<string, unknown>),
    );
    if (negotiated.protocol === "2.1" && !isV2RunnerSurface(this.surfaceValue)) {
      const surface = await this.reconnect();
      if (!isV2RunnerSurface(surface)) {
        throw new RunnerFault(
          "CONTRACT_UPGRADE_REQUIRED",
          "server accepted protocol 2.1 but did not expose the leased runner surface",
          {
            impact: "No unattended work was claimed.",
            recovery: "Run `engager-agent doctor`; reconnect or upgrade the server before retrying.",
          },
        );
      }
    }
    if (negotiated.protocol === "v1" && this.surfaceValue !== "v1-or-bootstrap") {
      throw new RunnerFault("CONTRACT_UPGRADE_REQUIRED", "legacy directive arrived on a v2 tool surface", {
        impact: "The protocol transition was not trusted, so the runner stayed idle.",
        recovery: "Run `engager-agent doctor` and verify the organization rollout state.",
      });
    }
    return negotiated;
  }

  async claim(input: RunnerClaimInput): Promise<RunnerClaimResponse> {
    return parseContractResponse(
      "claim_runner_work",
      RunnerClaimResponseSchema,
      await this.v2Call("claim_runner_work", RunnerClaimInputSchema.parse(input)),
    );
  }

  async renewLease(input: RunnerLeaseInput): Promise<RunnerLeaseResponse> {
    return parseContractResponse(
      "renew_runner_lease",
      RunnerLeaseResponseSchema,
      await this.v2Call("renew_runner_lease", RunnerLeaseInputSchema.parse(input)),
    );
  }

  async workContext(input: RunnerWorkContextInput): Promise<RunnerWorkContextResponse> {
    return parseContractResponse(
      "get_runner_work_context",
      RunnerWorkContextResponseSchema,
      await this.v2Call("get_runner_work_context", RunnerWorkContextInputSchema.parse(input)),
    );
  }

  async validateBatch(input: RunnerValidateBatchInput): Promise<RunnerValidateBatchResponse> {
    return parseContractResponse(
      "runner_validate_batch",
      RunnerValidateBatchResponseSchema,
      await this.v2Call("runner_validate_batch", RunnerValidateBatchInputSchema.parse(input)),
    );
  }

  async submitTriage(input: RunnerSubmitTriageInput): Promise<TriageReceipt> {
    return parseContractResponse(
      "runner_submit_triage",
      TriageReceiptSchema,
      await this.v2Call("runner_submit_triage", RunnerSubmitTriageInputSchema.parse(input)),
    );
  }

  async submitBatch(input: RunnerSubmitBatchInput): Promise<DraftReceipt> {
    return parseContractResponse(
      "runner_submit_batch",
      DraftReceiptSchema,
      await this.v2Call("runner_submit_batch", RunnerSubmitBatchInputSchema.parse(input)),
    );
  }

  async submitReplies(input: RunnerSubmitRepliesInput): Promise<ReplyReceipt> {
    return parseContractResponse(
      "runner_submit_replies",
      ReplyReceiptSchema,
      await this.v2Call("runner_submit_replies", RunnerSubmitRepliesInputSchema.parse(input)),
    );
  }

  async complete(input: RunnerCompleteWorkInput): Promise<RunnerCompletionResponse> {
    return parseContractResponse(
      "complete_runner_work",
      RunnerCompletionResponseSchema,
      await this.v2Call("complete_runner_work", RunnerCompleteWorkInputSchema.parse(input)),
    );
  }

  private async v2Call(name: string, input: object): Promise<unknown> {
    if (!isV2RunnerSurface(this.surfaceValue)) {
      throw new RunnerFault("CONTRACT_UPGRADE_REQUIRED", `${name} requires the v2.1 runner surface`, {
        impact: "No runner mutation was attempted.",
        recovery: "Negotiate protocol 2.1 and reconnect before claiming work.",
      });
    }
    if (
      this.surfaceValue === "v2-setup-proof" &&
      !(RUNNER_SETUP_PROOF_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      throw new RunnerFault(
        "CONTRACT_UPGRADE_REQUIRED",
        `${name} is outside the purpose-bound setup-proof surface`,
        {
          impact: "No production drafting or reply operation was attempted.",
          recovery:
            "Finish the exact setup proof first; reconnect only after Engager accepts it.",
        },
      );
    }
    return this.callJson(name, input as Record<string, unknown>);
  }

  private async callJson<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const text = await this.callText(name, args);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new RunnerFault("VALIDATION_REJECTED", `${name} returned non-JSON data`, {
        impact: "The response was discarded before it could influence runner state.",
        recovery: "Upgrade the server/runner contract pair, then retry.",
        cause: error,
      });
    }
  }

  private async callText(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client is not connected");
    const secrets = requestSecrets(this.apiKey, args);
    let response: CallResult;
    try {
      response = (await this.client.callTool(
        { name, arguments: args },
        this.requestOptions(name === "renew_runner_lease" ? 10_000 : 30_000),
      )) as CallResult;
    } catch (error) {
      throw transportFault(error, secrets);
    }
    const text = response.content?.find((part) => part.type === "text")?.text ?? "";
    if (!response.isError) return text;
    let envelope: RunnerErrorEnvelope | null = null;
    try {
      envelope = RunnerErrorEnvelopeSchema.parse(JSON.parse(text));
    } catch {
      /* v1/plain SDK error */
    }
    if (envelope) throw remoteFault(envelope, secrets);
    throw transportFault(new Error(`${name}: ${text.slice(0, 500)}`), secrets);
  }

  private requestOptions(timeout: number): McpRequestOptions {
    return {
      ...(this.signal ? { signal: this.signal } : {}),
      timeout,
      maxTotalTimeout: timeout,
    };
  }
}

function parseContractResponse<T>(
  operation: string,
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new RunnerFault("VALIDATION_REJECTED", `${operation} returned data outside the runner contract`, {
      impact: "The response was discarded before it could alter local or server completion state.",
      recovery: "Upgrade the server/runner contract pair and report the operation reference.",
      cause: error,
    });
  }
}

function remoteFault(
  error: RunnerErrorEnvelope,
  secrets: readonly (string | undefined)[],
): RunnerFault {
  const leaseCodes = new Set([
    "work_order_not_found",
    "work_order_not_claimed",
    "work_order_terminal",
    "wrong_runner",
    "invalid_lease",
    "lease_expired",
    "work_order_expired",
    "control_state_changed",
    "subscription_inactive",
  ]);
  const validationCodes = new Set([
    "context_revision_mismatch",
    "context_required",
    "context_too_large",
    "wrong_lane",
    "item_out_of_scope",
    "idempotency_conflict",
    "stale_item",
    "invalid_submission",
  ]);
  const code =
    error.code === "runner_upgrade_required" || error.code === "runner_v2_disabled"
      ? "CONTRACT_UPGRADE_REQUIRED"
      : leaseCodes.has(error.code)
        ? "LEASE_LOST"
        : validationCodes.has(error.code)
          ? "VALIDATION_REJECTED"
          : error.status === 401 || error.status === 403 || error.code === "runner_identity_mismatch"
            ? "AUTH_REVOKED"
            : "INTERNAL_ERROR";
  return new RunnerFault(code, sanitizeTerminalText(redact(error.error, secrets)), {
    impact:
      code === "LEASE_LOST"
        ? "The current result was not accepted; the runner will not resubmit it under a new lease."
        : "The runner stopped before an unverified mutation could be accepted.",
    recovery:
      (error.recovery ? sanitizeTerminalText(redact(error.recovery, secrets)) : undefined) ??
      (code === "AUTH_REVOKED"
        ? "Run `engager-agent setup --reauthorize`."
        : "Run `engager-agent doctor`, then retry the same safe operation."),
    retryable: error.retryable,
    reference: error.reference
      ? sanitizeTerminalText(redact(error.reference, secrets))
      : undefined,
    remoteCode: error.code,
    discardJournal: validationCodes.has(error.code),
  });
}

function transportFault(
  error: unknown,
  secrets: readonly (string | undefined)[],
): RunnerFault {
  if (error instanceof RunnerFault) return error;
  const raw = redact(error instanceof Error ? error.message : String(error), secrets);
  const auth = /\b(401|403|unauthori[sz]ed|forbidden|invalid.*(?:key|token))\b/i.test(raw);
  const safe = sanitizeTerminalText(raw) || "MCP request failed";
  return new RunnerFault(auth ? "AUTH_REVOKED" : "SERVER_UNREACHABLE", safe, {
    impact: "No new work was claimed and no local fallback was run.",
    recovery: auth
      ? "Run `engager-agent setup --reauthorize`."
      : "Check the server URL and network with `engager-agent doctor`; retry after connectivity returns.",
    retryable: !auth,
    cause: error,
  });
}

function requestSecrets(
  apiKey: string,
  args: Record<string, unknown>,
): readonly (string | undefined)[] {
  return [apiKey, typeof args.leaseToken === "string" ? args.leaseToken : undefined];
}
