import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M37）：浮层表面的配色必须"自洽"。
 *
 * 事故：原生下拉弹出层是白底，而闭合影射的文字是浅色 → 深色主题下看不见（M36）。
 * 用户追问："那如果我用了非黑白的主题呢"——风险同理：
 * 背景取 `--dsw-alias-bg-layer-*` 而文字取 `--dsw-alias-label-primary`，
 * 一旦皮肤只定义了其中一个，就会出现"深底黑字 / 浅底白字"。
 *
 * 规则：背景走别名链，**文字一律 inherit**（继承所在面板的文字色，与其表面本来就是一对）。
 */
describe("floating surface contrast (M37)", () => {
  it("lets floating surfaces inherit their text colour", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-select-list \{[^}]*color: inherit/s);
    expect(css).toMatch(/\.uniterminal-overlay-panel \{[^}]*color: inherit/s);
    expect(css).toMatch(/\.uniterminal-modal \{[^}]*color: inherit/s);
  });

  it("never mixes an alias background with a system text colour", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).not.toContain("color: var(--dsw-alias-label-primary, CanvasText)");
  });

  it("keeps the dropdown list in flow so the scrolling panel cannot clip it (M39)", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 面板是 overflow-y: auto 的滚动容器；absolute 的列表会被裁掉、并跟着内容滚
    expect(css).not.toMatch(/\.uniterminal-select-list \{[^}]*position: absolute/s);
    expect(css).toMatch(/\.uniterminal-select-list \{[^}]*margin-top: 4px/s);
  });

  it("keeps the dropdown opaque so options never blend into what is behind", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 玻璃主题会把层色定义成半透明：必须"主题色叠在不透明底上"，否则背后列表会透上来。
    // B4 起这条"不透明画布"是 4 个浮层表面共用的**一条**分组规则（原来写了 4 遍），
    // 所以断言升级成：唯一的那条画布规则里必须点名 .uniterminal-select-list。
    // 漏掉它 = 下拉列表又透出背后的主机列表。
    const canvas = /[^{}]*\{[^}]*background-color: Canvas;[^}]*linear-gradient\(var\(--dsw-alias-bg-layer-2/s.exec(css);
    expect(canvas).not.toBeNull();
    const canvasRule = canvas?.[0] ?? "";
    const canvasSelector = canvasRule.slice(0, canvasRule.indexOf("{"));
    for (const selector of [
      ".uniterminal-modal",
      ".uniterminal-overlay-panel",
      ".uniterminal-select-list",
      ".uniterminal-context-menu",
    ]) {
      expect(canvasSelector).toContain(selector);
    }
    // 整份 CSS 只允许存在这一条画布规则：再写第二份就是又走样了
    expect((css.match(/background-color: Canvas;/g) ?? []).length).toBe(1);
    expect(css).not.toMatch(/\.uniterminal-select-list \{[^}]*background: color-mix/s);
  });
});
