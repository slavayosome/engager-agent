import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  haltPath,
  pausePath,
  readHalt,
  readPause,
  writeHalt,
  writePause,
} from "./markers.js";

let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.ENGAGER_AGENT_HOME;
  process.env.ENGAGER_AGENT_HOME = mkdtempSync(join(tmpdir(), "engager-markers-test-"));
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.ENGAGER_AGENT_HOME;
  else process.env.ENGAGER_AGENT_HOME = priorHome;
});

describe("durable local control markers", () => {
  it("atomically writes private pause and halt intent", () => {
    writePause(Date.now() + 60_000);
    writeHalt("server stop", 3);
    expect(readPause()).not.toBeNull();
    expect(readHalt()).toMatchObject({ reason: "server stop", consecutiveFailures: 3 });
    expect(statSync(pausePath()).mode & 0o777).toBe(0o600);
    expect(statSync(haltPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(pausePath(), "utf8")).toContain('"id"');
  });

  it("fails closed on corrupt control intent", () => {
    writeFileSync(pausePath(), "{", { mode: 0o600 });
    writeFileSync(haltPath(), "{}", { mode: 0o600 });
    chmodSync(pausePath(), 0o600);
    chmodSync(haltPath(), 0o600);
    expect(readPause()).toMatchObject({ at: 0 });
    expect(readHalt()?.reason).toMatch(/corrupt/);
  });

  it("never deletes an expired marker that a concurrent pause can replace", () => {
    writePause(10);
    expect(readPause(11)).toBeNull();
    expect(existsSync(pausePath())).toBe(true);
    writePause(1_000);
    expect(readPause(11)?.until).toBe(1_000);
  });
});
