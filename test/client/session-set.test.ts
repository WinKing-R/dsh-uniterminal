import { beforeEach, describe, expect, it } from "vitest";
import {
  activateSession,
  addSession,
  adoptHostSessions,
  attachSessionUrl,
  clearPersistedSessionSet,
  markSessionEnded,
  parseSessionSet,
  readPersistedSessionSet,
  removeSession,
  SESSION_SET_KEY_PREFIX,
  serializeSessionSet,
  sessionSetStorageKey,
  setTabStateStorage,
  writePersistedSessionSet,
  type SessionEntry,
  type SessionSet,
} from "../../src/client/tab-state.js";

/**
 * 会话栏（M9-4）：本机原生右栏只给插件一个不透明标签（探针实测 id:"tab63"，path/meta 全丢），
 * 「一个会话一个标签」不可实现，于是把多会话收进本插件自己的标签里——
 * 会话集就是一个纯数据的 `{ entries, activeId }`，全部操作返回新对象，
 * 组件只负责把这份数据画成一条会话栏。这里锁的就是这份数据的语义。
 */

function entry(id: string, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { id, title: "host-" + id, ...extra };
}

/** 深冻结：任何原地改写都会在 ESM 严格模式下直接抛错。 */
function frozen(set: SessionSet): SessionSet {
  for (const item of set.entries) Object.freeze(item);
  Object.freeze(set.entries);
  return Object.freeze(set);
}

function three(): SessionSet {
  let set: SessionSet = { entries: [] };
  for (const id of ["a", "b", "c"]) set = addSession(set, entry(id));
  return frozen(set);
}

