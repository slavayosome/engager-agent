import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  expectedTarballName,
  releaseArtifactRoot,
  releaseManifestPath,
  sha256File,
  sourcePackage,
} from "./release-artifact.mjs";

const pkg = sourcePackage();
rmSync(releaseArtifactRoot, { recursive: true, force: true });
mkdirSync(releaseArtifactRoot, { recursive: true, mode: 0o700 });

const packed = spawnSync(
  "npm",
  [
    "pack",
    "--json",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    releaseArtifactRoot,
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
if (packed.status !== 0) {
  throw new Error(`npm pack failed:\n${packed.stderr || packed.stdout}`);
}
const result = JSON.parse(packed.stdout)[0];
if (!result?.filename || !Array.isArray(result.files)) {
  throw new Error("npm pack did not return an inspectable artifact manifest");
}
if (result.filename !== expectedTarballName(pkg)) {
  throw new Error(`npm pack produced unexpected filename ${result.filename}`);
}
const tarball = new URL(
  `../release-artifact/${result.filename}`,
  import.meta.url,
).pathname;
const manifest = {
  schemaVersion: 1,
  packageName: pkg.name,
  packageVersion: pkg.version,
  filename: result.filename,
  sha256: sha256File(tarball),
  files: result.files.map((file) => file.path).sort(),
};
writeFileSync(releaseManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${manifest.filename} sha256:${manifest.sha256}\n`);
