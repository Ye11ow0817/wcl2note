import { execFileSync, spawn } from "node:child_process";
import { createServer } from "vite";
import { buildElectron } from "./lib/electron-build.mjs";
import electron from "electron";
if (process.platform === "win32") {
  const groups = execFileSync("whoami.exe", ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (/\\CodexSandboxUsers"/i.test(groups))
    throw new Error(
      "Electron development requires a normal Windows user context. Run start-dev.cmd outside the Codex restricted account to avoid 0x80000003.",
    );
}
console.log("[1/3] Building Electron main process and preload...");
await buildElectron();
console.log("[2/3] Starting Vite at http://127.0.0.1:5173...");
const server = await createServer();
await server.listen();
const env = { ...process.env, WCL2NOTE_DEV_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
console.log("[3/3] Opening WCL2NOTE. Keep this console open while developing.");
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env,
  windowsHide: false,
});
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exit(code);
}
child.once("exit", (code) => void close(code ?? 0));
child.once("error", (error) => {
  console.error(error.message);
  void close(1);
});
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
