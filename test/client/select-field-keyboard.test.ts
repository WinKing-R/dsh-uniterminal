import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M38）：自绘下拉必须支持键盘操作。
 *
 * M36 换成自绘组件时只做了鼠标，键盘只剩 Tab —— 这是我自己引入的无障碍缺口。
 * 现在：↑/↓ 移动、Home/End 到两头、Enter/Space 选中、Esc 收起、Tab 收起并离开；
 * 焦点留在按钮上，用 aria-activedescendant 指到当前项。
 */
describe("select field keyboard support (M38)", () => {
  it("handles the expected keys", async () => {
    const source = await readFile(new URL("../../src/client/select-field.tsx", import.meta.url), "utf8");

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"]) {
      expect(source).toContain(key);
    }
  });

  it("keeps focus on the button and reports the active option", async () => {
    const source = await readFile(new URL("../../src/client/select-field.tsx", import.meta.url), "utf8");

    expect(source).toContain("aria-activedescendant");
    expect(source).toContain('role="listbox"');
    expect(source).toContain("aria-selected");
  });

  it("stops Escape from closing the outer overlay as well", async () => {
    const source = await readFile(new URL("../../src/client/select-field.tsx", import.meta.url), "utf8");

    // 下拉在浮层里：Esc 只收下拉，不该把整个面板一起关掉
    expect(source).toMatch(/event\.key === "Escape"[\s\S]{0,200}event\.stopPropagation\(\)/);
  });
});

/**
 * 回归锁（M36 / P1-4）：外观面板的下拉不许再出现原生 select。
 *
 * 原生 select 的弹出层由**浏览器**绘制，不继承我们的主题变量——
 * 深色主题下是"白底 + 浅灰字"，选项几乎看不见（用户实报）。
 * 换成自绘的 SelectField 后，颜色、边框、选中态全部走主题变量。
 */
describe("appearance panel dropdown (M36 / P1-4)", () => {
  it("uses the self-drawn SelectField instead of a native select", async () => {
    const source = await readFile(new URL("../../src/client/AppearancePanel.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("<select");
    expect(source).toContain("<SelectField");
    // 选项、顺序与「自定义…」分支一字未改：字体候选在前，自定义哨兵在最后
    expect(source).toContain("...fontOptions.map((family) => ({ value: family, label: family })),");
    expect(source).toContain('{ value: CUSTOM_FONT, label: "自定义…" },');
    // 可见文案「字体」还在，下拉的无障碍名也还是它
    expect(source).toContain('label="字体"');
  });
});
