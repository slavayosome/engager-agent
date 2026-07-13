import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RUNNER_V1_COMPATIBILITY,
  RUNNER_V2_OPERATION_CONTRACTS,
  RunnerErrorEnvelopeSchema,
  RunnerV1CompatibilityArtifactSchema,
  RunnerWireResponseSchema,
} from "@engager/runner-contract";
import {
  classifyRunnerSurface,
  parseNegotiatedDirective,
} from "./protocol.js";

const contractRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@engager",
  "runner-contract",
);
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(contractRoot, "fixtures", name), "utf8"));
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("published runner contract consumption", () => {
  const operations = [
    ["report_runner_status", "heartbeat-request-v2.1.json", "idle-v2.1.json"],
    ["claim_runner_work", "claim-request-v2.1.json", "triage-v2.1.json"],
    ["renew_runner_lease", "renew-request-v2.1.json", "lease-renewed-v2.1.json"],
    ["get_runner_work_context", "context-request-v2.1.json", "context-response-v2.1.json"],
    ["runner_validate_batch", "validation-request-v2.1.json", "validation-response-v2.1.json"],
    ["runner_submit_triage", "triage-submit-request-v2.1.json", "triage-receipt-v2.1.json"],
    ["runner_submit_batch", "batch-submit-request-v2.1.json", "draft-receipt-v2.1.json"],
    ["runner_submit_replies", "replies-submit-request-v2.1.json", "reply-receipt-v2.1.json"],
    ["complete_runner_work", "complete-request-v2.1.json", "completion-response-v2.1.json"],
  ] as const;

  for (const [name, request, response] of operations) {
    it(`parses canonical ${name} request and response`, () => {
      const contract = RUNNER_V2_OPERATION_CONTRACTS[name];
      expect(contract.requestSchema.safeParse(fixture(request)).success).toBe(true);
      expect(contract.responseSchema.safeParse(fixture(response)).success).toBe(true);
      expect(contract.errorSchema.safeParse(fixture("error-v2.1.json")).success).toBe(true);
    });
  }

  it("keeps v1 compatibility outside the strict v2 wire union", () => {
    const artifact = fixture("legacy-compatibility-v1.json");
    expect(RunnerV1CompatibilityArtifactSchema.parse(artifact)).toEqual(RUNNER_V1_COMPATIBILITY);
    expect(RunnerWireResponseSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects every canonical invalid transcript", () => {
    const names = [
      "invalid-context-omitted-v2.1.json",
      "invalid-discover-draft-missing-item-id-v2.1.json",
      "invalid-draft-missing-item-id-v2.1.json",
      "invalid-reply-missing-item-id-v2.1.json",
      "invalid-triage-missing-item-id-v2.1.json",
      "invalid-unsupported-major-v3.0.json",
    ];
    for (const name of names) expect(RunnerWireResponseSchema.safeParse(fixture(name)).success).toBe(false);
  });

  it("parses the strict error envelope", () => {
    expect(RunnerErrorEnvelopeSchema.parse(fixture("error-v2.1.json")).code).toBe("context_too_large");
  });

  it("pins the reviewed pack artifact by SHA-256", () => {
    const pkg = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      engagerRunnerContract: { vendoredArchive: string; sha256: string };
    };
    const path = join(repositoryRoot, pkg.engagerRunnerContract.vendoredArchive);
    expect(existsSync(path)).toBe(true);
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(sha).toBe(pkg.engagerRunnerContract.sha256);
  });

  it("validates the explicit workflow_dispatch tag instead of the branch ref", () => {
    const pkg = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const repository = mkdtempSync(join(tmpdir(), "engager-release-tag-test-"));
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    expect(git("init", "--quiet").status).toBe(0);
    expect(git("config", "user.email", "runner@example.com").status).toBe(0);
    expect(git("config", "user.name", "Runner Test").status).toBe(0);
    writeFileSync(join(repository, "artifact.txt"), "first\n");
    expect(git("add", "artifact.txt").status).toBe(0);
    expect(git("commit", "--quiet", "-m", "first").status).toBe(0);
    const script = join(repositoryRoot, "scripts", "assert-release-tag.mjs");
    const invoke = () =>
      spawnSync(process.execPath, [script, `v${pkg.version}`], {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF_NAME: "main" },
      });
    expect(invoke().status).not.toBe(0);
    expect(git("tag", `v${pkg.version}`).status).toBe(0);
    const result = spawnSync(
      process.execPath,
      [script, `v${pkg.version}`],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REF_NAME: "main" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    writeFileSync(join(repository, "artifact.txt"), "second\n");
    expect(git("add", "artifact.txt").status).toBe(0);
    expect(git("commit", "--quiet", "-m", "second").status).toBe(0);
    expect(invoke().status).not.toBe(0);
  });

  it("pins a trusted-publishing-capable npm CLI in the release workflow", () => {
    const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm install --global npm@11.18.0");
    expect(workflow).toContain('test "$(npm --version)" = "11.18.0"');
    expect(workflow).toContain("RELEASE_TAG: ${{ inputs.tag || github.ref_name }}");
    expect(workflow).not.toContain('npm run release:check-tag -- "${{');
    expect(workflow).toContain("npm run release:pack");
    expect(workflow).toContain("npm run test:package");
    expect(workflow).toContain("npm run release:verify-artifact");
    expect(workflow).toContain("npm run release:publish-artifact");
    expect(workflow).not.toContain("npm publish --access public --provenance");

    const packScript = readFileSync(join(repositoryRoot, "scripts", "pack-release.mjs"), "utf8");
    const publishScript = readFileSync(join(repositoryRoot, "scripts", "publish-release.mjs"), "utf8");
    expect(packScript).toContain('"--ignore-scripts"');
    expect(publishScript).toContain("verifyReleaseArtifact()");
    expect(publishScript).toMatch(/"publish",\s*tarball,\s*"--ignore-scripts"/);
  });

  it("ships no legacy broad-tool autonomous runtime", () => {
    for (const name of ["session.ts", "verify.ts", "skills.ts"]) {
      expect(existsSync(join(repositoryRoot, "src", name))).toBe(false);
    }
    const bundle = readFileSync(join(repositoryRoot, "bundle", "engager-agent.mjs"), "utf8");
    expect(bundle).not.toMatch(/WebSearch|WebFetch|runSession|--allowedTools|mcp-config\.json/);
  });
});

describe("protocol negotiation", () => {
  it("accepts only exact v1/bootstrap or v2 surfaces", () => {
    expect(classifyRunnerSurface([...RUNNER_V1_COMPATIBILITY.toolNames])).toBe("v1-or-bootstrap");
    expect(classifyRunnerSurface(Object.keys(RUNNER_V2_OPERATION_CONTRACTS))).toBe("v2");
    expect(() => classifyRunnerSurface(["report_runner_status", "list_campaigns", "admin"])).toThrow(
      /surface mismatch/,
    );
  });

  it("uses the tagged heartbeat response rather than tool names", () => {
    expect(parseNegotiatedDirective(fixture("idle-v2.1.json")).protocol).toBe("2.1");
    expect(
      parseNegotiatedDirective({
        directive: "run",
        reason: "ok",
        workOrder: null,
        intervalMinutes: 60,
        intervalMinutesBase: 60,
        runner: {},
      }).protocol,
    ).toBe("v1");
  });
});
