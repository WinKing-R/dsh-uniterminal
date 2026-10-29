import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "../host-diag.js";

/**
 * 凭据后端：**秘密存哪**是一个可替换的实现，不是一条写在 store 里的 if。
 *
 * 上一批（M65）把自研的 protected 档（主密码 + 插件自管的加密文件）整套删掉了——
 * 那套密码学在产品流程里走不到，是审查负债。删完之后剩下的问题是：
 * "密码该不该明文落盘"？本批给出业内标准的那一档答案：
 *
 * - 有系统密码箱的机器（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）
 *   → 交给操作系统保管，**本仓库不自己实现任何加密**；
 * - 没有系统密码箱的机器 → 回落明文文件（0600 / NTFS ACL），并**在界面上明说**。
 *
 * 三条不可让步的底线（贯穿本文件）：
 * ① 密码本体只在宿主 Node 进程里：不进浏览器、不进 profiles.json、不进日志与诊断；
 * ② 后端不可用（原生模块装不上 / 密码箱被锁 / 条目歧义）必须**降级**，绝不让插件起不来；
 * ③ 绝不把底层异常原文（可能带路径、库名）透给界面。
 */

/**
 * 凭据 ref 的三种前缀。account 就是 ref 名本身，浏览器与界面只见 ref 名字，不见密钥。
 *
 * 这一份是**唯一**定义处：src/routes.ts 也从这里取（同一个东西两份实现迟早会走偏）。
 */
export const CREDENTIAL_PREFIX = "profile:";
export const KEY_PREFIX = "key:";
export const KEY_PASSPHRASE_PREFIX = "key-passphrase:";
/** 认得的三种前缀；系统密码箱里**同名但不是我们的**条目一律不认。 */
export const CREDENTIAL_REF_PREFIXES: readonly string[] = [CREDENTIAL_PREFIX, KEY_PREFIX, KEY_PASSPHRASE_PREFIX];

/** 这个 ref 是不是我们自己的凭据条目？（别人的同名条目不是。） */
export function isCredentialRef(ref: string): boolean {
  return CREDENTIAL_REF_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

/** 系统密码箱里的 service 名：够独特，别和别的应用撞。 */
export const KEYCHAIN_SERVICE = "dsh-uniterminal";

/**
 * 界面文案：密码存在哪。
 *
 * 这几句话在**三处一致**：src（这里 + 客户端）、测试（test/store/security.test.ts）、
 * 文档（docs/SECURITY.md / docs/copy-guide.md）。改动任何一句都要三处一起改。
 *
 * 注意：界面上不许出现「加密」「主密码」「解锁」「锁定」（docs/acceptance-m2a.md 判据 3）——
 * 描述的是**操作系统密码箱**，不是本插件自造的档位。
 */
export const STORAGE_LABEL_KEYCHAIN_WINDOWS = "密码保存在 Windows 凭据管理器";
export const STORAGE_LABEL_KEYCHAIN_MACOS = "密码保存在 macOS 钥匙串";
export const STORAGE_LABEL_KEYCHAIN_LINUX = "密码保存在系统钥匙环（Secret Service）";
export const STORAGE_LABEL_KEYCHAIN_OTHER = "密码保存在系统密码箱";
export const STORAGE_LABEL_FILE = "这台机器没有可用的系统密码箱，密码明文保存在本机凭据文件（仅当前账户可读）";
export const STORAGE_LABEL_DEGRADED = "系统密码箱暂时不可用，已临时改用本机文件保存";

/** 平台 → 密码箱那一句话。Linux 必须显式说清是 Secret Service（内核 keyring 不跨重启）。 */
export function keychainLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return STORAGE_LABEL_KEYCHAIN_WINDOWS;
  if (platform === "darwin") return STORAGE_LABEL_KEYCHAIN_MACOS;
  if (platform === "linux") return STORAGE_LABEL_KEYCHAIN_LINUX;
  return STORAGE_LABEL_KEYCHAIN_OTHER;
}

/**
 * 后端接口：**秘密存哪**的可替换实现。
 *
 * 三个方法都是异步的——系统密码箱那一边本来就是异步 IO（被锁时要等它报错）。
 */
