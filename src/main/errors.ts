import type { DesktopError, Reply } from "../shared/desktop";

export class AppError extends Error {
  constructor(
    message: string,
    readonly code = "LOCAL",
    readonly status = 400,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
export async function reply<T>(
  action: () => T | Promise<T>,
): Promise<Reply<T>> {
  try {
    return { ok: true, data: await action() };
  } catch (error) {
    const safe: DesktopError =
      error instanceof AppError
        ? {
            message: error.message,
            code: error.code,
            status: error.status,
            retryAfter: error.retryAfter,
          }
        : {
            message: "本地操作失败，请重试。",
            code: "LOCAL",
            status: 500,
            retryAfter: 0,
          };
    return { ok: false, error: safe };
  }
}
