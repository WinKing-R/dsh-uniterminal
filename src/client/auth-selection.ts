import { selectionForKind, usesKey } from "../auth-kinds.js";

export interface AuthSelection {
  usePassword: boolean;
  useKey: boolean;
}

/**
 * 界面上两个勾选框相关的判断。
 *
 * 这些规则（哪种方式用到私钥、存档 kind 怎么还原成勾选）**只在 src/auth-kinds.ts 定义一次**，
 * 这里只是给客户端一个好读的名字。曾经客户端自己写了一份，于是 "both" 加进来时它没跟着变，
 * 结果"两个都勾"的主机不显示钥匙图标。
 */
export function hasKeyAuth(kind: string | undefined): boolean {
  return usesKey(kind);
}

export function initialAuthSelection(kind: string | undefined): AuthSelection {
  return selectionForKind(kind);
}
