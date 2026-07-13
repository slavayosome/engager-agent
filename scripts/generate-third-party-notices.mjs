import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metaPath = join(root, "bundle", "esbuild-meta.json");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const packageRoots = new Set();

for (const input of Object.keys(meta.inputs ?? {})) {
  const absolute = resolve(root, input);
  if (!absolute.includes(`${join("node_modules", "")}`)) continue;
  let directory = dirname(absolute);
  while (directory.startsWith(join(root, "node_modules"))) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const candidate = JSON.parse(readFileSync(packagePath, "utf8"));
      // Many ESM packages place a nested `{ "type": "module" }` marker under
      // dist/. That is not a distributable package root and carries no license.
      // Stop only at the first real named+versioned package; the strict license
      // validation below still fails closed if that actual package is malformed.
      if (candidate.name && candidate.version) {
        packageRoots.add(directory);
        break;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

const components = [...packageRoots].map((directory) => {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const licenseFile = readdirSync(directory).find((file) => /^licen[cs]e(?:\.|$)/i.test(file));
  if (!pkg.name || !pkg.version || !pkg.license || !licenseFile) {
    throw new Error(`Bundled package at ${directory} lacks name, version, license, or license text`);
  }
  const licenseText = readFileSync(join(directory, licenseFile), "utf8")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!licenseText) throw new Error(`Bundled package ${pkg.name} has an empty license notice`);
  const repository =
    typeof pkg.repository === "string"
      ? pkg.repository
      : typeof pkg.repository?.url === "string"
        ? pkg.repository.url
        : typeof pkg.homepage === "string"
          ? pkg.homepage
          : null;
  return {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license),
    repository,
    licenseText,
  };
}).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

if (components.length === 0) throw new Error("No bundled third-party components were discovered");

const notices = [
  "THIRD-PARTY SOFTWARE NOTICES",
  "",
  "This file is generated from the exact esbuild input graph. Do not edit it by hand.",
  "The standalone engager-agent bundle includes the following components:",
  "",
  ...components.flatMap((component) => [
    "=".repeat(78),
    `${component.name}@${component.version}`,
    `Declared license: ${component.license}`,
    ...(component.repository ? [`Source: ${component.repository}`] : []),
    "-".repeat(78),
    component.licenseText,
    "",
  ]),
].join("\n");

writeFileSync(join(root, "THIRD_PARTY_NOTICES"), notices);
writeFileSync(
  join(root, "bundle", "THIRD_PARTY_COMPONENTS.json"),
  `${JSON.stringify(
    {
      generatedFrom: "esbuild-meta",
      components: components.map(({ licenseText, ...component }) => ({
        ...component,
        noticeBytes: Buffer.byteLength(licenseText),
      })),
    },
    null,
    2,
  )}\n`,
);
rmSync(metaPath, { force: true });
// Keep stdout machine-readable for callers such as `npm pack --json`; lifecycle
// diagnostics belong on stderr.
process.stderr.write(`generated notices for ${components.length} bundled packages\n`);
