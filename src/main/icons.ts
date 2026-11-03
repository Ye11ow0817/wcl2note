import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseIcon } from "../shared/icons";

const maxBytes = 256 * 1024;
const retryDelay = 60_000;
const requestInterval = 500;
export interface IconData {
  bytes: Buffer;
  type: string;
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "image/jpeg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

async function readImage(response: Response) {
  if (
    !response.ok ||
    !/^image\/(jpeg|png|webp)(;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    Number(response.headers.get("content-length")) > maxBytes
  ) {
    await response.body?.cancel();
    throw Error("Invalid icon response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty icon response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw Error("Icon response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export class IconCache {
  private readonly inFlight = new Map<string, Promise<IconData | undefined>>();
  private readonly failures = new Map<string, number>();
  private readonly queue: (() => Promise<void>)[] = [];
  private running = 0;
  private lastStarted = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly directory: string,
    private readonly fetcher: Fetcher,
    private readonly isDecodable: (bytes: Buffer) => boolean,
  ) {}

  get(folder: string, icon: unknown): Promise<IconData | undefined> {
    const parsed = parseIcon(folder, icon);
    if (!parsed) return Promise.resolve(undefined);
    const key = `${parsed.folder}/${parsed.name}${parsed.search}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= 256) return Promise.resolve(undefined);
    const result = this.load(parsed, key).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, result);
    return result;
  }

  private validate(bytes: Buffer): IconData | undefined {
    if (!bytes.length || bytes.length > maxBytes) return undefined;
    const type = imageType(bytes);
    return type && this.isDecodable(bytes) ? { bytes, type } : undefined;
  }

  private async load(
    icon: NonNullable<ReturnType<typeof parseIcon>>,
    key: string,
  ) {
    // Hash the complete filename and query so cachebust variants stay separate.
    const hash = createHash("sha256").update(key).digest("hex");
    const target = join(this.directory, icon.folder, hash + extname(icon.name));
    try {
      const cached = this.validate(await readFile(target));
      if (cached) return cached;
    } catch {
      // Missing or corrupt cache entries can be downloaded again.
    }
    if ((this.failures.get(key) ?? 0) > Date.now()) return undefined;
    try {
      return await this.schedule(async () => {
        const response = await this.fetcher(
          `https://assets.rpglogs.com/img/warcraft/${icon.folder}/${icon.name}${icon.search}`,
          {
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
          },
        );
        const image = this.validate(await readImage(response));
        if (!image) throw Error("Undecodable icon");
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await mkdir(join(this.directory, icon.folder), { recursive: true });
          await writeFile(temporary, image.bytes);
          await rename(temporary, target);
        } catch {
          // A read-only/full disk must not prevent this session displaying it.
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
        this.failures.delete(key);
        return image;
      });
    } catch {
      if (this.failures.size >= 1024)
        this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(key, Date.now() + retryDelay);
      return undefined;
    }
  }

  private schedule<T>(action: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await action());
        } catch (error) {
          reject(error);
        }
      });
      this.pump();
    });
  }

  private pump() {
    if (this.running >= 2 || !this.queue.length || this.timer) return;
    const delay = requestInterval - (Date.now() - this.lastStarted);
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, delay);
      return;
    }
    this.lastStarted = Date.now();
    this.running++;
    void this.queue.shift()!().finally(() => {
      this.running--;
      this.pump();
    });
    this.pump();
  }
}
