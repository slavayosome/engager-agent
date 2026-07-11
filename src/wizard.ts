import * as p from "@clack/prompts";
import {
  CONFIG_DEFAULTS,
  createRunnerId,
  engineConfigDirFromEnvironment,
  engineConfigEnvironmentName,
  isSafeEngineConfigDir,
  isSafeMcpUrl,
  isValidRunnerId,
  loadConfig,
  saveConfig,
  savePartialConfig,
  type AgentConfig,
  type PendingDeviceAck,
} from "./config.js";
import { describeSource, detectEndpoints, type DetectedEndpoint } from "./detect.js";
import {
  acknowledgeDeviceGrant,
  isValidSetupProofOrganizationId,
  openBrowser,
  pollForKey,
  startDeviceFlow,
  type DeviceApprovedGrant,
  type DeviceStart,
} from "./deviceauth.js";
import { engineFor } from "./engines/index.js";
import type { EngineDetection, EngineName } from "./engine.js";
import { asRunnerFault, formatRunnerFault, sanitizeTerminalText } from "./errors.js";
import type { ExecutionOutcome } from "./executor.js";
import { runControlCycle } from "./loop.js";
import { prepareSetupJournal } from "./journal.js";
import { acquireRunnerLock } from "./lock.js";
import { EngagerMcp } from "./mcp.js";
import { installService } from "./service.js";
import { AGENT_VERSION } from "./version.js";
import { providerSessionsToday } from "./session-usage.js";

