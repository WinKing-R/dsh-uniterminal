import { beforeEach, describe, expect, it } from "vitest";
import {
  claimSessionTab,
  forgetSessionTab,
  openClaimedSessionTab,
  ownedSessionIds,
  readProfileSnapshot,
  rememberProfileSnapshot,
  resetSessionTabs,
  SESSION_CLAIM_GRACE_MS,
  type ClaimGuardDeps,
} from "../../src/client/tab-state.js";
import type { OpenTabSeed } from "../../src/client/right-pane.js";

/**
 * 泄漏保险（M9-2）：连接成功 → 开标签 → 新标签必须认领。
 * 5 秒内没人认领说明新标签根本没打开（宿主没渲染 / id 没往返），
 * 这条连接就成了没人能看见、也没人能关的残留——必须由启动器主动关掉。
 * 定时器、openTab、close 全部注入：这套用例一秒都不真等。
 */

interface Clock {
  tasks: { run: () => void; ms: number; cancelled: boolean }[];
  schedule: (run: () => void, ms: number) => () => void;
  fire: () => void;
}

function fakeClock(): Clock {
  const tasks: Clock["tasks"] = [];
  return {
    tasks,
    schedule: (run, ms) => {
      const task = { run, ms, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    fire: () => {
      for (const task of tasks) if (!task.cancelled) task.run();
    },
  };
}

interface Harness {
  clock: Clock;
  opened: OpenTabSeed[];
  closed: string[];
  leaked: string[];
  deps: ClaimGuardDeps;
}

function harness(overrides: Partial<ClaimGuardDeps> = {}): Harness {
  const clock = fakeClock();
  const opened: OpenTabSeed[] = [];
  const closed: string[] = [];
  const leaked: string[] = [];
  const deps: ClaimGuardDeps = {
    openTab: (seed) => void opened.push(seed),
    closeSession: (id) => void closed.push(id),
    onLeak: (id) => void leaked.push(id),
    schedule: clock.schedule,
    ...overrides,
  };
  return { clock, opened, closed, leaked, deps };
}

const request = { sessionId: "s-1", title: "root@10.0.0.9:22", profile: { host: "10.0.0.9", port: 22, user: "root" } };

beforeEach(() => {
  resetSessionTabs();
});

describe("session tab leak guard (M9-2)", () => {
  it("opens the tab with an explicit id built from the session id", () => {
    const h = harness();
    expect(openClaimedSessionTab(request, h.deps)).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.id).toBe("uniterminal:s-1");
    expect(h.opened[0]?.type).toBe("uniterminal");
    expect(h.opened[0]?.title).toBe("root@10.0.0.9:22");
    expect(h.opened[0]?.meta).toEqual({ profile: { host: "10.0.0.9", port: 22, user: "root" } });
  });

  it("arms a 5 second claim timer", () => {
    const h = harness();
    openClaimedSessionTab(request, h.deps);
    expect(h.clock.tasks).toHaveLength(1);
    expect(h.clock.tasks[0]?.ms).toBe(SESSION_CLAIM_GRACE_MS);
    expect(SESSION_CLAIM_GRACE_MS).toBe(5000);
  });

  it("closes the session when nobody claims it within the grace period", () => {
    const h = harness();
    openClaimedSessionTab(request, h.deps);
    expect(h.closed).toEqual([]);
    h.clock.fire();
    expect(h.closed).toEqual(["s-1"]);
    expect(h.leaked).toEqual(["s-1"]);
  });

  it("keeps the session when the new tab claims it", () => {
    const h = harness();
    openClaimedSessionTab(request, h.deps);
    expect(claimSessionTab("s-1")).toBe(true);
    h.clock.fire();
    expect(h.closed).toEqual([]);
    expect(h.leaked).toEqual([]);
  });

  it("needs no timer at all when the tab claims synchronously", () => {
    const h = harness({
      openTab: () => {
        expect(claimSessionTab("s-2")).toBe(true);
      },
    });
    expect(openClaimedSessionTab({ ...request, sessionId: "s-2" }, h.deps)).toBe(true);
    expect(h.clock.tasks).toHaveLength(0);
    h.clock.fire();
    expect(h.closed).toEqual([]);
  });

  it("does not leave a dangling claim when openTab throws", () => {
    const h = harness({
      openTab: () => {
        throw new Error("no such tab type");
      },
    });
    expect(openClaimedSessionTab(request, h.deps)).toBe(false);
    expect(h.clock.tasks).toHaveLength(0);
    expect(h.closed).toEqual([]);
    // 没有待认领记录 → 认领返回 false，不会误吞一条不存在的会话
    expect(claimSessionTab("s-1")).toBe(false);
    expect(h.clock.tasks).toHaveLength(0);
  });

  it("refuses to open a tab without a session id", () => {
    const h = harness();
    expect(openClaimedSessionTab({ ...request, sessionId: "" }, h.deps)).toBe(false);
    expect(h.opened).toHaveLength(0);
    expect(h.clock.tasks).toHaveLength(0);
  });

  it("claims nothing when there was no pending session", () => {
    const h = harness();
    expect(claimSessionTab("never-opened")).toBe(false);
    expect(h.closed).toEqual([]);
  });

  it("replaces a stale claim for the same session instead of arming two timers", () => {
    const h = harness();
    openClaimedSessionTab(request, h.deps);
    openClaimedSessionTab(request, h.deps);
    h.clock.fire();
    expect(h.closed).toEqual(["s-1"]);
  });

  it("counts the pending window as owned so the launcher cannot list it as an orphan", () => {
    const h = harness();
    expect(ownedSessionIds().has("s-1")).toBe(false);
    openClaimedSessionTab(request, h.deps);
    expect(ownedSessionIds().has("s-1")).toBe(true);
    claimSessionTab("s-1");
    expect(ownedSessionIds().has("s-1")).toBe(true);
    forgetSessionTab("s-1");
    expect(ownedSessionIds().has("s-1")).toBe(false);
  });

  it("does not let a fired timer close a session that was reborn under the same id", () => {
    const h = harness();
    openClaimedSessionTab(request, h.deps);
    const stale = h.clock.tasks[0];
    // 旧记录被撤掉、同一条会话重新开了一条标签并且已经认领
    resetSessionTabs();
    openClaimedSessionTab(request, h.deps);
    claimSessionTab("s-1");
    stale?.run();
    expect(h.closed).toEqual([]);
  });
});

describe("profile snapshot memory (M9-2)", () => {
  it("keeps a sanitized snapshot per session", () => {
    rememberProfileSnapshot("s-1", {
      host: "10.0.0.9",
      port: 22,
      user: "root",
      password: "hunter2",
      privateKey: "-----BEGIN KEY-----",
      passphrase: "phrase",
    });
    const stored = readProfileSnapshot("s-1");
    expect(stored).toEqual({ host: "10.0.0.9", port: 22, user: "root" });
    expect(JSON.stringify(stored)).not.toContain("hunter2");
  });

  it("ignores an unusable snapshot and an empty session id", () => {
    rememberProfileSnapshot("s-2", "not an object");
    expect(readProfileSnapshot("s-2")).toBeUndefined();
    rememberProfileSnapshot("", { host: "h" });
    expect(readProfileSnapshot("")).toBeUndefined();
  });

  it("forgets the snapshot when the session tab is done with it", () => {
    rememberProfileSnapshot("s-3", { host: "h" });
    forgetSessionTab("s-3");
    expect(readProfileSnapshot("s-3")).toBeUndefined();
  });
});

/**
 * M9-3：宿主不支持独立标签时，调用方把会话"接回本标签"（onLeak 返回 true），
 * 此时**绝不能**再关掉这条连接——用户正要用它。
 * 实测依据：本机原生右栏忽略 seed.id，只给 tabNN，且 path/meta 全丢。
 */
describe("leak guard with adoption (M9-3)", () => {
  it("does not close the session when the caller adopts it", () => {
    const closed: string[] = [];
    let scheduled: (() => void) | undefined;
    const opened: unknown[] = [];

    const ok = openClaimedSessionTab(
      { sessionId: "s-adopt", title: "t", profile: { host: "h" } },
      {
        openTab: (seed) => {
          opened.push(seed);
        },
        closeSession: (id) => {
          closed.push(id);
        },
        schedule: (fn) => {
          scheduled = fn;
          return () => undefined;
        },
        onLeak: () => true,
      },
    );

    expect(ok).toBe(true);
    expect(opened).toHaveLength(1);
    scheduled?.();
    // 已被接回：不许关闭
    expect(closed).toEqual([]);
  });

  it("still closes when nobody adopts", () => {
    const closed: string[] = [];
    let scheduled: (() => void) | undefined;

    openClaimedSessionTab(
      { sessionId: "s-leak", title: "t", profile: { host: "h" } },
      {
        openTab: () => undefined,
        closeSession: (id) => {
          closed.push(id);
        },
        schedule: (fn) => {
          scheduled = fn;
          return () => undefined;
        },
        onLeak: () => undefined,
      },
    );

    scheduled?.();
    expect(closed).toEqual(["s-leak"]);
  });
});
