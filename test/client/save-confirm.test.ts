import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { droppedSecrets, droppedSecretsMessage } from "../../src/client/save-confirm.js";

/**
 * 回归锁（M18）：取消勾选「记住密码 / 保存私钥路径」并保存，属于**主动丢弃已存凭据**，
 * 保存前必须用弹框问一句。用户要求复用删除主机那个弹框。
 */
describe("save confirmation (M18)", () => {
  const intent = (patch: Partial<Parameters<typeof droppedSecrets>[1]> = {}) => ({
    usePassword: true,
    remember: true,
    useKey: true,
    rememberKeyPath: true,
    identityPath: "C:\\Users\\me\\.ssh\\id_ed25519",
    ...patch,
  });

  it("drops the password when remembering is turned off", () => {
    const drops = droppedSecrets({ rememberedPassword: true }, intent({ remember: false }));
    expect(drops).toEqual(["password"]);
  });

  it("drops the key path when that box is turned off", () => {
    const drops = droppedSecrets({ rememberedPassword: false, storedKeyPath: "C:\\old\\id_ed25519" }, intent({ rememberKeyPath: false }));
    expect(drops).toEqual(["keyPath"]);
  });

  it("drops both when both boxes are turned off", () => {
    const drops = droppedSecrets(
      { rememberedPassword: true, storedKeyPath: "C:\\old\\id_ed25519" },
      intent({ remember: false, rememberKeyPath: false }),
    );
    expect(drops).toEqual(["password", "keyPath"]);
  });

  it("asks nothing when there is nothing stored to lose", () => {
    expect(droppedSecrets({ rememberedPassword: false }, intent({ remember: false }))).toEqual([]);
    expect(droppedSecrets({ rememberedPassword: true }, intent())).toEqual([]);
  });

  it("says the key file itself is not deleted", () => {
    const message = droppedSecretsMessage(["keyPath"]);

    expect(message).toContain("已保存的私钥路径");
    expect(message).toContain("私钥文件本身不会被删除");
  });

  it("wires the dialog into the save flow", async () => {
    const client = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 复用删除主机那个 ConfirmDialog
    expect(client).toContain("droppedSecretsMessage(saveConfirm)");
    expect(client).toContain('title="确认保存？"');
    // 新增的勾选框
    expect(client).toContain("保存私钥路径");
    expect(client).toContain("setRememberKeyPath");
    // 取消勾选后不再把路径写进存档
    expect(client).toContain("const path = rememberKeyPath ? identityPath.trim() : \"\";");
  });
});
