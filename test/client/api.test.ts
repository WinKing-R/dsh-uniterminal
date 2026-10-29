import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, errorText, requestJson, type ApiError, type ApiResult } from "../../src/client/api.js";
import { reportClient } from "../../src/client/report.js";
import {
  COLOR_DANGER,
  COLOR_INFO,
  COLOR_SUCCESS,
  COLOR_WARNING,
  GROUP_COLOR_FALLBACK,
  KEY_ICON_COLOR,
  LEVEL_COLOR,
} from "../../src/client/tokens.js";
import { SELECT_STYLE } from "../../src/client/ui.js";

/**
 * B2 地基：共享请求层（api.ts）、语义色单一来源（tokens.ts）、共享控件样式（ui.ts）、统一事件上报（report.ts）。
 *
 * 这些是"地基"，所以测试锁的是**契约**而不是实现细节：
 *
 * - 请求层永不抛错：网络异常、非法 JSON、非 2xx 一律变成 ok:false。
 *   面板里的调用点各自写好了失败文案，请求层再抛一次只会让调用点漏分支。
 * - 失败必须结构化：message（文案）/ status（状态码）/ code（失败分类）/ payload（整个响应体）。
 *   建会话失败时宿主回 `{ error, code, host?, port?, fingerprint? }`，
 *   hostkey 那一档的文案已被改成中文，**靠文案猜失败类型就会丢三元组**——
 *   所以 code 与 payload 必须原样带出来。
 * - 语义色只有一处定义：取值与旧值逐字一致（同一个宿主变量名、同一个 fallback 十六进制），
 *   这样搬家不改观感。
 * - 上报的 payload 里可能混进凭据：password / passphrase / privateKey / secret 一律丢弃。
 */

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

const calls: RecordedCall[] = [];

/** 拦下 fetch 并记录调用；handler 决定这次请求返回什么（或怎么失败）。 */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): void {
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers as unknown as Record<string, string> | undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return handler(String(input), init);
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function expectOk<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error("期望成功，实际失败：" + result.error.message);
  return result.data;
}

function expectFail<T>(result: ApiResult<T>): ApiError {
  if (result.ok) throw new Error("期望失败，实际成功");
  return result.error;
}

function firstCall(): RecordedCall {
  const call = calls[0];
  if (call === undefined) throw new Error("没有发出任何请求");
  return call;
}

describe("api：成功路径", () => {
  it("2xx 返回 ok:true 与解析后的数据", async () => {
    stubFetch(async () => jsonResponse(200, { profiles: [{ id: "p1" }], groups: [] }));
    const data = expectOk(
      await api.get<{ profiles: { id: string }[]; groups: unknown[] }>("/api/uniterminal/profiles"),
    );
    expect(data.profiles).toEqual([{ id: "p1" }]);
    expect(data.groups).toEqual([]);
  });

  it("请求的是给定的路径与方法", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    await api.get("/api/uniterminal/profiles");
    expect(firstCall().url).toBe("/api/uniterminal/profiles");
    expect(firstCall().method).toBe("GET");
  });
});

describe("api：失败路径永远不抛错", () => {
  it("非 2xx 返回 ok:false，带 message / status / code", async () => {
    stubFetch(async () =>
      jsonResponse(500, { error: "uniterminal: 建会话失败", code: "refused" }),
    );
    const error = expectFail(
      await requestJson("POST", "/api/uniterminal/sessions", { id: "p1" }),
    );
    expect(error.message).toBe("uniterminal: 建会话失败");
    expect(error.status).toBe(500);
    expect(error.code).toBe("refused");
  });

  it("响应体没有 error 时退回 HTTP 状态码的文本，code 为 undefined", async () => {
    stubFetch(async () => jsonResponse(503, { note: "忙" }));
    const error = expectFail(await api.get("/api/uniterminal/monitor"));
    expect(error.message).toBe("HTTP 503");
    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
  });

  it("响应体不是 JSON 也不抛错（宿主对未知路径的兜底是纯文本）", async () => {
    stubFetch(async () => textResponse(404, "not found"));
    const error = expectFail(await api.get("/api/uniterminal/不存在"));
    expect(error.message).toBe("HTTP 404 not found");
    expect(error.status).toBe(404);
  });

  it("2xx 但响应体不是 JSON 时也不当成成功", async () => {
    stubFetch(async () => textResponse(200, "not found"));
    const error = expectFail(await api.get("/api/uniterminal/未知"));
    expect(error.message).toBe("HTTP 200 not found");
    expect(error.status).toBe(200);
  });

  it("网络异常不抛错：连不上宿主时 status 为 0", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = expectFail(await api.get("/api/uniterminal/profiles"));
    expect(error.status).toBe(0);
    expect(error.message).toBe("Failed to fetch");
  });

  it("宿主用 200 回业务失败（ok:false）时也算失败——/profiles/test 就是这个形状", async () => {
    stubFetch(async () => jsonResponse(200, { ok: false, error: "认证失败", ms: 12, code: "auth" }));
    const error = expectFail(await api.post("/api/uniterminal/profiles/test", { id: "p1" }));
    expect(error.message).toBe("认证失败");
    expect(error.status).toBe(200);
    expect(error.code).toBe("auth");
  });
});

