import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".cache", { recursive: true });
await build({
  stdin: {
    contents:
      'export { defaultCredentials } from "./src/main/wcl/default-credentials"; export { WclClient, TOKEN_ENDPOINT } from "./src/main/wcl/client";',
    resolveDir: process.cwd(),
  },
  outfile: ".cache/check-wcl.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
const { defaultCredentials, TOKEN_ENDPOINT, WclClient } = await import(
  pathToFileURL(resolve(".cache/check-wcl.mjs")).href
);
try {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Basic ${Buffer.from(`${defaultCredentials.clientId}:${defaultCredentials.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw Error(`内置凭据认证失败，HTTP ${response.status}`);
  const token = await response.json();
  if (
    !token.access_token ||
    String(token.token_type).toLowerCase() !== "bearer"
  )
    throw Error("WCL 未返回有效 Token");
  console.log(
    "内置凭据：WCL Client Credentials 认证成功（不输出凭据或 Token）。",
  );
  const reportCode = process.argv[2];
  if (reportCode) {
    const client = new WclClient(defaultCredentials);
    try {
      const { report } = await client.query(
        { operation: "reportFights", variables: { reportCode } },
        AbortSignal.timeout(30000),
      );
      console.log(`真实报告读取成功：${report.fights?.length ?? 0} 场战斗。`);
    } finally {
      client.dispose();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "WCL 连接失败");
  process.exitCode = 1;
}
