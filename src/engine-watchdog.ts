import { asRunnerFault } from "./errors.js";
import {
  runEngineProcessDirect,
  type ProcessResult,
  type ProcessSpec,
} from "./engine.js";

type StartMessage = {
  type: "start";
  spec: Omit<ProcessSpec, "signal" | "watchdogPath" | "onSpawn">;
};

const controller = new AbortController();
let started = false;
let finished = false;
let spawnAck: { pid: number; resolve: () => void; reject: () => void } | null = null;

process.on("disconnect", () => {
  controller.abort();
  if (!started) process.exit(0);
});
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
process.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message != null &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).type === "abort"
  ) {
    controller.abort();
    if (!started) process.exit(0);
    return;
  }
  if (
    typeof message === "object" &&
    message != null &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).type === "spawn_ack" &&
    typeof (message as Record<string, unknown>).pid === "number"
  ) {
    const pid = Number((message as Record<string, unknown>).pid);
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

async function run(spec: StartMessage["spec"]): Promise<void> {
  try {
    const result = await runEngineProcessDirect({
      ...spec,
      signal: controller.signal,
      onSpawn: (pid) =>
        new Promise<void>((resolve, reject) => {
          spawnAck = { pid, resolve, reject };
          send({ type: "started", pid });
          if (controller.signal.aborted) reject();
          else controller.signal.addEventListener("abort", reject, { once: true });
        }),
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
        engineAttempted: fault.engineAttempted,
      },
    });
  }
}

function finish(message: { type: "result"; result: ProcessResult } | { type: "fault"; fault: object }): void {
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

function send(message: object): void {
  if (process.connected) process.send?.(message);
}

function isStartMessage(value: unknown): value is StartMessage {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const spec = message.spec;
  if (message.type !== "start" || typeof spec !== "object" || spec == null || Array.isArray(spec)) return false;
  const candidate = spec as Record<string, unknown>;
  return (
    typeof candidate.command === "string" &&
    Array.isArray(candidate.args) &&
    candidate.args.every((arg) => typeof arg === "string") &&
    typeof candidate.cwd === "string" &&
    typeof candidate.env === "object" &&
    candidate.env != null &&
    typeof candidate.stdin === "string" &&
    typeof candidate.timeoutMs === "number"
  );
}