describe("api：结构化字段与请求体", () => {
  it("code 从响应体取，payload 保留整个响应体（host/port/fingerprint 从这里取）", async () => {
    stubFetch(async () =>
      jsonResponse(500, {
        error: "未知主机指纹",
        code: "hostkey",
        host: "example.com",
        port: 22,
        fingerprint: "SHA256:abc",
      }),
    );
    const error = expectFail(await api.post("/api/uniterminal/sessions", { id: "p1" }));
    expect(error.code).toBe("hostkey");
    expect(error.payload).toEqual({
      error: "未知主机指纹",
      code: "hostkey",
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:abc",
    });
  });

  it("只在需要时发请求体：GET / DELETE 不带 body，也不带 content-type", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    await api.get("/api/uniterminal/profiles");
    expect(firstCall().body).toBeUndefined();
    expect(firstCall().headers).toBeUndefined();

    calls.length = 0;
    await api.del("/api/uniterminal/profiles/p1");
    expect(firstCall().method).toBe("DELETE");
    expect(firstCall().body).toBeUndefined();
    expect(firstCall().headers).toBeUndefined();
  });

  it("GET 即便硬塞了 body 也不发", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    await requestJson("GET", "/api/uniterminal/profiles", { a: 1 });
    expect(firstCall().body).toBeUndefined();
    expect(firstCall().headers).toBeUndefined();
  });

  it("POST 带 body 时才发 body 与 content-type", async () => {
    stubFetch(async () => jsonResponse(201, { id: "p1" }));
    await api.post("/api/uniterminal/profiles", { id: "p1", host: "example.com" });
    expect(firstCall().body).toBe(JSON.stringify({ id: "p1", host: "example.com" }));
    expect(firstCall().headers).toEqual({ "content-type": "application/json" });
  });

  it("POST 不给 body 时不发请求体", async () => {
    stubFetch(async () => jsonResponse(200, {}));
    await api.post("/api/uniterminal/sessions");
    expect(firstCall().body).toBeUndefined();
    expect(firstCall().headers).toBeUndefined();
  });

  it("错误信息里绝不夹带请求体（请求体里可能有凭据）", async () => {
    stubFetch(async () => jsonResponse(500, { error: "uniterminal: boom" }));
    const error = expectFail(
      await api.post("/api/uniterminal/sessions", { id: "p1", password: "hunter2" }),
    );
    expect(error.message).not.toContain("hunter2");
    expect(JSON.stringify(error)).not.toContain("hunter2");
  });
});

describe("api：errorText", () => {
  it("字符串原样取出", () => {
    expect(errorText("连不上宿主")).toBe("连不上宿主");
  });

  it("错误对象取 message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("带 message 字段的普通对象取 message", () => {
    expect(errorText({ message: "读不到响应体" })).toBe("读不到响应体");
  });

  it("认不出来的东西给可读兜底，不把整个对象转字符串", () => {
    expect(errorText({ detail: "…" })).toBe("未知错误");
    expect(errorText(undefined)).toBe("未知错误");
    expect(errorText(null)).toBe("未知错误");
  });
});

