import { describe, expect, it } from "vitest";
import {
  buildSessionTabMeta,
  resolveCloseTab,
  resolveOpenTab,
  parseSessionIdFromTabId,
  parseSessionTabMeta,
  sanitizeProfileSnapshot,
  SESSION_TAB_PREFIX,
  sessionIdTabId,
} from "../../src/client/right-pane.js";

/**
 * 会话标签的身份 = 标签 id（M9-2）。
 * 上一次尝试把会话 id 塞在 tab.path 里，线上证明那条通道拿不到载荷（M9-1 回滚）。
 * 这一层是纯函数：前缀进、前缀出，解析不出来一律当启动器，绝不抛错。
 */
describe("session tab id (M9-2)", () => {
  it("prefixes a session id with uniterminal:", () => {
    expect(sessionIdTabId("s-1")).toBe("uniterminal:s-1");
  });

  it("round-trips the session id", () => {
    expect(parseSessionIdFromTabId(sessionIdTabId("s-1"))).toBe("s-1");
  });

  it("treats an empty session id as no session at all", () => {
    expect(sessionIdTabId("")).toBe("");
    expect(parseSessionIdFromTabId(sessionIdTabId(""))).toBeUndefined();
  });

  it("reports undefined for the launcher tab id", () => {
    expect(parseSessionIdFromTabId("uniterminal")).toBeUndefined();
  });

  it("is case sensitive: a differently cased prefix is not a session", () => {
    expect(parseSessionIdFromTabId("Uniterminal:s-1")).toBeUndefined();
    expect(parseSessionIdFromTabId("UNITERNIMAL:s-1")).toBeUndefined();
  });

  it("reports undefined for missing or non-string ids", () => {
    expect(parseSessionIdFromTabId("")).toBeUndefined();
    expect(parseSessionIdFromTabId(undefined)).toBeUndefined();
    expect(parseSessionIdFromTabId(null)).toBeUndefined();
    expect(parseSessionIdFromTabId(42)).toBeUndefined();
    expect(parseSessionIdFromTabId({ id: "uniterminal:s-1" })).toBeUndefined();
    expect(parseSessionIdFromTabId(["uniterminal:s-1"])).toBeUndefined();
  });

  it("reports undefined when only the prefix is present", () => {
    expect(parseSessionIdFromTabId("uniterminal:")).toBeUndefined();
  });

  it("keeps colons inside the session id intact", () => {
    expect(parseSessionIdFromTabId("uniterminal:a:b")).toBe("a:b");
    expect(parseSessionIdFromTabId(sessionIdTabId("a:b"))).toBe("a:b");
    expect(parseSessionIdFromTabId("uniterminal::")).toBe(":");
  });

  it("ignores ids that carry another prefix", () => {
    expect(parseSessionIdFromTabId("other:s-1")).toBeUndefined();
    expect(parseSessionIdFromTabId(":uniterminal:s-1")).toBeUndefined();
  });

  it("never throws on hostile input", () => {
    const hostile: unknown[] = ["", "uniterminal", "uniterminal:", ":uniterminal", {}, [], () => undefined, Symbol("x")];
    for (const input of hostile) {
      expect(() => parseSessionIdFromTabId(input)).not.toThrow();
    }
  });

  it("exposes the prefix the component matches on", () => {
    expect(SESSION_TAB_PREFIX).toBe("uniterminal:");
  });
});

/** 带凭据的档案：构造侧与解析侧都必须把它过滤成白名单。 */
const profileWithSecrets = {
  id: "s-1",
  name: "box",
  kind: "ssh",
  host: "10.0.0.9",
  port: 22,
  user: "root",
  remember: true,
  auth: { kind: "key", identityPath: "C:/keys/id_ed25519", password: "hunter2", privateKey: "-----BEGIN KEY-----", passphrase: "phrase" },
  password: "hunter2",
  privateKey: "-----BEGIN KEY-----",
  passphrase: "phrase",
  proxyJump: ["bastion.example.com"],
};

/**
 * 白名单里现在有 proxyJump（跳板链）：它**不是凭据**，是连接路径——
 * 存档 profiles.json 里本来就明文存着它，放行它不破坏「凭据永不进快照」这道防线。
 */
const whitelisted = {
  id: "s-1",
  name: "box",
  kind: "ssh",
  host: "10.0.0.9",
  port: 22,
  user: "root",
  remember: true,
  auth: { kind: "key", identityPath: "C:/keys/id_ed25519" },
  proxyJump: ["bastion.example.com"],
};

const CREDENTIALS = ["hunter2", "BEGIN KEY", "phrase"];

function expectNoCredentials(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of CREDENTIALS) expect(text).not.toContain(secret);
}

