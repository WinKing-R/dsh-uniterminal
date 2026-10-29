import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../../src/engine/registry.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import { normalizeTunnelSpec, TunnelError, TunnelManager } from "../../src/engine/tunnel.js";
import type {
  TcpipEvent,
  TunnelCapability,
  TunnelListener,
  TunnelNet,
  TunnelSpec,
} from "../../src/engine/tunnel.js";
import type { TransportAdapter } from "../../src/engine/types.js";

/**
 * 全程不绑真端口：net 由注入的假工厂顶替，SSH 通道由内存 Duplex 顶替。
 * 这样本地监听、双向 pipe、SOCKS 握手都能在进程内确定性地验证。
 */

/** 内存双向流：写进来的字节收在 written 里，读走的数据用 push() 灌进去。 */
class FakeStream extends Duplex {
  readonly written: Buffer[] = [];

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.written).toString("utf8");
  }
}

class FakeListener implements TunnelListener {
  readonly listens: { port: number; host: string }[] = [];
  readonly errors: ((error: Error) => void)[] = [];
  readonly onConnection: (socket: Duplex) => void;
  closed = false;

  #bindError: Error | undefined;

  constructor(onConnection: (socket: Duplex) => void, bindError?: Error) {
    this.onConnection = onConnection;
    this.#bindError = bindError;
  }