export interface CredentialBackend {
  readonly kind: "keychain" | "file";
  /** 给界面看的一句话：密码存在哪。 */
  readonly label: string;
  get(ref: string): Promise<string | undefined>;
  put(ref: string, secret: string): Promise<void>;
  remove(ref: string): Promise<void>;
  listRefs(): Promise<string[]>;
}

/**
 * 「这个后端现在不可用」。
 *
 * 密码箱被锁 / 服务没起 / 原生模块装不上 / 同名条目歧义（Ambiguous）——
 * 这几种在用户看来是同一件事：**这台机器此刻取不到系统密码箱**。
 * 底层异常原文可能带路径与库名，**绝不透给界面**：由上层翻译成一句固定文案。
 */
export class CredentialBackendUnavailableError extends Error {
  constructor(message = "credential backend unavailable") {
    super(message);
    this.name = "CredentialBackendUnavailableError";
  }
}

/* ------------------------------------------------------------------ *
 * 文件后端：明文落盘（0600 / NTFS ACL）
 * ------------------------------------------------------------------ */

/** 凭据文件：明文。只给本人读写；win32 上 chmod 只切换只读位，实际由 NTFS ACL 保障。 */
const FILE_MODE = 0o600;
/** credentials.json 的格式版本。 */
const CREDENTIALS_VERSION = 1;
/** 凭据文件名（本仓库唯一一处）。 */
export const CREDENTIALS_FILE = "credentials.json";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isMissingFile = (error: unknown): boolean => asRecord(error)?.code === "ENOENT";

const invalid = (file: string, reason: string): Error =>
  new Error("uniterminal: " + file.split(/[\\/]/).pop() + " is invalid (" + file + "): " + reason);

/**
 * 简单档是明文落盘，只允许本人读写（与 dsh-credentials-local 同策略）。
 * win32 的 chmod 只能切换只读位，stat().mode 恒报 0o666；那里的等价保障是 %USERPROFILE% 的 NTFS ACL，
 * 因此 POSIX 位只在其平台上校验。
 */
const assertOwnerOnly = (modeBits: number, platform: typeof process.platform, file: string): void => {
  if (platform === "win32") return;
  if ((modeBits & 0o077) === 0) return;
  const name = file.split(/[\\/]/).pop();
  throw new Error(
    "uniterminal: " + name + " permissions are too open (" + file + "): mode 0" + (modeBits & 0o777).toString(8) +
      " lets other users read it; expected 0600",
  );
};

const parseEntries = (text: string, file: string): Map<string, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid(file, "content is not valid JSON");
  }
  const record = asRecord(raw);
  if (record === undefined) throw invalid(file, "root must be an object");
  if (record.version !== CREDENTIALS_VERSION) throw invalid(file, "version must be " + CREDENTIALS_VERSION);
  const entries = asRecord(record.entries);
  if (entries === undefined) throw invalid(file, "'entries' must be an object");
  const parsed = new Map<string, string>();
  for (const [ref, secret] of Object.entries(entries)) {
    if (typeof secret !== "string") throw invalid(file, "entry '" + ref + "' must be a string");
    parsed.set(ref, secret);
  }
  return parsed;
};

/**
 * 文件后端：明文凭据文件。
 *
 * 这一档的规矩是从上一批**原样搬过来**的，一条都不许弱化：
 * 0600 + 临时文件 + rename 的原子写、POSIX 属主校验、损坏即报错。
 */
