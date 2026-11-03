import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function buildElectron() {
  await build({
    absWorkingDir: root,
    entryPoints: {
      main: "src/main/index.ts",
      preload: "src/preload/index.ts",
    },
    outdir: "dist-electron",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false,
    logLevel: "info",
  });
  await copyFile(
    join(root, "build/icon.png"),
    join(root, "dist-electron/icon.png"),
  );
}
