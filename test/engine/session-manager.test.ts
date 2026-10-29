import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../../src/engine/registry.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import type { TcpipEvent } from "../../src/engine/tunnel.js";
import type { ResolvedProfile, SessionHandle, TransportAdapter } from "../../src/engine/types.js";

function stubAdapter() {
  const dataCallbacks = new Set<(chunk: Uint8Array) => void>();
  const writes: Uint8Array[] = [];
  const handle: SessionHandle = {
    id: "handle",
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    write: (chunk) => void writes.push(chunk),
    resize: () => {},
    onData: (cb) => {
      dataCallbacks.add(cb);
      return () => void dataCallbacks.delete(cb);
    },
    onClose: () => () => {},
    close: async () => {},
  };
  const adapter: TransportAdapter = {
    kind: "ssh",
    capabilities: handle.capabilities,
    open: async () => handle,
  };
  return {
    adapter,
    writes,
    push: (chunk: Uint8Array) => {
      for (const cb of dataCallbacks) cb(chunk);
    },
  };
}

interface ControllableHandle extends SessionHandle {
  readonly written: Uint8Array[];
  emit: (chunk: Uint8Array) => void;
  drop: (reason: string) => void;
}

/** 可主动掉线、可让后续 open 失败的适配器：用于退避重连。 */
function controllableAdapter() {
  const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
  const opens: ResolvedProfile[] = [];
  const handles: ControllableHandle[] = [];
  let failingOpens = 0;

  const adapter: TransportAdapter = {
    kind: "ssh",
    capabilities,
    open: async (profile) => {
      opens.push(profile);
      if (failingOpens > 0) {
        failingOpens -= 1;
        throw new Error("uniterminal: connect refused");
      }
      const dataListeners = new Set<(chunk: Uint8Array) => void>();
      const closeListeners = new Set<(reason: string) => void>();
      const handle: ControllableHandle = {
        id: "handle-" + String(handles.length),
        kind: "ssh",
        capabilities,
        written: [],
        write: (chunk) => void handle.written.push(chunk),
        resize: () => {},
        onData: (cb) => {
          dataListeners.add(cb);
          return () => void dataListeners.delete(cb);
        },
        onClose: (cb) => {
          closeListeners.add(cb);
          return () => void closeListeners.delete(cb);
        },
        close: async () => {
          for (const cb of [...closeListeners]) cb("closed");
        },
        emit: (chunk) => {
          for (const cb of [...dataListeners]) cb(chunk);
        },
        drop: (reason) => {
          for (const cb of [...closeListeners]) cb(reason);
        },
      };
      handles.push(handle);
      return handle;
    },
  };

  return {
    adapter,
    opens,
    handles,
    failOpens: (count: number) => {
      failingOpens = count;
    },
  };
}

describe("SessionManager", () => {
  it("buffers output and replays it from a cursor", async () => {
    const registry = new TransportRegistry();
    const fake = stubAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry, { bufferBytes: 64 });

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    fake.push(new Uint8Array([1, 2, 3]));

    expect([...manager.read(info.id, 0).data]).toEqual([1, 2, 3]);
    expect([...manager.read(info.id, 2).data]).toEqual([3]);
    expect(manager.read(info.id, 0).cursor).toBe(3);
  });

  it("routes writes to the underlying handle", async () => {
    const registry = new TransportRegistry();
    const fake = stubAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    manager.write(info.id, new Uint8Array([9]));
    expect(fake.writes).toEqual([new Uint8Array([9])]);
  });

  it("throws on an unknown session id", () => {
    const manager = new SessionManager(new TransportRegistry());
    expect(() => manager.read("nope", 0)).toThrow(/unknown session/);
  });

  it("runs a command on the session handle and returns its result", async () => {
    const calls: { command: string; timeoutMs: number | undefined }[] = [];
    const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
    const handle: SessionHandle = {
      id: "handle",
      kind: "ssh",
      capabilities,
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      exec: async (command, options) => {
        calls.push({ command, timeoutMs: options?.timeoutMs });
        return { stdout: "ok:" + command, stderr: "", code: 0, truncated: false, timedOut: false };
      },
    };
    const registry = new TransportRegistry();
    registry.register({ kind: "ssh", capabilities, open: async () => handle });
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    const result = await manager.exec(info.id, "uname -a", { timeoutMs: 250 });

    expect(calls).toEqual([{ command: "uname -a", timeoutMs: 250 }]);
    expect(result).toMatchObject({ stdout: "ok:uname -a", code: 0 });
  });

  it("refuses unknown sessions and handles without exec with typed reasons", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    await expect(manager.exec("nope", "id")).rejects.toMatchObject({ reason: "unknown-session" });
    // 非 SSH 适配器没有 exec：能力缺失要说清楚，绝不假装命令执行过
    await expect(manager.exec(info.id, "id")).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("closes and drops the session", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });

    await manager.close(info.id);
    expect(manager.list()).toEqual([]);
  });
});