  listen(port: number, host: string, callback: () => void): void {
    this.listens.push({ port, host });
    if (this.#bindError !== undefined) {
      // 真实 net 的 EADDRINUSE 也是异步报的：这里同步发给已注册的处理器即可
      for (const handler of this.errors) handler(this.#bindError);
      return;
    }
    callback();
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  on(_event: "error", callback: (error: Error) => void): void {
    this.errors.push(callback);
  }
}

interface FakeNet extends TunnelNet {
  readonly listeners: FakeListener[];
  readonly dialed: { port: number; host: string }[];
  readonly sockets: FakeStream[];
}

function fakeNet(options: { bindError?: Error } = {}): FakeNet {
  const listeners: FakeListener[] = [];
  const dialed: { port: number; host: string }[] = [];
  const sockets: FakeStream[] = [];
  return {
    listeners,
    dialed,
    sockets,
    createListener: (onConnection) => {
      const listener = new FakeListener(onConnection, options.bindError);
      listeners.push(listener);
      return listener;
    },
    connect: (port, host) => {
      dialed.push({ port, host });
      const socket = new FakeStream();
      sockets.push(socket);
      return socket;
    },
  };
}

/** 一次派发的结果：谁认领了这条连接、谁把它拒了（真 ssh2 里同一事件只有一对 accept/reject，用计数暴露「谁插了嘴」）。 */
interface FireResult {
  accepted: number;
  rejected: number;
  channel: FakeStream;
}

interface FakeCapability {
  capability: TunnelCapability;
  forwardOuts: [string, number, string, number][];
  forwardIns: [string, number][];
  channels: FakeStream[];
  tcpip: ((event: TcpipEvent) => void)[];
  /** capability.onTcpipEvent 返回的取消函数被调用了几次（M3-11 要求可撤销）。 */
  revokes: number;
  /** 派发一条 tcpip 事件给所有仍注册着的监听器：等价于 ssh2 的 'tcp connection'。 */
  emit(data: { destIP: string; destPort: number; srcIP: string; srcPort: number }): FireResult;
  refuseRemote(error: Error | undefined): void;
}

function fakeCapability(options: { boundPort?: number } = {}): FakeCapability {
  const forwardOuts: [string, number, string, number][] = [];
  const forwardIns: [string, number][] = [];
  const channels: FakeStream[] = [];
  const tcpip: ((event: TcpipEvent) => void)[] = [];
  let remoteRefusal: Error | undefined;
  let revokes = 0;
  const capability: TunnelCapability = {
    forwardOut: async (srcHost, srcPort, dstHost, dstPort) => {
      forwardOuts.push([srcHost, srcPort, dstHost, dstPort]);
      const channel = new FakeStream();
      channels.push(channel);
      return channel;
    },
    forwardIn: async (host, port) => {
      forwardIns.push([host, port]);
      if (remoteRefusal !== undefined) throw remoteRefusal;
      return options.boundPort ?? port;
    },
    onTcpipEvent: (listener) => {
      tcpip.push(listener);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        revokes += 1;
        const index = tcpip.indexOf(listener);
        if (index !== -1) tcpip.splice(index, 1);
      };
    },
  };
  const emit = (data: { destIP: string; destPort: number; srcIP: string; srcPort: number }): FireResult => {
    const channel = new FakeStream();
    const result: FireResult = { accepted: 0, rejected: 0, channel };
    const event: TcpipEvent = {
      ...data,
      accept: async () => {
        result.accepted += 1;
        return channel;
      },
      reject: () => {
        result.rejected += 1;
      },
    };
    // 快照派发：监听器在派发过程中撤销注册不该改变这一次的投递集合
    for (const listener of [...tcpip]) listener(event);
    return result;
  };
  return {
    capability,
    forwardOuts,
    forwardIns,
    channels,
    tcpip,
    emit,
    get revokes() {
      return revokes;
    },
    refuseRemote: (error) => {
      remoteRefusal = error;
    },
  };
}

const localSpec = (overrides: Partial<TunnelSpec> = {}): TunnelSpec => ({
  sessionId: "s1",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 18080,
  destHost: "127.0.0.1",
  destPort: 5432,
  ...overrides,
});

const remoteSpec = (overrides: Partial<TunnelSpec> = {}): TunnelSpec => ({
  sessionId: "s1",
  mode: "remote",
  bindHost: "127.0.0.1",
  bindPort: 22000,
  destHost: "127.0.0.1",
  destPort: 22,
  ...overrides,
});

const socksSpec = (overrides: Partial<TunnelSpec> = {}): TunnelSpec => ({
  sessionId: "s1",
  mode: "socks",
  bindHost: "127.0.0.1",
  bindPort: 1080,
  destHost: null,
  destPort: null,
  ...overrides,
});

/** pipe 是流事件驱动的：等一拍再断言，别跟事件循环抢跑。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 模拟远端连进被转发的端口：accept() 交回来一条内存通道。 */
const fireTcpip = async (
  listeners: ((event: TcpipEvent) => void)[],
  data: { destIP: string; destPort: number; srcIP: string; srcPort: number },
): Promise<FakeStream> => {
  const channel = new FakeStream();
  for (const listener of listeners) {
    listener({ ...data, accept: async () => channel, reject: () => {} });
  }
  await flush();
  return channel;
};

describe("TunnelManager local mode (-L)", () => {
  it("listens on loopback and pipes one channel per connection both ways", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net, now: () => 1700000000000 });

    const info = await tunnels.start(localSpec());

    expect(info).toMatchObject({
      id: "t1",
      sessionId: "s1",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 18080,
      destHost: "127.0.0.1",
      destPort: 5432,
      state: "active",
      bytesIn: 0,
      bytesOut: 0,
      createdAt: 1700000000000,
    });
    // 硬性安全口径：本地监听只许回环
    expect(net.listeners[0]!.listens).toEqual([{ port: 18080, host: "127.0.0.1" }]);

    const client = new FakeStream();
    net.listeners[0]!.onConnection(client);
    await flush();

    // 每条连接一条新通道，源地址就是本地监听地址
    expect(fake.forwardOuts).toEqual([["127.0.0.1", 18080, "127.0.0.1", 5432]]);
    const channel = fake.channels[0]!;

    client.push(Buffer.from("ping"));
    channel.push(Buffer.from("pong"));
    await flush();

    expect(channel.text()).toBe("ping");
    expect(client.text()).toBe("pong");
    expect(tunnels.list()[0]).toMatchObject({ bytesIn: 4, bytesOut: 4 });
  });

  it("destroys the local socket when the channel cannot be opened", async () => {
    const net = fakeNet();
    const capability: TunnelCapability = {
      forwardOut: async () => {
        throw new Error("administratively prohibited");
      },
      forwardIn: async (_host, port) => port,
      onTcpipEvent: () => {},
    };
    const tunnels = new TunnelManager({ sessions: async () => capability, net });
    await tunnels.start(localSpec());

    const client = new FakeStream();
    net.listeners[0]!.onConnection(client);
    await flush();

    expect(client.destroyed).toBe(true);
  });
});