describe("report：统一的事件上报", () => {
  it("上报体是摊平的 { event, ...payload }", () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    reportClient("client.ws-open", { sessionId: "s1", url: "ws://127.0.0.1/ws/s1" });
    expect(firstCall().url).toBe("/api/uniterminal/diag");
    expect(firstCall().method).toBe("POST");
    expect(JSON.parse(firstCall().body ?? "{}")).toEqual({
      event: "client.ws-open",
      sessionId: "s1",
      url: "ws://127.0.0.1/ws/s1",
    });
  });

  it("payload 里的凭据字段一律丢弃（大小写不敏感，含变体）", () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    reportClient("client.auth", {
      password: "hunter2",
      PassPhrase: "口诀",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      secret: "s3cret",
      userPassword: "another",
      sshPassphrase: "yet-another",
      keep: "留下的",
    });
    const body = JSON.parse(firstCall().body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ event: "client.auth", keep: "留下的" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("BEGIN OPENSSH");
  });

  it("嵌套一层里的凭据同样出不去", () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    reportClient("client.auth", {
      auth: { passphrase: "口诀", kind: "password" },
      list: [{ privateKey: "pk" }],
      ok: 1,
    });
    const body = JSON.parse(firstCall().body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      event: "client.auth",
      auth: { kind: "password" },
      list: [{}],
      ok: 1,
    });
  });

  it("上报失败绝不影响界面：fetch 抛错也不往上抛", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("no network");
    });
    expect(() => reportClient("client.ws-open", { sessionId: "s1" })).not.toThrow();
  });

  it("上报失败绝不影响界面：fetch 拒绝也不往上抛", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));
    expect(() => reportClient("client.ws-open", { sessionId: "s1" })).not.toThrow();
    await Promise.resolve();
  });
});

describe("tokens：语义色的单一来源", () => {
  it("四个语义色与旧值逐字一致", () => {
    expect(COLOR_SUCCESS).toBe("var(--dsw-alias-label-success, #3fb950)");
    expect(COLOR_WARNING).toBe("var(--dsw-alias-label-warning, #d9a536)");
    expect(COLOR_DANGER).toBe("var(--dsw-alias-label-error, #e5534b)");
    expect(COLOR_INFO).toBe("var(--dsw-alias-label-info, #5a8dee)");
  });

  it("私钥古铜色与分组兜底色与旧值逐字一致", () => {
    expect(KEY_ICON_COLOR).toBe("#b87333");
    expect(GROUP_COLOR_FALLBACK).toBe("#d6dde4");
  });

  it("监控三档与旧值逐字一致（ok / warn / danger）", () => {
    expect(LEVEL_COLOR).toEqual({
      ok: "var(--dsw-alias-label-success, #3fb950)",
      warn: "var(--dsw-alias-label-warning, #d9a536)",
      danger: "var(--dsw-alias-label-error, #e5534b)",
    });
  });
});

describe("ui：共享的控件样式", () => {
  const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

  it("SELECT_STYLE 与两个面板现有的写法逐字一致", () => {
    expect(SELECT_STYLE).toEqual({
      padding: "4px 6px",
      font: "inherit",
      color: "inherit",
      background: "transparent",
      border: "1px solid var(--ut-border)",
      borderRadius: 4,
    });
  });

  it("TunnelPanel 与 AppearancePanel 现有的内联写法与 ui.ts 等价（改成导入后本断言自动跳过）", async () => {
    // 只取对象字面量本体：ui.ts 多一个 ": CSSProperties" 类型标注，属性必须逐字相同
    const blockOf = (source: string): string | undefined => {
      const start = source.indexOf("const SELECT_STYLE");
      if (start < 0) return undefined;
      const brace = source.indexOf("{", start);
      const end = source.indexOf("};", start);
      if (brace < 0 || end < 0) return undefined;
      return source.slice(brace, end + 2).replace(/\s+/g, " ");
    };
    const uiBlock = blockOf(await read("../../src/client/ui.ts"));
    expect(uiBlock).toBeDefined();
    for (const file of ["TunnelPanel.tsx", "AppearancePanel.tsx"]) {
      const block = blockOf(await read("../../src/client/" + file));
      if (block === undefined) continue;
      expect(block).toBe(uiBlock);
    }
  });
});
