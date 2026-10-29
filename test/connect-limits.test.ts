import { describe, expect, it } from "vitest";
import { CONNECT_COUNTDOWN_AFTER_MS, DEFAULT_CONNECT_TIMEOUT_MS, connectProgress } from "../src/connect-limits.js";

/**
 * 连接倒计时的换算规则（用户要求：连接超过 5 秒后显示"连接超时倒计时 XXXs"）。
 * 这是纯函数，边界能直接断言——界面上的每一秒都由它决定。
 */
describe("connectProgress", () => {
  it("stays quiet during the first five seconds", () => {
    expect(connectProgress(0).counting).toBe(false);
    expect(connectProgress(4999).counting).toBe(false);
  });

  it("starts counting at exactly five seconds", () => {
    expect(connectProgress(CONNECT_COUNTDOWN_AFTER_MS).counting).toBe(true);
  });

  it("counts down against the real engine timeout", () => {
    // 5s 时还剩 15s（默认超时 20s）
    expect(connectProgress(5000).remainingSec).toBe(15);
    expect(connectProgress(19500).remainingSec).toBe(1);
  });

  it("never goes negative after the timeout", () => {
    expect(connectProgress(20000).remainingSec).toBe(0);
    expect(connectProgress(60000).remainingSec).toBe(0);
  });

  it("is robust to nonsense input", () => {
    expect(connectProgress(Number.NaN).counting).toBe(false);
    expect(connectProgress(-100).counting).toBe(false);
    // 超时值非法时回落到默认值，而不是算出 NaN 秒
    expect(connectProgress(6000, 0).remainingSec).toBe(Math.ceil((DEFAULT_CONNECT_TIMEOUT_MS - 6000) / 1000));
  });

  it("uses the same timeout constant as the engine", async () => {
    const transport = await (await import("node:fs/promises")).readFile(new URL("../src/engine/ssh-transport.ts", import.meta.url), "utf8");

    // 引擎必须引用共享常量：两边各写一个 20000 迟早不一致
    expect(transport).toContain("DEFAULT_CONNECT_TIMEOUT_MS");
    expect(transport).not.toContain("?? 20000");
  });
});
