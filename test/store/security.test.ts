import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialBackendUnavailableError,
  KeychainBackend,
  KEYCHAIN_SERVICE,
  STORAGE_LABEL_FILE,
  STORAGE_LABEL_DEGRADED,
  type CredentialBackend,
} from "../../src/store/credential-backend.js";
import { SecurityStore, type SecurityState, type SecurityStoreOptions } from "../../src/store/security.js";

/**
 * 凭据存储：秘密存在哪由一个**可替换的后端**决定。
 *
 * 这一份原来测的是被删掉的那套密码学（主密码 + 自建加密文件）。
 * 那些用例不是"删了就没了"：每一条都换成了新行为锁，对应关系写在
 * docs/superpowers/plans/ledger-m0.md 的 M65 / M66 两节里。
 *
 * 留下来的老锁一条都不许弱化：
 * ① 明文凭据文件走「临时文件 → chmod 0600 → rename」的原子写；
 * ② POSIX 上属主校验：权限过宽直接拒绝加载，绝不清空；
 * ③ 损坏的文件要报错，且原文件一个字节都不许动。
 *
 * M66 新增的锁：
 * ④ 系统密码箱后端的往返与「只认我们那三种 ref 前缀」；
 * ⑤ 探测失败 → 回落文件后端，插件仍然能用；
 * ⑥ 明文库 → 密码箱的迁移：全部搬完才删文件，中途失败保留原文件；
 * ⑦ 密码箱不可用 → 降级到文件后端，并如实告诉界面（degraded）。
 */

/** 记录落盘顺序：临时文件 → chmod 0600 → rename。 */
const fsSpy = vi.hoisted(() => ({ chmod: vi.fn(), rename: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsSpy.chmod.mockImplementation((path: string, mode: number) => actual.chmod(path, mode));
  fsSpy.rename.mockImplementation((from: string, to: string) => actual.rename(from, to));
  return { ...actual, chmod: fsSpy.chmod, rename: fsSpy.rename };
});

/**
 * 假原生模块：把 @napi-rs/keyring 整个换掉。
 *
 * 这样 KeychainBackend 的**真实代码**（service/account 的对应、只认三种前缀的过滤、
 * 抛错即"后端不可用"）都能被测到，而测试**不依赖真机密码箱**，
 * 也不会在用户的凭据管理器里留下任何东西。
 */
const keyring = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  available: true,
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly #service: string;
    readonly #account: string;
    constructor(service: string, account: string) {
      this.#service = service;
      this.#account = account;
    }
    #key(): string {
      return this.#service + "\u0000" + this.#account;
    }
    async setPassword(password: string): Promise<void> {
      if (!keyring.available) throw new Error("keychain is locked");
      keyring.entries.set(this.#key(), password);
    }
    async getPassword(): Promise<string | null> {
      if (!keyring.available) throw new Error("keychain is locked");
      return keyring.entries.get(this.#key()) ?? null;
    }
    async deletePassword(): Promise<boolean> {
      if (!keyring.available) throw new Error("keychain is locked");
      return keyring.entries.delete(this.#key());
    }
  },
  findCredentialsAsync: async (service: string): Promise<{ account: string; password: string }[]> => {
    if (!keyring.available) throw new Error("keychain is locked");
    const found: { account: string; password: string }[] = [];
    for (const [key, password] of keyring.entries) {
      const split = key.indexOf("\u0000");
      if (key.slice(0, split) === service) found.push({ account: key.slice(split + 1), password });
    }
    return found;
  },
}));

/** 一个"此刻用不了"的系统密码箱：所有动作都抛"后端不可用"（模拟密码箱被锁）。 */
class BrokenKeychain implements CredentialBackend {
  readonly kind = "keychain" as const;
  readonly label = "密码保存在系统密码箱";
  async get(): Promise<string | undefined> {
    throw new CredentialBackendUnavailableError();
  }
  async put(): Promise<void> {
    throw new CredentialBackendUnavailableError();
  }
  async remove(): Promise<void> {
    throw new CredentialBackendUnavailableError();
  }
  async listRefs(): Promise<string[]> {
    throw new CredentialBackendUnavailableError();
  }
}

const dirs: string[] = [];

/** 每个用例一个 mkdtemp 目录：永不触碰真实的 ~/.dsh/uniterminal。 */
const openStore = async (
  options?: SecurityStoreOptions,
): Promise<{ store: SecurityStore; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "uniterminal-security-"));
  dirs.push(dir);
  return { store: new SecurityStore(dir, options), dir };
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;

