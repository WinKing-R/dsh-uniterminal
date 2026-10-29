import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M28）：四个浮层（连接 / 编辑主机 / 移入分组 / 新建分组）共用**同一份**间距规格。
 *
 * 用户问：「这些按钮和输入框边距都是优化过的吗？和添加主机的前端设计规格一致吗」——
 * 实测是不一致的：面板当初没有 display/gap，子元素间距全靠各自默认值凑；
 * 连接面板还单独覆盖了 label gap 与 input padding；下拉框完全没有样式。
 */
describe("overlay panel spec (M28)", () => {
  it("declares one vertical rhythm for every panel", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*display: flex/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*flex-direction: column/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*gap: 10px/s);
  });

  it("styles the controls inside panels, including the dropdown", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-overlay-panel input,[\s\S]{0,80}select \{/);
    expect(css).toMatch(/\.uniterminal-overlay-panel button \{[^}]*padding: 4px 10px/s);
  });

  it("keeps the native dropdown arrow and looks like a control (M29)", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 上一版写了 appearance: none 却没补自定义箭头 → 下拉框看起来是一行纯文本
    expect(css).not.toMatch(/\.uniterminal-overlay-panel select \{[^}]*appearance: none/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel select \{[^}]*cursor: pointer/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel select \{[^}]*background: color-mix/s);
  });

  it("has no per-panel overrides left", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 旧的 connect 专用覆盖必须删掉，否则连接面板又会和别人不一样
    expect(css).not.toContain("uniterminal-connect-panel");
    // 也不允许再有"面板内 label gap 2px"这种局部收紧
    expect(css).not.toMatch(/\.uniterminal-overlay-panel label \{[^}]*gap: 2px/s);
  });
});
