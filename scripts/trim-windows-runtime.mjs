import { rm } from "node:fs/promises";
import { join } from "node:path";

export function beforeBuild() {
  // The staged app is already bundled. Skip rebuilding and collecting workspace dependencies.
  return false;
}

export async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== "win32") return;
  // electron-builder keeps these stock Electron files when using a local electronDist.
  await Promise.all([
    rm(join(appOutDir, "resources", "default_app.asar"), { force: true }),
    rm(join(appOutDir, "version"), { force: true }),
  ]);
}
