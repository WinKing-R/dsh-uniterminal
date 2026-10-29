import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M17）：取消「记住密码」必须**真的清掉凭据库里的口令**。
 *
 * 用户实报：取消勾选「记住密码」并保存后，列表里的绿色盾牌（已记住）还在。
 * 原因是保存只改了 remember 标记，凭据库里 profile:<id> 仍然存在，
 * 列表面板从 /security/refs 读到它，于是图标一直亮着。
 */
describe("forgetting a stored password (M17)", () => {
  it("writes remember=false explicitly and forgets the stored password", async () => {
    const client = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 反选后必须真的写 false（旧代码只在勾选时才赋值，反选会留旧值）
    expect(client).toContain("next.remember = usePassword && remember;");
    // 保存后要调用遗忘端点
    expect(client).toContain("if (!next.remember) await forgetStoredPassword(profileId);");
    expect(client).toContain('"/api/uniterminal/profiles/forget-password"');
  });

  it("removes only the password ref on the host, never the private key", async () => {
    const routes = await readFile(new URL("../../src/routes.ts", import.meta.url), "utf8");

    expect(routes).toContain('profilesForget: "/api/uniterminal/profiles/forget-password"');
    // 只删 profile:<id>；私钥相关的前缀不得出现在这个 handler 里
    const start = routes.indexOf("const forgetProfilePassword");
    const end = routes.indexOf("const deleteProfileKey");
    const handler = routes.slice(start, end);
    expect(handler).toContain("CREDENTIAL_PREFIX + profileId");
    expect(handler).not.toContain("KEY_PREFIX");
    expect(handler).not.toContain("KEY_PASSPHRASE_PREFIX");
  });
});
