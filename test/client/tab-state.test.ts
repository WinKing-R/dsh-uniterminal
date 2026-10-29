import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTerminalTabState,
  readPersistedTerminalTabState,
  readTerminalTabState,
  setTabStateStorage,
  TERMINAL_TAB_STATE_KEY,
  writeTerminalTabState,
} from "../../src/client/tab-state.js";

// 存档是模块级单实例：不重置的话用例之间会互相看到对方的写入
beforeEach(() => {
  clearTerminalTabState();
});

describe("terminal tab state", () => {
  it("starts empty", () => {
    expect(readTerminalTabState()).toBeUndefined();
  });

  it("reads back exactly what was written", () => {
    writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
    expect(readTerminalTabState()).toEqual({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
  });

  it("returns to empty after clearing", () => {
    writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
    clearTerminalTabState();
    expect(readTerminalTabState()).toBeUndefined();
  });

  it("keeps only the newest write", () => {
    writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
    writeTerminalTabState({ sessionId: "s-2", wsUrl: "ws://127.0.0.1:7002/ws/s-2" });
    expect(readTerminalTabState()).toEqual({ sessionId: "s-2", wsUrl: "ws://127.0.0.1:7002/ws/s-2" });
  });

  it("does not leak later mutations of the written object", () => {
    const state = { sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" };
    writeTerminalTabState(state);
    state.sessionId = "mutated";
    expect(readTerminalTabState()).toEqual({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
  });
});

/**
 * 注入用的内存实现：本套用例绝不碰真实 storage（sessionStorage / localStorage），
 * 否则测试之间会互相污染，也无法断言「存储里到底是什么」。
 */
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

describe("persisted terminal tab state", () => {
  beforeEach(() => {
    // 每个用例都自带一份内存存储，绝不继承上一个用例（也不落到默认的 sessionStorage）
    setTabStateStorage(undefined);
    clearTerminalTabState();
  });

  it("writes a fixed key and reads the same state back", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);

    writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/api/uniterminal/ws/s-1" });

    expect(TERMINAL_TAB_STATE_KEY).toBe("uniterminal.terminal-tab-state");
    expect(memory.data.has(TERMINAL_TAB_STATE_KEY)).toBe(true);
    expect(readPersistedTerminalTabState()).toEqual({
      sessionId: "s-1",
      wsUrl: "ws://127.0.0.1:7001/api/uniterminal/ws/s-1",
    });
  });

  it("is unreadable after clearing", () => {
    const memory = memoryStorage();
    setTabStateStorage(memory.storage);
    writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/api/uniterminal/ws/s-1" });

    clearTerminalTabState();

    expect(readTerminalTabState()).toBeUndefined();
    expect(readPersistedTerminalTabState()).toBeUndefined();
    expect(memory.data.has(TERMINAL_TAB_STATE_KEY)).toBe(false);
  });

  it("treats unparsable JSON as no state and never throws", () => {
    const memory = memoryStorage({ [TERMINAL_TAB_STATE_KEY]: '{"sessionId":"s-1",' });
    setTabStateStorage(memory.storage);

    expect(() => readPersistedTerminalTabState()).not.toThrow();
    expect(readPersistedTerminalTabState()).toBeUndefined();
  });

  it("treats fields of the wrong type as no state", () => {
    const broken: string[] = [
      JSON.stringify({ sessionId: 42, wsUrl: "ws://127.0.0.1:7001/ws/s-1" }),
      JSON.stringify({ sessionId: "s-1", wsUrl: 7001 }),
      JSON.stringify({ sessionId: "s-1" }),
      JSON.stringify({ wsUrl: "ws://127.0.0.1:7001/ws/s-1" }),
      JSON.stringify(["s-1", "ws://127.0.0.1:7001/ws/s-1"]),
      JSON.stringify(null),
      JSON.stringify("s-1"),
    ];
    for (const raw of broken) {
      setTabStateStorage(memoryStorage({ [TERMINAL_TAB_STATE_KEY]: raw }).storage);
      expect(readPersistedTerminalTabState()).toBeUndefined();
    }
  });

  it("survives a storage that throws on every operation", () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error("storage denied");
      },
      setItem: (): void => {
        throw new Error("storage denied");
      },
      removeItem: (): void => {
        throw new Error("storage denied");
      },
    };
    setTabStateStorage(throwing);

    expect(() => readPersistedTerminalTabState()).not.toThrow();
    expect(readPersistedTerminalTabState()).toBeUndefined();

    // 模块存档仍然要写成功：持久化只是附加，绝不因为 storage 报错而丢掉当前会话
    expect(() =>
      writeTerminalTabState({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" }),
    ).not.toThrow();
    expect(readTerminalTabState()).toEqual({ sessionId: "s-1", wsUrl: "ws://127.0.0.1:7001/ws/s-1" });
    expect(() => clearTerminalTabState()).not.toThrow();
  });

  it("reads nothing when no storage is available at all", () => {
    setTabStateStorage(undefined);
    expect(readPersistedTerminalTabState()).toBeUndefined();
  });
});
