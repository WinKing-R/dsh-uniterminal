import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".dsh", "uniterminal");
const FILE = join(DIR, "diag.log");

/** 测试进程一律静默：诊断只服务于真实运行，测试数据不得污染用户日志。 */
const SILENT = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

/** 追加一行 JSON 诊断记录；失败静默（诊断本身不得影响功能）。 */
export function diag(event: string, data: Record<string, unknown> = {}): void {
  if (SILENT) return;
  const line = JSON.stringify({ ts: Date.now(), event, ...data }) + "\n";
  void mkdir(DIR, { recursive: true })
    .then(() => appendFile(FILE, line, "utf8"))
    .catch(() => undefined);
}
