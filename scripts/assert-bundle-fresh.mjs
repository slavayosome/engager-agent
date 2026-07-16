import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundles } from "./build-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "engager-agent-bundle-check-"));

try {
  await buildBundles({ outdir: temporary, releaseAssets: false });
  const stale = [];
  for (const file of ["engager-agent.mjs", "engine-watchdog.mjs"]) {
    let checkedIn;
    try {
      checkedIn = readFileSync(join(root, "bundle", file));
    } catch {
      stale.push(`${file} is missing`);
      continue;
    }
    const generated = readFileSync(join(temporary, file));
    if (!checkedIn.equals(generated)) stale.push(`${file} differs from current source`);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `Release blocked: checked-in bundle is stale (${stale.join("; ")}). Run \`npm run build\` and review the generated bundle.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("checked-in runner bundle matches current source\n");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
