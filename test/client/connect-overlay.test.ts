import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M22）：连接表单改成浮层，占侧栏约八成宽。
 *
 * 用户要求：「略微缩小一点塞入弹窗，弹窗占侧边栏 80% 左右」。
 * 关键点：列表必须仍在背后渲染（这才能叫弹窗），面板要在内部滚动。
 */
describe("connect form overlay (M22)", () => {
  it("keeps the host list mounted behind the floating form", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 列表不再被三元分支替换掉，而是常驻 + 表单浮层
    expect(source).toContain("{view === \"form\" && connectForm}");
    expect(source).not.toContain("{view === \"list\" ? (");
  });

  it("wraps the form in an overlay panel sized to the sidebar", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(source).toContain('className="uniterminal-overlay"');
    expect(source).toContain('className="uniterminal-overlay-panel"');
    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*width: 80%/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*overflow-y: auto/s);
    // absolute 需要面板自身建立定位上下文，否则会贴到视口
    expect(css).toMatch(/\.uniterminal-pane \{[^}]*position: relative/s);
  });

  it("reuses the same overlay for the edit form (M24)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 编辑/添加主机的表单不再是列表上方的内联盒子，而是同一个浮层
    expect(list).toContain('className="uniterminal-overlay"');
    expect(list).toContain('className="uniterminal-overlay-panel"');
    // 编辑表单不再是自己那套带边框的内联盒子：出现浮层类即可证明走了同一套样式
  });

  it("shows the move-to-group control in an overlay too (M25)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 不再在主机行下面展开一条内联输入条
    expect(list).not.toContain('paddingLeft: depth * 14 + 14 }}>');
    expect(list).toContain('移入分组</div>');
  });

  it("shows the new-folder draft and the move picker in overlays (M26)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 新建分组不再是列表上方的内联盒子
    expect(list).toContain('新建分组</div>');
    expect(list).toContain('className="uniterminal-overlay"');
    // 移入分组用**完整下拉**，且必须是自绘组件：原生 select 的弹出层不吃主题，深色下看不清
    expect(list).toContain('<SelectField');
    expect(list).not.toContain('<datalist');
    expect(list).not.toContain('<select');
  });

  it("add-host form offers the same group picker (M30)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 添加/编辑：完整下拉 + 一个明确的"＋ 新建分组…"分支
    expect(list).toContain('＋ 新建分组…');
    expect(list).toContain('const NEW_GROUP_OPTION');
    expect(list).not.toContain('<datalist');
  });

  it("anchors both overlays and dialogs to the panel, not the viewport (M49)", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");
    const dialog = await readFile(new URL("../../src/client/confirm-dialog.tsx", import.meta.url), "utf8");

    // 浮层面板：absolute 贴面板
    expect(css).toMatch(/\.uniterminal-overlay \{[^}]*position: absolute/s);
    // 确认弹框：fixed + inset:0，不带测量坐标（带坐标会被主题的 transform 打穿）
    const backdrop = css.slice(css.indexOf(".uniterminal-modal-backdrop {"), css.indexOf(".uniterminal-modal {"));
    expect(backdrop).toContain("inset: 0");
    expect(backdrop).not.toMatch(/\bwidth:/);
    expect(dialog).not.toContain("getBoundingClientRect");
  });
});
