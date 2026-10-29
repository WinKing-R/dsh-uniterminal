/**
 * 客户端事件上报：写进宿主的 diag.log。
 * 界面出问题时，浏览器里的异常/环境信息本来无处可看；这条通道让它们和宿主事件落在同一个日志里。
 *
 * ## 统一成摊平形状
 *
 * 这里曾有三份实现、三种 payload 形状：
 * 本文件的 `reportClient` 发 `{ event, payload }`（嵌套），
 * UniterminalTab 与 TerminalView 又各自发 `{ event, ...payload }`（摊平）。
 *
 * 宿主不解析形状，只是把这份 JSON 原样记进 diag.log
 * （src/routes.ts 的 diag 路由 → `diag("client", payload)`），
 * 所以摊平那份在宿主侧完全等价，而且 log 里能直接看到字段、不用再展开一层。
 * 现在统一成摊平：`{ event, ...payload }`。
 *
 * ## 凭据字段一律丢弃
 *
 * 上报是"顺手把手边的数据塞进去"的典型场景：调用点想记什么就记什么。
 * 一旦有人把 password / passphrase / privateKey / secret 塞进 payload，
 * 这些凭据就会**明文落进 diag.log**——而密码 / 口令 / 私钥永远不该离开凭据文件。
 *
 * 所以这里在发送前把这类键丢掉：
 * 大小写不敏感，按"包含"匹配（userPassword、sshPassphrase、privateKeyPath 一并挡住），
 * 并且递归处理嵌套对象与数组——凭据藏在 payload 里的一层嵌套下，同样出不去。
 */

/** 凭据类键名：大小写不敏感，按包含匹配，所以 userPassword / sshPassphrase 一并挡住。 */
const SENSITIVE_KEY_MARKERS = ["password", "passphrase", "privatekey", "secret"] as const;

/** 嵌套深度上限：payload 正常只有一两层；深了就截断，别让异常结构把上报拖死。 */
const MAX_SCRUB_DEPTH = 6;

/** 键名是否属于"可能装凭据"那一类。 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_MARKERS.some((marker) => lower.includes(marker));
}

/** 递归剔除凭据类字段；超过深度上限的值直接丢掉。 */
function scrubValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (isSensitiveKey(key)) continue;
    const scrubbed = scrubValue(item, depth + 1);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
}

/**
 * 上报一条客户端事件。永不抛错、永不阻塞界面（fire-and-forget）。
 *
 * @param event 事件名，例如 "client.ws-open"。
 * @param payload 附加字段；凭据类字段会被丢弃。
 */
export function reportClient(event: string, payload: Record<string, unknown> = {}): void {
  try {
    const scrubbed = scrubValue(payload, 0);
    const fields = typeof scrubbed === "object" && scrubbed !== null ? scrubbed : {};
    void fetch("/api/uniterminal/diag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...fields }),
    }).catch(() => undefined);
  } catch {
    // 上报本身绝不能影响界面
  }
}