describe("profile snapshot whitelist (M9-2)", () => {
  it("keeps only the whitelisted fields", () => {
    expect(sanitizeProfileSnapshot(profileWithSecrets)).toEqual(whitelisted);
  });

  it("drops credentials on the construction side", () => {
    const meta = buildSessionTabMeta(profileWithSecrets);
    expect(meta).toEqual({ profile: whitelisted });
    expectNoCredentials(meta);
  });

  it("drops credentials on the parse side", () => {
    // 宿主或旧标签塞回来的 meta 不受我们控制：解析时必须再过一遍白名单
    const parsed = parseSessionTabMeta({ profile: profileWithSecrets });
    expect(parsed).toEqual(whitelisted);
    expectNoCredentials(parsed);
  });

  it("rejects garbage instead of throwing", () => {
    expect(parseSessionTabMeta(undefined)).toBeUndefined();
    expect(parseSessionTabMeta(null)).toBeUndefined();
    expect(parseSessionTabMeta("uniterminal:s-1")).toBeUndefined();
    expect(parseSessionTabMeta({})).toBeUndefined();
    expect(parseSessionTabMeta({ profile: "nope" })).toBeUndefined();
    expect(sanitizeProfileSnapshot(undefined)).toBeUndefined();
    expect(sanitizeProfileSnapshot("s-1")).toBeUndefined();
    expect(sanitizeProfileSnapshot([])).toBeUndefined();
  });

  it("keeps the snapshot free of non-finite ports and non-string hosts", () => {
    expect(sanitizeProfileSnapshot({ host: 22, port: Number.NaN })).toEqual({});
    expect(sanitizeProfileSnapshot({ host: "h", port: "22" })).toEqual({ host: "h" });
  });

  it("never lets an empty auth object claim a method", () => {
    expect(sanitizeProfileSnapshot({ auth: { password: "hunter2" } })).toEqual({ auth: {} });
  });

  it("proxyJump 进快照：跳板链是连接路径，不是凭据", () => {
    expect(sanitizeProfileSnapshot({ host: "h", proxyJump: ["ops@jump1:2222", "jump2.internal"] })).toEqual({
      host: "h",
      proxyJump: ["ops@jump1:2222", "jump2.internal"],
    });
  });

  it("proxyJump 非法就整条丢弃，绝不发半条链", () => {
    // 不是数组
    expect(sanitizeProfileSnapshot({ host: "h", proxyJump: "jump1" })).toEqual({ host: "h" });
    // 项不是字符串
    expect(sanitizeProfileSnapshot({ host: "h", proxyJump: ["jump1", 7] })).toEqual({ host: "h" });
    // 去空白后为空
    expect(sanitizeProfileSnapshot({ host: "h", proxyJump: ["  "] })).toEqual({ host: "h" });
    // 空数组 = 没有跳板链（绝不带空数组）
    expect(sanitizeProfileSnapshot({ host: "h", proxyJump: [] })).toEqual({ host: "h" });
  });

  it("proxyJump 每项去空白后存回（与存档层同一套规矩）", () => {
    expect(sanitizeProfileSnapshot({ proxyJump: [" jump1 ", "jump2"] })).toEqual({
      proxyJump: ["jump1", "jump2"],
    });
  });

  it("加了 proxyJump 也不放宽凭据：password / privateKey / passphrase 仍然一律丢弃", () => {
    const snapshot = sanitizeProfileSnapshot(profileWithSecrets);

    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty("password");
    expect(snapshot).not.toHaveProperty("privateKey");
    expect(snapshot).not.toHaveProperty("passphrase");
    // 嵌套的 auth 里也一样：只剩方式与路径
    expect(snapshot?.auth).toEqual({ kind: "key", identityPath: "C:/keys/id_ed25519" });
    expectNoCredentials(snapshot);
  });

  it("旧存档里没有 proxyJump 也能解析：缺字段就是没有，绝不报错", () => {
    const parsed = parseSessionTabMeta({ profile: { host: "10.0.0.9", port: 22 } });

    expect(parsed).toEqual({ host: "10.0.0.9", port: 22 });
    expect(parsed).not.toHaveProperty("proxyJump");
  });
});

describe("host tab services (M9-2)", () => {
  it("resolves openTab from the betterSidebar service", () => {
    const seeds: unknown[] = [];
    const ctx = { betterSidebar: { openTab: (seed: unknown) => void seeds.push(seed) } };
    const openTab = resolveOpenTab(ctx);
    expect(openTab).toBeDefined();
    openTab?.({ id: "uniterminal:s-1", type: "uniterminal" });
    expect(seeds).toEqual([{ id: "uniterminal:s-1", type: "uniterminal" }]);
  });

  it("returns undefined when the host exposes no openTab", () => {
    expect(resolveOpenTab(undefined)).toBeUndefined();
    expect(resolveOpenTab({})).toBeUndefined();
    expect(resolveOpenTab({ betterSidebar: {} })).toBeUndefined();
    expect(resolveOpenTab({ betterSidebar: { openTab: "nope" } })).toBeUndefined();
  });

  it("swallows host openTab failures instead of breaking the caller", () => {
    const openTab = resolveOpenTab({
      betterSidebar: {
        openTab() {
          throw new Error("tab type missing");
        },
      },
    });
    expect(() => openTab?.({ type: "uniterminal" })).not.toThrow();
  });

  it("resolves closeTab and swallows its failures too", () => {
    const closed: string[] = [];
    const closeTab = resolveCloseTab({ betterSidebar: { closeTab: (id: string) => void closed.push(id) } });
    closeTab?.("uniterminal:s-1");
    expect(closed).toEqual(["uniterminal:s-1"]);
    expect(resolveCloseTab({})).toBeUndefined();
    const throwing = resolveCloseTab({
      betterSidebar: {
        closeTab() {
          throw new Error("no such tab");
        },
      },
    });
    expect(() => throwing?.("uniterminal:s-1")).not.toThrow();
  });
});
