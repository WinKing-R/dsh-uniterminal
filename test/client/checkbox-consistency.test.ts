import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M19）：勾选行必须共用同一个类。
 *
 * 用户实报：「保存私钥路径」的勾选框居中、文字掉到下一行，和「记住密码」不一致。
 * 根因是 .uniterminal-pane label 默认竖向（label 在上、控件在下），
 * 旧代码靠每行写内联 flexDirection 覆盖，新加的那行漏了 → 立刻跑偏。
 */
describe("checkbox rows share one design (M19)", () => {
  it("uses the shared class for every checkbox row and no inline sizing", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    const rows = (source.match(/className="uniterminal-check"/g) ?? []).length;
    const inputs = (source.match(/type="checkbox"/g) ?? []).length;
    expect(rows).toBe(inputs);
    expect(rows).toBe(4);
    expect(source).not.toContain('accentColor: "currentColor"');
    expect(source).not.toContain("width: 14, height: 14, padding: 0");
  });

  it("declares the row horizontally, with one size and one transition", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/label\.uniterminal-check \{[^}]*display: inline-flex;[^}]*flex-direction: row/s);
    expect(css).toMatch(/label\.uniterminal-check input\[type="checkbox"\] \{[^}]*width: 15px;[^}]*transition: transform/s);
    expect(css).toContain("label.uniterminal-check:has(input:disabled)");
  });

  it("does not leak markdown asterisks into the UI", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    expect(source.includes("**私钥文件本身不会被删除**")).toBe(false);
  });
});
