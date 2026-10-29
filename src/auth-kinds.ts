/**
 * 「认证方式有几种」的唯一事实来源。
 *
 * 事故背景（M15 前后）：这个契约曾散在 8 个地方——类型联合、store 的数组、
 * routes 的两个 Set、RequestAuthKind、回落映射、客户端的两个局部类型与两个判断函数。
 * 加一个 "both" 时只改到其中一处，结果：存档存不下 → 保存报 400 → 图标不显示，
 * 三次连续返工，每次都是同一根因的不同侧面。
 *
 * 现在：**这里定义一次，其余全部派生**。新增一种认证方式只需改这个文件。
 */

/** 顺序即错误信息里的展示顺序。 */
export const AUTH_KINDS = ["password", "key", "both"] as const;

export type AuthKind = (typeof AUTH_KINDS)[number];

/** 没有任何表态时的默认值（老数据、直接调 API）。 */
export const DEFAULT_AUTH_KIND: AuthKind = "password";

export function isAuthKind(value: unknown): value is AuthKind {
  return typeof value === "string" && (AUTH_KINDS as readonly string[]).includes(value);
}

/** 错误信息里的取值列表，避免各处手写 "password|key|both" 而与上面脱节。 */
export function authKindsText(): string {
  return AUTH_KINDS.join("|");
}

/** 这种认证方式要不要用到私钥。 */
export function usesKey(kind: AuthKind | string | undefined): boolean {
  return kind === "key" || kind === "both";
}

/** 这种认证方式要不要用到口令。 */
export function usesPassword(kind: AuthKind | string | undefined): boolean {
  return kind === "password" || kind === "both";
}

/** 任意外部输入 → 确定的认证方式；不认识的一律回落到默认值，绝不抛。 */
export function authKindOr(kind: unknown): AuthKind {
  return isAuthKind(kind) ? kind : DEFAULT_AUTH_KIND;
}

/**
 * 界面勾选 → 写进存档的 kind。
 * 只勾密码时返回 undefined：那意味着**不写 auth 块**（存档用"没有 auth"表达纯密码）。
 */
export function storedKindForSelection(usePassword: boolean, useKey: boolean): "key" | "both" | undefined {
  if (!useKey) return undefined;
  return usePassword ? "both" : "key";
}

/** 界面勾选 → 发给后端的请求 kind（请求层始终能表达三种）。 */
export function requestKindForSelection(usePassword: boolean, useKey: boolean): AuthKind {
  if (usePassword && useKey) return "both";
  if (useKey) return "key";
  return "password";
}

/** 存档 kind → 界面勾选。 */
export function selectionForKind(kind: unknown): { usePassword: boolean; useKey: boolean } {
  const resolved = authKindOr(kind);
  return { usePassword: usesPassword(resolved), useKey: usesKey(resolved) };
}
