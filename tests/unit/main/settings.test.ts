import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore, type SecretStorage } from "../../../src/main/settings";
const directories: string[] = [];
const encryption: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text.split("").reverse().join("")),
  decryptString: (buffer) => buffer.toString().split("").reverse().join(""),
};
async function create(secrets = encryption) {
  const directory = await mkdtemp(join(tmpdir(), "wcl2note-test-"));
  directories.push(directory);
  return { directory, store: new SettingsStore(directory, secrets) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => {
      const target = resolve(path);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith("wcl2note-test-")
      )
        throw Error("Unexpected test cleanup path");
      return rm(target, { recursive: true, force: true });
    }),
  );
});
it("首次启动默认内置凭据，自定义凭据加密保存后重启可恢复", async () => {
  const { directory, store } = await create();
  expect((await store.load()).mode).toBe("default");
  await store.save({ clientId: " own-id ", clientSecret: " own-secret " });
  const saved = await readFile(join(directory, "credentials.json"), "utf8");
  expect(saved).not.toContain("own-secret");
  expect(await new SettingsStore(directory, encryption).load()).toEqual({
    mode: "custom",
    clientId: "own-id",
    clientSecret: "own-secret",
  });
});
it("连续自动保存按顺序执行，最后一组值生效，清空恢复默认", async () => {
  const { store } = await create();
  await Promise.all([
    store.save({ clientId: "a", clientSecret: "" }),
    store.save({ clientId: "ab", clientSecret: "" }),
    store.save({ clientId: "abc", clientSecret: "secret" }),
  ]);
  expect(await store.load()).toMatchObject({ mode: "custom", clientId: "abc" });
  await store.save({ clientId: "", clientSecret: "" });
  expect((await store.load()).mode).toBe("default");
});
it("加密不可用时不写明文，不破坏已有凭据", async () => {
  const { directory, store } = await create();
  await store.save({ clientId: "first", clientSecret: "old-secret" });
  const unavailable = new SettingsStore(directory, {
    ...encryption,
    isEncryptionAvailable: () => false,
  });
  await expect(
    unavailable.save({ clientId: "new", clientSecret: "new-secret" }),
  ).rejects.toThrow("加密不可用");
  expect((await store.load()).clientId).toBe("first");
});
it("本地配置损坏明确报错，用户恢复默认后可继续使用", async () => {
  const { directory, store } = await create();
  await writeFile(join(directory, "credentials.json"), "broken json");
  await expect(store.load()).rejects.toThrow("无法读取");
  await store.save({ clientId: "", clientSecret: "" });
  expect((await store.load()).mode).toBe("default");
});