export async function runWizard(
  existing?: Partial<AgentConfig> & { pendingDeviceAck?: PendingDeviceAck },
  options: {
    reauthorize?: boolean;
    setupProofOrganizationId?: string;
  } = {},
): Promise<AgentConfig | null> {
  p.intro("engager-agent setup — private Claude/Codex executor");
  if (process.platform === "win32") {
    p.log.error(
      "Windows setup is disabled in 0.9: private credential ACLs and descendant-process termination are not yet certified.",
    );
    p.outro("No Engager credential was requested or stored. Use macOS or Linux for this release.");
    return null;
  }
  if (
    options.setupProofOrganizationId !== undefined &&
    !isValidSetupProofOrganizationId(options.setupProofOrganizationId)
  ) {
    p.log.error("The setup-proof project id is not a valid UUID.");
    p.outro("No Engager credential was requested or stored.");
    return null;
  }
  if (existing?.pendingDeviceAck) {
    const pending = existing.pendingDeviceAck;
    if (!existing.mcpUrl || !existing.apiKey) {
      const { pendingDeviceAck: _pending, apiKey: _key, ...rest } = existing;
      savePartialConfig(rest);
      existing = rest;
      p.log.warn("Discarded an incomplete device-delivery record that carried no persisted key.");
    } else {
      const recovery = p.spinner();
      recovery.start("Recovering the persisted runner-key delivery ACK…");
      let status: "acknowledged" | "expired" | "not_found";
      try {
        status = await acknowledgeDeviceGrant(existing.mcpUrl, pending);
      } catch (error) {
        recovery.stop("Runner-key delivery ACK is still pending.");
        p.log.error(error instanceof Error ? error.message : String(error));
        p.outro("The temporary key and ACK token remain private on disk. Rerun setup when the endpoint is reachable.");
        return null;
      }
      if (status === "acknowledged") {
        const { pendingDeviceAck: _pending, ...finalized } = existing;
        savePartialConfig(finalized);
        const loaded = loadConfig();
        if (!loaded) {
          savePartialConfig(existing);
          recovery.stop("ACK succeeded, but the saved runner configuration is incomplete.");
          p.outro("Repair the private setup state and rerun setup; the ACK is idempotent.");
          return null;
        }
        existing = loaded;
        recovery.stop("Recovered and acknowledged the persisted runner credential.");
      } else {
        const { pendingDeviceAck: _pending, apiKey: _key, ...rest } = existing;
        savePartialConfig(rest);
        existing = rest;
        recovery.stop("The temporary key delivery expired before ACK; requesting a fresh code.");
      }
    }
  }
  const { engineConfigDirs, detections } = await detectSetupEngines(existing);
  const choices = detections
    .filter((detection) => detection.installed && detection.supported)
    .map((detection) => ({
      value: detection.name,
      label: `${detection.name} ${detection.version ?? ""} — ${
        detection.authenticated === true
          ? "authenticated"
          : detection.authenticated === false
            ? "authentication required"
            : detection.detail ?? "auth status unknown"
      }`,
    }));
  if (choices.length === 0) {
    p.log.error("No supported local engine was found. Install Claude Code or Codex CLI, authenticate it, then rerun setup.");
    p.outro("Setup stopped before requesting any Engager credential.");
    return null;
  }
  const engine = must(
    await p.select({
      message: "Which subscription-backed engine should execute frozen work orders?",
      options: choices,
      initialValue:
        choices.some((choice) => choice.value === existing?.engine)
          ? existing!.engine
          : choices[0]!.value,
    }),
  ) as "claude" | "codex";
  const selected = detections.find((detection) => detection.name === engine)!;
  if (!selected.supported || selected.authenticated !== true) {
    p.log.error(
      selected.detail ??
        `${engine} is installed but not authenticated. Authenticate it, then run \`engager-agent doctor\`.`,
    );
    p.outro("Setup did not request a runner credential.");
    return null;
  }

  const runnerId = isValidRunnerId(existing?.runnerId) ? existing.runnerId : createRunnerId();
  const setupLock = acquireRunnerLock(runnerId);
  try {
    const recovery = prepareSetupJournal();
    if (recovery.state === "blocked") {
      p.log.error(
        recovery.reason === "invalid"
          ? "Setup cannot prove whether active-work.json still carries live lease authority because it is corrupt, unsafe, or was claimed under an untrusted clock."
          : "Setup cannot replace the endpoint, credential, or engine while a leased recovery journal is still live.",
      );
      p.outro(
        recovery.reason === "active"
          ? `Restore the existing credential and run once, or wait until ${new Date(recovery.terminalAt!).toISOString()} then rerun setup --reauthorize.`
          : "Run `engager-agent doctor`; correct clock/permissions, preserve the journal, and reconcile it with the original credential.",
      );
      return null;
    }
    if (recovery.state === "quarantined") {
      p.log.warn(
        "The prior work order is past its hard expiry plus clock-skew margin; its private journal was quarantined before credential rotation.",
      );
    }
  const replacingCredential = Boolean(
    existing?.apiKey &&
      (options.reauthorize || options.setupProofOrganizationId),
  );
  if (replacingCredential && existing?.apiKey) {
    p.note(
      options.setupProofOrganizationId
        ? "This protected setup needs a project- and purpose-bound owner approval. Revoke the current general runner credential in Engager Settings before continuing; setup cannot upgrade or revoke it with runner:execute authority."
        : "Engager permits one active runner credential per runner identity. Revoke the old credential in Engager Settings before continuing; setup cannot revoke it with runner:execute authority.",
      "Credential rotation",
    );
    const revoked = must(
      await p.confirm({
        message: "Have you revoked the old runner credential in Engager Settings?",
        initialValue: false,
      }),
    );
    if (!revoked) {
      p.outro(
        options.setupProofOrganizationId
          ? "No credential was changed. Revoke the old key, then rerun the protected setup command."
          : "No credential was changed. Revoke the old key, then rerun setup --reauthorize.",
      );
      return null;
    }
  }
  const spinner = p.spinner();
  spinner.start("Looking for Engager endpoints…");
  const detected = await detectEndpoints(existing);
  spinner.stop("Endpoint discovery complete.");

  let mcpUrl = "";
  let apiKey = "";
  let connected = false;
  let pendingGrant: DeviceApprovedGrant | null = null;
  const rejectedKeys = new Set<string>();
  while (!connected) {
    const manual = -1;
    const choice = must(
      await p.select({
        message: "Which Engager should this runner connect to?",
        options: [
          ...detected.map((endpoint, index) => ({
            value: index,
            label: `${endpoint.url} — ${describeSource(endpoint)}${
              endpoint.apiKey &&
              !replacingCredential &&
              !options.setupProofOrganizationId &&
              !rejectedKeys.has(endpoint.apiKey)
                ? " (dedicated key found)"
                : ""
            }`,
          })),
          { value: manual, label: "Other — enter a URL" },
        ],
      }),
    ) as number;
    let endpoint: DetectedEndpoint | null = choice === manual ? null : (detected[choice] ?? null);
    if (!endpoint) {
      const url = must(
        await p.text({
          message: "Engager MCP endpoint",
          placeholder: "https://your-engager.example/mcp",
          initialValue: existing?.mcpUrl ?? "",
          validate: (value) => {
            try {
              new URL(value);
              return isSafeMcpUrl(value)
                ? undefined
                : "Use HTTPS; HTTP is allowed only for localhost development.";
            } catch {
              return "Enter a full MCP URL.";
            }
          },
        }),
      );
      endpoint = { url, source: "cloud" };
    }
    mcpUrl = endpoint.url;
    pendingGrant = null;
    if (
      endpoint.apiKey &&
      !replacingCredential &&
      !options.setupProofOrganizationId &&
      !rejectedKeys.has(endpoint.apiKey)
    ) {
      apiKey = endpoint.apiKey;
    } else {
      pendingGrant = await acquireKey(
        mcpUrl,
        runnerId,
        options.setupProofOrganizationId,
      );
      apiKey = pendingGrant.apiKey;
    }
    // Persist a newly minted token before the first post-authorization network
    // check. A transient outage must not lose the only plaintext copy or force
    // a conflicting second credential for the same runner identity.
    const provisionalConfig: AgentConfig = {
      configVersion: 2,
      mcpUrl,
      apiKey,
      credentialProfile: "runner",
      runnerId,
      engine,
      enginePath: selected.executablePath!,
      ...(engineConfigDirs[engine]
        ? { engineConfigDir: engineConfigDirs[engine] }
        : {}),
      ...(existing?.model ? { model: existing.model } : engine === "claude" ? { model: CONFIG_DEFAULTS.model } : {}),
      maxTurns: CONFIG_DEFAULTS.maxTurns,
      dailySessionCap: existing?.dailySessionCap ?? CONFIG_DEFAULTS.dailySessionCap,
      sessionTimeoutMinutes:
        existing?.sessionTimeoutMinutes ?? CONFIG_DEFAULTS.sessionTimeoutMinutes,
      ...(existing?.legacy ? { legacy: existing.legacy } : {}),
    };
    if (pendingGrant) {
      const pendingDeviceAck: PendingDeviceAck = {
        deviceCode: pendingGrant.deviceCode,
        ackToken: pendingGrant.ackToken,
        deliveryExpiresAt: pendingGrant.deliveryExpiresAt,
      };
      // The temporary key and ACK authority are committed in one private file.
      // A crash before ACK makes loadConfig fail closed and setup replays ACK.
      savePartialConfig({ ...provisionalConfig, pendingDeviceAck });
      let ackStatus: "acknowledged" | "expired" | "not_found";
      try {
        ackStatus = await acknowledgeDeviceGrant(mcpUrl, pendingGrant);
      } catch (error) {
        p.outro(
          `Credential persisted but ACK is pending: ${error instanceof Error ? error.message : String(error)}. Rerun setup to recover it.`,
        );
        return null;
      }
      if (ackStatus !== "acknowledged") {
        const { apiKey: _key, ...withoutKey } = provisionalConfig;
        savePartialConfig(withoutKey);
        p.outro(`Credential delivery ${ackStatus}; rerun setup to request a fresh code.`);
        return null;
      }
      pendingGrant = null;
    }
    saveConfig(provisionalConfig);
    for (;;) {
      const check = p.spinner();
      check.start("Verifying the dedicated runner credential…");
      const mcp = new EngagerMcp(mcpUrl, apiKey, AGENT_VERSION);
      try {
        const surface = await mcp.connect();
        check.stop(
          surface === "v2"
            ? "Connected to the leased v2.1 runner surface."
            : "Connected to the version-negotiation surface.",
        );
        connected = true;
        break;
      } catch (error) {
        const fault = asRunnerFault(error);
        check.stop(`Connection check failed: ${fault.message}`);
        if (fault.code === "AUTH_REVOKED") {
          rejectedKeys.add(apiKey);
          break;
        }
        p.log.warn("The dedicated credential was saved safely; it will not be replaced for a network outage.");
        const retry = must(
          await p.confirm({
            message: "Retry the same credential now?",
            initialValue: true,
          }),
        );
        if (!retry) {
          p.outro("Credential preserved. Rerun setup when the endpoint is reachable.");
          return null;
        }
      } finally {
        await mcp.close();
      }
    }
  }

  const model = await selectModel(engine, existing?.model);
  const config: AgentConfig = {
    configVersion: 2,
    mcpUrl,
    apiKey,
    credentialProfile: "runner",
    runnerId,
    engine,
    enginePath: selected.executablePath!,
    ...(engineConfigDirs[engine]
      ? { engineConfigDir: engineConfigDirs[engine] }
      : {}),
    ...(model ? { model } : {}),
    maxTurns: CONFIG_DEFAULTS.maxTurns,
    dailySessionCap: existing?.dailySessionCap ?? CONFIG_DEFAULTS.dailySessionCap,
    sessionTimeoutMinutes:
      existing?.sessionTimeoutMinutes ?? CONFIG_DEFAULTS.sessionTimeoutMinutes,
    ...(existing?.legacy ? { legacy: existing.legacy } : {}),
  };
  saveConfig(config);
  p.log.success("Saved organization-level runner configuration at ~/.engager/agent.json (0600).");
  p.note(
    "The model receives frozen context only. It gets no Engager key, MCP, shell, files, browser, web search, plugins, or lease token. Engager does not meter agent drafting; your Claude/Codex provider limits and charges still apply.",
    "Execution boundary",
  );

  const prove = must(
    await p.confirm({
      message: "Claim and execute at most one server-authored proof work order now?",
      initialValue: true,
    }),
  );
  let proofAccepted = false;
  if (prove) {
    try {
      const result = await runControlCycle(config, AGENT_VERSION, {
        state: "preflight",
        consecutiveFailures: 0,
        sessionsToday: providerSessionsToday(),
      }, { claimPurpose: "setup_proof" });
      proofAccepted = isAcceptedSetupProof(result.outcome);
      if (proofAccepted) p.log.success(`Proof accepted — ${result.outcome.note}`);
      else p.log.warn(`No accepted proof yet — ${result.outcome.note}`);
    } catch (error) {
      p.log.error(formatRunnerFault(error));
    }
  }

  if (proofAccepted && process.platform === "darwin") {
    const install = must(
      await p.confirm({
        message: "Install the verified versioned runner as a background service?",
        initialValue: true,
      }),
    );
    if (install) {
      const result = installService(AGENT_VERSION);
      result.ok ? p.log.success(result.note) : p.log.error(result.note);
    }
  } else if (!proofAccepted) {
    p.note(
      "Configuration is saved, but the background service was not armed without an accepted proof receipt.\nRun `engager-agent doctor`, then `engager-agent run --once`.",
      "Not armed yet",
    );
  }
  p.outro("Setup complete. Bare `engager-agent` shows status; it never starts work.");
  return config;
  } finally {
    setupLock.release();
  }
}

