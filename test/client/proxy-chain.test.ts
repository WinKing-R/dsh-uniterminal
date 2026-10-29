import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

/**
 * 建会话请求里的两件要事。
 *
 * ① 跳板链（P0-9）：从主机列表点「连接」时，请求体必须带 proxyChain，
 *    否则带跳板机的主机会**绕过跳板机直连**（测试连通性那条路有跳板，真正建会话那条路没有）。
 * ② 未知主机指纹（P0-6 前端侧）：优先读响应体的结构化字段，读不到才退回英文原文里的正则。
 *
 * 组件层没有 react-dom / 测试库（也不允许为断言装依赖）：这里把 hooks 与 jsx 运行时换成记账桩，
 * 于是两个**纯函数**（proxyChainFor / parseUnknownHostKey）能被当普通数据断言；
 * 「请求体长什么样」这种接线部分读源码断言。
 */
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useRef: () => ({ current: undefined }),
  useState: () => [undefined, () => undefined],
}));
vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));
vi.mock("react/jsx-dev-runtime", () => ({
  jsxDEV: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));

import { parseUnknownHostKey, proxyChainFor, snapshotProxyChainFor } from "../../src/client/UniterminalTab.js";

const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

describe("建会话请求带跳板链（P0-9）", () => {
  it("请求体里的字段名是 proxyChain，不是 proxyJump", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    // 宿主只认 proxyChain（routes.ts 的 parseProfile 读的就是这个名字）
    expect(source).toContain("profile.proxyChain = proxyChain");
    expect(source).not.toContain("profile.proxyJump");
  });

  it("只有非空数组才带这个字段（后端缺省即直连）", async () => {
    // 空数组 / 缺字段 → undefined = 请求里不带 proxyChain
    expect(proxyChainFor(undefined)).toBeUndefined();
    expect(proxyChainFor({ id: "a", name: "a", kind: "ssh", groupId: null })).toBeUndefined();
    expect(proxyChainFor({ id: "a", name: "a", kind: "ssh", groupId: null, proxyJump: [] })).toBeUndefined();
  });

  it("原样透传跳板项字符串（不重新拼 user@host:port）", () => {
    const hops = ["root@jump1.example.com:22", "ops@jump2.example.com:2222"];
    const profile = { id: "a", name: "a", kind: "ssh", groupId: null, proxyJump: hops };

    // 原样：同一个数组，内容与顺序都不动
    expect(proxyChainFor(profile)).toEqual(hops);
    expect(proxyChainFor(profile)).toBe(hops);
  });

  it("建会话请求在 profile 里带上这条链", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("const proxyChain = proxyChainFor(selected);");
    expect(source).toContain("if (proxyChain !== undefined) profile.proxyChain = proxyChain;");
    // 请求体就是这份 profile：{ profile }（请求改走 api.ts，**请求体形状一个字都没变**）
    expect(source).toContain('api.post<CreateSessionResponse>("/api/uniterminal/sessions", { profile })');
  });

  it("宿主侧两条路子的字段名一致（存档 proxyJump / 请求 proxyChain）", async () => {
    const routes = await read("../../src/routes.ts");

    // 建会话：读 proxyChain
    expect(routes).toContain('optionalStringArray(profile, "proxyChain")');
    // 存档：存 proxyJump
    expect(routes).toContain('proxyJump: optionalStringArray(raw, "proxyJump")');
    // 测试连通性那条路早就带上跳板链了（所以「连通」不等于「直连也通」）
    expect(routes).toContain("proxyChain: stored.proxyJump");
  });
});

/**
 * 复制会话这条路上的跳板链（M59 残留）。
 *
 * 病根：复制会话靠**会话快照**重连，而快照的白名单 sanitizeProfileSnapshot
 * 里没有 proxyJump → 快照里根本没有跳板信息 → 复制出来的会话必然直连。
 * 现在白名单放行 proxyJump（它不是凭据，是连接路径），
 * duplicateSession 再把它原样转成请求里的 proxyChain。
 */
