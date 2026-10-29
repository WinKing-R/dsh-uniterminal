// @vitest-environment jsdom
/**
 * DOM 级回归锁：确认弹框（焦点、Esc、遮罩）。
 *
 * 弹框的语义全在**焦点与事件**上：
 * 打开时焦点必须落在「取消」上（回车不会误触发删除）；
 * Esc 必须取消；点遮罩取消，但点弹框**内部**不能取消；
 * 这几条以前只有"源码里出现过 cancelRef.current?.focus()"这种字符串断言，
 * 抓不住"焦点其实没落上去"或者"点内部也取消了"。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { ConfirmDialog } from "../../src/client/confirm-dialog.js";

/** 本包 vitest 没开 globals，RTL 的自动 cleanup 注册不上，要显式清理。 */
afterEach(cleanup);

function DialogHarness(props: { onConfirm: () => void; onCancel: () => void }): ReactElement {
  return (
    <div className="uniterminal-pane">
      <ConfirmDialog
        title="删除主机"
        message="从本机列表删除「web-01」？"
        confirmLabel="删除"
        danger={true}
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
      />
    </div>
  );
}

describe("confirm dialog — DOM 级交互", () => {
  it("打开时焦点落在「取消」上（回车不会误触发删除）", () => {
    render(<DialogHarness onConfirm={() => undefined} onCancel={() => undefined} />);

    const cancel = screen.getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
  });

  it("Esc 取消", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={onConfirm} onCancel={onCancel} />);

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("点遮罩取消", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={() => undefined} onCancel={onCancel} />);

    await user.click(screen.getByRole("presentation"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("点弹框内部**不**取消", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={() => undefined} onCancel={onCancel} />);

    await user.click(screen.getByRole("dialog"));

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("点「确认」触发 onConfirm，不触发 onCancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("弹框带 dialog 角色与标题的可访问名", () => {
    render(<DialogHarness onConfirm={() => undefined} onCancel={() => undefined} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("删除主机");
  });
});

/**
 * 外部按钮 + 可关闭的弹框：测"卸载后焦点回到打开前的元素"。
 * 那个外部按钮就是真实场景里的「删除」行内按钮。
 */
function FocusReturnHarness(props: { onConfirm: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="uniterminal-pane">
      <button type="button" onClick={() => setOpen(true)}>
        删除主机
      </button>
      {open && (
        <ConfirmDialog
          title="删除主机"
          message="从本机列表删除「web-01」？"
          confirmLabel="删除"
          danger={true}
          onConfirm={() => {
            props.onConfirm();
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

describe("confirm dialog — 焦点陷阱与焦点归还（B5 无障碍）", () => {
  it("Tab 从最后一个元素回到第一个（焦点陷阱）", async () => {
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={() => undefined} onCancel={() => undefined} />);

    const confirm = screen.getByRole("button", { name: "删除" });
    confirm.focus();
    expect(document.activeElement).toBe(confirm);

    // 最后一个再 Tab：不许跑到弹框外面（那里是页面其余部分，用户会以为弹框没了）
    await user.keyboard("{Tab}");

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  });

  it("陷阱不破坏正常的 Tab 顺序（中间的元素照常前进）", async () => {
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={() => undefined} onCancel={() => undefined} />);

    // 打开时焦点在「取消」（第一个），Tab 应当照常走到「删除」，不是又跳回自己
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    await user.keyboard("{Tab}");

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "删除" }));
  });

  it("Shift+Tab 从第一个元素回到最后一个（反向陷阱）", async () => {
    const user = userEvent.setup();
    render(<DialogHarness onConfirm={() => undefined} onCancel={() => undefined} />);

    // 打开时焦点就在第一个元素上
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));

    await user.keyboard("{Shift>}{Tab}{/Shift}");

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "删除" }));
  });

  it("卸载后焦点回到打开前的元素", async () => {
    const user = userEvent.setup();
    render(<FocusReturnHarness onConfirm={() => undefined} />);

    const opener = screen.getByRole("button", { name: "删除主机" });
    await user.click(opener);

    // 打开：焦点被移到「取消」，同时记下"打开前是谁"
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    // 焦点不还回去，键盘用户就得从页面开头重新 Tab 到这一行
    expect(document.activeElement).toBe(opener);
  });
});