describe("TunnelManager socks mode (-D)", () => {
  it("completes a SOCKS5 CONNECT handshake and then pipes the tunnel", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    await tunnels.start(socksSpec());

    const client = new FakeStream();
    net.listeners[0]!.onConnection(client);
    await flush();

    // 1) 问候：版本 5，只提供「无认证」
    client.push(Buffer.from([5, 1, 0]));
    await flush();
    expect(client.written).toEqual([Buffer.from([5, 0])]);

    // 2) CONNECT example.com:443（域名寻址）
    const host = Buffer.from("example.com");
    client.push(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0x01, 0xbb])]));
    await flush();

    expect(fake.forwardOuts).toEqual([["127.0.0.1", 1080, "example.com", 443]]);
    expect(client.written[1]).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));

    const channel = fake.channels[0]!;
    client.push(Buffer.from("GET /"));
    channel.push(Buffer.from("HTTP/1.1 200"));
    await flush();

    expect(channel.text()).toBe("GET /");
    // written[0]/[1] 是两帧握手回复，之后才是通道数据
    expect(client.written.slice(2)).toEqual([Buffer.from("HTTP/1.1 200")]);
  });

  it("refuses a non-CONNECT command instead of opening a channel", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    await tunnels.start(socksSpec());

    const client = new FakeStream();
    net.listeners[0]!.onConnection(client);
    await flush();

    client.push(Buffer.from([5, 1, 0]));
    await flush();
    // BIND：只支持 CONNECT，回 0x07 而不是开通道
    client.push(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 22]));
    await flush();

    expect(fake.forwardOuts).toEqual([]);
    expect(client.written[1]!.subarray(1, 2)).toEqual(Buffer.from([7]));
  });
});

describe("TunnelManager remote mode (-R)", () => {
  it("asks the server for a bind and dials the local target for every arriving connection", async () => {
    const net = fakeNet();
    const fake = fakeCapability({ boundPort: 22022 });
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    const info = await tunnels.start(remoteSpec());

    // 远端监听地址来自 bindHost:bindPort，实际端口以服务端分配为准
    expect(fake.forwardIns).toEqual([["127.0.0.1", 22000]]);
    expect(info.bindPort).toBe(22022);
    expect(fake.tcpip).toHaveLength(1);

    const channel = await fireTcpip(fake.tcpip, {
      destIP: "127.0.0.1",
      destPort: 22022,
      srcIP: "10.0.0.9",
      srcPort: 51000,
    });

    expect(net.dialed).toEqual([{ port: 22, host: "127.0.0.1" }]);
    const local = net.sockets[0]!;
    channel.push(Buffer.from("ssh-banner"));
    local.push(Buffer.from("client-hello"));
    await flush();

    expect(local.text()).toBe("ssh-banner");
    expect(channel.text()).toBe("client-hello");
  });

  it("ignores tcp connections that belong to another tunnel on the same session", async () => {
    const net = fakeNet();
    const fake = fakeCapability({ boundPort: 22022 });
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    await tunnels.start(remoteSpec());

    await fireTcpip(fake.tcpip, { destIP: "127.0.0.1", destPort: 22023, srcIP: "10.0.0.9", srcPort: 51001 });

    expect(net.dialed).toEqual([]);
  });

  it("explains a refused remote bind instead of blaming the local port", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    fake.refuseRemote(new Error("Unable to bind to 127.0.0.1:22000"));
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    const failure = await tunnels.start(remoteSpec()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelError);
    expect(failure).toMatchObject({ reason: "remote-refused" });
    expect(messageOf(failure)).toContain("服务器可能禁用了远程转发");
    expect(tunnels.list()).toEqual([]);
  });

  it("keeps one tcpip listener per session no matter how many tunnels start and stop", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    await tunnels.start(remoteSpec({ bindPort: 22000 }));
    await tunnels.stop("t1");
    await tunnels.start(remoteSpec({ bindPort: 22001 }));
    await tunnels.stop("t2");
    await tunnels.start(remoteSpec({ bindPort: 22002 }));

    // 停一次就摘一次：监听不随启动次数累积（M3-11 的真机残留）
    expect(fake.tcpip).toHaveLength(1);
    expect(tunnels.list().map((tunnel) => tunnel.id)).toEqual(["t3"]);
  });

  it("rejects tcpip events that arrive after the tunnel is stopped and never accepts them", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    await tunnels.start(remoteSpec());

    expect(await tunnels.stop("t1")).toBe(true);
    const event = fake.emit({ destIP: "127.0.0.1", destPort: 22000, srcIP: "10.0.0.9", srcPort: 51000 });
    await flush();

    // 停掉的端口不再有主：明确拒绝，别 accept 后继续转发，也别让远端挂死
    expect(event.rejected).toBe(1);
    expect(event.accepted).toBe(0);
    expect(net.dialed).toEqual([]);
  });

  it("does not let a stopped tunnel answer events that belong to another tunnel on the same session", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    await tunnels.start(remoteSpec({ bindPort: 22000 }));
    await tunnels.stop("t1");
    await tunnels.start(remoteSpec({ bindPort: 22001 }));

    const event = fake.emit({ destIP: "127.0.0.1", destPort: 22001, srcIP: "10.0.0.9", srcPort: 51002 });
    await flush();

    // 真机复现：停掉的那条仍留着监听，「已停用」分支抢先把别人的连接拒了
    expect(event.rejected).toBe(0);
    expect(event.accepted).toBe(1);
    expect(net.dialed).toEqual([{ port: 22, host: "127.0.0.1" }]);
  });

  it("destroys the accepted channel and the local socket when the tunnel is stopped", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    await tunnels.start(remoteSpec());

    const event = fake.emit({ destIP: "127.0.0.1", destPort: 22000, srcIP: "10.0.0.9", srcPort: 51000 });
    await flush();
    const local = net.sockets[0]!;
    expect([local.destroyed, event.channel.destroyed]).toEqual([false, false]);

    await tunnels.stop("t1");

    // 只掐本地 socket 不够：ssh 通道还挂着，已连上的转发会继续跑
    expect([local.destroyed, event.channel.destroyed]).toEqual([true, true]);
  });

  it("leaves nothing behind that could reject later events when the remote bind fails", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });
    fake.refuseRemote(new Error("Unable to bind to 127.0.0.1:22000"));

    await expect(tunnels.start(remoteSpec())).rejects.toMatchObject({ reason: "remote-refused" });

    fake.refuseRemote(undefined);
    await tunnels.start(remoteSpec({ bindPort: 22001 }));
    const event = fake.emit({ destIP: "127.0.0.1", destPort: 22001, srcIP: "10.0.0.9", srcPort: 51003 });
    await flush();

    expect(event.rejected).toBe(0);
    expect(net.dialed).toEqual([{ port: 22, host: "127.0.0.1" }]);
  });
});

