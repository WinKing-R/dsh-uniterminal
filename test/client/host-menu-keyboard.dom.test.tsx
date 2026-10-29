// @vitest-environment jsdom
/**
 * DOM 级回归锁：菜单的**键盘入口**与焦点归还（B5 无障碍第三段）。
 *
 * 【为什么补这个入口】B5 第一批给菜单补好了内部键盘操作（方向键 / Esc / 焦点归还），
 * 但菜单本身**只有右键能开**——纯键盘用户根本进不去那一排动作
 * （编辑 / 移入分组 / 删除）。这不是"体验差一点"，是 WCAG 2.1.1（键盘）的硬失败：
 * 功能对键盘用户不可达。
 *
 * 【为什么必须有 DOM 级测试】"源码里出现了 onKeyDown / onContextMenu"这种字符串断言
 * 抓不住真机上真正要验的三件事：
 * ① 按 Shift+F10 菜单**真的开了**，且焦点**真的落在第一项**；
 * ② 点「更多操作」按钮菜单真的开了（aria-expanded 从 false 变 true）；
 * ③ 关菜单后焦点**真的回到触发元素**——第一批把 returnFocusTo 做进了组件，
 *    但没有任何调用方，所以真机上一直是"关掉就丢焦点"。
 *
 * 【怎么处理 fetch】HostListView 挂载时会取主机列表与「已记住」refs：
 * 这里 vi.mock 掉 ./api.js（仓库里已有这种打法），列表就能在 jsdom 里真实渲染出来。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "../../src/client/confirm-dialog.js";
import { HostListView } from "../../src/client/HostListView.js";

/**
 * api 打桩：GET /profiles 回两台主机 + 一个分组，GET /security/refs 回空表，
 * POST 一律成功（测试连接回 12 ms）。**字面量写在工厂函数里**：
 * vi.mock 的工厂会被提升到 import 之前，引用模块级常量会撞上 TDZ。
 */
vi.mock("../../src/client/api.js", () => ({
  api: {
    get: (path: string) =>
      Promise.resolve(
        path.includes("/profiles")
          ? {
              ok: true,
              data: {
                profiles: [
                  { id: "p1", name: "web-01", kind: "ssh", groupId: null, host: "192.0.2.10", port: 22 },
                  { id: "p2", name: "db-01", kind: "ssh", groupId: "g1", host: "192.0.2.11", port: 22 },
                ],
                groups: [{ id: "g1", name: "工程", parentId: null }],
              },
            }
          : { ok: true, data: { refs: [] } },
      ),
    post: () => Promise.resolve({ ok: true, data: { ok: true, ms: 12 } }),
  },
  errorText: () => "请求失败",
}));

/**
 * 注入真实样式表在 jsdom 里没有意义：`.module.css` 在这里是 Vite 的类名代理对象，
 * 塞进 `style.textContent` 会撞上 Symbol → string 的转换错误（真浏览器里不会发生）。
 * 这个测试关心的是**焦点与 ARIA**，不是样式表有没有挂上去，所以直接打桩。
 */
vi.mock("../../src/client/inject-css.js", () => ({ ensureUniterminalCss: () => undefined }));

/** 本包 vitest 没开 globals，RTL 的自动 cleanup 注册不上，要显式清理。 */
afterEach(cleanup);

async function renderList(): Promise<void> {
  render(<HostListView onSelect={() => undefined} onManualConnect={() => undefined} />);
  // 等列表加载完：菜单入口按钮只有在主机行渲染出来之后才存在
  await screen.findByRole("button", { name: "更多操作：web-01" });
}

/** 主机行容器（点的、焦点归还的目标都是它）。 */
const hostRow = (name: string): HTMLElement => {
  const row = screen.getByRole("button", { name: "更多操作：" + name }).closest(".uniterminal-hostrow");
  if (!(row instanceof HTMLElement)) throw new Error("找不到主机行：" + name);
  return row;
};

