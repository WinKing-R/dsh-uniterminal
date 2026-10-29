import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M13-2）：连接反馈必须**就地**显示在连接表单里（按钮下方），
 * 不能只在面板顶部。用户实报：点了「连接」超时，结果要跑到最上面去找。
 */
describe("connect feedback placement (M13-2)", () => {
  it("renders the notice inside the connect form, next to the buttons", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 表单是**嵌套渲染**在主视图里的（不是并列的 return 分支），
    // 所以除了表单里就地显示，顶部那份必须在表单打开时被关掉——否则同一条错误出现两次。
    expect(source).toContain("!connecting && notice !== undefined");
    expect(source).toContain('!(launcherVisible && view === "form") && notice !== undefined');
  });

  it("keeps the countdown right next to the connecting text", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    expect(source).toContain("连接超时倒计时");
    expect(source).toContain("useConnectCountdown");
  });
});
