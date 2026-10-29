import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { initialAuthSelection } from "../../src/client/auth-selection.js";

/**
 * 回归锁（M14）：连接表单的勾选状态**只看存档**。
 * 用户实报：取消「使用密码」并保存后，重新打开表单密码又被勾上了
 * （旧逻辑 `kind !== "key" || remembered` 用"本机还记得口令"覆盖了用户的显式选择）。
 */
describe("initialAuthSelection", () => {
  it("keeps a key-only profile key-only", () => {
    expect(initialAuthSelection("key")).toEqual({ usePassword: false, useKey: true });
  });

  it("keeps a password profile on password", () => {
    expect(initialAuthSelection("password")).toEqual({ usePassword: true, useKey: false });
  });

  it("defaults to password for an unsaved profile", () => {
    expect(initialAuthSelection(undefined)).toEqual({ usePassword: true, useKey: false });
  });

  it("restores both boxes for a both-auth profile (M15)", () => {
    expect(initialAuthSelection("both")).toEqual({ usePassword: true, useKey: true });
  });

  it("treats unknown values as password rather than crashing", () => {
    expect(initialAuthSelection("agent")).toEqual({ usePassword: true, useKey: false });
  });

  it("treats both as having a key path, so the key icon shows (M15-3)", async () => {
    const { hasKeyAuth } = await import("../../src/client/auth-selection.js");
    const source = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    expect(hasKeyAuth("both")).toBe(true);
    expect(hasKeyAuth("key")).toBe(true);
    expect(hasKeyAuth("password")).toBe(false);
    expect(hasKeyAuth(undefined)).toBe(false);
    // 行内必须用判断函数，不能只判 "key"——否则"两种都试"的主机没有钥匙图标
    expect(source).toContain("hasKeyAuth(profile.auth.kind)");
    expect(source).not.toContain('profile.auth?.kind === "key"');
  });

  it("no longer re-checks password just because one is remembered", async () => {
    const source = await (await import("node:fs/promises")).readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    expect(source).not.toContain('profile.auth?.kind !== "key" || remembered');
    expect(source).toContain("initialAuthSelection(profile.auth?.kind)");
  });
});