describe("addSession (M9-4)", () => {
  it("starts a session set from an empty one and activates the new session", () => {
    const set = addSession({ entries: [] }, entry("s-1"));
    expect(set).toEqual({ entries: [entry("s-1")], activeId: "s-1" });
  });

  it("appends in insertion order and activates the newest session", () => {
    let set: SessionSet = { entries: [] };
    set = addSession(set, entry("s-1"));
    set = addSession(set, entry("s-2"));
    expect(set.entries.map((item) => item.id)).toEqual(["s-1", "s-2"]);
    expect(set.activeId).toBe("s-2");
  });

  it("replaces a repeated id in place and activates it again", () => {
    const before = three();
    const after = addSession(before, entry("a", { title: "renamed", wsUrl: "ws://127.0.0.1:1/ws/a" }));

    expect(after.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(after.entries[0]).toEqual(entry("a", { title: "renamed", wsUrl: "ws://127.0.0.1:1/ws/a" }));
    expect(after.activeId).toBe("a");
    // 原集合不受影响
    expect(before.entries[0]).toEqual(entry("a"));
  });

  it("ignores an entry without an id instead of inventing one", () => {
    const before = three();
    expect(addSession(before, entry(""))).toBe(before);
  });

  it("never mutates the input set", () => {
    const before = three();
    expect(() => addSession(before, entry("d"))).not.toThrow();
    expect(before.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(before.activeId).toBe("c");
  });
});

describe("removeSession (M9-4)", () => {
  it("leaves the set untouched for an unknown id", () => {
    const before = three();
    expect(removeSession(before, "nope")).toBe(before);
  });

  it("keeps the active session when a different one is closed", () => {
    const after = removeSession(three(), "a");
    expect(after.entries.map((item) => item.id)).toEqual(["b", "c"]);
    expect(after.activeId).toBe("c");
  });

  it("drops the active session and falls back to the previous neighbour", () => {
    // three() 的 active 是最后一条（c），先切到中间那条再关它
    const after = removeSession(activateSession(three(), "b"), "b");
    expect(after.entries.map((item) => item.id)).toEqual(["a", "c"]);
    expect(after.activeId).toBe("a");
  });

  it("falls forward when the first session was the active one", () => {
    let set = addSession({ entries: [] }, entry("a"));
    set = activateSession(set, "a");
    set = addSession(set, entry("b"));
    set = activateSession(set, "a");
    const after = removeSession(set, "a");
    expect(after.entries.map((item) => item.id)).toEqual(["b"]);
    expect(after.activeId).toBe("b");
  });

  it("empties the active id when the last session closes", () => {
    const after = removeSession({ entries: [entry("solo")], activeId: "solo" }, "solo");
    expect(after.entries).toEqual([]);
    expect(after.activeId).toBeUndefined();
  });

  it("never mutates the input set", () => {
    const before = three();
    expect(() => removeSession(before, "b")).not.toThrow();
    expect(before.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(before.activeId).toBe("c");
  });
});

describe("activateSession (M9-4)", () => {
  it("switches the active session", () => {
    const after = activateSession(three(), "a");
    expect(after.activeId).toBe("a");
    expect(after.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("shares the entry array instead of copying it", () => {
    const before = three();
    expect(activateSession(before, "a").entries).toBe(before.entries);
  });

  it("ignores an unknown id", () => {
    const before = three();
    expect(activateSession(before, "nope")).toBe(before);
  });

  it("is a no-op for the session that is already active", () => {
    const before = three();
    expect(activateSession(before, "c")).toBe(before);
  });
});

describe("markSessionEnded (M9-4)", () => {
  it("keeps the entry but flags it as ended", () => {
    const after = markSessionEnded(three(), "b");
    expect(after.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(after.entries[1]).toEqual(entry("b", { ended: true }));
    // 已结束的那条仍在会话栏上：用户要能看见它并手动关掉
    expect(after.activeId).toBe("c");
  });

  it("keeps an ended session active so its placeholder is on screen", () => {
    const after = markSessionEnded(three(), "c");
    expect(after.activeId).toBe("c");
    expect(after.entries[2]?.ended).toBe(true);
  });

  it("leaves the other entries by identity", () => {
    const before = three();
    const after = markSessionEnded(before, "b");
    expect(after.entries[0]).toBe(before.entries[0]);
    expect(after.entries[2]).toBe(before.entries[2]);
  });

  it("ignores an unknown id and an already ended entry", () => {
    const before = three();
    expect(markSessionEnded(before, "nope")).toBe(before);
    const once = markSessionEnded(before, "b");
    expect(markSessionEnded(once, "b")).toBe(once);
  });
});

describe("attachSessionUrl (M9-4)", () => {
  it("fills in the loopback address of one session", () => {
    const after = attachSessionUrl(three(), "b", "ws://127.0.0.1:7/ws/b");
    expect(after.entries[1]).toEqual(entry("b", { wsUrl: "ws://127.0.0.1:7/ws/b" }));
    expect(after.activeId).toBe("c");
  });

  it("clears the ended flag when the address really arrives", () => {
    const ended = markSessionEnded(three(), "b");
    const after = attachSessionUrl(ended, "b", "ws://127.0.0.1:7/ws/b");
    expect(after.entries[1]).toEqual(entry("b", { wsUrl: "ws://127.0.0.1:7/ws/b" }));
    expect(after.entries[1]?.ended).toBeUndefined();
  });

  it("ignores an unknown id and an entry that already carries the same address", () => {
    const before = three();
    expect(attachSessionUrl(before, "nope", "ws://127.0.0.1:7/ws/x")).toBe(before);
    const attached = attachSessionUrl(before, "b", "ws://127.0.0.1:7/ws/b");
    expect(attachSessionUrl(attached, "b", "ws://127.0.0.1:7/ws/b")).toBe(attached);
  });
});

describe("adoptHostSessions (M9-4)", () => {
  it("reattaches the loopback address the host reports", () => {
    const set: SessionSet = { entries: [entry("a"), entry("b", { wsUrl: "ws://keep/ws/b" })], activeId: "a" };
    const after = adoptHostSessions(set, new Map([["a", "ws://127.0.0.1:7/ws/a"], ["b", "ws://other/ws/b"]]));

    expect(after.entries[0]).toEqual(entry("a", { wsUrl: "ws://127.0.0.1:7/ws/a" }));
    // 已经连上的条目一个字节都不改
    expect(after.entries[1]).toBe(set.entries[1]);
    expect(after.activeId).toBe("a");
  });

  it("marks a session the host no longer lists as ended", () => {
    const set: SessionSet = { entries: [entry("a"), entry("gone")], activeId: "gone" };
    const after = adoptHostSessions(set, new Map([["a", "ws://127.0.0.1:7/ws/a"]]));

    expect(after.entries[1]).toEqual(entry("gone", { ended: true }));
    expect(after.activeId).toBe("gone");
  });

  it("never resurrects an ended entry", () => {
    const set: SessionSet = { entries: [entry("a", { ended: true })], activeId: "a" };
    expect(adoptHostSessions(set, new Map([["a", "ws://127.0.0.1:7/ws/a"]]))).toBe(set);
  });

  it("returns the very same set when the host changes nothing", () => {
    const set: SessionSet = { entries: [entry("a", { wsUrl: "ws://keep/ws/a" })], activeId: "a" };
    expect(adoptHostSessions(set, new Map())).toBe(set);
  });
});

/** 带凭据的会话条目：存档与载荷都不许带着它们走。 */
const SECRETS = ["hunter2", "BEGIN KEY", "phrase"];
const poisonedEntry: SessionEntry = entry("s-1", {
  wsUrl: "ws://127.0.0.1:7/ws/s-1",
  profile: {
    id: "s-1",
    host: "10.0.0.9",
    port: 22,
    user: "root",
    auth: { kind: "key", identityPath: "C:/keys/id_ed25519" },
    password: "hunter2",
    privateKey: "-----BEGIN KEY-----",
    passphrase: "phrase",
  } as SessionEntry["profile"],
});

function expectNoCredentials(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("session set persistence (M9-4)", () => {
  it("serializes the fields the session bar needs", () => {
    const raw = serializeSessionSet({ entries: [entry("a", { wsUrl: "ws://127.0.0.1:7/ws/a" }), entry("b", { ended: true })], activeId: "b" });
    expect(JSON.parse(raw)).toEqual({
      entries: [
        { id: "a", title: "host-a", wsUrl: "ws://127.0.0.1:7/ws/a" },
        { id: "b", title: "host-b", ended: true },
      ],
      activeId: "b",
    });
  });

  it("drops credentials from the archived profile", () => {
    const raw = serializeSessionSet({ entries: [poisonedEntry], activeId: "s-1" });
    expectNoCredentials(raw);
    const parsed = JSON.parse(raw) as { entries: { profile?: Record<string, unknown> }[] };
    expect(parsed.entries[0]?.profile).toEqual({
      id: "s-1",
      host: "10.0.0.9",
      port: 22,
      user: "root",
      auth: { kind: "key", identityPath: "C:/keys/id_ed25519" },
    });
  });

  it("drops entries without an id and an active id that points at nothing", () => {
    const raw = serializeSessionSet({ entries: [entry(""), entry("a")], activeId: "" });
    expect(JSON.parse(raw)).toEqual({ entries: [{ id: "a", title: "host-a" }] });
  });

  it("round-trips through parse", () => {
    const set: SessionSet = { entries: [entry("a", { wsUrl: "ws://127.0.0.1:7/ws/a", ended: true })], activeId: "a" };
    expect(parseSessionSet(serializeSessionSet(set))).toEqual(set);
  });

  it("parses an empty archive into an empty set", () => {
    expect(parseSessionSet('{"entries":[]}')).toEqual({ entries: [] });
  });

  it("rejects garbage instead of throwing", () => {
    const garbage: unknown[] = [undefined, null, "", "not json", "[]", '"s-1"', "42", '{"entries":"no"}', '{"entries":null}', "{}"];
    for (const raw of garbage) {
      expect(() => parseSessionSet(raw as string | null | undefined)).not.toThrow();
      expect(parseSessionSet(raw as string | null | undefined)).toBeUndefined();
    }
  });

  it("strips credentials a hostile archive carries", () => {
    const archive = JSON.stringify({
      entries: [{ id: "s-1", title: "box", profile: poisonedEntry.profile }],
      activeId: "s-1",
    });
    const parsed = parseSessionSet(archive);
    expectNoCredentials(parsed);
    expect(parsed?.entries[0]?.profile?.auth).toEqual({ kind: "key", identityPath: "C:/keys/id_ed25519" });
    const profile = parsed?.entries[0]?.profile as Record<string, unknown> | undefined;
    expect(profile?.["password"]).toBeUndefined();
  });

  it("skips duplicate and empty ids and falls back to the id as title", () => {
    const parsed = parseSessionSet(
      JSON.stringify({
        entries: [
          { id: "a" },
          { id: "a", title: "duplicate" },
          { id: "" },
          { title: "no id" },
          { id: "b", title: "box", wsUrl: "", ended: "yes" },
        ],
        activeId: "a",
      }),
    );

    expect(parsed?.entries).toEqual([{ id: "a", title: "a" }, { id: "b", title: "box" }]);
    expect(parsed?.activeId).toBe("a");
  });

  it("activates the first entry when the archived active id is unknown", () => {
    const parsed = parseSessionSet(JSON.stringify({ entries: [{ id: "a" }, { id: "b" }], activeId: "gone" }));
    expect(parsed?.activeId).toBe("a");
    const missing = parseSessionSet(JSON.stringify({ entries: [{ id: "a" }, { id: "b" }] }));
    expect(missing?.activeId).toBe("a");
  });
});

/** 注入用的内存实现：本套用例绝不碰真实 storage。 */
function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    storage: {
      getItem: (key: string): string | null => data.get(key) ?? null,
      setItem: (key: string, value: string): void => void data.set(key, value),
      removeItem: (key: string): void => void data.delete(key),
    },
  };
}

describe("session set archive per tab (M9-4)", () => {
  beforeEach(() => {
    setTabStateStorage(undefined);
  });

  it("keys the archive by tab id, and has one bucket for an unscoped pane", () => {
    expect(SESSION_SET_KEY_PREFIX).toBe("uniterminal.session-set");
    expect(sessionSetStorageKey("tab63")).toBe(SESSION_SET_KEY_PREFIX + ":tab63");
    expect(sessionSetStorageKey("tab63")).not.toBe(sessionSetStorageKey("tab64"));
    expect(sessionSetStorageKey("")).toBe(SESSION_SET_KEY_PREFIX + ":unscoped");
  });

  it("writes and reads back through the injected storage", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);
    const set: SessionSet = { entries: [entry("a", { wsUrl: "ws://127.0.0.1:7/ws/a" }), entry("b")], activeId: "b" };

    writePersistedSessionSet("tab63", set);

    expect(memory.data.has(sessionSetStorageKey("tab63"))).toBe(true);
    expect(readPersistedSessionSet("tab63")).toEqual(set);
    // M9-5：宿主给的 tab.id 不透明且可能在刷新后重生成（实测 tab63），
    // 因此按 tabId 读不到时**回退到最后一次存档**——宁可多接回，也不要刷新后全丢。
    expect(readPersistedSessionSet("tab64")).toEqual(set);
  });

  it("keeps the archive free of credentials and of secrets in the key", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);
    writePersistedSessionSet("tab63", { entries: [poisonedEntry], activeId: "s-1" });

    const stored = memory.data.get(sessionSetStorageKey("tab63")) ?? "";
    expect(stored).not.toBe("");
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
  });

  it("removes the key when the last session closes", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);
    writePersistedSessionSet("tab63", { entries: [entry("a")], activeId: "a" });
    writePersistedSessionSet("tab63", { entries: [] });

    expect(memory.data.has(sessionSetStorageKey("tab63"))).toBe(false);
  });

  it("clears the archive on demand", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);
    writePersistedSessionSet("tab63", { entries: [entry("a")], activeId: "a" });
    clearPersistedSessionSet("tab63");
    expect(readPersistedSessionSet("tab63")).toBeUndefined();
  });

  it("reads nothing when no storage is wired in or the archive is garbage", () => {
    setTabStateStorage(undefined);
    expect(readPersistedSessionSet("tab63")).toBeUndefined();

    const memory = memoryStorage({ [sessionSetStorageKey("tab63")]: "not json" });
    setTabStateStorage(memory.storage);
    expect(readPersistedSessionSet("tab63")).toBeUndefined();
  });
});
