import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "../host-diag.js";
import {
  CredentialBackendUnavailableError,
  FileBackend,
  KeychainBackend,
  probeKeychainBackend,
  STORAGE_LABEL_DEGRADED,
  type CredentialBackend,
} from "./credential-backend.js";

/**
 * 凭据存储：**秘密存哪**由一个可替换的后端决定（见 credential-backend.ts）。
 *
 * 历史：这里曾经有第二档——主密码 + 插件自管的加密文件（scrypt + AES-256-GCM）。
 * 查实它在产品流程里**根本走不到**（前端没有任何主密码输入框，也没有调用它的端点），
 * 却在开源仓库里要被人逐行审：那是审查负债。那套密码学已整体删除（M65）。
 *
 * 现在的姿态（M66）：**把边界交给操作系统**——
 * 有系统密码箱就用系统密码箱（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），
 * 没有就回落明文文件并**在界面上明说**。本仓库不自己实现任何加密。
 *
 * 保护边界仍然只有两条——
 * 文件权限（POSIX 0600 / Windows NTFS ACL）与"密码永不进 DOM / 日志 / 诊断上报"。
 */
export type SecurityMode = "plain";

/** 秘密现在存在哪：系统密码箱，还是本机文件。 */
export type CredentialStorage = "keychain" | "file";

export interface SecurityState {
  /** 永远是 "plain"：没有档位之分，只剩"存在哪"这一件事。 */
  mode: SecurityMode;
  /** 本机还留着旧版加密凭据文件（vault.bin）：该格式已停用，等用户点「清理旧版凭据」。 */
  legacy: boolean;
  /** 当前生效的后端：系统密码箱还是本机文件。 */
  storage: CredentialStorage;
  /** 给界面看的一句话：密码存在哪。 */
  storageLabel: string;
  /** 曾经用密码箱、现在临时降级到本机文件。 */
  degraded: boolean;
}

/** security.json 的格式版本。 */
const VERSION = 1;
const SECURITY_FILE = "security.json";
/**
 * 旧版（已停用）加密凭据文件：只用于**识别**与**删除**，永远不读、不解析、不迁移。
 * 那份数据已经没有能读它的代码了——删掉 protected 模式就是这个结论的直接后果。
 */
const LEGACY_VAULT_FILE = "vault.bin";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isMissingFile = (error: unknown): boolean => asRecord(error)?.code === "ENOENT";

const invalid = (file: string, reason: string): Error =>
  new Error("uniterminal: " + file.split(/[\\/]/).pop() + " is invalid (" + file + "): " + reason);

/**
 * security.json 里登记过的档位。
 *
 * "plain" 是现役档；"protected" 是**历史值**——旧版加密档，已经不再被支持。
 * 但它必须能被认出来：认出来是为了告诉用户「你本机还留着旧版文件，请清理」，
 * 不是为了继续用它（继续用它需要那套已经删掉的密码学）。
 */
type RegisteredMode = "plain" | "protected";

/**
 * security.json 里登记过的后端。
 *
 * 缺省（老机器上的 security.json 里没有这个字段）= "file"：
 * 上一批留下的明文库就是文件后端，升级不该凭空改成别的存储。
 */
type RegisteredStorage = "keychain" | "file";

const parseSecurity = (
  text: string,
  file: string,
): { mode: RegisteredMode; storage: RegisteredStorage } => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid(file, "content is not valid JSON");
  }
  const record = asRecord(raw);
  if (record === undefined) throw invalid(file, "root must be an object");
  if (record.version !== VERSION) throw invalid(file, "version must be " + VERSION);
  const mode = record.mode;
  if (mode !== "plain" && mode !== "protected") throw invalid(file, "'mode' must be 'plain' or 'protected'");
  const storage = record.storage;
  if (storage !== undefined && storage !== null && storage !== "keychain" && storage !== "file") {
    throw invalid(file, "'storage' must be 'keychain' or 'file'");
  }
  return {
    mode,
    storage: storage === undefined || storage === null ? "file" : (storage as RegisteredStorage),
  };
};

/**
 * 测试进程一律**不碰真机密码箱**。
 *
 * 测试不该在用户的凭据管理器里留下任何东西（写进去再删掉也可能留痕）。
 * 因此默认探测在测试里直接返回"没有系统密码箱"，后端一律靠注入。
 */