describe("菜单的键盘入口（B5 无障碍：WCAG 2.1.1）", () => {
  it("主机行渲染出带 aria-haspopup=\"menu\" 的「更多操作」按钮", async () => {
    await renderList();

    const more = screen.getByRole("button", { name: "更多操作：web-01" });
    // 纯键盘用户要靠它进菜单：它必须是**真正的按钮**，并且声明自己会开菜单
    expect(more.tagName).toBe("BUTTON");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("title")).toBe("更多操作");
    // 静止时不可见只能靠 opacity：display / visibility 会把它移出 Tab 序列
    expect(more.className).toContain("uniterminal-row-more");
  });

  it("点「更多操作」按钮能打开菜单，aria-expanded 从 false 变 true", async () => {
    const user = userEvent.setup();
    await renderList();

    const more = screen.getByRole("button", { name: "更多操作：web-01" });
    expect(more.getAttribute("aria-expanded")).toBe("false");

    await user.click(more);

    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    // 可访问名：同一屏还有分组菜单，没有名字读屏读不出这是谁的操作
    expect(menu.getAttribute("aria-label")).toBe("主机 web-01 的操作");
    // 打开就把焦点送进第一项，否则方向键/回车全落在菜单外面
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "编辑" }));
  });

  it("焦点在行内按钮上时按 Shift+F10 能打开菜单，且焦点落在第一项", async () => {
    const user = userEvent.setup();
    await renderList();

    // 快捷键挂在**行容器**上：焦点落在行内任何一个按钮上都要能唤出菜单
    // （B5 第四段起「连接」带主机名：一行里几十个同名按钮，读屏本来就分不清）
    within(hostRow("web-01")).getByRole("button", { name: "连接：web-01" }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");

    expect(screen.getByRole("menu")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "编辑" }));
  });

  it("菜单键（ContextMenu）与 Shift+F10 走同一条路径", async () => {
    const user = userEvent.setup();
    await renderList();

    hostRow("web-01").focus();
    await user.keyboard("{ContextMenu}");

    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("主机 web-01 的操作");
  });
});

describe("菜单的焦点归还：这次有真实调用方（B5 第二批）", () => {
  it("从「更多操作」按钮打开、Esc 关闭后，焦点回到那个按钮", async () => {
    const user = userEvent.setup();
    await renderList();

    const more = screen.getByRole("button", { name: "更多操作：web-01" });
    await user.click(more);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "编辑" }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    // 不还焦点，键盘用户就得从页面开头重新 Tab 回这一行
    expect(document.activeElement).toBe(more);
  });

  it("从键盘路径打开、Esc 关闭后，焦点回到主机行本身", async () => {
    const user = userEvent.setup();
    await renderList();

    const row = hostRow("web-01");
    within(row).getByRole("button", { name: "连接：web-01" }).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "编辑" }));

    await user.keyboard("{Escape}");

    // 键盘路径的触发元素是**行元素**：菜单关掉要回到这一行，而不是掉到 body
    expect(document.activeElement).toBe(row);
  });
});

describe("分组行同样有入口（重命名 / 删除分组只在菜单里）", () => {
  it("分组行渲染出「更多操作」按钮，点开的是分组菜单", async () => {
    const user = userEvent.setup();
    await renderList();

    const more = screen.getByRole("button", { name: "更多操作：分组 工程" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");

    await user.click(more);

    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu").getAttribute("aria-label")).toBe("分组 工程 的操作");
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDefined();
  });
});

/**
 * 弹框的正文绑定（B5 第三段同批）。
 *
 * 只有 aria-label（标题）时，读屏念完「删除主机」就停了——用户不知道这次要删的是哪一台。
 * 这一条要验的是**引用真的能解析到元素**，源码里出现 aria-describedby 说明不了这件事。
 */
describe("确认弹框：正文被 aria-describedby 绑上", () => {
  it("顺着 aria-describedby 能找到那句关键正文", () => {
    render(
      <div className="uniterminal-pane">
        <ConfirmDialog
          title="删除主机"
          message="从本机列表删除「web-01」？"
          confirmLabel="删除"
          danger={true}
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />
      </div>,
    );

    const describedBy = screen.getByRole("dialog").getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy ?? "");
    expect(message?.textContent).toBe("从本机列表删除「web-01」？");
  });
});

describe("「测试连接」的结果进 live region（B5：这处以前完全静音）", () => {
  it("测试成功后，结果落在常驻的 status 容器里", async () => {
    const user = userEvent.setup();
    await renderList();

    // 容器常驻：还没测的时候就已经在 DOM 里（读屏只在"已有节点的内容变化"时播报）
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);

    // 可访问名按 docs/copy-guide.md 的术语写成「测试连接：<主机名>」，可见文字仍是「测试」
    await user.click(within(hostRow("web-01")).getByRole("button", { name: "测试连接：web-01" }));

    await waitFor(() => {
      const regions = screen.getAllByRole("status");
      expect(regions.some((region) => region.textContent === "连通 ✓ 12 ms")).toBe(true);
    });
  });
});
