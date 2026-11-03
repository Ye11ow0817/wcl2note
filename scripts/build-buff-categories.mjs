import { readFile, mkdir, writeFile } from "node:fs/promises";

const observationsPath = new URL(
  "../data/wcl-buff-categories/observations.jsonl",
  import.meta.url,
);
const outputPath = new URL(
  "../src/domain/data/buff-categories.json",
  import.meta.url,
);
const allowedMasks = new Set([0, 1, 2, 4, 8, 16, 32, 64, 128, 256]);
const observations = (await readFile(observationsPath, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const masks = new Map();
const conflicts = [];
for (const observation of observations) {
  const url = new URL(observation.url);
  if (
    url.hostname !== "cn.warcraftlogs.com" ||
    !/^\/reports\/[a-zA-Z0-9]+$/.test(url.pathname)
  )
    throw Error("Invalid observation URL");
  const current = new Map();
  for (const [category, ids] of Object.entries(observation.categories)) {
    const mask = Number(category);
    if (!allowedMasks.has(mask) || !Array.isArray(ids))
      throw Error(`Invalid WCL category: ${category}`);
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id <= 0)
        throw Error(`Invalid spell ID: ${id}`);
      current.set(id, (current.get(id) ?? 0) | mask);
    }
  }
  for (const [id, mask] of current) {
    if (masks.has(id) && masks.get(id) !== mask)
      conflicts.push({
        id,
        previous: masks.get(id),
        mask,
        url: observation.url,
      });
    masks.set(id, (masks.get(id) ?? 0) | mask);
  }
}
if (conflicts.length)
  throw Error(`Conflicting WCL classifications: ${JSON.stringify(conflicts)}`);
const mapping = Object.fromEntries([...masks].sort(([a], [b]) => a - b));
let coverage = "";
if (process.argv.includes("--require-coverage")) {
  const samples = (
    await readFile(
      new URL("../data/wcl-buff-categories/samples.jsonl", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const snapshot = JSON.parse(
    await readFile(
      new URL("../data/wcl-buff-categories/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  const sampleKeys = new Set(
    samples.map(
      (sample) =>
        `${sample.zoneId}:${sample.encounterId}:${sample.className}:${sample.specName}`,
    ),
  );
  if (
    sampleKeys.size !== samples.length ||
    samples.length !== snapshot.expectedSamples
  )
    throw Error("Incomplete or duplicate ranking samples");
  const sampledIds = new Set(samples.flatMap((sample) => sample.spellIds));
  if (sampledIds.size !== snapshot.uniqueSampledSpellIds)
    throw Error("Sample spell ID count does not match the snapshot");
  const reports = new Set(
    samples.map((sample) => sample.reportCode).filter(Boolean),
  );
  for (const observation of observations)
    if (!reports.has(new URL(observation.url).pathname.split("/").at(-1)))
      throw Error(
        `Observation is not from a sampled top-ranked report: ${observation.url}`,
      );
  const missing = [...sampledIds].filter((id) => !masks.has(id));
  if (missing.length)
    throw Error(
      `Missing webpage classifications for ${missing.length} sampled spell IDs: ${missing.join(",")}`,
    );
  coverage = `; ${sampledIds.size}/${sampledIds.size} sampled IDs covered`;
}
const contents = JSON.stringify(mapping) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(outputPath, "utf8")) !== contents)
    throw Error(
      "Buff classification index is stale; run npm run build:buff-categories",
    );
} else {
  await mkdir(new URL("../src/domain/data/", import.meta.url), {
    recursive: true,
  });
  await writeFile(outputPath, contents);
}
console.log(
  `${observations.length} WCL pages; ${masks.size} spell IDs; ${Buffer.byteLength(contents)} bytes${coverage}`,
);
