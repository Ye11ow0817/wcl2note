import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { credentialSchema } from "../shared/contract";
import type { Credentials, SettingsSnapshot } from "../shared/desktop";
import { AppError } from "./errors";

export interface SecretStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (data: Buffer) => string;
}
const storedSchema = z
  .object({
    version: z.literal(1),
    clientId: z.string().max(256),
    encryptedSecret: z.string().max(16384),
  })
  .strict();
export function snapshot(credentials: Credentials): SettingsSnapshot {
  const { clientId, clientSecret } = credentials;
  return {
    ...credentials,
    mode:
      !clientId && !clientSecret
        ? "default"
        : clientId && clientSecret
          ? "custom"
          : "incomplete",
  };
}
export class SettingsStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(
    private readonly directory: string,
    private readonly secrets: SecretStorage,
  ) {
    this.path = join(directory, "credentials.json");
  }
  async load(): Promise<SettingsSnapshot> {
    await this.tail;
    try {
      const stored = storedSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
      const clientSecret = stored.encryptedSecret
        ? this.secrets.decryptString(
            Buffer.from(stored.encryptedSecret, "base64"),
          )
        : "";
      return snapshot(
        credentialSchema.parse({ clientId: stored.clientId, clientSecret }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return snapshot({ clientId: "", clientSecret: "" });
      throw new AppError(
        "无法读取本机保存的凭据，请在设置中重新填写或恢复默认。",
        "SETTINGS",
      );
    }
  }
  save(input: unknown): Promise<SettingsSnapshot> {
    const parsed = credentialSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new AppError("凭据格式无效。", "SETTINGS"));
    const operation = this.tail.then(async () => {
      const credentials = parsed.data;
      if (credentials.clientSecret && !this.secrets.isEncryptionAvailable())
        throw new AppError(
          "Windows 凭据加密不可用，无法保存 Client Secret。",
          "SETTINGS",
        );
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const encryptedSecret = credentials.clientSecret
          ? this.secrets
              .encryptString(credentials.clientSecret)
              .toString("base64")
          : "";
        await mkdir(this.directory, { recursive: true });
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            clientId: credentials.clientId,
            encryptedSecret,
          }),
          "utf8",
        );
        await rename(temporary, this.path);
      } catch {
        throw new AppError(
          "保存本机凭据失败，请检查目录权限后重试。",
          "SETTINGS",
        );
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return snapshot(credentials);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async flush() {
    await this.tail;
  }
}
