import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const releaseArtifactRoot = join(repositoryRoot, "release-artifact");
export const releaseManifestPath = join(releaseArtifactRoot, "manifest.json");

export function sourcePackage() {
  return JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
}

export function expectedTarballName(pkg = sourcePackage()) {
  return `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyReleaseArtifact() {
  if (!existsSync(releaseManifestPath)) {
    throw new Error(
      "release artifact manifest is missing; run `npm run release:pack`",
    );
  }
  const manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  const pkg = sourcePackage();
  const expectedFilename = expectedTarballName(pkg);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== pkg.name ||
    manifest.packageVersion !== pkg.version ||
    manifest.filename !== expectedFilename ||
    basename(manifest.filename) !== manifest.filename ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("release artifact manifest does not match package.json");
  }
  const tarball = join(releaseArtifactRoot, manifest.filename);
  if (!existsSync(tarball))
    throw new Error(`release tarball is missing: ${manifest.filename}`);
  const actual = sha256File(tarball);
  if (actual !== manifest.sha256) {
    throw new Error(
      `release tarball SHA-256 drifted (expected ${manifest.sha256}, found ${actual})`,
    );
  }
  return { manifest, tarball, pkg };
}