type SetupEngineConfigResolution = {
  configDir?: string;
  error?: string;
};

/** Resolve and probe each provider independently. A malformed override for an
 * unselected provider must not prevent setup with a healthy provider. */
export async function detectSetupEngines(
  existing?: Pick<Partial<AgentConfig>, "engine" | "engineConfigDir">,
  source: NodeJS.ProcessEnv = process.env,
  factory: typeof engineFor = engineFor,
): Promise<{
  engineConfigDirs: Partial<Record<EngineName, string>>;
  detections: EngineDetection[];
}> {
  const claude = resolveSetupEngineConfigDir("claude", existing, source);
  const codex = resolveSetupEngineConfigDir("codex", existing, source);
  const engineConfigDirs: Partial<Record<EngineName, string>> = {
    ...(claude.configDir ? { claude: claude.configDir } : {}),
    ...(codex.configDir ? { codex: codex.configDir } : {}),
  };
  const detect = async (
    engine: EngineName,
    resolution: SetupEngineConfigResolution,
  ): Promise<EngineDetection> => {
    if (resolution.error) {
      return {
        name: engine,
        installed: true,
        supported: false,
        authenticated: null,
        detail: resolution.error,
      };
    }
    try {
      return await factory(engine, undefined, resolution.configDir).detect();
    } catch (error) {
      return {
        name: engine,
        installed: true,
        supported: false,
        authenticated: null,
        detail: `${engine} probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const detections = await Promise.all([
    detect("claude", claude),
    detect("codex", codex),
  ]);
  return { engineConfigDirs, detections };
}

function resolveSetupEngineConfigDir(
  engine: EngineName,
  existing: Pick<Partial<AgentConfig>, "engine" | "engineConfigDir"> | undefined,
  source: NodeJS.ProcessEnv,
): SetupEngineConfigResolution {
  try {
    const environmentConfigDir = engineConfigDirFromEnvironment(engine, source);
    const persistedConfigDir =
      existing?.engine === engine ? existing.engineConfigDir : undefined;
    if (
      environmentConfigDir === undefined &&
      persistedConfigDir !== undefined &&
      !isSafeEngineConfigDir(persistedConfigDir)
    ) {
      throw new Error(
        `persisted ${engineConfigEnvironmentName(engine)} must be an absolute path no longer than 2000 characters`,
      );
    }
    const configDir = environmentConfigDir ?? persistedConfigDir;
    return configDir ? { configDir } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function isAcceptedSetupProof(outcome: ExecutionOutcome): boolean {
  return (
    outcome.ran &&
    outcome.ok &&
    outcome.workPurpose === "setup_proof" &&
    outcome.completion?.status === "completed" &&
    outcome.completion.result.unfinished === 0 &&
    outcome.completion.result.failed === 0
  );
}

async function selectModel(engine: "claude" | "codex", existing?: string): Promise<string | undefined> {
  if (engine === "codex") {
    const useDefault = must(
      await p.confirm({
        message: "Use the Codex provider default model (recommended and upgrade-safe)?",
        initialValue: existing == null,
      }),
    );
    if (useDefault) return undefined;
    const custom = must(
      await p.text({
        message: "Explicit Codex model ID",
        initialValue: existing ?? "",
        validate: (value) => (value.trim() ? undefined : "Enter a model ID or choose the provider default."),
      }),
    );
    return custom.trim();
  }
  return must(
    await p.select({
      message: "Claude model",
      initialValue: existing ?? CONFIG_DEFAULTS.model,
      options: [
        { value: "sonnet", label: "sonnet — recommended" },
        { value: "opus", label: "opus — highest quality" },
        { value: "haiku", label: "haiku — lowest allowance use" },
      ],
    }),
  ) as string;
}

async function acquireKey(
  mcpUrl: string,
  runnerId: string,
  setupProofOrganizationId?: string,
): Promise<DeviceApprovedGrant> {
  const spinner = p.spinner();
  spinner.start("Requesting a least-privilege runner sign-in code…");
  let start: DeviceStart;
  try {
    start = await startDeviceFlow(mcpUrl, runnerId, {
      setupProofOrganizationId,
    });
  spinner.stop(`Code ${sanitizeTerminalText(start.userCode)}`);
  } catch (error) {
    spinner.stop("Runner sign-in could not start.");
    throw new Error(
      error instanceof Error && "code" in error
        ? `${String(error.code)}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error },
    );
  }
  p.note(`Confirm this code in your browser, then approve runner:execute only:\n${start.verificationUrl}`);
  openBrowser(start.verificationUrl);
  const wait = p.spinner();
  wait.start("Waiting for browser approval…");
  const result = await pollForKey(mcpUrl, start);
  if (result.outcome === "approved") {
    wait.stop("Dedicated runner credential delivered; persisting before ACK.");
    return {
      apiKey: result.apiKey,
      deviceCode: result.deviceCode,
      ackToken: result.ackToken,
      deliveryExpiresAt: result.deliveryExpiresAt,
    };
  }
  wait.stop(`Authorization did not complete: ${result.note}`);
  throw new Error(`runner authorization failed: ${result.note}`);
}

function must<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  return value as T;
}
