import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M21）：分组标题必须**定宽**，后面的「· N 台 / 颜色 / 清除颜色 / 重命名 / 删除分组」才排得齐。
 *
 * 限长（M20）只保证名字不会超长，但短名字仍会把后面推左——
 * "ssh 导入" 与 "demo-group" 长度不同，靠内容宽度永远对不齐。
 */
describe("group title column (M21)", () => {
  it("gives the title a fixed width tied to the name limit", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(source).toContain('className="uniterminal-group-title"');
    expect(css).toMatch(/\.uniterminal-group-title \{[^}]*width: 16ch/s);
    expect(css).toMatch(/\.uniterminal-group-title \{[^}]*text-overflow: ellipsis/s);
  });

  it("keeps the collapse button on centre alignment", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 标题格定宽后，基线对齐会让文字与折叠箭头错位
    const groupButton = source.slice(source.indexOf("aria-expanded"), source.indexOf("onClick={() => toggleGroup"));
    expect(groupButton).toContain('alignItems: "center"');
  });
});
