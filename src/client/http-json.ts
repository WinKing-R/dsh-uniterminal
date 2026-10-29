/** 与宿主兜底文案一致：错误里保留多少原文。 */
const ERROR_TEXT_LIMIT = 80;

function failure(status: number, raw: string): { error: string } {
  const clipped = raw.slice(0, ERROR_TEXT_LIMIT);
  return { error: "HTTP " + String(status) + (clipped === "" ? "" : " " + clipped) };
}

/**
 * 安全解析响应体：先取 text 再 try JSON.parse，永不抛 SyntaxError。
 * 宿主对未知路径的兜底是纯文本 "not found"，因此非 JSON（或 JSON 不是对象）时
 * 返回 { error: "HTTP <status> <text 前 80 字>" }，错误信息仍然可读。
 */
export function parseJsonSafe<T extends object = Record<string, unknown>>(
  text: string,
  status: number,
): T & { error?: string } {
  const raw = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure(status, raw) as T & { error?: string };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure(status, raw) as T & { error?: string };
  }
  return parsed as T & { error?: string };
}