const isTestProcess = (): boolean => process.env.VITEST !== undefined || process.env.NODE_ENV === "test";

/** 构造参数：后端与探测都**可注入**，测试因此不依赖真机密码箱。 */
export interface SecurityStoreOptions {
  /** 直接指定后端（测试用）：给了就不再探测、不再回落。 */
  backend?: CredentialBackend;
  /** 探测系统密码箱（测试用）：返回 undefined 表示这台机器没有可用的系统密码箱。 */
  probe?: () => Promise<CredentialBackend | undefined>;
}

/**
 * 凭据存储的门面：对外只有「记住 / 取回 / 忘了 / 有哪些」，对内把「存在哪」交给后端。
 *
 * 三条不可让步的底线在这里落地：
 * ① 秘密只在宿主进程里：store 不把任何秘密交给浏览器（/security/refs 只回 ref 名字）；
 * ② 后端不可用 → 降级到文件后端，**绝不让插件起不来或请求 500 崩掉**；
 * ③ 降级这件事**如实告诉界面**（degraded + storageLabel），不让用户以为"密码没记住"。
 */
export class SecurityStore {
  readonly #dir: string;
  /** 文件后端：永远存在，永远是降级时的去处。 */
  readonly #file: FileBackend;
  readonly #options: SecurityStoreOptions;
  /** 主后端（系统密码箱）：登记为 keychain 时才有。 */
  #keychain: CredentialBackend | undefined;
  /** 当前生效的后端：降级时从 keychain 换到 file。 */
  #active: CredentialBackend;
  /** 登记进 security.json 的后端（下次启动按它来；降级**不**改这个值）。 */
  #storage: RegisteredStorage = "file";
  /** 曾经用密码箱、现在临时降级到本机文件。 */
  #degraded = false;
  /**
   * 本机存在旧版加密凭据文件：只报告状态，等用户点「清理旧版凭据」——
   * 启动时**绝不**自动删：升级不该静默毁掉用户的数据。
   */
  #legacy = false;

  constructor(dir: string, options: SecurityStoreOptions = {}) {
    this.#dir = dir;
    this.#file = new FileBackend(dir);
    this.#options = options;
    this.#active = options.backend ?? this.#file;
    if (options.backend !== undefined) {
      this.#storage = options.backend.kind;
      if (options.backend.kind === "keychain") this.#keychain = options.backend;
    }
  }

