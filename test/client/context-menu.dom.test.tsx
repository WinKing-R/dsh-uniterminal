// @vitest-environment jsdom
/**
 * DOM 级回归锁：右键菜单（真机发现的缺陷，M61）。
 *
 * 【来历】用户在真机上点右键菜单的「编辑」，毫无反应。查下来是**事件顺序**问题：
 * 关菜单的窗口 mousedown 监听挂在**捕获阶段**且无条件 onClose()，
 * 而菜单自己的 stopPropagation 挂在**冒泡阶段**——捕获阶段先跑，拦不住。
 * 于是 mousedown → 菜单被卸载 → mouseup / click 落不到按钮上 → onSelect 永不执行。
 * **菜单能渲染出来，但每一项都点不动。**
 *
 * 【为什么必须有 DOM 级测试】当时的回归锁是"源码里必须出现 onContextMenu、
 * 必须出现菜单项文案"这种字符串断言——渲染断言抓不住这种"能显示但不能点"的缺陷。
 * 本文件用真实的 mousedown → mouseup → click 序列把它锁住。
 *
 * ⚠ 别把 `contains` 判断"优化"掉：那是"点菜单项能生效"的唯一保障。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactElement } from "react";
import { ContextMenu } from "../../src/client/context-menu.js";

function MenuHarness(props: { onPick: (label: string) => void }): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div className="uniterminal-pane">
      {open && (
        <ContextMenu
          left={8}
          top={8}
          onClose={() => setOpen(false)}
          items={[
            { label: "编辑", onSelect: () => props.onPick("编辑") },
            { label: "移入分组…", onSelect: () => props.onPick("移入分组…") },
            { label: "删除", danger: true, onSelect: () => props.onPick("删除") },
          ]}
        />
      )}
      <button type="button">菜单外面</button>
    </div>
  );
}

/**
 * 本包 vitest 没有开 globals，RTL 的自动 cleanup 注册不上（它要靠全局 afterEach），
 * 于是上一条用例的 DOM 会留在文档里，下一条查询就撞到多个元素。
 * 所以这里显式清理——写 DOM 测试时每个文件都要有这一行。
 */
afterEach(cleanup);

describe("context menu — DOM 级交互（M61 真机缺陷回归锁）", () => {
  it("点菜单项会真的触发 onSelect（菜单能显示不等于能点）", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<MenuHarness onPick={onPick} />);

    // user-event 派发完整的 pointerdown → mousedown → pointerup → mouseup → click 序列，
    // 与真机一致：旧的实现在 mousedown 阶段就把菜单关掉了，click 根本落不到按钮上。
    await user.click(screen.getByRole("menuitem", { name: "编辑" }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("编辑");
  });

  it("点完菜单项后菜单关闭", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("点菜单外面会关闭菜单，且不触发任何菜单项", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<MenuHarness onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "菜单外面" }));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("Esc 关闭菜单", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("菜单与菜单项带上正确的 ARIA 角色，危险项用危险色", () => {
    render(<MenuHarness onPick={() => undefined} />);

    expect(screen.getByRole("menu")).toBeDefined();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    const danger = screen.getByRole("menuitem", { name: "删除" });
    expect(danger.style.color).toContain("#e5534b");
  });
});

/** 按可访问名取菜单项："焦点在谁身上"只有拿真元素比对才有意义。 */
const menuItem = (name: string): HTMLElement => screen.getByRole("menuitem", { name });

/**
 * 真实触发按钮 + 菜单：测"关闭后焦点回到触发元素"。
 * 焦点归还的目标是**调用方传进来的那个元素**，所以触发按钮必须真的存在，
 * 不能用 MenuHarness 里那个"菜单外面"的按钮顶替。
 */
function TriggerHarness(props: { onPick: (label: string) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="uniterminal-pane">
      <button type="button" ref={triggerRef} onClick={() => setOpen(true)}>
        打开菜单
      </button>
      {open && (
        <ContextMenu
          left={8}
          top={8}
          returnFocusTo={triggerRef.current}
          onClose={() => setOpen(false)}
          items={[
            { label: "编辑", onSelect: () => props.onPick("编辑") },
            { label: "移入分组…", onSelect: () => props.onPick("移入分组…") },
            { label: "删除", danger: true, onSelect: () => props.onPick("删除") },
          ]}
        />
      )}
    </div>
  );
}

/** 含禁用项的菜单：禁用项不可聚焦，方向键必须跨过它。 */
function DisabledItemHarness(): ReactElement {
  return (
    <div className="uniterminal-pane">
      <ContextMenu
        left={0}
        top={0}
        onClose={() => undefined}
        items={[
          { label: "编辑", onSelect: () => undefined },
          { label: "测试连接", disabled: true, onSelect: () => undefined },
          { label: "删除", danger: true, onSelect: () => undefined },
        ]}
      />
    </div>
  );
}

describe("context menu — 键盘与焦点（B5 无障碍）", () => {
  it("打开时焦点落在第一项", () => {
    render(<MenuHarness onPick={() => undefined} />);

    // 焦点不进菜单，方向键/回车就全落在菜单外面——菜单画出来了却"按什么都没反应"。
    expect(document.activeElement).toBe(menuItem("编辑"));
  });

  it("ArrowDown / ArrowUp 在菜单项之间移动，并在首尾之间循环", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem("移入分组…"));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem("删除"));

    // 最后一项再往下：回到第一项（循环，不是卡在末尾）
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem("编辑"));

    // 第一项再往上：绕到最后一项
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(menuItem("删除"));

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(menuItem("移入分组…"));
  });

  it("Home / End 跳到第一项 / 最后一项", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(menuItem("删除"));

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(menuItem("编辑"));
  });

  it("方向键跨过禁用项（禁用项不可聚焦）", async () => {
    const user = userEvent.setup();
    render(<DisabledItemHarness />);

    expect(document.activeElement).toBe(menuItem("编辑"));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menuItem("删除"));

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(menuItem("编辑"));
  });

  it("Tab 关闭菜单（菜单项不是 Tab 停靠点）", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.keyboard("{Tab}");

    // menu 模式的惯例：Tab 的意思是"离开菜单"，不是"在菜单里换一项"
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Esc 关闭菜单，并把焦点还给触发元素", async () => {
    const user = userEvent.setup();
    render(<TriggerHarness onPick={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "打开菜单" });

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeDefined();
    expect(document.activeElement).toBe(menuItem("编辑"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    // 焦点不回触发元素，键盘用户就被丢回文档开头，得重新 Tab 到这一行
    expect(document.activeElement).toBe(trigger);
  });

  it("没传触发元素时不瞎猜焦点目标", async () => {
    const user = userEvent.setup();
    render(<MenuHarness onPick={() => undefined} />);

    await user.keyboard("{Escape}");

    // 拿不到触发元素就不还焦点（而不是把焦点硬塞给 body 之外的某个元素）
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
