import { expect, it, vi } from "vitest";
import {
  WclClient,
  TOKEN_ENDPOINT,
  QUERY_ENDPOINT,
} from "../../../src/main/wcl/client";
import { reply } from "../../../src/main/errors";
const defaults = { clientId: "built-in-id", clientSecret: "built-in-secret" };
const payload = {
  operation: "reportFights",
  variables: { reportCode: "abc" },
} as const;
const signal = () => new AbortController().signal;
const tokenResponse = (token = "test-token", expires = 3600) =>
  Response.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: expires,
  });
const reportResponse = () =>
  Response.json({ data: { reportData: { report: { fights: [] } } } });

it("本机直接请求原 app 的固定 WCL 地址，共享并发 Token 刷新", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT ? tokenResponse() : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher);
  await Promise.all([
    client.query(payload, signal()),
    client.query(payload, signal()),
  ]);
  expect(
    fetcher.mock.calls.filter(([url]) => url === TOKEN_ENDPOINT),
  ).toHaveLength(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(TOKEN_ENDPOINT);
  expect(init?.body).toBe("grant_type=client_credentials");
  expect((init?.headers as Record<string, string>).Authorization).toBe(
    `Basic ${Buffer.from("built-in-id:built-in-secret").toString("base64")}`,
  );
  expect(fetcher.mock.calls[1][0]).toBe(QUERY_ENDPOINT);
});
it("Token 提前过期刷新，用户修改凭据后立即更换认证身份", async () => {
  let now = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT ? tokenResponse() : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher, () => now);
  await client.query(payload, signal());
  now = 3540000;
  await client.query(payload, signal());
  client.setCredentials({
    clientId: "custom-id",
    clientSecret: "custom-secret",
  });
  await client.query(payload, signal());
  const auth = fetcher.mock.calls.filter(([url]) => url === TOKEN_ENDPOINT);
  expect(auth).toHaveLength(3);
  expect((auth[2][1]?.headers as Record<string, string>).Authorization).toBe(
    `Basic ${Buffer.from("custom-id:custom-secret").toString("base64")}`,
  );
});
it.each([
  { clientId: "", clientSecret: "secret" },
  { clientId: "id", clientSecret: "" },
])("不完整自定义凭据不会回退内置凭据：%j", async (custom) => {
  const fetcher = vi.fn();
  const client = new WclClient(defaults, fetcher);
  client.setCredentials(custom);
  await expect(client.query(payload, signal())).rejects.toThrow("为空");
  expect(fetcher).not.toHaveBeenCalled();
});
it("自定义凭据认证失败不会回退，错误不透传上游 Secret", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ error_description: "custom-secret" }, { status: 401 }),
  );
  const client = new WclClient(defaults, fetcher);
  client.setCredentials({
    clientId: "custom-id",
    clientSecret: "custom-secret",
  });
  const result = await reply(() => client.query(payload, signal()));
  expect(result).toMatchObject({
    ok: false,
    error: { code: "AUTH", status: 401 },
  });
  expect(JSON.stringify(result)).not.toContain("custom-secret");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("两项均清空恢复内置凭据", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT ? tokenResponse() : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher);
  client.setCredentials({ clientId: "", clientSecret: "" });
  await client.query(payload, signal());
  expect(
    (fetcher.mock.calls[0][1]?.headers as Record<string, string>).Authorization,
  ).toBe(
    `Basic ${Buffer.from("built-in-id:built-in-secret").toString("base64")}`,
  );
});
it("仅接受固定操作，验证时间范围，不向上游发送任意 GraphQL", async () => {
  const fetcher = vi.fn();
  const client = new WclClient(defaults, fetcher);
  await expect(
    client.query({ operation: "arbitrary", query: "secret" }, signal()),
  ).rejects.toThrow("参数");
  await expect(
    client.query(
      {
        operation: "fightAbilityEvents",
        variables: {
          reportCode: "abc",
          fightId: 1,
          startTime: 10,
          endTime: 1,
          dataType: "Casts",
          hostilityType: "Enemies",
        },
      },
      signal(),
    ),
  ).rejects.toThrow("结束时间");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["Casts", "Buffs", "Debuffs"] as const)(
  "%s 的宠物施法查询标记和原 app 相同",
  async (dataType) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      url === TOKEN_ENDPOINT ? tokenResponse() : reportResponse(),
    );
    const client = new WclClient(defaults, fetcher);
    await client.query(
      {
        operation: "fightAbilityEvents",
        variables: {
          reportCode: "abc",
          fightId: 1,
          startTime: 0,
          endTime: 10,
          dataType,
          hostilityType: "Friendlies",
        },
      },
      signal(),
    );
    expect(
      JSON.parse(fetcher.mock.calls[1][1]!.body as string).variables
        .viewOptions,
    ).toBe(dataType === "Casts" ? 1 : null);
  },
);
it("技能搜索只将验证后的技能 ID 编译为上游过滤，不传递任意表达式", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT ? tokenResponse() : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher);
  const search = {
    operation: "fightAbilityEvents",
    variables: {
      reportCode: "abc",
      fightId: 1,
      startTime: 0,
      endTime: 10,
      dataType: "Buffs",
      hostilityType: "Friendlies",
      abilityIds: [31821, 62618, 31821],
    },
  } as const;
  await client.query(search, signal());
  const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  expect(body.query).toContain("filterExpression: $filterExpression");
  expect(body.variables.filterExpression).toBe("ability.id IN (31821,62618)");
  expect(body.variables).not.toHaveProperty("abilityIds");
  const before = fetcher.mock.calls.length;
  for (const abilityIds of [
    [],
    [0],
    [-1],
    ["31821"],
    Array.from({ length: 101 }, (_, index) => index + 1),
  ])
    await expect(
      client.query(
        { ...search, variables: { ...search.variables, abilityIds } },
        signal(),
      ),
    ).rejects.toThrow("参数");
  await expect(
    client.query(
      {
        ...search,
        variables: { ...search.variables, filterExpression: "true" },
      },
      signal(),
    ),
  ).rejects.toThrow("参数");
  expect(fetcher).toHaveBeenCalledTimes(before);
});
it("API 401 只重新获取一次 Token，后续失败正常返回", async () => {
  let api = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT
      ? tokenResponse()
      : ++api === 1
        ? new Response(null, { status: 401 })
        : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher);
  await client.query(payload, signal());
  expect(
    fetcher.mock.calls.filter(([url]) => url === TOKEN_ENDPOINT),
  ).toHaveLength(2);
  expect(api).toBe(2);
});
it("并发请求中一项取消，不影响其他请求等待共享 Token", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : reportResponse(),
  );
  const client = new WclClient(defaults, fetcher);
  const abort = new AbortController();
  const first = client.query(payload, abort.signal);
  const second = client.query(payload, signal());
  abort.abort();
  await expect(first).rejects.toThrow();
  finish(tokenResponse());
  await expect(second).resolves.toEqual({ report: { fights: [] } });
});
it("上游限流返回可重试时间，GraphQL 错误不冒充空成功", async () => {
  let limited = true;
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    url === TOKEN_ENDPOINT
      ? tokenResponse()
      : limited
        ? new Response(null, { status: 429, headers: { "Retry-After": "8" } })
        : Response.json({ errors: [{ message: "sensitive details" }] }),
  );
  const client = new WclClient(defaults, fetcher);
  await expect(client.query(payload, signal())).rejects.toMatchObject({
    status: 429,
    retryAfter: 8000,
  });
  limited = false;
  await expect(client.query(payload, signal())).rejects.toMatchObject({
    code: "GRAPHQL",
  });
});
