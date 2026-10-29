import { describe, expect, it } from "vitest";
import { menuAnchor } from "../../src/client/menu-anchor.js";

/**
 * 回归锁：右键菜单靠右时**必须向左展开**。
 *
 * 【来历】真机上「更多操作」（⋯）按钮在行尾，菜单一律向右伸展 →
 * 伸出面板右边缘、被宿主祖先的 overflow 裁掉，菜单项只显示半截。
 * 面板自己没有 overflow（裁剪来自宿主），所以只能让菜单不越界。
 *
 * 这里锁的是**判定规则**本身（纯函数），不依赖 jsdom 的布局
 * ——jsdom 里 getBoundingClientRect 恒为 0，几何断言在那里没有意义。
 */
describe("menuAnchor（菜单不越出面板右边缘）", () => {
  it("锚点在左半边：左边缘对齐，向右展开", () => {
    expect(menuAnchor(40, 100, 400)).toEqual({ left: 40, top: 100 });
  });

  it("锚点在右半边：**右边缘对齐**，向左展开", () => {
    // 400 宽的面板，锚点在 380：右边距 20 → 菜单从锚点向左铺开
    expect(menuAnchor(380, 100, 400)).toEqual({ right: 20, top: 100 });
  });

  it("恰好在中线时仍按左对齐（边界稳定，不受浮点影响）", () => {
    expect(menuAnchor(200, 50, 400)).toEqual({ left: 200, top: 50 });
  });

  it("面板宽度未知（0）时退回左对齐，绝不返回负的 right", () => {
    expect(menuAnchor(300, 50, 0)).toEqual({ left: 300, top: 50 });
    expect(menuAnchor(300, 50, -1)).toEqual({ left: 300, top: 50 });
  });

  it("锚点超出面板（滚动/舍入误差）时钳到 0，不产生负坐标", () => {
    expect(menuAnchor(-12, -8, 400)).toEqual({ left: 0, top: 0 });
    expect(menuAnchor(460, 50, 400)).toEqual({ right: 0, top: 50 });
  });

  it("永远只给出 left 或 right 之一（两个都给会把 absolute 元素拉伸）", () => {
    for (const x of [-5, 0, 100, 199, 200, 201, 399, 400, 500]) {
      const anchor = menuAnchor(x, 10, 400);
      const hasLeft = anchor.left !== undefined;
      const hasRight = anchor.right !== undefined;
      expect(hasLeft !== hasRight).toBe(true);
    }
  });
});
