import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Single build definition used by both release builds and the checked-in
 * source-to-bundle freshness verifier. */
export async function buildBundles(options = {}) {
  const outdir = resolve(options.outdir ?? join(root, "bundle"));
  const releaseAssets = options.releaseAssets ?? true;
  mkdirSync(outdir, { recursive: true, mode: 0o755 });
  const result = await build({
    entryPoints: [join(root, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: join(outdir, "engager-agent.mjs"),
    metafile: releaseAssets,
    define: {
      __ENGAGER_AGENT_VERSION__: JSON.stringify(pkg.version),
    },
  });

  await build({
    entryPoints: [join(root, "src", "engine-watchdog.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: join(outdir, "engine-watchdog.mjs"),
  });

  if (releaseAssets) {
    writeFileSync(join(outdir, "esbuild-meta.json"), JSON.stringify(result.metafile));
    if (outdir !== join(root, "bundle")) {
      throw new Error("release notices may be generated only for the canonical bundle directory");
    }
    await import(`./generate-third-party-notices.mjs?build=${Date.now()}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildBundles();
}
