import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_DISMISS_MS, useAutoDismiss } from "../../src/client/use-auto-dismiss.js";
import { noticeClassName, noticeLiveProps, useNotice } from "../../src/client/notice.js";
import { uploadResultsView } from "../../src/client/SftpPanel.js";

/**
 * 迷你 React 运行时。
 *
 * 本包没有 react/react-dom 运行时（也不允许为断言装依赖），
 * 这里手写一个够用的 hook 宿主：useState / useCallback / useRef / useEffect 记账成普通数据，
 * 于是「提示是成功还是失败」「6 秒倒计时还准不准」能被当普通断言跑，而不是只看源码。
 */
const runtime = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    deps?: unknown[];
    cleanup?: (() => void) | undefined;
  }
  interface PendingEffect {
    index: number;
    run: () => (() => void) | undefined;
    changed: boolean;
  }

  const ctx = {
    slots: [] as Slot[],
    cursor: 0,
    pending: [] as PendingEffect[],
    rendering: false,
    dirty: false,
    schedule: undefined as (() => void) | undefined,
  };

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined): boolean => {
    if (a === undefined || b === undefined) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  };

  const useState = <T,>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
    const index = ctx.cursor++;
    const slot = (ctx.slots[index] ??= {
      value: typeof initial === "function" ? (initial as () => T)() : initial,
    });
    const setState = (next: T | ((prev: T) => T)): void => {
      const current = slot.value as T;
      const value = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      if (Object.is(value, current)) return;
      slot.value = value;
      ctx.dirty = true;
      if (!ctx.rendering) ctx.schedule?.();
    };
    return [slot.value as T, setState];
  };

  const useRef = <T,>(initial: T): { current: T } => {
    const index = ctx.cursor++;
    const slot = (ctx.slots[index] ??= { value: { current: initial } });
    return slot.value as { current: T };
  };

  const useCallback = <T,>(fn: T, deps: unknown[]): T => {
    const index = ctx.cursor++;
    const slot = (ctx.slots[index] ??= {});
    if (!sameDeps(slot.deps, deps)) {
      slot.value = fn;
      slot.deps = deps;
    }
    return slot.value as T;
  };

  const useEffect = (run: () => (() => void) | undefined, deps?: unknown[]): void => {
    const index = ctx.cursor++;
    const slot = (ctx.slots[index] ??= {});
    const changed = !sameDeps(slot.deps, deps);
    slot.deps = deps;
    ctx.pending.push({ index, run, changed });
  };

  return { ctx, useState, useRef, useCallback, useEffect };
});

vi.mock("react", () => ({
  useState: runtime.useState,
  useRef: runtime.useRef,
  useCallback: runtime.useCallback,
  useEffect: runtime.useEffect,
}));

/**
 * jsx 运行时换成记账桩：DOM 用例要断言的是"属性对、文字进了哪个容器"。
 * jsdom 不会真的播报，所以这一层只能验这两件事——播报本身只能靠真人 + 读屏软件验。
 */
vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));
vi.mock("react/jsx-dev-runtime", () => ({
  jsxDEV: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));

interface Harness<T> {
  /** 最近一次渲染的返回值。 */
  readonly current: T;
  /** 再渲染一次：模拟父组件重渲染（每次都会产生新的箭头函数）。 */
  rerender: () => void;
  /** 卸载：跑掉所有 effect 的清理。 */
  unmount: () => void;
}

/** 把一个 hook 挂到迷你运行时上：能渲染、能重渲染、能卸载。 */
function renderHook<T>(hook: () => T): Harness<T> {
  const { ctx } = runtime;
  ctx.slots = [];
  ctx.cursor = 0;
  ctx.pending = [];
  ctx.dirty = false;
  let result: T;
  let renders = 0;

  const commit = (): void => {
    const pending = ctx.pending;
    ctx.pending = [];
    for (const item of pending) {
      if (!item.changed) continue;
      const slot = ctx.slots[item.index];
      slot?.cleanup?.();
      if (slot !== undefined) slot.cleanup = item.run();
    }
  };

  const render = (): void => {
    renders += 1;
    if (renders > 100) throw new Error("渲染次数失控：某个 effect 在不停地改状态");
    ctx.rendering = true;
    ctx.cursor = 0;
    ctx.pending = [];
    try {
      result = hook();
    } finally {
      ctx.rendering = false;
    }
    commit();
  };

  const flush = (): void => {
    let guard = 0;
    while (ctx.dirty) {
      ctx.dirty = false;
      render();
      guard += 1;
      if (guard > 100) throw new Error("状态更新没有收敛");
    }
  };

  ctx.schedule = flush;
  render();
  flush();

  return {
    get current(): T {
      return result;
    },
    rerender: () => {
      render();
      flush();
    },
    unmount: () => {
      for (const slot of ctx.slots) slot.cleanup?.();
      ctx.schedule = undefined;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 回归锁：一次性提示必须区分成功与失败。
 * 早先四个面板各有一套 notice state，"成功"与"失败"共用同一个字符串 state，
 * 于是「已删除 X」「已导入 N 台主机」「已保存配置」这些**成功反馈也是红的**。
 */
describe("共享的一次性提示模型（notice.ts）", () => {
  it("setNotice 是失败语义、setOk 是成功语义", () => {
    const h = renderHook(() => useNotice());

    expect(h.current.notice).toBeUndefined();
    h.current.setNotice("删除失败：连接被拒");
    expect(h.current.notice).toEqual({ text: "删除失败：连接被拒", kind: "error" });
    h.current.setOk("已删除 X");
    expect(h.current.notice).toEqual({ text: "已删除 X", kind: "ok" });
    h.current.clear();
    expect(h.current.notice).toBeUndefined();
  });

  it("三个动作都是稳定引用：否则计时器会跟着每次渲染重建", () => {
    const h = renderHook(() => useNotice());
    const first = h.current;

    h.rerender();

    expect(h.current.setNotice).toBe(first.setNotice);
    expect(h.current.setOk).toBe(first.setOk);
    expect(h.current.clear).toBe(first.clear);
  });

  it("6 秒后自动过期，规则仍然只有一个来源", () => {
    vi.useFakeTimers();
    const h = renderHook(() => useNotice());

    h.current.setOk("已保存配置");
    expect(h.current.notice).not.toBeUndefined();
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(h.current.notice).not.toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(h.current.notice).toBeUndefined();
  });
});

/**
 * 回归锁：一次性提示可能永不过期。
 * 调用点每次渲染都传一个新的箭头函数（`() => setNotice(undefined)`），
 * 它一旦进了 useAutoDismiss 的依赖数组，父组件每重渲染一次就重建 6 秒计时器。
 */
describe("过期倒计时（use-auto-dismiss.ts）", () => {
  it("clear 的身份变化不得影响倒计时：重渲染不能把 6 秒重新开始", () => {
    vi.useFakeTimers();
    const cleared: string[] = [];
    // 每次渲染都是一个新的箭头函数——正是四个面板现在的写法
    const h = renderHook(() =>
      useAutoDismiss(true, () => {
        cleared.push("clear");
      }),
    );

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    h.rerender();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    // 满 6 秒准时清掉，而不是被一次次重渲染无限推迟
    expect(cleared).toEqual(["clear"]);
  });

  it("计时器由本 hook 独占：卸载即清理", () => {
    vi.useFakeTimers();
    const cleared: string[] = [];
    const h = renderHook(() =>
      useAutoDismiss(true, () => {
        cleared.push("clear");
      }),
    );

    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 2);
    expect(cleared).toEqual([]);
  });
});

/**
 * 回归锁：提示的颜色绑定语义——成功不能是红的。
 * 成功色必须与主机列表的 COLOR_SUCCESS 同一个宿主变量。
 */
describe("提示的 CSS 契约（tab.module.css）", () => {
  it("成功提示有独立的成功色，错误提示仍是 .uniterminal-notice", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // B4 起颜色走语义令牌：规则里是 var(--ut-…)，令牌背后仍是那个宿主变量。
    // 两段都锁，才既防"令牌指向了别的变量"，也防"规则压根没用令牌"。
    expect(css).toMatch(/\.uniterminal-notice-ok \{[^}]*color: var\(--ut-success\);[^}]*\}/s);
    expect(css).toContain("--ut-success: var(--dsw-alias-label-success, #3fb950);");
    // 错误红没动
    expect(css).toMatch(/\.uniterminal-notice \{[^}]*color: var\(--ut-danger\);[^}]*\}/s);
    expect(css).toContain("--ut-danger: var(--dsw-alias-label-error, #e5534b);");
    // 类名由 kind 决定，不能反了
    expect(noticeClassName("ok")).toBe("uniterminal-notice uniterminal-notice-ok");
    expect(noticeClassName("error")).toBe("uniterminal-notice");
  });

  it("工具栏按钮补了 align-self，既有声明一个都没动", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-toolbar > button \{[^}]*align-self: center;[^}]*\}/s);
    expect(css).toMatch(
      /\.uniterminal-toolbar > button \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;[^}]*\}/s,
    );
  });

  it("6 秒过期规则只有一个来源：notice.ts 不另写时长常量", async () => {
    const source = await readFile(new URL("../../src/client/notice.ts", import.meta.url), "utf8");

    expect(AUTO_DISMISS_MS).toBe(6000);
    expect(source).not.toContain("6000");
  });
});