describe("复制会话也带跳板链（快照白名单放行 proxyJump）", () => {
  it("快照里的 proxyJump 原样转成请求里的 proxyChain", () => {
    const hops = ["ops@jump1.example.com:2222", "jump2.internal"];

    expect(snapshotProxyChainFor({ proxyJump: hops })).toEqual(hops);
    expect(snapshotProxyChainFor({ proxyJump: hops })).toBe(hops);
  });

  it("只有非空数组才带（缺/空一律 undefined = 请求里不带 proxyChain）", () => {
    expect(snapshotProxyChainFor(undefined)).toBeUndefined();
    expect(snapshotProxyChainFor({})).toBeUndefined();
    expect(snapshotProxyChainFor({ proxyJump: [] })).toBeUndefined();
  });

  it("复制会话的请求体里带 proxyChain（字段名必须是 proxyChain）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("const proxyChain = snapshotProxyChainFor(snapshot);");
    expect(source).toContain('request["proxyChain"] = proxyChain;');
  });

  it("连接时就把跳板链存进白名单快照（不然快照里根本没有它）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("proxyJump: selected.proxyJump");
  });

  it("白名单放行 proxyJump（sanitizeProfileSnapshot 里有它）", async () => {
    const rightPane = await read("../../src/client/right-pane.ts");

    expect(rightPane).toContain("snapshot.proxyJump = proxyJump;");
  });

  it("复制会话的请求体里仍然一个凭据都没有", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const at = source.indexOf("const duplicateSession");
    const body = source.slice(at, source.indexOf("}, [activeEntry, duplicating]);", at));

    expect(body).not.toContain("password");
    expect(body).not.toContain("privateKey");
    expect(body).not.toContain("passphrase");
  });
});

describe("未知主机指纹：结构化字段优先（P0-6 前端侧）", () => {
  it("有结构化字段时直接用它", () => {
    const trust = parseUnknownHostKey({
      code: "hostkey",
      host: "10.0.0.5",
      port: 2222,
      fingerprint: "SHA256:structured",
      error: "主机指纹未知，请先确认",
    });

    expect(trust).toEqual({ host: "10.0.0.5", port: 2222, fingerprint: "SHA256:structured" });
  });

  it("端口是数字串也照样认", () => {
    const trust = parseUnknownHostKey({ host: "10.0.0.5", port: "2222", fingerprint: "SHA256:x" });

    expect(trust).toEqual({ host: "10.0.0.5", port: 2222, fingerprint: "SHA256:x" });
  });

  it("读不到结构化字段时退回英文原文里的正则（老宿主兼容）", () => {
    const trust = parseUnknownHostKey({ error: "unknown host key for 10.0.0.5:2222 (SHA256:legacy)" });

    expect(trust).toEqual({ host: "10.0.0.5", port: 2222, fingerprint: "SHA256:legacy" });
  });

  it("结构化字段齐全时优先于原文里的另一组三元组", () => {
    const trust = parseUnknownHostKey({
      host: "10.0.0.5",
      port: 22,
      fingerprint: "SHA256:new",
      error: "unknown host key for 1.1.1.1:22 (SHA256:old)",
    });

    expect(trust).toEqual({ host: "10.0.0.5", port: 22, fingerprint: "SHA256:new" });
  });

  it("三者缺一不可：缺任何一个都不给「信任该主机并重试」按钮", () => {
    // 缺 fingerprint
    expect(parseUnknownHostKey({ host: "10.0.0.5", port: 22 })).toBeUndefined();
    // host 是空串
    expect(parseUnknownHostKey({ host: "  ", port: 22, fingerprint: "SHA256:x" })).toBeUndefined();
    // 端口不是数字
    expect(parseUnknownHostKey({ host: "10.0.0.5", port: "abc", fingerprint: "SHA256:x" })).toBeUndefined();
    // 什么都没有
    expect(parseUnknownHostKey({})).toBeUndefined();
    expect(parseUnknownHostKey(undefined)).toBeUndefined();
  });

  it("调用点传的是整个响应体（结构化优先）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("setPendingTrust(parseUnknownHostKey(payload));");
  });

  it("老正则仍然留着（兼容只回英文原文的旧宿主）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("/unknown host key for (.+):(\\d+) \\(([^)]+)\\)/");
  });
});
