import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { statusBarFallback, unavailableReasonText } from "../../src/client/StatusBar.js";

/**
 * 组件层没有 react-dom / 测试库，跑不了真 React：这里把 hooks 与 jsx 运行时换成记账桩，
 * 状态栏的**纯逻辑**（替代行该不该渲染、原因怎么写）就能被当普通数据断言；
 * 组件内部的接线（轮询节奏、可见性门控、阈值配色）只能读源码断言。
 */
vi.mock("react", () => ({
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

/**
 * 回归锁：指标不可用要给用户看见。
 * M8-20 的原裁定是"拿不到指标就整条不渲染"，但那会让"曾经有过、后来断了"
 * 与"系统从来就不支持"长得一模一样——状态栏凭空消失，用户完全不知道为什么。
 */
describe("状态栏的指标不可用提示", () => {
  it("从未取到过样本：整条不渲染（M8-20 原裁定，不推翻）", () => {
    expect(statusBarFallback(false, "取数失败：连不上宿主")).toBeUndefined();
  });

  it("曾经可用、之后失效：给一行替代文案，原因进 title", () => {
    const fallback = statusBarFallback(true, "服务端报告当前环境不支持指标采集：非 Linux 主机");

    expect(fallback).toBeDefined();
    expect(fallback?.text).toBe("指标暂不可用");
    expect(fallback?.title).toContain("非 Linux 主机");
  });

  it("原因缺失时也要有一句能看懂的说明", () => {
    const fallback = statusBarFallback(true, undefined);

    expect(fallback?.text).toBe("指标暂不可用");
    expect(fallback?.title).toBeTruthy();
  });

  it("区分「服务端说不支持」与「请求失败」：原因写进 title", () => {
    // 服务端说 supported:false（不支持）：不是错误，是这台机器没有这套指标
    expect(unavailableReasonText({ supported: false, reason: "非 Linux 主机" }, 200, true)).toBe(
      "服务端报告当前环境不支持指标采集：非 Linux 主机",
    );
    expect(unavailableReasonText({ supported: false }, 200, true)).toBe(
      "服务端报告当前环境不支持指标采集",
    );
    // 请求失败：与"不支持"是两回事
    expect(unavailableReasonText({ error: "HTTP 404 not found" }, 404, false)).toBe(
      "取数失败：HTTP 404 not found",
    );
    expect(unavailableReasonText({ error: "unknown session" }, 500, false)).toBe(
      "取数失败（HTTP 500）：unknown session",
    );
    expect(unavailableReasonText({}, 200, true)).toBe("取数失败：宿主返回的指标数据不完整");
    expect(unavailableReasonText({}, 503, false)).toBe("取数失败（HTTP 503）");
  });
});

describe("状态栏的接线（读源码断言）", () => {
  it("轮询节奏与可见性门控没有被改动", async () => {
    const source = await readFile(new URL("../../src/client/StatusBar.tsx", import.meta.url), "utf8");

    expect(source).toContain("const POLL_INTERVAL_MS = 1000;");
    expect(source).toMatch(/if \(!active \|\| !pageVisible\) return;/);
    expect(source).toContain('addEventListener("visibilitychange"');
    // 串行自调度：请求偶尔超过 1 秒时不会叠成一堆并发请求
    expect(source).toMatch(/timer = setTimeout\(\(\) => \{\s*void tick\(\);/);
  });

  it("曾经成功过这件事由 ref 记住，且按会话区分", async () => {
    const source = await readFile(new URL("../../src/client/StatusBar.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/const everAvailable = useRef<string \| undefined>\(undefined\)/);
    expect(source).toContain("everAvailable.current = sessionId;");
  });

  it("替代行保持这一行原有的高度与上边框，且不用错误色", async () => {
    const source = await readFile(new URL("../../src/client/StatusBar.tsx", import.meta.url), "utf8");
    const fallbackBlock = source.slice(
      source.indexOf("if (sample === undefined) {"),
      source.indexOf("const line = formatMonitorLine(sample);"),
    );

    expect(fallbackBlock).toContain("statusBarFallback(");
    // 弱对比（0.5~0.6），不是错误色
    expect(fallbackBlock).toMatch(/opacity: 0\.5[0-9]?/);
    expect(fallbackBlock).not.toContain("label-error");
    // 高度与上边框与正常行共用同一份样式：终端高度不跳动
    expect(source).toMatch(
      /const ROW_STYLE: CSSProperties = \{[^}]*borderTop: "1px solid var\(--ut-border\)"[^}]*\}/s,
    );
    expect(source).toContain("...ROW_STYLE");
  });

  it("五段指标与阈值配色没有被改动", async () => {
    const source = await readFile(new URL("../../src/client/StatusBar.tsx", import.meta.url), "utf8");
    const tokens = await readFile(new URL("../../src/client/tokens.ts", import.meta.url), "utf8");

    expect(source).toContain("const segments = monitorSegments(sample);");
    expect(source).toContain("LEVEL_COLOR[segment.level]");
    // 阈值配色搬到共享的 tokens.ts（B2 地基）：状态栏不再自带一份，
    // 但取值逐字未变——搬的是"住址"，不是"配色"。
    expect(source).toContain('from "./tokens.js"');
    expect(tokens).toContain('"var(--dsw-alias-label-success, #3fb950)"');
    expect(tokens).toContain('"var(--dsw-alias-label-warning, #d9a536)"');
    expect(tokens).toContain('"var(--dsw-alias-label-error, #e5534b)"');
  });
});
