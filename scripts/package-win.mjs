import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const buildDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
  .format(new Date())
  .replaceAll("-", "");
const cache = join(root, ".cache");
await mkdir(cache, { recursive: true });
const app = await mkdtemp(join(cache, "packaged-app-"));

async function removeStagingDirectory(directory) {
  const actual = await realpath(directory);
  if (dirname(actual) !== (await realpath(cache)))
    throw Error("Unexpected packaging staging directory");
  await rm(actual, { recursive: true, force: true });
}

try {
  // Stage the bundled outputs and the metadata needed to launch the app.
  // Build configuration stays in the source project.
  await Promise.all([
    cp(join(root, "dist"), join(app, "dist"), { recursive: true }),
    cp(join(root, "dist-electron"), join(app, "dist-electron"), {
      recursive: true,
    }),
  ]);
  const runtimeMetadata = Object.fromEntries(
    [
      "name",
      "productName",
      "version",
      "description",
      "author",
      "private",
      "type",
      "main",
    ]
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]]),
  );
  await writeFile(
    join(app, "package.json"),
    JSON.stringify(runtimeMetadata, null, 2) + "\n",
  );

  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/electron-builder/cli.js"),
      "--win",
      "--x64",
      `--config.directories.app=${app}`,
      `--config.directories.buildResources=${join(root, "build")}`,
      `--config.win.icon=${join(root, "build/icon.ico")}`,
      `--config.electronDist=${join(root, "node_modules/electron/dist")}`,
      `--config.electronVersion=${metadata.devDependencies.electron}`,
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        WCL_BUILD_DATE: buildDate,
        ELECTRON_BUILDER_CACHE: join(cache, "electron-builder"),
        electron_config_cache: join(cache, "electron"),
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const output = resolve(root, metadata.build.directories.output);
    const values = {
      version: metadata.version,
      "env.WCL_BUILD_DATE": buildDate,
      arch: "x64",
      ext: "exe",
    };
    const expand = (pattern) =>
      pattern.replace(
        /\$\{(version|env.WCL_BUILD_DATE|arch|ext)\}/g,
        (_, key) => values[key],
      );
    const expected = process.argv.includes("--dir")
      ? [join(output, "win-unpacked", `${metadata.productName}.exe`)]
      : [metadata.build.portable.artifactName].map((pattern) =>
          join(output, expand(pattern)),
        );
    for (const artifact of expected) {
      const info = await stat(artifact).catch(() => null);
      if (!info?.isFile() || info.size === 0 || info.mtimeMs < startedAt - 2000)
        throw Error(`Windows packaging did not produce ${artifact}`);
    }
    console.log(`Verified Windows output: ${expected.join(", ")}`);
  }
} finally {
  await removeStagingDirectory(app);
}
