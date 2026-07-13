import { verifyReleaseArtifact } from "./release-artifact.mjs";

const { manifest } = verifyReleaseArtifact();
process.stdout.write(
  `release artifact verified: ${manifest.filename} sha256:${manifest.sha256}\n`,
);