export class FileBackend implements CredentialBackend {
  readonly kind = "file" as const;
  readonly label = STORAGE_LABEL_FILE;
  readonly #dir: string;
  #entries = new Map<string, string>();
  #loaded = false;
  /** 读盘失败的原因缓存住：坏了就是坏了，每次都报同一个错，不假装"没存过"。 */
  #loadError: unknown;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** 读盘：文件不存在视为尚未记住任何密码；权限过宽或内容损坏直接抛错，绝不清空。 */
  async load(): Promise<void> {
    if (this.#loadError !== undefined) throw this.#loadError;
    if (this.#loaded) return;
    try {
      const path = join(this.#dir, CREDENTIALS_FILE);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isMissingFile(error)) {
          this.#entries = new Map();
          this.#loaded = true;
          return;
        }
        throw error;
      }
      assertOwnerOnly((await stat(path)).mode, process.platform, path);
      this.#entries = parseEntries(text, path);
      this.#loaded = true;
    } catch (error) {
      this.#loadError = error;
      throw error;
    }
  }

  async get(ref: string): Promise<string | undefined> {
    await this.load();
    return this.#entries.get(ref);
  }

  async put(ref: string, secret: string): Promise<void> {
    await this.load();
    const next = new Map(this.#entries);
    next.set(ref, secret);
    await this.#persist(next);
    this.#entries = next;
  }

  async remove(ref: string): Promise<void> {
    await this.load();
    if (!this.#entries.has(ref)) return;
    const next = new Map(this.#entries);
    next.delete(ref);
    await this.#persist(next);
    this.#entries = next;
  }

  async listRefs(): Promise<string[]> {
    await this.load();
    return [...this.#entries.keys()];
  }

  /** 迁移用：读出全部条目（明文）。调用方负责立刻把它们搬走。 */
  async readAll(): Promise<Map<string, string>> {
    await this.load();
    return new Map(this.#entries);
  }

  /**
   * 确保凭据文件在：**没有就建一个空的，已存在就原样保留**。
   *
   * 这条规矩只有一份实现（ensureStorage 与 clearLegacy 共用）：credentials.json 里装的是
   * 用户已经记住的密码，任何"顺手覆盖成空"都会毁掉它们。
   */
  async ensureFile(): Promise<void> {
    if (await this.#exists(join(this.#dir, CREDENTIALS_FILE))) return;
    await this.#writeJson(join(this.#dir, CREDENTIALS_FILE), { version: CREDENTIALS_VERSION, entries: {} });
  }

  /** 迁移用：删掉明文副本（**只在全部条目都搬完之后**才调）。 */
  async removeFile(): Promise<void> {
    await rm(join(this.#dir, CREDENTIALS_FILE), { force: true });
    // 内存里的明文也一并丢掉：搬完之后本机不该再留着明文副本。
    this.#entries = new Map();
    this.#loaded = true;
  }

  async #persist(entries: Map<string, string>): Promise<void> {
    await this.#writeJson(join(this.#dir, CREDENTIALS_FILE), {
      version: CREDENTIALS_VERSION,
      entries: Object.fromEntries(entries),
    });
  }

  /** 文件在不在：只关心存在性，读不动的内容不归它管。 */
  async #exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  /** 临时文件 + chmod 0600 + rename：任何时刻都不存在非本人可读的成品文件。 */
  async #writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await chmod(temp, FILE_MODE);
    await rename(temp, file);
  }
}

/* ------------------------------------------------------------------ *
 * 系统密码箱后端
 * ------------------------------------------------------------------ */

/**
 * Linux 必须**显式 pin** secret-service。
 *
 * 不 pin 的话库会"Secret Service → 内核 keyring"自动回落，而内核 keyring
 * **不跨重启、也不是加密存储**——静默用它会导致"密码存了、重启就没"，是欺骗用户。
 * pin 之后该后端不可用会**抛错而不是回落**，正是我们要的行为（上层据此降级到文件后端）。
 */
const LINUX_OPTIONS = { linux: { store: "secret-service" } } as const;

type KeyringModule = typeof import("@napi-rs/keyring");

let keyringModule: KeyringModule | undefined;
let keyringLoadFailed = false;

/**
 * 动态载入原生模块。
 *
 * **动态导入**是硬要求：原生模块装不上（或平台没有预编译二进制）时，
 * 这里抛错由上层降级到文件后端——**绝不能让插件启动失败**。
 * 静态 import 会在模块加载阶段就把整个插件一起带崩。
 */
async function loadKeyring(): Promise<KeyringModule> {
  if (keyringModule !== undefined) return keyringModule;
  if (keyringLoadFailed) throw new CredentialBackendUnavailableError("keyring module unavailable");
  try {
    keyringModule = await import("@napi-rs/keyring");
    return keyringModule;
  } catch (error) {
    keyringLoadFailed = true;
    // 原文可能带路径与库名：只进诊断，不透给界面。
    diag("credential.keyring-load-failed", { error: String(error).slice(0, 160) });
    throw new CredentialBackendUnavailableError("keyring module unavailable");
  }
}

/**
 * 系统密码箱后端。
 *
 * - service = "dsh-uniterminal"（够独特，不与别的应用撞）；
 * - account = ref 名本身（profile:&lt;id&gt; / key:&lt;id&gt; / key-passphrase:&lt;id&gt;）。
 *
 * **不在内存里缓存秘密**：每次 get 现读现用（比上一批的内存 Map 更安全）。
 */
export class KeychainBackend implements CredentialBackend {
  readonly kind = "keychain" as const;
  readonly label: string;
  readonly #service: string;

  constructor(service: string = KEYCHAIN_SERVICE, platform: NodeJS.Platform = process.platform) {
    this.#service = service;
    this.label = keychainLabel(platform);
  }

  async get(ref: string): Promise<string | undefined> {
    const entry = await this.#entry(ref);
    try {
      const password = await entry.getPassword();
      // 没有时返回 null（不是 undefined）：这里统一成 undefined。
      return password === null ? undefined : password;
    } catch (error) {
      throw this.#unavailable(error, "get");
    }
  }

  async put(ref: string, secret: string): Promise<void> {
    const entry = await this.#entry(ref);
    try {
      await entry.setPassword(secret);
    } catch (error) {
      throw this.#unavailable(error, "put");
    }
  }

  async remove(ref: string): Promise<void> {
    const entry = await this.#entry(ref);
    try {
      // 删掉返回 true，没有返回 false：两者都不是失败。
      await entry.deletePassword();
    } catch (error) {
      throw this.#unavailable(error, "remove");
    }
  }

  /**
   * 列出我们自己的 ref：按 service 枚举，再**只保留符合那三种前缀的**。
   *
   * 同一个 service 下别人的同名条目不是我们的——它们既不该出现在界面上，也不该被迁移。
   */
  async listRefs(): Promise<string[]> {
    const { findCredentialsAsync } = await loadKeyring();
    let credentials: { account: string; password: string }[];
    try {
      credentials = await findCredentialsAsync(this.#service);
    } catch (error) {
      throw this.#unavailable(error, "list");
    }
    return credentials.map((item) => item.account).filter((account) => isCredentialRef(account));
  }

  async #entry(ref: string): Promise<import("@napi-rs/keyring").AsyncEntry> {
    const { AsyncEntry } = await loadKeyring();
    return new AsyncEntry(this.#service, ref, LINUX_OPTIONS);
  }

  /**
   * 密码箱被锁 / 服务没起 / 条目歧义（Ambiguous）——在用户看来都是同一件事：
   * **这个后端现在不可用**。原文只进诊断。
   */
  #unavailable(error: unknown, action: string): CredentialBackendUnavailableError {
    diag("credential.keychain-unavailable", { action, error: String(error).slice(0, 160) });
    return new CredentialBackendUnavailableError("keychain unavailable");
  }
}

/**
 * 探测系统密码箱：**只读**。
 *
 * 用 findCredentialsAsync 试一次列举（**不为了探测去写一条测试凭据**——
 * 写进去再删掉会在用户的凭据管理器里留下痕迹，也可能在半路失败留下垃圾）。
 *
 * 返回 undefined 表示"这台机器没有可用的系统密码箱"（含原生模块装不上的情况）。
 */
export async function probeKeychainBackend(
  service: string = KEYCHAIN_SERVICE,
): Promise<KeychainBackend | undefined> {
  try {
    const backend = new KeychainBackend(service);
    await backend.listRefs();
    return backend;
  } catch (error) {
    diag("credential.keychain-probe-failed", { error: String(error).slice(0, 160) });
    return undefined;
  }
}
