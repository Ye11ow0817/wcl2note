import { z } from "zod";
import source from "./update-source.json" with { type: "json" };

export const releaseRoot = `https://github.com/${source.repository}/releases`;
export const updateManifestUrl = `${releaseRoot}/latest/download/update.json`;
export const stableVersion =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const artifactSchema = z
  .object({
    filename: z.string(),
    url: z.string().url(),
    size: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const updateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(stableVersion),
    publishedAt: z.string().datetime(),
    notes: z.string().max(100_000),
    releaseUrl: z.string().url(),
    artifacts: z.object({ setup: artifactSchema }).strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedRelease = `${releaseRoot}/tag/v${manifest.version}`;
    if (manifest.releaseUrl !== expectedRelease)
      context.addIssue({ code: "custom", message: "Invalid release URL" });
    for (const kind of ["setup"] as const) {
      const artifact = manifest.artifacts[kind];
      const filename = `WCL2NOTE-${manifest.version}-win-x64-${kind}.exe`;
      if (
        artifact.filename !== filename ||
        artifact.url !==
          `${releaseRoot}/download/v${manifest.version}/${filename}`
      )
        context.addIssue({
          code: "custom",
          message: "Invalid release artifact",
        });
    }
  });
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export interface UpdateSnapshot {
  currentVersion: string;
  status:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "verifying"
    | "downloaded"
    | "installing"
    | "error";
  release?: UpdateManifest;
  transferred?: number;
  total?: number;
  error?: string;
  errorPhase?: "check" | "download" | "install";
}
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!stableVersion.test(candidate) || !stableVersion.test(current))
    return false;
  const left = candidate.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
