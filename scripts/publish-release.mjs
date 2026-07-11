import { spawnSync } from "node:child_process";
import { verifyReleaseArtifact } from "./release-artifact.mjs";

const { manifest, tarball } = verifyReleaseArtifact();
process.stderr.write(
  `publishing verified immutable artifact ${manifest.filename} sha256:${manifest.sha256}\n`,
);
const published = spawnSync(
  "npm",
  [
    "publish",
    tarball,
    "--ignore-scripts",
    "--access",
    "public",
    "--provenance",
  ],
  { stdio: "inherit" },
);
if (published.status !== 0) process.exit(published.status ?? 1);
