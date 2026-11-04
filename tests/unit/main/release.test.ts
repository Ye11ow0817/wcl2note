import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import metadata from "../../../package.json";
import { updateManifestSchema } from "../../../src/shared/updates";

async function cleanup(directory: string) {
  const target = resolve(directory);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith("wcl2note-release-test-")
  )
    throw Error("Unexpected cleanup path");
  await rm(target, { recursive: true, force: true });
}

it("发布脚本生成可被客户端读取的仅含安装包的清单，验证文件篡改与标签不一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wcl2note-release-test-"));
  const env = {
    ...process.env,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: `v${metadata.version}`,
  };
  const run = (action: string) =>
    execFileSync(
      process.execPath,
      ["scripts/release.mjs", action, `--output=${directory}`],
      { cwd: resolve("."), env, windowsHide: true, stdio: "pipe" },
    );
  try {
    for (const kind of ["setup"])
      await writeFile(
        join(directory, `WCL2NOTE-${metadata.version}-win-x64-${kind}.exe`),
        `fixture-${kind}`,
      );
    run("validate");
    run("generate");
    run("verify");
    const manifest = updateManifestSchema.parse(
      JSON.parse(await readFile(join(directory, "update.json"), "utf8")),
    );
    expect(manifest.version).toBe(metadata.version);
    expect(Object.keys(manifest.artifacts)).toEqual(["setup"]);
    expect(metadata.build.win.target.map((target) => target.target)).toEqual([
      "nsis",
    ]);
    expect(manifest.artifacts.setup.filename).not.toMatch(/-\d{8}-/);
    await writeFile(
      join(directory, manifest.artifacts.setup.filename),
      "changed",
    );
    expect(() => run("verify")).toThrow();
    const invalidTag = spawnSync(
      process.execPath,
      ["scripts/release.mjs", "validate"],
      {
        env: { ...env, GITHUB_REF_NAME: "v999.0.0" },
        windowsHide: true,
        encoding: "utf8",
      },
    );
    expect(invalidTag.status).not.toBe(0);
    expect(invalidTag.stderr).toContain("Tag must match");
    const latest = (tag: string) =>
      execFileSync(process.execPath, ["scripts/release.mjs", "latest"], {
        env: { ...env, LATEST_RELEASE_TAG: tag },
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    expect(latest("")).toBe("true");
    expect(latest(`v${metadata.version}`)).toBe("false");
    expect(latest("v999.0.0")).toBe("false");
    expect(latest("v0.0.0")).toBe("true");
  } finally {
    await cleanup(directory);
  }
}, 15_000);
