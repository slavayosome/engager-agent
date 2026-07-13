import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [new URL("../src/cli.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: new URL("../bundle/engager-agent.mjs", import.meta.url).pathname,
  metafile: true,
  define: {
    __ENGAGER_AGENT_VERSION__: JSON.stringify(pkg.version),
  },
}).then((result) => {
  const path = new URL("../bundle/esbuild-meta.json", import.meta.url);
  return import("node:fs").then(({ writeFileSync }) =>
    writeFileSync(path, JSON.stringify(result.metafile)),
  );
});

await build({
  entryPoints: [new URL("../src/engine-watchdog.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: new URL("../bundle/engine-watchdog.mjs", import.meta.url).pathname,
});

await import("./generate-third-party-notices.mjs");