/* ===================== B5 无障碍：让读屏软件能听见提示 ===================== */

/**
 * 回归锁：kind → live region 的语义映射。
 *
 * 成功与失败的**打断强度**必须不同：
 * - 成功等用户把当前这句读完（status / polite）；
 * - 失败立刻打断（alert / assertive）——密码错了、列表加载不出来，
 *   用户晚一秒知道就是在错误的方向上多走一步。
 *
 * 这两种映射就是提示模型的一部分：和 noticeClassName 一样只能有一个来源，
 * 否则四个面板迟早各写一套。纯函数才好在这里钉死。
 */
describe("提示的 live region 语义（noticeLiveProps）", () => {
  it("成功 = status/polite：等用户现在这句朗读完", () => {
    expect(noticeLiveProps("ok")).toEqual({ role: "status", "aria-live": "polite" });
  });

  it("失败 = alert/assertive：立刻打断", () => {
    expect(noticeLiveProps("error")).toEqual({ role: "alert", "aria-live": "assertive" });
  });
});

/** 有提示容器的那几个文件（这一轮允许触碰的全部）。 */
const LIVE_FILES = [
  "HostListView.tsx",
  "UniterminalTab.tsx",
  "SftpPanel.tsx",
  "AppearancePanel.tsx",
  "TunnelPanel.tsx",
] as const;

const readSource = (name: string): Promise<string> =>
  readFile(new URL("../../src/client/" + name, import.meta.url), "utf8");

/**
 * 回归锁：容器必须**常驻**。
 *
 * `{err && <div role="alert">…}` 是无效的：读屏软件只在"已有节点的内容变化"时播报，
 * 节点刚插入的那一帧往往被整条漏掉——错误于是对读屏用户完全静音。
 * 正确形态是外层容器永远在 DOM 里（role/aria-live 挂在它身上），
 * 条件只决定**里面的文字**要不要出现。
 */
describe("提示容器是常驻的 live region，不是条件渲染", () => {
  it("三处错误容器：条件写在常驻容器里面，容器自己不挂条件", async () => {
    const CASES = [
      ["HostListView.tsx", "folderError"],
      ["HostListView.tsx", "formError"],
      ["UniterminalTab.tsx", "resetError"],
    ] as const;

    for (const [file, name] of CASES) {
      const source = await readSource(file);
      const at = source.indexOf("{" + name + " !== undefined &&");
      expect(at, file + " 里再也找不到 " + name + " 的渲染").toBeGreaterThan(-1);
      const wrapper = source.lastIndexOf('{...noticeLiveProps("error")}', at);
      expect(wrapper, file + "：" + name + " 没有住在常驻 alert 容器里").toBeGreaterThan(-1);
      // 容器开标签与那个条件之间只该是 `} className="uniterminal-live">`：
      // 一旦出现 && / ?，说明容器本身又变回条件渲染了
      const between = source.slice(wrapper, at);
      expect(between).toContain('className="uniterminal-live"');
      expect(between).not.toContain("&&");
      expect(between).not.toContain("?");
    }
  });

  it("live region 只以 <div {...noticeLiveProps(...)}> 的形态出现：容器常驻", async () => {
    for (const file of LIVE_FILES) {
      const source = await readSource(file);
      const spreads = source.match(/\{\.\.\.noticeLiveProps\(/g) ?? [];
      const uses = source.match(/noticeLiveProps\(/g) ?? [];
      expect(spreads.length, file + " 一个 live region 都没有").toBeGreaterThan(0);
      // 每一次调用都必须落在 <div> 的 spread 上（import 里那个名字不算调用）：
      // 只有这样容器才是常驻的，条件才只能写在容器里面
      expect(uses.length, file + "：noticeLiveProps 有非 spread 的用法").toBe(spreads.length);
      // 反面：条件渲染的元素上直接挂 aria-live / noticeLiveProps
      expect(source).not.toMatch(/&&\s*<div[^>]*(noticeLiveProps|aria-live)/s);
      expect(source).not.toMatch(/\?\s*<div[^>]*(noticeLiveProps|aria-live)/s);
    }
  });

  it("没有任何 live region 靠「不可见」或 aria-hidden 藏起来", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");
    const rule = /\.uniterminal-live:empty \{[^}]*\}/s.exec(css);
    expect(rule, "tab.module.css 里缺 .uniterminal-live:empty").not.toBeNull();
    const body = rule?.[0] ?? "";
    // 一旦不可见，live region 就彻底失效——空着的时候只许"挪出流"，不许"藏起来"
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
    expect(body).not.toMatch(/aria-hidden/);
    // 真正把空容器挪出流的那两条：绝对定位 + 1px，元素仍在渲染树里
    expect(body).toContain("position: absolute");
    expect(body).toContain("clip-path: inset(50%)");

    for (const file of LIVE_FILES) {
      const source = await readSource(file);
      // 同一个标签上既要求播报、又把它从无障碍树里摘掉，是自相矛盾
      for (const line of source.split("\n")) {
        const both = line.includes("aria-live") && line.includes("aria-hidden");
        expect(both, file + "：同一行既有 aria-live 又有 aria-hidden").toBe(false);
      }
    }
  });
});

interface StubElement {
  type: unknown;
  props: Record<string, unknown>;
}

const isStubElement = (value: unknown): value is StubElement =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { props?: unknown }).props === "object" &&
  (value as { props?: unknown }).props !== null;

