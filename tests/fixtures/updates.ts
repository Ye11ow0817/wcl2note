import { createHash } from "node:crypto";
import { releaseRoot, type UpdateManifest } from "../../src/shared/updates";

export const updateBytes = Buffer.from("WCL2NOTE update test payload");
export function updateManifest(version = "1.1.0"): UpdateManifest {
  const artifact = () => {
    const filename = `WCL2NOTE-${version}-win-x64-setup.exe`;
    return {
      filename,
      url: `${releaseRoot}/download/v${version}/${filename}`,
      size: updateBytes.length,
      sha256: createHash("sha256").update(updateBytes).digest("hex"),
    };
  };
  return {
    schemaVersion: 1,
    version,
    publishedAt: "2026-11-03T04:00:00.000Z",
    notes: "更新测试说明\n第二行说明",
    releaseUrl: `${releaseRoot}/tag/v${version}`,
    artifacts: { setup: artifact() },
  };
}