describe("tunnel safety guards", () => {
  it("refuses to listen on anything but loopback", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    for (const bindHost of ["0.0.0.0", "::", "192.0.2.5", "10.0.0.5", "example.com"]) {
      await expect(tunnels.start(localSpec({ bindHost }))).rejects.toMatchObject({ reason: "invalid-request" });
    }

    // 拒绝发生在创建监听之前：一条监听都没建，也就不可能把端口摊到局域网上
    expect(net.listeners).toEqual([]);
    expect(tunnels.list()).toEqual([]);
    await expect(tunnels.start(localSpec({ bindHost: "0.0.0.0" }))).rejects.toThrow(/127\.0\.0\.1/);
    await expect(tunnels.start(localSpec({ bindHost: "0.0.0.0" }))).rejects.toThrow(/localhost/);
  });

  it("rejects a port outside 1..65535", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    for (const bindPort of [0, -1, 65536, 1.5, Number.NaN]) {
      await expect(tunnels.start(localSpec({ bindPort }))).rejects.toMatchObject({ reason: "invalid-request" });
    }
    expect(net.listeners).toEqual([]);
  });

  it("reports a busy local port with a hint to pick another one", async () => {
    const net = fakeNet({ bindError: Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }) });
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    const failure = await tunnels.start(localSpec()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TunnelError);
    expect(failure).toMatchObject({ reason: "bind-failed" });
    expect(messageOf(failure)).toContain("换一个端口");
    expect(tunnels.list()).toEqual([]);
  });

  it("passes the session source failure through untouched", async () => {
    const net = fakeNet();
    const tunnels = new TunnelManager({
      sessions: async () => {
        throw new TunnelError("unknown-session", "uniterminal: unknown session 's9'");
      },
      net,
    });

    await expect(tunnels.start(localSpec({ sessionId: "s9" }))).rejects.toMatchObject({ reason: "unknown-session" });
    expect(net.listeners).toEqual([]);
  });
});

