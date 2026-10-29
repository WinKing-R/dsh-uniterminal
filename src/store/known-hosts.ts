import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type HostKeyVerdict = "match" | "unknown" | "mismatch";
export type UnknownHostKeyPolicy = "reject" | "trust";

export interface KnownHostEntry {
  host: string;
  port: number;
  fingerprint: string;
  addedAt: number;
}

export interface KnownHostPolicy {
  knownHosts: KnownHosts;
  onUnknownHostKey?: UnknownHostKeyPolicy;
}

const VERSION = 1;
const FILE_NAME = "known_hosts.json";
const SHA256_PREFIX = "SHA256:";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isMissingFile = (error: unknown): boolean => asRecord(error)?.code === "ENOENT";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** ssh2 的 hostVerifier 在 hostHash 模式下给出不带前缀的 base64，两种写法都按同一指纹比较。 */
const normalizeFingerprint = (fingerprint: string): string => {
  const trimmed = fingerprint.trim();
  return trimmed.slice(0, SHA256_PREFIX.length).toUpperCase() === SHA256_PREFIX
    ? trimmed.slice(SHA256_PREFIX.length).trim()
    : trimmed;
};

const entryKey = (host: string, port: number): string => host.toLowerCase() + "\u0000" + port;

const formatTarget = (host: string, port: number): string => host + ":" + port;

const parseEntry = (value: unknown): KnownHostEntry => {
  const record = asRecord(value);
  if (record === undefined) throw new Error("entry must be an object");

  const host = record.host;
  if (typeof host !== "string" || host === "") throw new Error("field 'host' must be a non-empty string");

  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port)) throw new Error("field 'port' must be an integer");

  const fingerprint = record.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint === "") {
    throw new Error("field 'fingerprint' must be a non-empty string");
  }

  const addedAt = record.addedAt;
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) {
    throw new Error("field 'addedAt' must be a finite number");
  }

  return { host, port, fingerprint, addedAt };
};

export class KnownHosts {
  readonly #file: string;
  readonly #entries = new Map<string, KnownHostEntry>();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const entries = this.#parse(text);
    this.#entries.clear();
    for (const entry of entries) this.#entries.set(entryKey(entry.host, entry.port), entry);
  }

  check(host: string, port: number, fingerprint: string): HostKeyVerdict {
    const entry = this.#entries.get(entryKey(host, port));
    if (entry === undefined) return "unknown";
    const stored = normalizeFingerprint(entry.fingerprint);
    return stored === normalizeFingerprint(fingerprint) ? "match" : "mismatch";
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const key = entryKey(host, port);
    const existing = this.#entries.get(key);
    this.#entries.set(key, { host, port, fingerprint, addedAt: existing?.addedAt ?? Date.now() });
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const payload = JSON.stringify({ version: VERSION, hosts: [...this.#entries.values()] }, null, 2) + "\n";
    // 随机后缀：两个并发 save 各写各的临时文件，否则后一个 rename 会 ENOENT
    const temp = this.#file + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await writeFile(temp, payload, "utf8");
      await rename(temp, this.#file);
    } catch (error) {
      // 写失败也把临时文件收掉：否则半截文件会一直躺在数据目录里
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #parse(text: string): KnownHostEntry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw this.#invalid("content is not valid JSON");
    }
    const record = asRecord(raw);
    if (record === undefined) throw this.#invalid("root must be an object");
    if (record.version !== VERSION) throw this.#invalid("version must be " + VERSION);
    const entries = record.hosts;
    if (!Array.isArray(entries)) throw this.#invalid("'hosts' must be an array");

    const parsed: KnownHostEntry[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      try {
        parsed.push(parseEntry(entries[index]));
      } catch (error) {
        throw this.#invalid("hosts[" + index + "]: " + messageOf(error));
      }
    }
    return parsed;
  }

  #invalid(reason: string): Error {
    return new Error("uniterminal: " + FILE_NAME + " is invalid (" + this.#file + "): " + reason);
  }
}

/**
 * 把 known_hosts 判定包成 ssh2 的 hostVerifier 形态：返回 true 放行，拒绝时抛出
 * 带 uniterminal 前缀的错误，供调用方直接呈现给用户。
 */
export function decideHostKey(
  policy: KnownHostPolicy,
  host: string,
  port: number,
): (fingerprint: string) => boolean {
  return (fingerprint: string): boolean => {
    const verdict = policy.knownHosts.check(host, port, fingerprint);
    if (verdict === "match") return true;
    if (verdict === "unknown") {
      if ((policy.onUnknownHostKey ?? "reject") === "trust") {
        // 内存条目先生效，落盘在后台完成：握手不被磁盘延迟阻塞
        void policy.knownHosts.trust(host, port, fingerprint).catch(() => undefined);
        return true;
      }
      throw new Error("uniterminal: unknown host key for " + formatTarget(host, port) + " (" + fingerprint + ")");
    }
    throw new Error("uniterminal: host key changed for " + formatTarget(host, port) + " (presented " + fingerprint + ")");
  };
}
