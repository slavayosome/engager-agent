import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseArtifact } from "./release-artifact.mjs";

const scratch = mkdtempSync(join(tmpdir(), "engager-agent-package-"));

try {
  const { manifest, tarball, pkg: sourcePackage } = verifyReleaseArtifact();
  const paths = manifest.files;
  for (const forbidden of [
    "src/",
    "dist/",
    "vendor/",
    "active-work",
    "agent.json",
  ]) {
    if (
      paths.some(
        (path) => path.startsWith(forbidden) || path.includes(forbidden),
      )
    ) {
      throw new Error(`published artifact unexpectedly contains ${forbidden}`);
    }
  }
  for (const required of [
    "bundle/engager-agent.mjs",
    "bundle/engine-watchdog.mjs",
    "bundle/THIRD_PARTY_COMPONENTS.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "package.json",
  ]) {
    if (!paths.includes(required))
      throw new Error(`published artifact is missing ${required}`);
  }
  const consumer = join(scratch, "consumer");
  // Keep the consumer outside the package root so no workspace or sibling
  // dependency can accidentally satisfy the install.
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer,
  );
  const sbomPath = join(
    consumer,
    "node_modules",
    "engager-agent",
    "bundle",
    "THIRD_PARTY_COMPONENTS.json",
  );

  const bin = join(consumer, "node_modules", ".bin", "engager-agent");
  const version = run(bin, ["--version"], consumer).trim();
  if (version !== sourcePackage.version) {
    throw new Error(
      `clean install returned ${version}; package.json declares ${sourcePackage.version}`,
    );
  }
  const help = run(bin, ["--help"], consumer);
  if (!help.includes("claim at most one server-authored work order")) {
    throw new Error(
      "clean install help does not describe the v2.1 execution contract",
    );
  }
  const status = run(bin, ["status", "--json"], consumer, {
    ...process.env,
    ENGAGER_AGENT_HOME: join(scratch, "agent-home"),
    ENGAGER_LAUNCH_AGENTS_DIR: join(scratch, "launch-agents"),
  });
  JSON.parse(status);
  const watchdog = join(
    consumer,
    "node_modules",
    "engager-agent",
    "bundle",
    "engine-watchdog.mjs",
  );
  const watchdogProbe = spawnSync(process.execPath, [watchdog], {
    cwd: consumer,
    env: process.env,
    encoding: "utf8",
  });
  if (watchdogProbe.status !== 2) {
    throw new Error(
      "engine watchdog did not fail closed when launched without its parent IPC channel",
    );
  }

  const published = JSON.parse(
    readFileSync(
      join(consumer, "node_modules", "engager-agent", "package.json"),
      "utf8",
    ),
  );
  if (Object.keys(published.dependencies ?? {}).length !== 0) {
    throw new Error(
      "standalone runner artifact unexpectedly installs runtime dependencies",
    );
  }
  const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  const notices = readFileSync(
    join(consumer, "node_modules", "engager-agent", "THIRD_PARTY_NOTICES"),
    "utf8",
  );
  if (!Array.isArray(sbom.components) || sbom.components.length < 5) {
    throw new Error("bundled component inventory is unexpectedly empty");
  }
  for (const component of sbom.components) {
    if (
      !component.name ||
      !component.version ||
      !component.license ||
      component.noticeBytes < 50
    ) {
      throw new Error(
        `invalid bundled component notice for ${component.name ?? "unknown"}`,
      );
    }
    if (!notices.includes(`${component.name}@${component.version}`)) {
      throw new Error(
        `THIRD_PARTY_NOTICES omits bundled component ${component.name}`,
      );
    }
  }
  process.stdout.write(
    `package smoke passed: ${manifest.filename} sha256:${manifest.sha256} (${paths.length} files, zero runtime dependencies)\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function run(command, args, cwd = process.cwd(), env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