function walkElements(node: unknown, visit: (element: StubElement) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkElements(item, visit);
    return;
  }
  if (!isStubElement(node)) return;
  visit(node);
  walkElements(node.props["children"], visit);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => textOf(item)).join("");
  if (!isStubElement(node)) return "";
  return textOf(node.props["children"]);
}

/**
 * 上传结果行有自己的播报通道（它不自动消失，所以不能并进 notice 那条 6 秒的通道）。
 *
 * jsdom / 记账桩都**不会真的播报**，这一条只能验两件可验的事：
 * 属性挂对了、失败文案确实进了那个容器。真正的播报只能真人 + 读屏软件验。
 */
describe("上传失败行的播报通道（SftpPanel 自己的通道）", () => {
  type RowStatus = "pending" | "uploading" | "done" | "failed" | "cancelled";
  const row = (name: string, status: RowStatus, extra: { loaded?: number; total?: number; error?: string } = {}) => ({
    name,
    status,
    loaded: extra.loaded ?? 0,
    total: extra.total ?? 0,
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });
  const handlers = { clear: () => undefined, cancel: () => undefined };

  it("失败文案进 alert/assertive 容器，而且行还在传时容器就已经在 DOM 里", () => {
    const failed = uploadResultsView([row("bad.bin", "failed", { error: "提交失败" })], handlers, 0);
    const regions: StubElement[] = [];
    walkElements(failed, (element) => {
      if (element.props["aria-live"] !== undefined) regions.push(element);
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]?.props["role"]).toBe("alert");
    expect(regions[0]?.props["aria-live"]).toBe("assertive");
    expect(regions[0]?.props["className"]).toBe("uniterminal-live");
    // 文案进了正确的容器（失败文案只能在这里播报，notice 那条通道它不去）
    expect(textOf(regions[0])).toContain("上传失败：提交失败");

    // 还在传的行走同一个容器：容器随行挂载、此刻是空的——失败时才往里写文字，
    // 这正是"节点常驻、只有内容变化"的形态（反过来的话读屏会漏播）
    const uploading = uploadResultsView([row("big.bin", "uploading", { loaded: 5, total: 10 })], handlers, 0);
    const duringUpload: StubElement[] = [];
    walkElements(uploading, (element) => {
      if (element.props["aria-live"] !== undefined) duringUpload.push(element);
    });
    expect(duringUpload).toHaveLength(1);
    expect(duringUpload[0]?.props["aria-live"]).toBe("assertive");
    expect(textOf(duringUpload[0])).toBe("");
    // 进度文案照旧显示在外面，不往播报通道里塞（不然每秒都要念一次）
    expect(textOf(uploading)).toContain("已传 5 B / 10 B");
  });

  it("成功 / 取消的行不往播报通道里写东西", () => {
    const tree = uploadResultsView([row("ok.bin", "done"), row("skip.bin", "cancelled")], handlers, 0);
    const regions: StubElement[] = [];
    walkElements(tree, (element) => {
      if (element.props["aria-live"] !== undefined) regions.push(element);
    });

    expect(regions).toHaveLength(2);
    for (const region of regions) expect(textOf(region)).toBe("");
    // 结果文案本身一个字都没少
    expect(textOf(tree)).toContain("上传完成");
    expect(textOf(tree)).toContain("已取消（远端未生成文件）");
  });
});

