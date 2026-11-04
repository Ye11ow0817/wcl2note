import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const source = JSON.parse(
  await readFile(resolve(root, "src/shared/update-source.json"), "utf8"),
);
const version = metadata.version;
assert.match(
  version,
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/,
  "Release version must be a stable major.minor.patch version",
);
assert.match(source.repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    `v${version}`,
    "Tag must match package.json version",
  );
  if (process.env.GITHUB_REPOSITORY)
    assert.equal(
      process.env.GITHUB_REPOSITORY.toLowerCase(),
      source.repository.toLowerCase(),
      "Release repository must match the app update source",
    );
}
const directory = resolve(
  root,
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    metadata.build.directories.output,
);
const action = process.argv[2];
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
if (action === "latest") {
  const tag = process.env.LATEST_RELEASE_TAG ?? "";
  if (!tag) console.log("true");
  else {
    assert.match(
      tag,
      /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/,
    );
    const current = tag.slice(1).split(".").map(Number);
    const next = version.split(".").map(Number);
    const different = next.findIndex(
      (number, index) => number !== current[index],
    );
    console.log(
      different >= 0 && next[different] > current[different] ? "true" : "false",
    );
  }
} else if (action === "validate") {
  console.log(`Validated release v${version} for ${source.repository}`);
} else if (action === "generate" || action === "verify") {
  const releaseRoot = `https://github.com/${source.repository}/releases`;
  const artifacts = {};
  for (const kind of ["setup"]) {
    const filename = `WCL2NOTE-${version}-win-x64-${kind}.exe`;
    assert.equal(
      metadata.build.nsis.artifactName,
      `WCL2NOTE-\${version}-win-\${arch}-${kind}.\${ext}`,
      "Unexpected artifact pattern",
    );
    const path = resolve(directory, filename);
    const info = await stat(path);
    assert(
      info.isFile() && info.size > 0 && info.size <= 2 * 1024 ** 3,
      `Invalid artifact: ${path}`,
    );
    artifacts[kind] = {
      filename,
      url: `${releaseRoot}/download/v${version}/${filename}`,
      size: info.size,
      sha256: await digest(path),
    };
  }
  const manifestPath = resolve(directory, "update.json");
  const previous =
    action === "verify"
      ? JSON.parse(await readFile(manifestPath, "utf8"))
      : undefined;
  const manifest = {
    schemaVersion: 1,
    version,
    publishedAt: previous?.publishedAt ?? new Date().toISOString(),
    notes: (await readFile(resolve(root, "RELEASE_NOTES.md"), "utf8")).trim(),
    releaseUrl: `${releaseRoot}/tag/v${version}`,
    artifacts,
  };
  assert(
    manifest.notes.length <= 100_000 &&
      Number.isFinite(Date.parse(manifest.publishedAt)),
  );
  const content = JSON.stringify(manifest, null, 2) + "\n";
  assert(Buffer.byteLength(content) <= 256 * 1024);
  if (action === "generate") await writeFile(manifestPath, content);
  else
    assert.deepEqual(
      previous,
      manifest,
      "Release manifest does not match artifacts or notes",
    );
  const checksums =
    [
      ...Object.values(artifacts).map(
        (artifact) => `${artifact.sha256}  ${artifact.filename}`,
      ),
      `${await digest(manifestPath)}  update.json`,
    ].join("\n") + "\n";
  const checksumPath = resolve(directory, "SHA256SUMS.txt");
  if (action === "generate") await writeFile(checksumPath, checksums);
  else
    assert.equal(
      await readFile(checksumPath, "utf8"),
      checksums,
      "Release checksums do not match",
    );
  console.log(
    `${action === "generate" ? "Generated" : "Verified"} release v${version} in ${directory}`,
  );
} else {
  throw Error(
    "Usage: node scripts/release.mjs validate|generate|verify [--output=directory]",
  );
}
