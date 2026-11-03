import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const result = spawnSync(
  process.execPath,
  ["node_modules/electron/install.js"],
  {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, electron_config_cache: resolve(".cache/electron") },
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
