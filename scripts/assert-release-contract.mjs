import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const spec = pkg.devDependencies?.["@engager/runner-contract"];
const pin = pkg.engagerRunnerContract;

if (
  !pin ||
  typeof pin.packageVersion !== "string" ||
  typeof pin.protocolVersion !== "string" ||
  typeof pin.vendoredArchive !== "string" ||
  !/^[a-f0-9]{64}$/.test(pin.sha256 ?? "")
) {
  fail(
    "package.json engagerRunnerContract must declare exact package/protocol/archive/SHA-256 pins",
  );
}

const vendorSpec = `file:${pin.vendoredArchive}`;
if (spec !== vendorSpec && spec !== pin.packageVersion) {
  fail(
    `@engager/runner-contract must use exact ${JSON.stringify(vendorSpec)} or exact registry version ${JSON.stringify(pin.packageVersion)} (found ${JSON.stringify(spec)})`,
  );
}

const installed = lock.packages?.["node_modules/@engager/runner-contract"];
if (
  lock.packages?.[""]?.devDependencies?.["@engager/runner-contract"] !== spec ||
  installed?.version !== pin.packageVersion
) {
  fail(
    "package-lock.json does not preserve the exact reviewed runner-contract package pin",
  );
}

if (spec === vendorSpec) {
  const archive = resolve(
    new URL("..", import.meta.url).pathname,
    pin.vendoredArchive,
  );
  if (!existsSync(archive))
    fail(`reviewed contract archive is missing: ${pin.vendoredArchive}`);
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.sha256) {
    fail(
      `runner-contract archive SHA-256 drifted (expected ${pin.sha256}, found ${sha256})`,
    );
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (installed.resolved !== vendorSpec || installed.integrity !== integrity) {
    fail(
      "package-lock.json does not resolve to the exact reviewed vendored archive bytes",
    );
  }
  const packedManifest = spawnSync(
    "tar",
    ["-xOf", archive, "package/package.json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (packedManifest.status !== 0) {
    fail(
      `runner-contract archive could not be inspected: ${packedManifest.stderr.trim()}`,
    );
  }
  const archivedPackage = JSON.parse(packedManifest.stdout);
  if (
    archivedPackage.name !== "@engager/runner-contract" ||
    archivedPackage.version !== pin.packageVersion
  ) {
    fail(
      "runner-contract archive package identity does not match its reviewed pin",
    );
  }
}

const contract = await import("@engager/runner-contract");
if (contract.RUNNER_CONTRACT_VERSION !== pin.protocolVersion) {
  fail(
    `installed runner contract advertises protocol ${contract.RUNNER_CONTRACT_VERSION}; expected ${pin.protocolVersion}`,
  );
}

if (
  typeof contract.RunnerDoctorHealthSchema?.safeParse !== "function" ||
  contract.RUNNER_CONTRACT_HEALTH?.current?.version !== pin.protocolVersion ||
  !contract.RunnerDoctorHealthSchema.safeParse({
    serverTime: 0,
    runnerContract: contract.RUNNER_CONTRACT_HEALTH,
    release: { environment: null, releaseSha: null },
  }).success
) {
  fail(
    "runner-contract archive is exact but stale: doctor health schema/compatibility metadata is missing or inconsistent",
  );
}

// Package versions and archive hashes prove identity, not freshness. Keep the
// release-required semantic boundaries here so a reviewed-but-obsolete archive
// cannot satisfy the gate merely because its old hash is still pinned.
const securityProbe = {
  contractVersion: 2,
  workOrderId: "11111111-1111-4111-8111-111111111111",
  leaseToken: "1234567890123456",
  idempotencyKey: "contract-security-probe",
  contextRevision: "contract-security-probe",
  lane: "draft",
  items: [{ candidateId: 1, text: "safe\u202Eevil" }],
};
if (contract.RunnerSubmitBatchInputSchema.safeParse(securityProbe).success) {
  fail(
    "runner-contract archive is exact but stale: authored text still accepts bidirectional or invisible format controls",
  );
}

process.stdout.write(
  `runner contract verified: ${pin.packageVersion} / protocol ${pin.protocolVersion} / ${spec === vendorSpec ? pin.sha256 : "registry pin"}\n`,
);

function fail(message) {
  console.error(`Release blocked: ${message}.`);
  process.exit(1);
}
