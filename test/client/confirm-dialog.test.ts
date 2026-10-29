import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁：确认弹框的定位方式。
 *
 * 曾经用 `position: fixed` + 视口坐标，被玻璃/壁纸主题打穿：
 * 那类主题在容器上加 transform / backdrop-filter，**会给 fixed 造出新包含块**，
 * 于是视口坐标被当成"相对该祖先"的坐标，弹框被放到屏幕外——
 * 用户看到的就是"点删除 / 断开连接没反应"，而且日志里毫无异常。
 *
 * 现在：遮罩 `position: absolute; inset: 0` 贴住 `.uniterminal-pane`，不依赖任何测量。
 */
describe("confirm dialog placement", () => {
  it("fills the viewport without any measured coordinates", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    const rule = css.slice(css.indexOf(".uniterminal-modal-backdrop {"), css.indexOf(".uniterminal-modal {"));
    // 贴住面板（absolute）而不是铺满视口：用户要求弹框出现在**侧栏**中间
    expect(rule).toContain("position: absolute");
    // 且不得带任何计算坐标（那正是被主题打穿的原因）
    expect(rule).toContain("inset: 0");
    expect(rule).not.toMatch(/\bwidth:/);
    expect(rule).not.toMatch(/\bheight:/);
  });

  it("does not measure anything before rendering", async () => {
    const dialog = await readFile(new URL("../../src/client/confirm-dialog.tsx", import.meta.url), "utf8");

    expect(dialog).not.toContain("useAnchoredBox");
    expect(dialog).not.toContain("getBoundingClientRect");
    // 焦点默认在「取消」上，回车不会误删
    expect(dialog).toContain("cancelRef.current?.focus()");
    expect(dialog).toContain('event.key !== "Escape"');
    expect(dialog).toContain('role="dialog"');
  });

  it("is used for every destructive action", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");
    const tab = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 主机删除 / 分组删除 / 导入确认 + 断开连接 / 保存确认
    expect((list.match(/<ConfirmDialog/g) ?? []).length).toBe(3);
    expect((tab.match(/<ConfirmDialog/g) ?? []).length).toBe(2);
  });
  it("reports when the dialog is not anchored to the panel (M54)", async () => {
    const dialog = await readFile(new URL("../../src/client/confirm-dialog.tsx", import.meta.url), "utf8");

    // 贴错祖先时没有任何可见报错，只能靠运行时自检写进 diag
    expect(dialog).toContain("client.dialog-off-pane");
    expect(dialog).toContain('closest(".uniterminal-pane")');
  });
});