describe("SessionManager hooks and reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies opened subscribers with the session info", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);
    const opened: string[] = [];
    const unsubscribe = manager.onOpened((info) => void opened.push(info.id));

    const first = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    const second = await manager.open({ id: "p2", kind: "ssh", host: "h" });
    expect(opened).toEqual([first.id, second.id]);
    expect(opened[0]).toBe("s1");

    unsubscribe();
    await manager.open({ id: "p3", kind: "ssh", host: "h" });
    expect(opened).toEqual([first.id, second.id]);
  });

  it("notifies closed subscribers with the session id after close()", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);
    const closed: string[] = [];
    const unsubscribe = manager.onClosed((id) => void closed.push(id));

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    expect(closed).toEqual([]);

    await manager.close(info.id);
    expect(closed).toEqual([info.id]);
    expect(info.status).toBe("closed");

    unsubscribe();
    const survivor = await manager.open({ id: "p2", kind: "ssh", host: "h" });
    await manager.close(survivor.id);
    expect(closed).toEqual([info.id]);
  });

  it("retries a dropped session along the configured delays, then gives up", async () => {
    vi.useFakeTimers();
    const registry = new TransportRegistry();
    const fake = controllableAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry, { autoReconnect: { delaysMs: [5, 10] } });
    const closed: string[] = [];
    manager.onClosed((id) => void closed.push(id));

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    fake.failOpens(2);
    fake.handles[0]!.drop("connection reset");

    await vi.advanceTimersByTimeAsync(4);
    expect(fake.opens).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.opens).toHaveLength(2);
    expect(closed).toEqual([]);

    await vi.advanceTimersByTimeAsync(9);
    expect(fake.opens).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.opens).toHaveLength(3);
    expect(closed).toEqual([info.id]);
    expect(info.status).toBe("closed");
    expect(manager.list()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.opens).toHaveLength(3);
  });

  it("does not reconnect after an explicit close()", async () => {
    vi.useFakeTimers();
    const registry = new TransportRegistry();
    const fake = controllableAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry, { autoReconnect: { delaysMs: [5, 10] } });
    const closed: string[] = [];
    manager.onClosed((id) => void closed.push(id));

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    await manager.close(info.id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.opens).toHaveLength(1);
    expect(closed).toEqual([info.id]);
    expect(manager.list()).toEqual([]);
  });

  it("keeps the session id and announces a successful reconnect", async () => {
    vi.useFakeTimers();
    const registry = new TransportRegistry();
    const fake = controllableAdapter();
    registry.register(fake.adapter);
    const manager = new SessionManager(registry, { autoReconnect: { delaysMs: [5] } });
    const opened: string[] = [];
    manager.onOpened((info) => void opened.push(info.id));

    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    const chunks: string[] = [];
    manager.subscribe(info.id, (chunk) => void chunks.push(new TextDecoder().decode(chunk)));

    fake.handles[0]!.drop("connection reset");
    await vi.advanceTimersByTimeAsync(5);

    expect(fake.opens).toHaveLength(2);
    expect(fake.opens[1]).toEqual(fake.opens[0]);
    expect(manager.list().map((entry) => entry.id)).toEqual([info.id]);
    expect(opened).toEqual([info.id]);
    expect(info.status).toBe("open");
    expect(chunks).toEqual(["\n[uniterminal] reconnected\n"]);

    fake.handles[1]!.emit(new Uint8Array([104, 105]));
    expect(chunks).toEqual(["\n[uniterminal] reconnected\n", "hi"]);
  });
});

