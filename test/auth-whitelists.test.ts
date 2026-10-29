import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AUTH_KINDS,
  authKindOr,
  authKindsText,
  isAuthKind,
  requestKindForSelection,
  selectionForKind,
  storedKindForSelection,
  usesKey,
  usesPassword,
} from "../src/auth-kinds.js";

/**
 * 回归锁（M16）：认证方式的白名单**只有一份**。
 *
 * 事故史：这个契约曾散在 8 处。加 "both" 时只改到一处，连续三次返工：
 * 存档存不下 → 保存 400 → 图标不显示。这里同时锁住"共享模块的行为"与"别处不再复制"。
 */
describe("auth kinds: one source of truth (M16)", () => {
  it("declares the three kinds in one place", () => {
    expect(AUTH_KINDS).toEqual(["password", "key", "both"]);
    expect(authKindsText()).toBe("password|key|both");
  });

  it("answers which credentials each kind needs", () => {
    expect(usesKey("key")).toBe(true);
    expect(usesKey("both")).toBe(true);
    expect(usesKey("password")).toBe(false);
    expect(usesPassword("password")).toBe(true);
    expect(usesPassword("both")).toBe(true);
    expect(usesPassword("key")).toBe(false);
  });

  it("round-trips between the checkbox selection and the stored kind", () => {
    expect(storedKindForSelection(true, true)).toBe("both");
    expect(storedKindForSelection(false, true)).toBe("key");
    expect(storedKindForSelection(true, false)).toBe(undefined);

    expect(selectionForKind("both")).toEqual({ usePassword: true, useKey: true });
    expect(selectionForKind("key")).toEqual({ usePassword: false, useKey: true });
    expect(selectionForKind("password")).toEqual({ usePassword: true, useKey: false });
    expect(selectionForKind(undefined)).toEqual({ usePassword: true, useKey: false });
  });

  it("maps a selection to the request kind", () => {
    expect(requestKindForSelection(true, true)).toBe("both");
    expect(requestKindForSelection(false, true)).toBe("key");
    expect(requestKindForSelection(true, false)).toBe("password");
  });

  it("normalises unknown input instead of throwing", () => {
    expect(isAuthKind("agent")).toBe(false);
    expect(isAuthKind(42)).toBe(false);
    expect(authKindOr("agent")).toBe("password");
    expect(authKindOr("both")).toBe("both");
  });

  it("is not copied anywhere else", async () => {
    const store = await readFile(new URL("../src/store/profile-store.ts", import.meta.url), "utf8");
    const routes = await readFile(new URL("../src/routes.ts", import.meta.url), "utf8");
    const client = await readFile(new URL("../src/client/auth-selection.ts", import.meta.url), "utf8");

    expect(store).toContain('from "../auth-kinds.js"');
    expect(routes).toContain('from "./auth-kinds.js"');
    expect(client).toContain('from "../auth-kinds.js"');

    expect(store).not.toContain("const AUTH_KINDS: readonly string[] = [");
    expect(routes).not.toContain("const AUTH_KINDS: ReadonlySet");
    expect(routes).not.toContain("REQUEST_AUTH_KINDS");
    expect(routes).not.toContain('type RequestAuthKind = ProfileAuthKind | "both"');
  });
});
