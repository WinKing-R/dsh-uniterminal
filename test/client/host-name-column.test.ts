import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M11-9）：主机名限 16 字符 + 名称列定宽，好让 user@host:port 各列对齐。
 * 用户实报：「主机名能否强制不得超过 20 字符，然后让主机 IP 和名称能做到同列对齐」。
 */
describe("host name column (M11-9)", () => {
  it("caps the name at 16 characters in the form", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(source).toContain('from "../name-limits.js"');
    expect(source).toContain("maxLength={NAME_MAX}");
    
    expect(source).toContain("名称不能超过 ");
  });

  it("shows only host:port as the detail, without the user name", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 用户名每行都一样，是噪声；明细只留 host:port
    expect(source).not.toContain('profile.user + "@"');
    expect(source).toContain("return target + port;");
  });

  it("gives both the name and the detail a fixed width so the icons line up", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 名称按钮不撑满（否则明细与图标被推远）
    expect(source).toContain('flex: "0 1 auto"');
    // 明细定宽 16ch —— 否则图标随文字长短浮动，上下两组对不齐
    expect(css).toMatch(/\.uniterminal-hostdetail \{[^}]*flex: 0 0 auto[^}]*width: 16ch/s);
    // 图标列**不**定宽：定宽会在图标前后留下多余空白（只有一个图标时尤其明显）
    expect(source).toContain('className="uniterminal-hosticons"');
    // 图标列不定宽（定宽会在只有一个图标时留白），间距只由 gap 决定
    expect(css).toMatch(/\.uniterminal-hosticons \{[^}]*gap: 2px/s);
    expect(css).not.toMatch(/\.uniterminal-hosticons \{[^}]*width:/s);
    // 图标自身不得再写 marginLeft，否则与 gap 叠加、间距翻倍
    expect(source).not.toContain("marginLeft: 4,");
    // 动作按钮右对齐：弹性占位符必须存在，窗口拉宽时按钮贴右而不是飘到中间
    // 样板搬进 .uniterminal-grow（flex: 1 1 auto + min-width: 0），占位符只留类名
    expect(source).toContain('<span aria-hidden="true" className="uniterminal-grow" />');
    expect(css).toMatch(/\.uniterminal-grow \{[^}]*flex: 1 1 auto;[^}]*min-width: 0/s);
  });

  it("draws the hover state on the whole row, not on the name button", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    // 悬停高亮必须覆盖整行（含最右的删除），否则高亮断在名称按钮边界、与动作按钮"不连通"
    expect(css).toMatch(/\.uniterminal-hostrow:hover[\s\S]{0,200}box-shadow/s);
    // 名称按钮自己不得再画背景/描边
    expect(css).toMatch(/button\.uniterminal-hostname:hover \{[^}]*background: transparent/s);
  });

  it("draws the group-membership guide at 2px", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 1px 在浅色主题下几乎看不出归属；用户实报太窄后定为 2px
    expect(source).toContain('"2px solid " + (color ?? "var(--ut-border)")');
  });

  it("lets the action buttons ellipsize when the window is narrow", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-grouprow button \{[^}]*text-overflow: ellipsis/s);
  });

  it("lets the detail ellipsize instead of being clipped by the button", async () => {
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.uniterminal-hostdetail \{[^}]*text-overflow: ellipsis/s);
    expect(css).toMatch(/button\.uniterminal-hostname \{[^}]*display: flex/s);
  });

  it("gives the name a fixed-width cell so the detail column lines up", async () => {
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(source).toContain('className="uniterminal-hostname-text"');
    expect(css).toContain("width: 16ch");
    expect(css).toContain("text-overflow: ellipsis");
  });
});
