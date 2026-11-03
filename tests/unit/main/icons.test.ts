import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { IconCache } from "../../../src/main/icons";
import { classIcons, iconSource } from "../../../src/shared/icons";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const directories: string[] = [];
const response = () =>
  new Response(new Uint8Array(image), {
    headers: { "Content-Type": "image/png" },
  });
async function create(
  fetcher: ConstructorParameters<typeof IconCache>[1] = async () => response(),
) {
  const directory = await mkdtemp(join(tmpdir(), "wcl2note-icons-test-"));
  directories.push(directory);
  const download = vi.fn(fetcher);
  return {
    directory,
    fetcher: download,
    cache: new IconCache(directory, download, (bytes) => bytes.equals(image)),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => {
      const target = resolve(path);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith("wcl2note-icons-test-")
      )
        throw Error("Unexpected icon test cleanup path");
      return rm(target, { recursive: true, force: true });
    }),
  );
});

it("重复图标合并下载，新实例直接读取持久缓存，缓存损坏后重新下载", async () => {
  const { directory, cache, fetcher } = await create();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      cache.get("abilities", "spell_magearmor.jpg"),
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(results.every((result) => result?.bytes.equals(image))).toBe(true);
  const offline = vi.fn(async () => {
    throw Error("offline");
  });
  const restarted = new IconCache(directory, offline, (bytes) =>
    bytes.equals(image),
  );
  expect(
    (await restarted.get("abilities", "spell_magearmor.jpg"))?.bytes,
  ).toEqual(image);
  expect(offline).not.toHaveBeenCalled();
  const files = await readdir(join(directory, "abilities"));
  expect(files).toHaveLength(1);
  await writeFile(join(directory, "abilities", files[0]), "corrupt cache");
  const repaired = new IconCache(directory, fetcher, (bytes) =>
    bytes.equals(image),
  );
  expect(
    (await repaired.get("abilities", "spell_magearmor.jpg"))?.bytes,
  ).toEqual(image);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await readFile(join(directory, "abilities", files[0]))).toEqual(image);
});

it("图标目录、文件名与 cachebust 保留准确，两个版本不会互相覆盖", async () => {
  const { cache, fetcher, directory } = await create();
  await cache.get("icons", classIcons.mage);
  await cache.get("icons", `${classIcons.mage}?cachebust`);
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual([
    "https://assets.rpglogs.com/img/warcraft/icons/Mage.jpg",
    "https://assets.rpglogs.com/img/warcraft/icons/Mage.jpg?cachebust",
  ]);
  expect(await readdir(join(directory, "icons"))).toHaveLength(2);
  expect(iconSource("ability_monk_chiexplosion.jpg?cachebust")).toBe(
    "app://wcl2note/icons/abilities/ability_monk_chiexplosion.jpg?cachebust",
  );
});

it("只允许固定图标目录和文件名，拒绝 URL、路径穿越及非图片资源", async () => {
  const { cache, fetcher } = await create();
  for (const icon of [
    "https://example.com/a.jpg",
    "../credentials.json",
    "..\\a.jpg",
    "a.jpg/../../a.jpg",
    "a.svg",
    "a.jpg#fragment",
    "a.jpg?x=\r\n",
    null,
  ]) {
    expect(iconSource(icon)).toBeUndefined();
    expect(await cache.get("abilities", icon)).toBeUndefined();
  }
  expect(await cache.get("../", "Mage.jpg")).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ["403", () => new Response(null, { status: 403 })],
  [
    "HTML",
    () =>
      new Response("<html>error</html>", {
        headers: { "Content-Type": "text/html" },
      }),
  ],
  [
    "伪装成图片的错误内容",
    () => new Response("error", { headers: { "Content-Type": "image/png" } }),
  ],
  [
    "超大响应",
    () =>
      new Response(new Uint8Array(256 * 1024 + 1), {
        headers: { "Content-Type": "image/png" },
      }),
  ],
] as const)(
  "%s 不写入图片缓存，短时间内不会重复请求",
  async (_name, makeResponse) => {
    const fetcher = vi.fn(async () => makeResponse());
    const { cache, directory } = await create(fetcher);
    expect(await cache.get("abilities", "missing.jpg")).toBeUndefined();
    expect(await cache.get("abilities", "missing.jpg")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect(await cache.get("abilities", "missing.jpg")).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("图片解码失败时不保存，缓存目录不可写时仍能显示下载成功的图片", async () => {
  const { directory, fetcher } = await create();
  const invalid = new IconCache(directory, fetcher, () => false);
  expect(await invalid.get("abilities", "invalid.jpg")).toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
  await writeFile(join(directory, "blocked"), "file instead of directory");
  const readOnly = new IconCache(
    join(directory, "blocked"),
    fetcher,
    () => true,
  );
  expect((await readOnly.get("abilities", "valid.jpg"))?.bytes).toEqual(image);
});

it("最多同时下载两张，开始请求的间隔至少 500ms", async () => {
  const started: number[] = [];
  const complete: (() => void)[] = [];
  const fetcher = vi.fn(async () => {
    started.push(Date.now());
    await new Promise<void>((resolve) => complete.push(resolve));
    return response();
  });
  const { cache } = await create(fetcher);
  const downloads = ["a.jpg", "b.jpg", "c.jpg"].map((name) =>
    cache.get("abilities", name),
  );
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), {
    timeout: 2000,
  });
  expect(started[1] - started[0]).toBeGreaterThanOrEqual(490);
  complete[0]();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3), {
    timeout: 2000,
  });
  expect(started[2] - started[1]).toBeGreaterThanOrEqual(490);
  complete[1]();
  complete[2]();
  expect((await Promise.all(downloads)).every(Boolean)).toBe(true);
});
