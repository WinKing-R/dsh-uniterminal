import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M43）：工具栏只放"列表级"动作与搜索；导入挪进「添加主机」弹窗。
 *
 * 用户实报：工具栏四个按钮 + 搜索框挤在一起，侧栏一窄搜索框就被挤出去看不见。
 */
describe("toolbar layout (M43)", () => {
  it("keeps the ssh-config import out of the toolbar", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 源码里 "uniterminal-toolbar" 有两处：「移入分组」浮层（在 row() 里，位于 pane 之前）
    // 与**真正的列表工具栏**（.uniterminal-pane 之后）。断言必须按位置区分，不能两处都算数。
    const paneIndex = source.indexOf('className="uniterminal-pane"');
    const firstToolbarIndex = source.indexOf('className="uniterminal-toolbar"');
    const toolbarIndex = source.indexOf('className="uniterminal-toolbar"', paneIndex);
    expect(paneIndex).toBeGreaterThan(-1);
    expect(firstToolbarIndex).toBeGreaterThan(-1);
    expect(firstToolbarIndex).toBeLessThan(paneIndex);
    expect(toolbarIndex).toBeGreaterThan(paneIndex);

    // 工具栏本体：pane 之后第一个 uniterminal-toolbar，到搜索框之前
    const toolbar = source.slice(paneIndex, source.indexOf('className="uniterminal-search"', paneIndex));
    expect(toolbar).toContain('className="uniterminal-toolbar"');
    // 内联的 flex 三件套已经删掉：布局归 CSS 管
    expect(toolbar).not.toContain('style={{ display: "flex", alignItems: "center", gap: 8 }}');
    // 导入入口不进工具栏
    expect(toolbar).not.toContain("从 ~/.ssh/config 导入");
    // 但功能必须还在：在添加主机的操作行里触发**预览**，真正导入由确认弹框发起
    expect(source).toContain("onClick={() => void previewImport()}");
    expect(source).toContain("void importFromSshConfig();");
  });

  it("lets the search box shrink instead of being pushed off-screen", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 搜索框是唯一可收缩的元素，min-width 必须能降到 0
    expect(css).toMatch(/\.uniterminal-toolbar \.uniterminal-search \{[^}]*min-width: 0/s);
    // 按钮不收缩、不折字
    expect(css).toMatch(/\.uniterminal-toolbar > button \{[^}]*white-space: nowrap/s);
    // 窄窗口换行的是整行，不是按钮里的字
    expect(css).toMatch(/\.uniterminal-toolbar \{[^}]*flex-wrap: wrap;[^}]*\}/s);
  });
});
