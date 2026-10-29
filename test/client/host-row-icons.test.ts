import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M11-4）：主机行的状态用**图标**表达，不再用带描边的文字徽标。
 * 用户实报：「已记住」做成小方框太丑；要求改成盾牌镂空对勾，有私钥再加一个钥匙。
 * 这里锁三件事：两枚图标都在用、文字徽标没有回归、行内不再有自造描边框。
 */
describe("host row status icons (M11-4)", () => {
  it("renders a shield-check for a stored password and a key for key auth", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(source).toContain("<ShieldCheckIcon />");
    expect(source).toContain("<KeyIcon />");
    expect(source).toContain('from "./host-icons.js"');
  });

  it("no longer shows the boxed text badges", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(source).not.toMatch(/REMEMBERED_LABEL\}/);
    expect(source).not.toMatch(/KEY_AUTH_LABEL\}/);
    // 自造的小方框徽标（1px currentColor 圆角胶囊）不得回归
    expect(source).not.toContain('border: "1px solid currentColor"');
  });
  it("draws the search magnifier as an inline SVG, not an emoji (M41)", async () => {
    const icons = await readFile(new URL("../../src/client/host-icons.tsx", import.meta.url), "utf8");
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(icons).toContain("export function SearchIcon");
    // emoji 字形跨机器不一致，也无法跟随 currentColor
    expect(list).not.toContain("🔍");
    expect(list).toContain("<SearchIcon />");
  });
});
