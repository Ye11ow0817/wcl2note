import { querySchema } from "../../shared/contract";
import type { Credentials } from "../../shared/desktop";
import { AppError } from "../errors";
import { queries } from "./queries";

export const TOKEN_ENDPOINT = "https://www.warcraftlogs.com/oauth/token";
export const QUERY_ENDPOINT = "https://cn.warcraftlogs.com/api/v2/client";
type Token = { accessToken: string; expiresAt: number };

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export class WclClient {
  private credentials: Credentials;
  private token?: Token;
  private refresh?: Promise<Token>;
  private generation = new AbortController();
  constructor(
    private readonly defaults: Credentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = () => Date.now(),
  ) {
    this.credentials = defaults;
  }

  setCredentials(custom: Credentials) {
    this.generation.abort();
    this.generation = new AbortController();
    this.token = undefined;
    this.refresh = undefined;
    this.credentials =
      !custom.clientId && !custom.clientSecret ? this.defaults : custom;
  }
  dispose() {
    this.generation.abort();
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(30000);
    try {
      return await this.fetcher(url, {
        ...init,
        signal: AbortSignal.any([signal, timeout]),
        redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new AppError(
        timeout.aborted
          ? "Warcraft Logs 请求超时，请重试。"
          : "无法连接 Warcraft Logs，请检查网络后重试。",
        "NETWORK",
        504,
      );
    }
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || Array.isArray(data))
        throw Error();
      return data as Record<string, unknown>;
    } catch {
      throw new AppError("Warcraft Logs 返回了无效的 JSON 响应。", "JSON", 502);
    }
  }
  private httpError(response: Response, authentication = false): AppError {
    const status = response.status;
    if (status === 429) {
      const retryHeader = response.headers.get("retry-after") ?? "";
      const seconds = Number(retryHeader);
      const wait = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryHeader) - this.now();
      return new AppError(
        "Warcraft Logs 请求额度不足，请稍后重试。",
        "RATE",
        status,
        Math.min(30000, Math.max(0, wait || 0)),
      );
    }
    if (authentication || status === 401)
      return new AppError(
        `Warcraft Logs 认证失败（HTTP ${status}），请检查 Client ID 和 Client Secret。`,
        "AUTH",
        status,
      );
    if (status === 403)
      return new AppError(
        "没有权限读取此报告，Client Credentials 仅能访问公开或不公开列出的报告。",
        "FORBIDDEN",
        status,
      );
    if (status === 404)
      return new AppError("找不到此 Warcraft Logs 报告。", "NOT_FOUND", status);
    return new AppError(
      `Warcraft Logs 请求失败（HTTP ${status}）。`,
      status >= 500 ? "UPSTREAM" : "HTTP",
      status,
    );
  }
  private async requestToken(signal: AbortSignal): Promise<Token> {
    const { clientId, clientSecret } = this.credentials;
    if (!clientId)
      throw new AppError(
        "已填写 Client Secret，但 Client ID 为空。",
        "CREDENTIALS",
      );
    if (!clientSecret)
      throw new AppError(
        "已填写 Client ID，但 Client Secret 为空。",
        "CREDENTIALS",
      );
    const response = await this.request(
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
        }).toString(),
      },
      signal,
    );
    if (!response.ok) throw this.httpError(response, true);
    const data = await this.json(response);
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in)
    )
      throw new AppError(
        "Warcraft Logs 认证响应缺少有效的 Token。",
        "AUTH",
        502,
      );
    const life = Math.max(1, data.expires_in);
    const margin = Math.min(60, Math.max(5, life * 0.1));
    return {
      accessToken: data.access_token,
      expiresAt: this.now() + (life - margin) * 1000,
    };
  }
  private async getToken(signal: AbortSignal): Promise<Token> {
    if (this.token && this.token.expiresAt > this.now()) return this.token;
    if (!this.refresh) {
      const generation = this.generation;
      const pending = this.requestToken(generation.signal)
        .then((token) => {
          generation.signal.throwIfAborted();
          this.token = token;
          return token;
        })
        .finally(() => {
          if (this.refresh === pending) this.refresh = undefined;
        });
      this.refresh = pending;
    }
    return waitFor(this.refresh, signal);
  }
  async query(
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ report: unknown }> {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new AppError("查询参数无效。", "INPUT");
    const { operation, variables } = parsed.data;
    if (
      operation === "fightAbilityEvents" &&
      variables.endTime < variables.startTime
    )
      throw new AppError("事件结束时间不能早于开始时间。", "INPUT");
    const generation = this.generation.signal;
    const combined = AbortSignal.any([signal, generation]);
    for (let attempt = 0; attempt < 2; attempt++) {
      combined.throwIfAborted();
      const token = await this.getToken(combined);
      const eventVariables =
        operation === "fightAbilityEvents"
          ? (() => {
              const { abilityIds, ...event } = variables;
              return {
                ...event,
                viewOptions: event.dataType === "Casts" ? 1 : null,
                filterExpression: abilityIds
                  ? "ability.id IN (" + [...new Set(abilityIds)].join(",") + ")"
                  : null,
              };
            })()
          : variables;
      const response = await this.request(
        QUERY_ENDPOINT,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query: queries[operation],
            variables: eventVariables,
          }),
        },
        combined,
      );
      if (response.status === 401 && attempt === 0) {
        if (this.token === token) this.token = undefined;
        continue;
      }
      if (!response.ok) throw this.httpError(response);
      const data = await this.json(response);
      combined.throwIfAborted();
      if (Array.isArray(data.errors) && data.errors.length)
        throw new AppError(
          "Warcraft Logs 无法读取此报告，请确认报告存在且允许公开访问。",
          "GRAPHQL",
          400,
        );
      const report = (
        data.data as { reportData?: { report?: unknown } } | undefined
      )?.reportData?.report;
      if (!report)
        throw new AppError("找不到此报告，或没有访问权限。", "NOT_FOUND", 404);
      return { report };
    }
    throw new AppError("Warcraft Logs 认证失败，请检查凭据。", "AUTH", 401);
  }
}