/** 文件后端下的状态：没有系统密码箱，密码明文落盘。 */
const fileState = (overrides: Partial<SecurityState> = {}): SecurityState => ({
  mode: "plain",
  legacy: false,
  storage: "file",
  storageLabel: STORAGE_LABEL_FILE,
  degraded: false,
  ...overrides,
});

/**
 * 造一个旧档现场：security.json 登记成 protected + vault.bin 在场。
 * vault.bin 里放什么没人读得了——它在场这件事本身就是全部意义。
 */
const openLegacyStore = async (): Promise<{ store: SecurityStore; dir: string }> => {
  const { store, dir } = await openStore();
  await writeFile(join(dir, "security.json"), JSON.stringify({ version: 1, mode: "protected" }) + "\n", "utf8");
  await writeFile(join(dir, "vault.bin"), "legacy-bytes-nobody-reads", "utf8");
  return { store, dir };
};

/** win32 的 chmod 改不了 POSIX 位，用「假装在 POSIX 上」触发真实的权限闸门。 */
const asPosixPlatform = async (run: () => Promise<void>): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform is not configurable");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true, enumerable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
};

beforeEach(() => {
  keyring.entries.clear();
  keyring.available = true;
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SecurityStore 首次运行（ensureStorage）", () => {
  it("建好明文档：security.json + 空的 credentials.json", async () => {
    const { store, dir } = await openStore();
    await store.load();

    expect(store.state()).toEqual(fileState());

    await store.ensureStorage();

    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "plain", storage: "file" });
    expect(await readJson(join(dir, "credentials.json"))).toEqual({ version: 1, entries: {} });
    expect(await store.listRefs()).toEqual([]);
  });

  it("幂等：已登记过就直接返回，凭据文件一个字节都不动", async () => {
    const { store, dir } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");
    const before = await readFile(join(dir, "credentials.json"), "utf8");

    await store.ensureStorage();
    await store.ensureStorage();

    expect(await readFile(join(dir, "credentials.json"), "utf8")).toBe(before);
    expect(await store.get("profile:web")).toBe("hunter2");
  });

  it("不覆盖已有的凭据文件：老机器上只补 security.json", async () => {
    const { store, dir } = await openStore();
    await writeFile(
      join(dir, "credentials.json"),
      JSON.stringify({ version: 1, entries: { "profile:web": "hunter2" } }) + "\n",
      "utf8",
    );
    await store.load();

    await store.ensureStorage();

    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "plain", storage: "file" });
    expect(await store.get("profile:web")).toBe("hunter2");
  });

  it("重复 load() 幂等：状态与凭据都不变", async () => {
    const { store } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");

    await store.load();
    await store.load();

    expect(store.state()).toEqual(fileState());
    expect(await store.listRefs()).toEqual(["profile:web"]);
    expect(await store.get("profile:web")).toBe("hunter2");
  });

  it("状态里只有「存在哪」这一件事：没有档位，也没有遗留任何定时器", async () => {
    vi.useFakeTimers();
    try {
      const { store } = await openStore();
      await store.ensureStorage();
      await store.put("profile:web", "hunter2");
      await store.get("profile:web");
      await store.listRefs();

      expect(Object.keys(store.state()).sort()).toEqual(["degraded", "legacy", "mode", "storage", "storageLabel"]);
      expect(store.state()).toEqual(fileState());
      // 闲置自动上锁连同它的计时器一起删干净了：一次完整往返后不留定时器
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SecurityStore 旧档识别", () => {
  it("load() 不抛错：登记成 protected 只被标成 legacy=true", async () => {
    const { store } = await openLegacyStore();

    await store.load();

    expect(store.state()).toEqual(fileState({ legacy: true }));
  });

  it("旧档在场时不提供任何 ref：等价于没存过密码", async () => {
    const { store } = await openLegacyStore();
    await store.load();

    expect(await store.listRefs()).toEqual([]);
    expect(await store.get("profile:web")).toBeUndefined();
  });

  it("load() 不删 vault.bin：一个字节都不动", async () => {
    const { store, dir } = await openLegacyStore();
    const before = await readFile(join(dir, "vault.bin"), "utf8");

    await store.load();

    expect(await readFile(join(dir, "vault.bin"), "utf8")).toBe(before);
    expect(store.state().legacy).toBe(true);
  });

  it("旧档在场时拒绝写入：收下再假装记住了是在骗用户", async () => {
    const { store, dir } = await openLegacyStore();
    await store.load();

    await expect(store.put("profile:web", "hunter2")).rejects.toThrow(/uniterminal: legacy credentials are present/);

    expect(await store.listRefs()).toEqual([]);
    // 磁盘上也没有多出一个凭据文件
    await expect(readFile(join(dir, "credentials.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("ensureStorage 不碰旧档：删旧文件是破坏性动作，只能由用户点清理", async () => {
    const { store, dir } = await openLegacyStore();
    await store.load();

    await store.ensureStorage();

    expect(store.state().legacy).toBe(true);
    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "protected" });
    await expect(readFile(join(dir, "vault.bin"), "utf8")).resolves.toContain("legacy-bytes");
  });

  it("旧档文件的内容无关紧要：它只被当成「文件在场」，绝不解析", async () => {
    const { store, dir } = await openLegacyStore();
    await writeFile(join(dir, "vault.bin"), "{ not json", "utf8");

    await store.load();

    expect(store.state().legacy).toBe(true);
    expect(await readFile(join(dir, "vault.bin"), "utf8")).toBe("{ not json");
  });
});

describe("SecurityStore clearLegacy", () => {
  it("清理旧档：vault.bin 被删、security.json 变 plain、credentials.json 建好", async () => {
    const { store, dir } = await openLegacyStore();
    await store.load();

    await store.clearLegacy();

    expect(store.state()).toEqual(fileState());
    await expect(readFile(join(dir, "vault.bin"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "plain", storage: "file" });
    expect(await readJson(join(dir, "credentials.json"))).toEqual({ version: 1, entries: {} });
    expect(await store.listRefs()).toEqual([]);
  });

  it("清理之后不用任何解锁动作就能继续用", async () => {
    const { store, dir } = await openLegacyStore();
    await store.load();

    await store.clearLegacy();
    await store.put("profile:db", "s3cret");

    expect(await store.listRefs()).toEqual(["profile:db"]);
    expect(await store.get("profile:db")).toBe("s3cret");

    const reopened = new SecurityStore(dir);
    await reopened.load();
    expect(reopened.state()).toEqual(fileState());
    expect(await reopened.listRefs()).toEqual(["profile:db"]);
  });

  it("没有旧档时是空操作：已记住的密码一条都不少", async () => {
    const { store } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");

    await store.clearLegacy();
    await store.clearLegacy();

    expect(store.state()).toEqual(fileState());
    expect(await store.get("profile:web")).toBe("hunter2");
    expect(await store.listRefs()).toEqual(["profile:web"]);
  });

  /**
   * 数据丢失回归锁：清理旧版凭据**绝不许**动明文库里已经记住的密码。
   *
   * legacy 有两个来源，两条都要测：
   * ① security.json 登记成 protected（真·旧档用户）；
   * ② 只是 vault.bin 残留（用户早就是 plain 档）——这时他的明文凭据**完全有效**，
   *    点一次「清理旧版凭据」不该把它清掉。
   */
  it("清理旧版凭据不会清掉已经存在的明文凭据（旧档来自 security.json 登记）", async () => {
    const { store, dir } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");
    // 制造旧档现场：登记成 protected + vault.bin 在场
    await writeFile(join(dir, "security.json"), JSON.stringify({ version: 1, mode: "protected" }) + "\n", "utf8");
    await writeFile(join(dir, "vault.bin"), "legacy-bytes-nobody-reads", "utf8");

    const reopened = new SecurityStore(dir);
    await reopened.load();
    expect(reopened.state().legacy).toBe(true);

    await reopened.clearLegacy();

    // 已经记住的密码一条都不少
    expect(await reopened.get("profile:web")).toBe("hunter2");
    expect(await reopened.listRefs()).toEqual(["profile:web"]);
    expect(await readJson(join(dir, "credentials.json"))).toEqual({
      version: 1,
      entries: { "profile:web": "hunter2" },
    });
    // 旧档本身照旧被丢掉
    await expect(readFile(join(dir, "vault.bin"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "plain", storage: "file" });
    expect(reopened.state()).toEqual(fileState());
  });

  it("清理旧版凭据不会清掉已经存在的明文凭据（旧档来自 vault.bin 残留）", async () => {
    const { store, dir } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");
    // 只是 vault.bin 残留：用户本来就是 plain 档，他的明文凭据完全有效
    await writeFile(join(dir, "vault.bin"), "legacy-bytes-nobody-reads", "utf8");

    const reopened = new SecurityStore(dir);
    await reopened.load();
    expect(reopened.state().legacy).toBe(true);

    await reopened.clearLegacy();

    expect(await reopened.get("profile:web")).toBe("hunter2");
    expect(await reopened.listRefs()).toEqual(["profile:web"]);
    expect(await readJson(join(dir, "credentials.json"))).toEqual({
      version: 1,
      entries: { "profile:web": "hunter2" },
    });
    await expect(readFile(join(dir, "vault.bin"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await readJson(join(dir, "security.json"))).toEqual({ version: 1, mode: "plain", storage: "file" });
    expect(reopened.state()).toEqual(fileState());
  });

  it("反向锁：credentials.json 不存在时，清理仍会建好空文件（新建路径没坏）", async () => {
    const { store, dir } = await openLegacyStore();
    await store.load();
    expect(store.state().legacy).toBe(true);

    await store.clearLegacy();

    expect(await readJson(join(dir, "credentials.json"))).toEqual({ version: 1, entries: {} });
    expect(await store.listRefs()).toEqual([]);
    expect(store.state()).toEqual(fileState());
  });
});

describe("SecurityStore 文件后端", () => {
  it("round-trips secrets and writes credentials.json owner-only via a temp file", async () => {
    const { store, dir } = await openStore();
    await store.ensureStorage();
    fsSpy.chmod.mockClear();
    fsSpy.rename.mockClear();

    await store.put("profile:web", "hunter2");
    await store.put("profile:db", "s3cret");

    await expect(store.get("profile:web")).resolves.toBe("hunter2");
    expect(await store.listRefs()).toEqual(["profile:web", "profile:db"]);

    const file = join(dir, "credentials.json");
    expect(await readJson(file)).toEqual({
      version: 1,
      entries: { "profile:web": "hunter2", "profile:db": "s3cret" },
    });

    const chmodCalls = fsSpy.chmod.mock.calls as unknown as [string, number][];
    const renameCalls = fsSpy.rename.mock.calls as unknown as [string, string][];
    expect(chmodCalls.map((call) => call[1])).toEqual([0o600, 0o600]);
    expect(chmodCalls.map((call) => call[0])).toEqual(renameCalls.map((call) => call[0]));
    expect(chmodCalls.every((call) => call[0].endsWith(".tmp") && call[0] !== file)).toBe(true);
    expect(renameCalls.map((call) => call[1])).toEqual([file, file]);
    // 两次写入各用各的临时文件：成品文件不会在半成品上就地改写
    expect(chmodCalls[0]?.[0]).not.toBe(chmodCalls[1]?.[0]);

    // win32 上 stat 恒报 0o666，POSIX 位由 NTFS ACL 表达；真实位只在 POSIX 上断言
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reopened = new SecurityStore(dir);
    await reopened.load();
    expect(reopened.state()).toEqual(fileState());
    expect(await reopened.listRefs()).toEqual(["profile:web", "profile:db"]);

    await reopened.remove("profile:db");
    expect(await reopened.listRefs()).toEqual(["profile:web"]);
    const afterRemove = new SecurityStore(dir);
    await afterRemove.load();
    expect(await afterRemove.listRefs()).toEqual(["profile:web"]);
  });

  it("refuses to load a credentials file that other users can read", async () => {
    const { store, dir } = await openStore();
    await store.ensureStorage();
    await store.put("profile:web", "hunter2");
    const file = join(dir, "credentials.json");
    await chmod(file, 0o644);
    const before = await readFile(file, "utf8");

    const reopened = new SecurityStore(dir);
    await asPosixPlatform(async () => {
      await expect(reopened.load()).rejects.toThrow(/uniterminal: credentials.json permissions are too open/);
    });

    expect(reopened.state()).toEqual(fileState());
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("throws on corrupted files and leaves them untouched", async () => {
    const plainStore = await openStore();
    await plainStore.store.ensureStorage();
    await plainStore.store.put("profile:db", "s3cret");

    const securityPath = join(plainStore.dir, "security.json");
    const brokenSecurity = JSON.stringify({ version: 2, mode: "plain" });
    await writeFile(securityPath, brokenSecurity, "utf8");
    await expect(new SecurityStore(plainStore.dir).load()).rejects.toThrow(
      /uniterminal: security.json is invalid/,
    );
    expect(await readFile(securityPath, "utf8")).toBe(brokenSecurity);

    // security.json 修好之后，坏掉的 credentials.json 一样要报错
    await writeFile(securityPath, JSON.stringify({ version: 1, mode: "plain" }) + "\n", "utf8");
    const credentialsPath = join(plainStore.dir, "credentials.json");
    await writeFile(credentialsPath, "[]", "utf8");
    await expect(new SecurityStore(plainStore.dir).load()).rejects.toThrow(
      /uniterminal: credentials.json is invalid/,
    );
    expect(await readFile(credentialsPath, "utf8")).toBe("[]");
  });
});

describe("KeychainBackend（系统密码箱后端）", () => {
  it("get/put/remove/listRefs 往返", async () => {
    const backend = new KeychainBackend();

    await backend.put("profile:web", "hunter2");
    expect(await backend.get("profile:web")).toBe("hunter2");
    expect(await backend.listRefs()).toEqual(["profile:web"]);

    await backend.remove("profile:web");
    expect(await backend.get("profile:web")).toBeUndefined();
    expect(await backend.listRefs()).toEqual([]);
  });

  it("listRefs 只认我们那三种 ref 前缀：别人的同名条目被过滤掉", async () => {
    const backend = new KeychainBackend();
    await backend.put("profile:web", "hunter2");
    await backend.put("key:db", "s3cret");
    await backend.put("key-passphrase:db", "phrase");
    // 别人写在同一个 service 下的条目：不是我们的，不认
    keyring.entries.set(KEYCHAIN_SERVICE + "\u0000someone-else", "not-ours");
    // 别人写在别的 service 下的条目：连列举都轮不到
    keyring.entries.set("some-other-app\u0000profile:web", "not-ours-either");

    expect(await backend.listRefs()).toEqual(["profile:web", "key:db", "key-passphrase:db"]);
  });

  it("密码箱此刻不可用时抛「后端不可用」：不回落、不把底层原文泄出去", async () => {
    keyring.available = false;
    try {
      const backend = new KeychainBackend();
      await expect(backend.get("profile:web")).rejects.toThrow(CredentialBackendUnavailableError);
      await expect(backend.put("profile:web", "hunter2")).rejects.toThrow(CredentialBackendUnavailableError);
      await expect(backend.listRefs()).rejects.toThrow(CredentialBackendUnavailableError);
    } finally {
      keyring.available = true;
    }
  });

  it("没有缓存秘密：每次 get 都现读现用", async () => {
    const backend = new KeychainBackend();
    await backend.put("profile:web", "hunter2");
    // 底层那条被改了，get 必须读到新的那份（说明它不是内存里的快照）
    keyring.entries.set(KEYCHAIN_SERVICE + "\u0000profile:web", "changed-elsewhere");
    expect(await backend.get("profile:web")).toBe("changed-elsewhere");
  });
});

describe("SecurityStore 选后端：探测失败 → 回落文件后端", () => {
  it("没有系统密码箱：自动用文件后端，插件仍然能用（能存能取）", async () => {
    const { store, dir } = await openStore({ probe: async () => undefined });
    await store.load();

    await store.ensureStorage();

    expect(store.state()).toEqual(fileState());
    expect(store.state().storageLabel).toBe(STORAGE_LABEL_FILE);
    // 仍然能用：能存能取
    await store.put("profile:web", "hunter2");
    expect(await store.get("profile:web")).toBe("hunter2");
    expect(await store.listRefs()).toEqual(["profile:web"]);
    // 磁盘上确实落了明文库（界面会如实说明这一点）
    expect(await readJson(join(dir, "credentials.json"))).toEqual({
      version: 1,
      entries: { "profile:web": "hunter2" },
    });
  });

  it("探测本身抛错也回落：探测失败绝不能让插件起不来", async () => {
    const { store } = await openStore({
      probe: async () => {
        throw new Error("probe exploded");
      },
    });
    await store.load();

    await store.ensureStorage();

    expect(store.state().storage).toBe("file");
    await store.put("profile:web", "hunter2");
    expect(await store.get("profile:web")).toBe("hunter2");
  });

  it("探测到系统密码箱：状态说清楚密码存在哪", async () => {
    const { store, dir } = await openStore({ probe: async () => new KeychainBackend() });
    await store.load();

    await store.ensureStorage();

    expect(store.state().storage).toBe("keychain");
    expect(store.state().degraded).toBe(false);
    expect(await readJson(join(dir, "security.json"))).toEqual({
      version: 1,
      mode: "plain",
      storage: "keychain",
    });
  });
});

describe("SecurityStore 迁移：明文库 → 系统密码箱", () => {
  /** 造一个"上一批留下的"明文库。 */
  const seedPlaintext = async (dir: string): Promise<void> => {
    const plain = new SecurityStore(dir, { probe: async () => undefined });
    await plain.load();
    await plain.ensureStorage();
    await plain.put("profile:web", "hunter2");
    await plain.put("key:db", "s3cret");
  };

  it("逐条搬完才删 credentials.json：搬完之后磁盘上没有明文副本", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uniterminal-security-"));
    dirs.push(dir);
    await seedPlaintext(dir);

    const store = new SecurityStore(dir, { probe: async () => new KeychainBackend() });
    await store.load();
    await store.ensureStorage();

    // 两条都搬进了密码箱
    expect(await store.get("profile:web")).toBe("hunter2");
    expect(await store.get("key:db")).toBe("s3cret");
    expect(await store.listRefs()).toEqual(["profile:web", "key:db"]);
    // 明文副本没了
    await expect(readFile(join(dir, "credentials.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("中途失败：保留原文件、继续用文件后端，已经记住的密码一条都不少", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uniterminal-security-"));
    dirs.push(dir);
    await seedPlaintext(dir);

    // 写到第二条就失败（模拟密码箱中途出问题）
    let writes = 0;
    const flaky: CredentialBackend = {
      kind: "keychain",
      label: "密码保存在系统密码箱",
      get: async () => undefined,
      put: async (ref: string, secret: string) => {
        writes += 1;
        if (writes === 2) throw new CredentialBackendUnavailableError();
        keyring.entries.set(KEYCHAIN_SERVICE + "\u0000" + ref, secret);
      },
      remove: async () => undefined,
      listRefs: async () => [],
    };
    const store = new SecurityStore(dir, { probe: async () => flaky });
    await store.load();

    await store.ensureStorage();

    // 原文件还在（绝不能出现"删了文件但密码没搬进去"）
    await expect(readFile(join(dir, "credentials.json"), "utf8")).resolves.toContain("hunter2");
    // 继续用文件后端，密码照常取回
    expect(store.state().storage).toBe("file");
    expect(await store.get("profile:web")).toBe("hunter2");
    expect(await store.get("key:db")).toBe("s3cret");
  });
});

describe("SecurityStore 降级：密码箱此刻不可用", () => {
  it("get/put 走文件后端，并如实告诉界面（degraded）", async () => {
    const { store, dir } = await openStore({ backend: new BrokenKeychain() });
    await store.load();
    // 降级后的去处是文件后端：这里先放一条，模拟"降级前写进文件的那条"
    await writeFile(
      join(dir, "credentials.json"),
      JSON.stringify({ version: 1, entries: { "profile:web": "hunter2" } }) + "\n",
      "utf8",
    );

    expect(await store.get("profile:web")).toBe("hunter2");

    expect(store.state().degraded).toBe(true);
    expect(store.state().storage).toBe("file");
    expect(store.state().storageLabel).toBe(STORAGE_LABEL_DEGRADED);

    // put 也走文件后端
    await store.put("profile:db", "s3cret");
    expect(await readJson(join(dir, "credentials.json"))).toEqual({
      version: 1,
      entries: { "profile:web": "hunter2", "profile:db": "s3cret" },
    });
    expect(await store.listRefs()).toEqual(["profile:web", "profile:db"]);
  });

  it("登记的后端不变：下次启动还会再试密码箱", async () => {
    const { store, dir } = await openStore({ backend: new BrokenKeychain() });
    await store.load();
    await store.ensureStorage();

    // 密码箱此刻用不了 → 降级（这是**运行时**的事）
    await store.get("profile:web");
    expect(store.state().degraded).toBe(true);
    expect(store.state().storage).toBe("file");
    // security.json 里登记的还是原后端：下次启动还会再试密码箱
    expect(await readJson(join(dir, "security.json"))).toEqual({
      version: 1,
      mode: "plain",
      storage: "keychain",
    });
  });
});