describe("tunnel lifecycle", () => {
  it("lists active tunnels and stops a tunnel exactly once", async () => {
    const net = fakeNet();
    const fake = fakeCapability();
    const tunnels = new TunnelManager({ sessions: async () => fake.capability, net });

    await tunnels.start(localSpec());
    await tunnels.start(socksSpec({ bindPort: 1081 }));
    expect(tunnels.list().map((tunnel) => tunnel.id + ":" + tunnel.mode)).toEqual(["t1:local", "t2:socks"]);

    const client = new FakeStream();
    net.listeners[0]!.onConnection(client);
    await flush();

    expect(await tunnels.stop("t1")).toBe(true);
    expect(tunnels.list().map((tunnel) => tunnel.id)).toEqual(["t2"]);
    // 本地监听与已建立的连接一并收掉，否则端口泄漏到进程结束
    expect(net.listeners[0]!.closed).toBe(true);
    expect(client.destroyed).toBe(true);
    expect(await tunnels.stop("t1")).toBe(false);
  });

  it("reclaims every tunnel derived from a session when that session closes", async () => {
    const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
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
        forwardOut: async () => new FakeStream(),
        forwardIn: async (_host, port) => port,
        onTcpipEvent: () => {},
      }),
    };
    const registry = new TransportRegistry();
    registry.register(adapter);
    const sessions = new SessionManager(registry, { bufferBytes: 16 });
    const net = fakeNet();
    // 与 index.ts 同一条接线：会话关闭事件直接接到隧道表的回收上
    const tunnels = new TunnelManager({
      sessions: (id) => sessions.openTunnels(id),
      net,
      onSessionClosed: (listener) => sessions.onClosed(listener),
    });

    const info = await sessions.open({ id: "p1", kind: "ssh", host: "h" });
    await tunnels.start(localSpec({ sessionId: info.id }));
    expect(tunnels.list()).toHaveLength(1);

    await sessions.close(info.id);

    await vi.waitFor(() => expect(tunnels.list()).toEqual([]));
    expect(net.listeners[0]!.closed).toBe(true);
  });

  it("detaches the session's tcpip router when that session closes", async () => {
    const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
    const revokes: string[] = [];
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
        forwardOut: async () => new FakeStream(),
        forwardIn: async (_host, port) => port,
        onTcpipEvent: () => () => void revokes.push("revoked"),
      }),
    };
    const registry = new TransportRegistry();
    registry.register(adapter);
    const sessions = new SessionManager(registry, { bufferBytes: 16 });
    const net = fakeNet();
    const tunnels = new TunnelManager({
      sessions: (id) => sessions.openTunnels(id),
      net,
      onSessionClosed: (listener) => sessions.onClosed(listener),
    });

    const info = await sessions.open({ id: "p1", kind: "ssh", host: "h" });
    await tunnels.start(remoteSpec({ sessionId: info.id }));
    expect(revokes).toEqual([]);

    await sessions.close(info.id);

    // 会话没了，路由必须跟着摘掉：摘的就是 capability.onTcpipEvent 交回来的那个取消函数
    await vi.waitFor(() => expect(revokes).toEqual(["revoked"]));
  });
});

describe("normalizeTunnelSpec", () => {
  it("defaults bindHost to 127.0.0.1 and accepts localhost", () => {
    expect(normalizeTunnelSpec({ sessionId: "s1", mode: "local", bindPort: 18080, destHost: "db", destPort: 5432 })).toEqual({
      sessionId: "s1",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 18080,
      destHost: "db",
      destPort: 5432,
    });
    expect(
      normalizeTunnelSpec({ sessionId: "s1", mode: "local", bindHost: "localhost", bindPort: 18080, destHost: "db", destPort: 5432 }).bindHost,
    ).toBe("localhost");
  });

  it("requires a destination for -L and -R but not for -D", () => {
    expect(() => normalizeTunnelSpec({ sessionId: "s1", mode: "local", bindPort: 18080 })).toThrow(/destHost/);
    expect(() => normalizeTunnelSpec({ sessionId: "s1", mode: "remote", bindPort: 18080, destHost: "db" })).toThrow(/destPort/);
    expect(normalizeTunnelSpec({ sessionId: "s1", mode: "socks", bindPort: 1080 })).toMatchObject({
      mode: "socks",
      destHost: null,
      destPort: null,
    });
  });

  it("rejects unknown modes, blank session ids and bad ports", () => {
    for (const mode of ["dynamic", "LOCAL", ""]) {
      expect(() => normalizeTunnelSpec({ sessionId: "s1", mode, bindPort: 1080 })).toThrow(/mode/);
    }
    expect(() => normalizeTunnelSpec({ sessionId: "", mode: "socks", bindPort: 1080 })).toThrow(/sessionId/);
    for (const bindPort of [0, 70000, 1.5, "1080", undefined]) {
      expect(() => normalizeTunnelSpec({ sessionId: "s1", mode: "socks", bindPort })).toThrow(/bindPort/);
    }
  });
});