  /**
   * 读取磁盘状态。
   *
   * 旧档（security.json 登记为 protected，或 vault.bin 还在）**不抛错**：
   * 它只是「本机还留着旧版文件」这一个事实，交给界面提示用户去清理。
   * 旧档在场时**不读**任何凭据——旧格式里的密码已经没有能读它的代码了，
   * 界面上必须表现得像「没存过密码」，而不是给一个读不出来的假象。
   */
  async load(): Promise<void> {
    const securityPath = join(this.#dir, SECURITY_FILE);
    let registered: { mode: RegisteredMode; storage: RegisteredStorage } | undefined;
    try {
      registered = parseSecurity(await readFile(securityPath, "utf8"), securityPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      registered = undefined;
    }

    this.#legacy = registered?.mode === "protected" || (await this.#exists(join(this.#dir, LEGACY_VAULT_FILE)));
    // 登记的后端（security.json 里写着"上次用的是哪个"）：清理旧档时不能把它降级掉。
    this.#storage = registered?.storage ?? "file";

    // 注入的后端（测试用）直接生效：不再探测、不再回落。
    if (this.#options.backend !== undefined) {
      this.#storage = this.#options.backend.kind;
      await this.#activate(this.#options.backend);
      return;
    }

    // 旧档在场：等价于「没存过密码」，一个字节都不读。
    if (this.#legacy) return;

    // 测试进程不碰真机密码箱（见 isTestProcess）：默认就是文件后端。
    if (isTestProcess()) {
      await this.#activate(this.#file);
      return;
    }

    if (registered?.storage === "keychain") {
      // 原生模块是懒加载的（第一次真正用它时才 require）：构造后端本身不会失败。
      // 万一装不上，第一次取用时抛 CredentialBackendUnavailableError → 降级到文件后端。
      const keychain = this.#createKeychain();
      if (keychain !== undefined) {
        this.#keychain = keychain;
        await this.#activate(keychain);
        return;
      }
      this.#degraded = true;
    }
    await this.#activate(this.#file);
  }

  /**
   * 选定凭据后端：**探测**系统密码箱 → 有就用它并把旧明文库搬进去；没有就用文件后端。
   *
   * - 探测是**只读**的（findCredentialsAsync 列举一次），不为了探测去写一条测试凭据；
   * - 迁移是**逐条**的，**全部写成功之后**才删 credentials.json；
   * - 任何一步失败都只是"用文件后端"，**绝不让插件起不来**。
   */
  async ensureStorage(): Promise<void> {
    // 旧档在场：用户的文件一个都不动（删旧档是破坏性动作，只能由用户点清理）。
    if (this.#legacy) return;

    if (this.#options.backend !== undefined) {
      // 注入的后端（测试用）：登记即可，不探测、不迁移。
      await this.#writeSecurityJson(this.#storage);
      return;
    }

    // 默认探测在测试进程里被禁用（见 isTestProcess）：测试永远不碰真机密码箱。
    const probe = this.#options.probe ?? (isTestProcess() ? undefined : probeKeychainBackend);
    let keychain: CredentialBackend | undefined;
    try {
      keychain = probe === undefined ? undefined : await probe();
    } catch {
      keychain = undefined;
    }

    if (keychain === undefined) {
      // 没有系统密码箱：文件后端（明文库必须在，与上一批的 ensurePlain 一致）。
      this.#keychain = undefined;
      this.#storage = "file";
      await this.#activate(this.#file);
      await this.#file.ensureFile();
      await this.#writeSecurityJson("file");
      return;
    }

    // 有系统密码箱：先把旧明文库逐条搬进去。
    this.#keychain = keychain;
    this.#storage = "keychain";
    await this.#activate(keychain);
    if (!(await this.#migratePlaintext(keychain))) {
      // 搬不动：保留原文件，继续用文件后端（绝不能出现"删了文件但密码没搬进去"）。
      this.#keychain = undefined;
      this.#degraded = true;
      await this.#activate(this.#file);
    }
    await this.#writeSecurityJson(this.#storage);
  }

  /** 只有一档：mode 恒为 "plain"；storage / storageLabel / degraded 说明密码存在哪。 */
  state(): SecurityState {
    return {
      mode: "plain",
      legacy: this.#legacy,
      storage: this.#active.kind,
      storageLabel: this.#degraded ? STORAGE_LABEL_DEGRADED : this.#active.label,
      degraded: this.#degraded,
    };
  }

  /** 曾经用密码箱、现在临时降级？（界面据此换一句文案） */
  degraded(): boolean {
    return this.#degraded;
  }

  /**
   * 清理旧版凭据：删掉已停用的旧档文件、把自己登记回明文档。
   *
   * **已经记住的密码一条都不动**：凭据库里装的是用户已经记住的密码，
   * 清理只该丢弃旧格式文件里那份读不出来的数据——**旧档里的密码**才是不解密、不迁移的那部分。
   * 已是明文时直接返回：重复点击不该动用户已经记住的密码。
   */
  async clearLegacy(): Promise<void> {
    if (!this.#legacy) return;
    // 顺序：先确保凭据文件在（没有才建空的），再读回来，翻 security.json，最后删旧档。
    // 中途失败最坏只留下一个被忽略的旧档文件——**绝不会把用户已经记住的密码清空**。
    if (this.#active === this.#file) {
      await this.#file.ensureFile();
      // 先读：读不动就别动用户的任何文件（权限过宽 / 文件损坏 → 直接抛错，旧档原样留着）
      await this.#file.load();
    }
    await this.#writeSecurityJson(this.#storage);
    await rm(join(this.#dir, LEGACY_VAULT_FILE), { force: true });
    this.#legacy = false;
    // 这里**不做**明文库 → 密码箱的迁移：清理旧档的形状必须与上一批一模一样
    // （用户的明文凭据原地保留，一个字节都不动）。迁移是启动时的事：
    // 下次启动探测到密码箱可用时，明文库会被逐条搬进去，搬完才删。
  }

  /** 取一条凭据：现读现用，**不在内存里缓存秘密**。 */
  async get(ref: string): Promise<string | undefined> {
    if (this.#legacy) return undefined;
    try {
      return await this.#active.get(ref);
    } catch (error) {
      if (!(error instanceof CredentialBackendUnavailableError)) throw error;
      await this.#degrade();
      return this.#file.get(ref);
    }
  }

  /**
   * 写一条凭据。
   *
   * 旧档在场时**拒绝写入**：旧格式已经没有任何能读它的代码了，这时候写进去的东西读不回来——
   * 收下再假装"记住了"，是在骗用户。唯一的出路是用户点「清理旧版凭据」。
   */
  async put(ref: string, secret: string): Promise<void> {
    if (this.#legacy) throw new Error("uniterminal: legacy credentials are present; clear them first");
    try {
      await this.#active.put(ref, secret);
    } catch (error) {
      if (!(error instanceof CredentialBackendUnavailableError)) throw error;
      await this.#degrade();
      await this.#file.put(ref, secret);
    }
  }

  async remove(ref: string): Promise<void> {
    if (this.#legacy) return;
    try {
      await this.#active.remove(ref);
    } catch (error) {
      if (!(error instanceof CredentialBackendUnavailableError)) throw error;
      await this.#degrade();
      await this.#file.remove(ref);
    }
  }

  /** 列出已记住的 ref（**只有名字**）：浏览器与界面拿到的就是这些字符串。 */
  async listRefs(): Promise<string[]> {
    if (this.#legacy) return [];
    try {
      return await this.#active.listRefs();
    } catch (error) {
      if (!(error instanceof CredentialBackendUnavailableError)) throw error;
      await this.#degrade();
      return this.#file.listRefs();
    }
  }

  /** 切到某个后端：文件后端要先读盘（懒加载：坏了就是坏了，每次报同一个错）。 */
  async #activate(backend: CredentialBackend): Promise<void> {
    if (backend === this.#file) await this.#file.load();
    this.#active = backend;
  }

  /**
   * 密码箱这一刻用不了（被锁 / 服务没起 / 原生模块装不上 / 条目歧义）：
   * 换到文件后端，并把"曾经用密码箱"这件事记下来，让界面如实说。
   */
  async #degrade(): Promise<void> {
    if (this.#active !== this.#keychain) return;
    this.#degraded = true;
    this.#active = this.#file;
    await this.#file.load();
  }

  /** 建一个系统密码箱后端；建不起来（原生模块装不上）时返回 undefined。 */
  #createKeychain(): CredentialBackend | undefined {
    try {
      return new KeychainBackend();
    } catch (error) {
      diag("credential.keychain-unavailable", { error: String(error).slice(0, 160) });
      return undefined;
    }
  }

  /**
   * 把旧明文库逐条搬进系统密码箱。
   *
   * **全部写成功之后**才删 credentials.json；中途失败就保留原文件、继续用文件后端——
   * 绝不能出现"删了文件但密码没搬进去"。搬完**不留明文副本**。
   */
  async #migratePlaintext(keychain: CredentialBackend): Promise<boolean> {
    let entries: Map<string, string>;
    try {
      entries = await this.#file.readAll();
    } catch (error) {
      // 明文库读不动（损坏 / 权限过宽）：搬不了，保留原文件。
      diag("security.migration-read-failed", { error: String(error).slice(0, 160) });
      return false;
    }
    if (entries.size === 0) return true;
    for (const [ref, secret] of entries) {
      try {
        await keychain.put(ref, secret);
      } catch {
        // 只记 ref 名，绝不记秘密。
        diag("security.migration-failed", { ref });
        return false;
      }
    }
    // 全部搬完 → 删掉明文副本（不留明文）。
    await this.#file.removeFile();
    diag("security.migrated", { count: entries.size });
    return true;
  }

  /**
   * 登记 security.json：mode 恒为 plain，storage 记下"密码存在哪"。
   *
   * 登记没变就**一个字节都不动**（幂等）：用户的文件不该被无意义地改写。
   */
  async #writeSecurityJson(storage: RegisteredStorage): Promise<void> {
    const path = join(this.#dir, SECURITY_FILE);
    const value = { version: VERSION, mode: "plain", storage };
    let current: string | undefined;
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (current === JSON.stringify(value, null, 2) + "\n") return;
    await this.#writeJson(path, value);
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
    await chmod(temp, 0o600);
    await rename(temp, file);
  }
}
