import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// workflow_dispatch runs from a branch, so GITHUB_REF_NAME is usually `main`
// even when the operator supplied a release tag. The workflow passes that
// explicit tag as argv[2]; tag-push runs pass the same value there as well.
const ref = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!ref || ref !== `v${pkg.version}`) {
  console.error(`Release blocked: tag ${ref ?? "<missing>"} must equal package version v${pkg.version}.`);
  process.exit(1);
}

const head = gitCommit("HEAD");
const tagged = gitCommit(`refs/tags/${ref}^{commit}`);
if (!head || !tagged || head !== tagged) {
  console.error(
    `Release blocked: HEAD must be the exact immutable ${ref} tag commit (HEAD ${head ?? "<missing>"}, tag ${tagged ?? "<missing>"}).`,
  );
  process.exit(1);
}

function gitCommit(revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", revision], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}
