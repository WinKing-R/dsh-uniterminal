import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M12-6）：SFTP 工具栏的「删除」平时是普通按钮，悬停才转危险色。
 * 用户要求：平时灰色可用，鼠标移上去立刻红字 + 警示底色。
 */
describe("danger on hover (M12-6)", () => {
  it("marks the sftp delete button and styles its hover state", async () => {
    const panel = await readFile(new URL("../../src/client/SftpPanel.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

    expect(panel).toContain('className="uniterminal-danger-on-hover"');
    // 悬停态必须用危险色变量 + 警示底色。
    // B4 起规则里写的是语义令牌 var(--ut-danger)，它背后仍是宿主的 label-error —— 两段都要锁。
    expect(css).toMatch(/button\.uniterminal-danger-on-hover:hover:not\(:disabled\) \{[^}]*var\(--ut-danger\)/s);
    expect(css).toContain("--ut-danger: var(--dsw-alias-label-error, #e5534b);");
    expect(css).toMatch(/uniterminal-danger-on-hover:hover[\s\S]{0,400}background: color-mix/s);

    // 危险色只在 hover 出现：整份 CSS 里 uniterminal-danger-on-hover 只出现在这一条 :hover 规则中
    const dangerRules = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]*uniterminal-danger-on-hover[^{}]*\{[^}]*\}/g) ?? [];
    expect(dangerRules).toHaveLength(1);
    expect(dangerRules[0]).toContain(":hover");
  });
});
