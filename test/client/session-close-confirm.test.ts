import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M33）：断开连接必须先确认；隧道与外观改成浮层。
 *
 * 用户实报：「断开连接和点 X 号弹出个框提示是否关闭该终端窗口之类的，有时候会误触」；
 * 同时要求「隧道和外观也作为弹窗」。
 */
describe("session close confirmation and panel overlays (M33)", () => {
  it("asks before closing from either entry point", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 两个入口都只设置待确认状态，不再直接调用 closeSessionEntry
    expect(source).toMatch(/setPendingClose\(\{ id: entry\.id/);
    expect(source).toContain("setPendingClose({ id: activeEntry.id");
    expect(source).toContain('title="断开连接"');
    // 确认按钮与标题是同一个说法
    expect(source).toContain('confirmLabel="断开连接"');
    // 弹框正文说的是"会话会断开"（语义正确），一个字都不许动
    expect(source).toContain("会话会断开，里面正在运行的任务会停止。");
    // 只有确认之后才真正关闭
    expect(source).toContain("void closeSessionEntry(target.id);");
  });

  it("reverts unsaved appearance changes when the panel is closed (M35)", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 打开时记快照、关闭时回滚、保存成功后更新快照
    expect(source).toContain("setAppearanceSnapshot(appearance)");
    expect(source).toContain("if (appearanceSnapshot !== undefined) setAppearance(appearanceSnapshot);");
    expect(source).toContain("onSaved={(next) => setAppearanceSnapshot(next)}");
  });

  it("shows tunnels and appearance in the shared overlay", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 浮层里包着面板即可：中间可能有标题栏与关闭按钮，窗口给足
    expect(source).toMatch(/uniterminal-overlay[\s\S]{0,1500}<TunnelPanel/s);
    expect(source).toMatch(/uniterminal-overlay[\s\S]{0,1500}<AppearancePanel/s);
  });
});
