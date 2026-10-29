/**
 * 共享请求层：前端对宿主 HTTP 接口的调用都从这里走。
 *
 * ## 为什么错误必须结构化
 *
 * 早先每个面板各写一份 fetch，失败时各写一份
 * `String(payload.error ?? response.status)`——同一段逻辑抄了 27 遍。
 *
 * **文案是给人看的，不能当机器可读的失败类型。**
 * 建会话失败时宿主回的是 `{ error, code, host?, port?, fingerprint? }`，
 * 其中 `code` 才是失败分类（timeout / refused / dns / unreachable / hostkey / auth / unknown）；
 * 而 hostkey 那一档的 `error` 文案已经被改成中文，
 * 靠文案去猜失败类型、正则再也匹配不上，host/port/fingerprint 三元组就丢了，
 * 「信任该主机并重试」那条链差点整条断掉。
 *
 * 所以失败在这里固定成一种形状：
 * - `message`：后端给的文案（payload.error），没有就退回 HTTP 状态码的文本；
 * - `status`：HTTP 状态码；
 * - `code`：后端的失败分类，旧宿主没有就是 undefined；
 * - `payload`：整个响应体，结构化字段（host / port / fingerprint）从里取。
 *
 * 调用方要文案拿 message，要分类拿 code，要结构化字段拿 payload——三者不必再互相猜。
 *
 * ## 绝不抛错
 *
 * 网络异常、非法 JSON、5xx 一律变成 `ok:false`。
 * 面板里的每个调用点都已经写好了各自的失败文案，
 * 请求层再抛一次只会让调用点多出一条漏掉的分支。
 *
 * ## 绝不记录凭据
 *
 * 本文件不打任何日志，也不把**请求体**写进错误信息：
 * 请求体里可能有密码 / 口令 / 私钥，而错误信息会进 DOM、会进日志。
 * 响应体的文案是宿主给的（宿主自己 scrub 过），可以带。
 */
import { parseJsonSafe } from "./http-json.js";

/** 失败的结构化形状：文案、状态码、失败分类、整个响应体。 */
export interface ApiError {
  /** 后端给的文案（payload.error）；没有就退回 HTTP 状态码的文本。 */
  message: string;
  /** HTTP 状态码。 */
  status: number;
  /** 后端新加的失败分类（timeout/refused/dns/unreachable/hostkey/auth/unknown）；旧宿主没有就是 undefined。 */
  code?: string;
  /** 原始响应体（结构化字段 host/port/fingerprint 之类要从这里取）。 */
  payload?: unknown;
}

/** 请求结果：要么拿到数据，要么拿到结构化的失败。永不抛错。 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** 这些方法一律不带请求体（即便调用方硬塞了 body）。 */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE"]);

/** 状态码的兜底文案：与 http-json.ts 的 "HTTP <status>" 同一个写法。 */
function statusText(status: number): string {
  return "HTTP " + String(status);
}

/** 失败分类只在响应体给了字符串时才认；数字 / 其它类型一律当没有。 */
function failureCode(payload: Record<string, unknown>): string | undefined {
  const code = payload["code"];
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * 区分「后端真的返回了错误」与「响应体压根不是 JSON」。
 *
 * parseJsonSafe 在响应体不是 JSON 对象时会合成 `{ error: "HTTP <status> <前 80 字>" }`；
 * 合成的文案必然以 "HTTP <status>" 开头，而宿主自己的错误文案没有一条以它开头
 * （见 src/routes.ts 的 sendJson 调用点），所以这个判据不会误伤。
 */
function synthesizedError(payload: Record<string, unknown>, status: number): string | undefined {
  const error = payload["error"];
  if (typeof error !== "string") return undefined;
  return error.startsWith(statusText(status)) ? error : undefined;
}

/**
 * 统一的 JSON 请求。绝不抛错：网络失败、非法 JSON、非 2xx 一律变成 ok:false。
 *
 * @param method HTTP 方法（大小写随意）。
 * @param path 宿主路径，例如 "/api/uniterminal/profiles"。
 * @param body 请求体；undefined 时**不发**请求体、也不发 content-type。
 */
export async function requestJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const verb = method.toUpperCase();
  const sendsBody = body !== undefined && !BODYLESS_METHODS.has(verb);
  const init: RequestInit = { method: verb };
  if (sendsBody) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    // 请求根本没发出去：没有状态码可言，用 0 表示「没走到宿主」。
    return { ok: false, error: { message: errorText(error), status: 0 } };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, error: { message: errorText(error), status: response.status } };
  }

  // 只此一份 JSON 解析：parseJsonSafe 永不抛 SyntaxError，失败时合成可读的 error。
  const payload = parseJsonSafe<Record<string, unknown>>(text, response.status);

  const synthesized = synthesizedError(payload, response.status);
  if (synthesized !== undefined) {
    // 响应体不是 JSON 对象：既不是成功，也不是后端的错。
    return { ok: false, error: { message: synthesized, status: response.status, payload } };
  }

  const rawError = payload["error"];
  const message =
    typeof rawError === "string" && rawError !== "" ? rawError : statusText(response.status);
  const code = failureCode(payload);
  // 宿主有两种失败：非 2xx，以及 200 + { ok:false }（例如 /profiles/test 业务失败）。
  const okFlag = payload["ok"];
  const hostFailed = typeof okFlag === "boolean" && okFlag === false;
  if (!response.ok || hostFailed) {
    return { ok: false, error: { message, status: response.status, code, payload } };
  }
  return { ok: true, data: payload as unknown as T };
}

/** GET / POST / DELETE 的薄封装。 */
export const api = {
  get: <T>(path: string): Promise<ApiResult<T>> => requestJson<T>("GET", path),
  post: <T>(path: string, body?: unknown): Promise<ApiResult<T>> =>
    requestJson<T>("POST", path, body),
  del: <T>(path: string): Promise<ApiResult<T>> => requestJson<T>("DELETE", path),
};

/**
 * 从任意 catch 到的值里取出人能看的文字。
 *
 * 错误对象取 message，字符串原样，其它取可读兜底——
 * **绝不把整个对象原样转字符串**：那可能把不该出现的东西带进错误文案。
 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error.trim() === "" ? "未知错误" : error;
  if (error instanceof Error) return error.message.trim() === "" ? error.name : error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
    return "未知错误";
  }
  if (error === undefined || error === null) return "未知错误";
  return String(error);
}