describe("SessionManager tunnel capability (M3-2)", () => {
  /** 会话层只关心「调用有没有转给 handle」，通道里的字节由 tunnel.test.ts 管。 */
  const fakeChannel = (): Duplex => new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });

  function forwardingAdapter() {
    const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
    const channel = fakeChannel();
    const calls: string[] = [];
    const listeners: ((event: TcpipEvent) => void)[] = [];
    let revokes = 0;
    const adapter: TransportAdapter = {
      kind: "ssh",
      capabilities,
      open: async (profile) => ({
        id: profile.id,
        kind: "ssh",
        capabilities,
        write: () => {},
        resize: () => {},
        onData: () => () => {},
        onClose: () => () => {},
        close: async () => {},
        forwardOut: async (srcHost, srcPort, dstHost, dstPort) => {
          calls.push("forwardOut:" + [srcHost, srcPort, dstHost, dstPort].join(","));
          return channel;
        },
        forwardIn: async (host, port) => {
          calls.push("forwardIn:" + host + ":" + String(port));
          return 22022;
        },
        onTcpipEvent: (listener) => {
          listeners.push(listener);
          return () => {
            revokes += 1;
          };
        },
      }),
    };
    return {
      adapter,
      calls,
      channel,
      listeners,
      get revokes() {
        return revokes;
      },
    };
  }

  const openWith = async (adapter: TransportAdapter) => {
    const registry = new TransportRegistry();
    registry.register(adapter);
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const info = await manager.open({ id: "p1", kind: "ssh", host: "h" });
    return { manager, info };
  };

  it("hands out a capability that delegates to the session handle", async () => {
    const fake = forwardingAdapter();
    const { manager, info } = await openWith(fake.adapter);

    const tunnel = await manager.openTunnels(info.id);

    await expect(tunnel.forwardOut("127.0.0.1", 18080, "127.0.0.1", 5432)).resolves.toBe(fake.channel);
    await expect(tunnel.forwardIn("127.0.0.1", 0)).resolves.toBe(22022);
    expect(fake.calls).toEqual(["forwardOut:127.0.0.1,18080,127.0.0.1,5432", "forwardIn:127.0.0.1:0"]);

    const seen: string[] = [];
    tunnel.onTcpipEvent((event) => void seen.push(event.srcIP + "->" + event.destIP + ":" + String(event.destPort)));
    expect(fake.listeners).toHaveLength(1);
    fake.listeners[0]!({ destIP: "127.0.0.1", destPort: 22022, srcIP: "10.0.0.9", srcPort: 51000, accept: async () => fake.channel, reject: () => {} });
    expect(seen).toEqual(["10.0.0.9->127.0.0.1:22022"]);
  });

  it("keeps one capability object per session and passes its unsubscribe through", async () => {
    const fake = forwardingAdapter();
    const { manager, info } = await openWith(fake.adapter);

    const first = await manager.openTunnels(info.id);
    // 会话级路由按对象身份认连接：每次 start 都换新对象会让 tcpip 监听随启动次数累积
    expect(await manager.openTunnels(info.id)).toBe(first);

    const cancel = first.onTcpipEvent(() => {});
    expect(typeof cancel).toBe("function");
    if (typeof cancel !== "function") return;
    cancel();

    expect(fake.revokes).toBe(1);
  });

  it("reports an unknown session as its own failure reason", async () => {
    const fake = forwardingAdapter();
    const { manager } = await openWith(fake.adapter);

    await expect(manager.openTunnels("nope")).rejects.toMatchObject({ reason: "unknown-session" });
  });

  it("reports a session without forwarding methods as unsupported", async () => {
    const stub = stubAdapter();
    const { manager, info } = await openWith(stub.adapter);

    await expect(manager.openTunnels(info.id)).rejects.toMatchObject({ reason: "unsupported" });
  });
});

const LIST_PASSWORD = "list-session-pw-6614";
const LIST_PASSPHRASE = "list-session-pp-2287";
const LIST_KEY_MARKER = "LIST-SESSION-KEY-MATERIAL-M41";
const LIST_KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + LIST_KEY_MARKER + "\n-----END OPENSSH PRIVATE KEY-----";

describe("SessionManager session metadata (M4-1)", () => {
  it("lists host, user and port from the opened profile", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);

    const info = await manager.open({ id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]).toMatchObject({
      id: info.id,
      kind: "ssh",
      host: "192.0.2.10",
      port: 2222,
      user: "deploy",
      status: "open",
    });
    expect(manager.list()[0]?.createdAt).toBe(info.createdAt);
  });

  it("keeps credentials out of the listed metadata", async () => {
    const registry = new TransportRegistry();
    registry.register(stubAdapter().adapter);
    const manager = new SessionManager(registry);

    await manager.open({
      id: "p1",
      kind: "ssh",
      host: "192.0.2.10",
      port: 2222,
      user: "deploy",
      password: LIST_PASSWORD,
      privateKey: LIST_KEY_TEXT,
      passphrase: LIST_PASSPHRASE,
    });

    // 序列化后的列表里一个字节的凭据都不能有
    const text = JSON.stringify(manager.list());
    expect(text).not.toContain(LIST_PASSWORD);
    expect(text).not.toContain(LIST_KEY_MARKER);
    expect(text).not.toContain(LIST_PASSPHRASE);
    const keys = Object.keys(manager.list()[0] ?? {});
    expect(keys).not.toContain("password");
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("passphrase");
  });
});
