/**
 * 端口转发（M3-2）：-L / -R / -D 三种模式共用一份隧道表。
 * 本文件只放三件事：通道契约与请求校验、net 监听/拨号的注入点、隧道管理器。
 * 通道一律来自 SessionManager.openTunnels——这里不碰 ssh2 类型，也绝不自己建 SSH 连接。
 */
import { connect, createServer } from "node:net";
import type { Duplex } from "node:stream";

/** 三种转发模式：local(-L) / remote(-R) / socks(-D)。 */
export type TunnelMode = "local" | "remote" | "socks";

export const TUNNEL_MODES = ["local", "remote", "socks"] as const;

export const isTunnelMode = (value: string): value is TunnelMode => (TUNNEL_MODES as readonly string[]).includes(value);

/** 远端有人连上了被转发的端口（ssh2 的 'tcp connection' 事件）。 */
export interface TcpipEvent {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
  /** 接下这条连接，拿到可双向 pipe 的通道。 */
  accept(): Promise<Duplex>;
  /** 拒掉：远端会看到连接被拒，而不是挂死。 */
  reject(): void;
}

/**
 * 撤销一次 tcpip 事件注册。void 只留给还交不出取消函数的通道层：
 * 隧道表按「拿到就调、拿不到也不假装」处理，绝不把不可撤销当成可撤销。
 */
export type TcpipUnsubscribe = void | (() => void);

/**
 * 一个 SSH 会话上的转发能力：只要通道，不要控制面。
 * 刻意不暴露裸 ssh2 client，也不暴露会话的 write/close/订阅。
 */
export interface TunnelCapability {
  forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number): Promise<Duplex>;
  forwardIn(host: string, port: number): Promise<number>;
  /** 返回取消函数：撤销之后回调不该再被调用（M3-11）。 */
  onTcpipEvent(listener: (event: TcpipEvent) => void): TcpipUnsubscribe;
}

/** 按会话 id 取转发能力（index.ts 接线成 manager.openTunnels）。 */
export type TunnelSource = (sessionId: string) => Promise<TunnelCapability>;

/**
 * 失败分类；路由层据此给状态码：
 * unknown-session → 404；open-failed → 500；其余（校验、端口占用、远端拒绝）→ 400。
 */
export type TunnelFailure =
  | "unknown-session"
  | "unsupported"
  | "invalid-request"
  | "bind-failed"
  | "remote-refused"
  | "open-failed";

export class TunnelError extends Error {
  readonly reason: TunnelFailure;

  constructor(reason: TunnelFailure, message: string) {
    super(message);
    this.name = "TunnelError";
    this.reason = reason;
  }
}

/** 可直接回给界面的隧道快照（响应体里只有这些字段，永远没有凭据）。 */
export interface TunnelInfo {
  id: string;
  sessionId: string;
  mode: TunnelMode;
  /** 本地监听地址；-R 是请求服务端监听的地址。 */
  bindHost: string;
  /** 真正生效的端口：-R 用服务端分配的端口。 */
  bindPort: number;
  /** -D 没有固定目标（目标由每个 SOCKS 请求决定），因此为 null。 */
  destHost: string | null;
  destPort: number | null;
  state: "active" | "stopped";
  /** 本地 → 远端 的字节数。 */
  bytesIn: number;
  /** 远端 → 本地 的字节数。 */
  bytesOut: number;
  createdAt: number;
}

/** 校验通过后的隧道规格（路由层用 normalizeTunnelSpec 从请求体得到它）。 */
export interface TunnelSpec {
  sessionId: string;
  mode: TunnelMode;
  bindHost: string;
  bindPort: number;
  destHost: string | null;
  destPort: number | null;
}

/** 硬性安全口径：本地监听只许回环。0.0.0.0 等于把端口摊给整个局域网。 */
export const DEFAULT_BIND_HOST = "127.0.0.1";
const LOOPBACK_BIND_HOSTS: readonly string[] = [DEFAULT_BIND_HOST, "localhost"];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const invalid = (message: string): TunnelError => new TunnelError("invalid-request", "uniterminal: " + message);

export function requireBindHost(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_BIND_HOST;
  if (typeof value !== "string" || !LOOPBACK_BIND_HOSTS.includes(value)) {
    throw invalid("bindHost 只允许 127.0.0.1 或 localhost（拒绝对外监听：绑 0.0.0.0 会把端口暴露给整个局域网）");
  }
  return value;
}

export function requirePort(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalid("参数 " + what + " 必须是 1..65535 之间的整数");
  }
  return value;
}

const requireSessionId = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") throw invalid("参数 sessionId 必须是非空字符串");
  return value;
};

const requireDestHost = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "" || /\s/.test(value)) {
    throw invalid("参数 destHost 必须是主机名或 IP（不能为空、不能含空白）");
  }
  return value;
};

export function requireMode(value: unknown): TunnelMode {
  if (typeof value !== "string" || !isTunnelMode(value)) throw invalid("参数 mode 必须是 local / remote / socks 之一");
  return value;
}

/** 请求体 → 隧道规格：所有校验都在这里，路由层只负责把 TunnelError 映射成 400。 */
export function normalizeTunnelSpec(input: Record<string, unknown>): TunnelSpec {
  const sessionId = requireSessionId(input.sessionId);
  const mode = requireMode(input.mode);
  const bindHost = requireBindHost(input.bindHost);
  const bindPort = requirePort(input.bindPort, "bindPort");
  if (mode === "socks") {
    // -D 的目标由每个 SOCKS 请求带进来：固定一个 dest 只会误导用户
    if (input.destHost !== undefined && input.destHost !== null) throw invalid("socks 模式不接受 destHost（目标由请求决定）");
    if (input.destPort !== undefined && input.destPort !== null) throw invalid("socks 模式不接受 destPort（目标由请求决定）");
    return { sessionId, mode, bindHost, bindPort, destHost: null, destPort: null };
  }
  return {
    sessionId,
    mode,
    bindHost,
    bindPort,
    destHost: requireDestHost(input.destHost),
    destPort: requirePort(input.destPort, "destPort"),
  };
}

/** start() 自己再校验一遍：路由层不是唯一调用方，类型正确的 spec 也可能带着 0 号端口。 */
const assertSpec = (spec: TunnelSpec): TunnelSpec =>
  normalizeTunnelSpec({
    sessionId: spec.sessionId,
    mode: spec.mode,
    bindHost: spec.bindHost,
    bindPort: spec.bindPort,
    destHost: spec.destHost,
    destPort: spec.destPort,
  });

/** node net 的最小形状：listen/close + error 事件。 */
export interface TunnelListener {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
}

/** 可注入的 net：测试用它顶替真绑定，生产用它就是 node:net。 */
export interface TunnelNet {
  createListener(onConnection: (socket: Duplex) => void): TunnelListener;
  connect(port: number, host: string): Duplex;
}

export const nodeTunnelNet: TunnelNet = {
  createListener: (onConnection) => {
    const server = createServer((socket) => onConnection(socket));
    return {
      listen: (port, host, callback) => void server.listen({ port, host, exclusive: true }, callback),
      // 不 await server.close 的回调：它要等所有连接结束，stop() 不该被挂住的连接拖死
      close: (callback) => {
        server.close();
        callback?.();
      },
      on: (event, callback) => void server.on(event, callback),
    };
  },
  connect: (port, host) => connect({ port, host }),
};

/** 双向转发：本地侧 ↔ 远端通道，顺带记流量。任一方向断开就收掉另一侧。 */
const bridge = (local: Duplex, remote: Duplex, info: TunnelInfo): void => {
  local.on("data", (chunk: Buffer) => {
    info.bytesIn += chunk.length;
  });
  remote.on("data", (chunk: Buffer) => {
    info.bytesOut += chunk.length;
  });
  local.on("error", () => remote.destroy());
  remote.on("error", () => local.destroy());
  local.on("close", () => remote.destroy());
  remote.on("close", () => local.destroy());
  local.pipe(remote);
  remote.pipe(local);
};

interface SocketReader {
  read(count: number): Promise<Buffer>;
  /** 摘掉监听，并把还没被读走的字节还回来（握手之后它们属于通道数据）。 */
  dispose(): Buffer;
}

/** SOCKS 握手要按字节读：先攒够再解析，多出来的字节必须还给通道。 */
function createReader(socket: Duplex): SocketReader {
  let buffered = Buffer.alloc(0);
  let notify: (() => void) | undefined;
  let failure: Error | undefined;
  let disposed = false;
  const wake = (): void => {
    const resume = notify;
    notify = undefined;
    resume?.();
  };
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  };
  const onFailure = (error: Error): void => {
    failure ??= error;
    wake();
  };
  const onClose = (): void => onFailure(new Error("uniterminal: connection closed during the socks handshake"));
  socket.on("data", onData);
  socket.on("error", onFailure);
  socket.on("close", onClose);
  return {
    read: async (count) => {
      while (buffered.length < count) {
        if (failure !== undefined) throw failure;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const value = buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      return value;
    },
    dispose: () => {
      if (!disposed) {
        disposed = true;
        socket.off("data", onData);
        socket.off("error", onFailure);
        socket.off("close", onClose);
      }
      const rest = buffered;
      buffered = Buffer.alloc(0);
      return rest;
    },
  };
}

const SOCKS_VERSION = 0x05;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_CONNECT = 0x01;
const SOCKS_SUCCEEDED = 0x00;
const SOCKS_CONNECTION_REFUSED = 0x05;
const SOCKS_COMMAND_UNSUPPORTED = 0x07;
const SOCKS_ADDRESS_UNSUPPORTED = 0x08;
const SOCKS_NO_ACCEPTABLE_METHODS = 0xff;
const SOCKS_GRANTED = Buffer.from([SOCKS_VERSION, SOCKS_SUCCEEDED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

const socksRefuse = (socket: Duplex, code: number): void => {
  socket.end(Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
};

const formatIpv6 = (raw: Buffer): string => {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(raw.readUInt16BE(index).toString(16));
  return groups.join(":");
};

/**
 * 最小 SOCKS5 服务端：只支持 CONNECT、只支持无认证。
 * 少即是快——不做 BIND/UDP ASSOCIATE，也就不给攻击面留位置。
 */
async function socksServe(
  socket: Duplex,
  forward: (host: string, port: number) => Promise<Duplex>,
  info: TunnelInfo,
): Promise<void> {
  const reader = createReader(socket);
  try {
    // 1) 问候：版本 + 方法列表，只认「无认证」
    const greeting = await reader.read(2);
    if (greeting.readUInt8(0) !== SOCKS_VERSION) throw new Error("unsupported socks version");
    const methods = await reader.read(greeting.readUInt8(1));
    if (!methods.includes(SOCKS_NO_AUTH)) {
      reader.dispose();
      socket.end(Buffer.from([SOCKS_VERSION, SOCKS_NO_ACCEPTABLE_METHODS]));
      return;
    }
    socket.write(Buffer.from([SOCKS_VERSION, SOCKS_NO_AUTH]));

    // 2) 请求：CONNECT + 目标地址
    const head = await reader.read(4);
    if (head.readUInt8(0) !== SOCKS_VERSION) throw new Error("unsupported socks version");
    if (head.readUInt8(1) !== SOCKS_CONNECT) {
      reader.dispose();
      socksRefuse(socket, SOCKS_COMMAND_UNSUPPORTED);
      return;
    }
    const addressType = head.readUInt8(3);
    let host: string;
    if (addressType === 0x01) {
      host = [...(await reader.read(4))].join(".");
    } else if (addressType === 0x03) {
      const length = (await reader.read(1)).readUInt8(0);
      host = (await reader.read(length)).toString("utf8");
    } else if (addressType === 0x04) {
      host = formatIpv6(await reader.read(16));
    } else {
      reader.dispose();
      socksRefuse(socket, SOCKS_ADDRESS_UNSUPPORTED);
      return;
    }
    const port = (await reader.read(2)).readUInt16BE(0);

    let channel: Duplex;
    try {
      channel = await forward(host, port);
    } catch {
      reader.dispose();
      socksRefuse(socket, SOCKS_CONNECTION_REFUSED);
      return;
    }
    // 握手后多出来的字节属于通道数据：一并交过去，绝不丢包
    const rest = reader.dispose();
    socket.write(SOCKS_GRANTED);
    bridge(socket, channel, info);
    if (rest.length > 0) channel.write(rest);
  } catch {
    // 版本不对或对端提前关闭：直接收掉，别把半截会话留在那里
    reader.dispose();
    socket.destroy();
  }
}

interface TunnelEntry {
  readonly info: TunnelInfo;
  teardown(): void;
}

/** 一条会话上的 -R 事件路由：一条会话只注册一个监听，按端口派给当时活着的隧道。 */
interface RemoteRouter {
  /** 路由所属的转发能力：重连换了连接就换路由，旧连接上的监听必须摘掉。 */
  readonly capability: TunnelCapability;
  /** 端口 → 该端口当前的主人；隧道停止时移除。 */
  readonly owners: Map<number, (event: TcpipEvent) => void>;
  /** 从转发能力上摘掉这个路由（会话回收 / 装配销毁）。 */
  detach(): void;
}

/** 一次端口认领：服务端改派端口时 move，隧道停止时 revoke。 */
interface RemoteClaim {
  move(port: number): void;
  revoke(): void;
}

export interface TunnelManagerOptions {
  sessions: TunnelSource;
  net?: TunnelNet;
  now?: () => number;
  /** 会话关闭事件源（index.ts 接到 SessionManager.onClosed）：该会话的隧道由它回收。 */
  onSessionClosed?: (listener: (sessionId: string) => void) => () => void;
}

export class TunnelManager {
  readonly #sessions: TunnelSource;
  readonly #net: TunnelNet;
  readonly #now: () => number;
  readonly #entries = new Map<string, TunnelEntry>();
  /** 会话 id → -R 事件路由（每会话至多一个，不随隧道启停累积）。 */
  readonly #routers = new Map<string, RemoteRouter>();
  readonly #detach: () => void;
  #sequence = 0;

  constructor(options: TunnelManagerOptions) {
    this.#sessions = options.sessions;
    this.#net = options.net ?? nodeTunnelNet;
    this.#now = options.now ?? Date.now;
    this.#detach = options.onSessionClosed?.((sessionId) => this.#reclaim(sessionId)) ?? (() => {});
  }

  /** 装配销毁时解除与会话关闭事件的绑定（隧道本身由 stopAll 收）。 */
  dispose(): void {
    this.#detach();
    for (const sessionId of [...this.#routers.keys()]) this.#dropRouter(sessionId);
  }

  list(): TunnelInfo[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry.info }));
  }

  /** 开一条隧道；失败时不留半条记录（端口/监听/远端绑定都要么全成、要么全不留）。 */
  async start(input: TunnelSpec): Promise<TunnelInfo> {
    const spec = assertSpec(input);
    const capability = await this.#sessions(spec.sessionId);
    const info: TunnelInfo = {
      id: "t" + String(++this.#sequence),
      sessionId: spec.sessionId,
      mode: spec.mode,
      bindHost: spec.bindHost,
      bindPort: spec.bindPort,
      destHost: spec.destHost,
      destPort: spec.destPort,
      state: "active",
      bytesIn: 0,
      bytesOut: 0,
      createdAt: this.#now(),
    };
    const sockets = new Set<Duplex>();
    let stopServing: () => void;
    switch (spec.mode) {
      case "local":
        stopServing = await this.#openLocal(spec, capability, info, sockets);
        break;
      case "remote":
        stopServing = await this.#openRemote(spec, capability, info, sockets);
        break;
      case "socks":
        stopServing = await this.#openSocks(spec, capability, info, sockets);
        break;
    }
    this.#entries.set(info.id, {
      info,
      teardown: () => {
        // 先掐掉已建立的连接，再关监听：否则 server.close 会等连接自然结束
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        stopServing();
      },
    });
    return { ...info };
  }

  /** 停一条隧道；不存在的 id 返回 false（幂等，路由层据此同时给出 200 与 stopped:false）。 */
  async stop(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    entry.info.state = "stopped";
    try {
      entry.teardown();
    } catch {
      // 关闭失败不改变「已停用」的事实
    }
    return true;
  }

  /** 回收某个会话派生的全部隧道（会话关闭时自动调用）。 */
  async stopSession(sessionId: string): Promise<number> {
    const ids = [...this.#entries.values()]
      .filter((entry) => entry.info.sessionId === sessionId)
      .map((entry) => entry.info.id);
    for (const id of ids) await this.stop(id);
    return ids.length;
  }

  /** 装配销毁时收掉全部隧道，避免端口在进程里继续被占着。 */
  async stopAll(): Promise<void> {
    for (const id of [...this.#entries.keys()]) await this.stop(id);
  }

  /** -L / -D：本地 net server → 每条连接一条 forwardOut 通道。 */
  async #openLocal(
    spec: TunnelSpec,
    capability: TunnelCapability,
    info: TunnelInfo,
    sockets: Set<Duplex>,
  ): Promise<() => void> {
    const listener = this.#net.createListener((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void (async () => {
        let channel: Duplex;
        try {
          // 源地址就是本地监听地址：服务端日志里一眼能认出这次转发
          channel = await capability.forwardOut(DEFAULT_BIND_HOST, info.bindPort, spec.destHost ?? "", spec.destPort ?? 0);
        } catch {
          socket.destroy();
          return;
        }
        bridge(socket, channel, info);
      })();
    });
    await this.#listen(listener, spec);
    return () => this.#closeListener(listener);
  }

  /**
   * -R：bindHost:bindPort 是**请求服务端监听**的地址（等价 ssh -R 的远端侧），
   * destHost:destPort 是本地要连的目标。远端每来一条连接就连一次本地目标再 pipe。
   * 实际生效的端口以服务端分配为准，写回 info.bindPort（tcpip 事件按它认领）。
   *
   * M3-11：监听挂在**会话**的路由上（一条会话一个），本隧道只认领一个端口。
   * 停止 = 把端口交还路由：之后到达的连接由路由统一拒绝，既不会再漏进已停的隧道，
   * 也不会像从前那样在 ssh2 连接上按启动次数无限累积监听器。
   */
  async #openRemote(
    spec: TunnelSpec,
    capability: TunnelCapability,
    info: TunnelInfo,
    sockets: Set<Duplex>,
  ): Promise<() => void> {
    const destHost = spec.destHost ?? "";
    const destPort = spec.destPort ?? 0;
    let stopped = false;
    // 先认领端口再 forwardIn：服务端监听一生效就可能来连接，晚认领会漏第一条
    const claim = this.#claim(this.#route(spec.sessionId, capability), spec.bindPort, (event) => {
      void (async () => {
        let channel: Duplex;
        try {
          channel = await event.accept();
        } catch {
          return;
        }
        if (stopped) {
          // stop 与 accept 撞车：通道已经开了，就地收掉，绝不让它绕开 teardown 继续跑
          channel.destroy();
          return;
        }
        const socket = this.#net.connect(destPort, destHost);
        // 通道也进 sockets：只销毁本地 socket 时 ssh 通道还活着，已连上的转发会继续穿
        sockets.add(channel);
        channel.on("close", () => sockets.delete(channel));
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        bridge(socket, channel, info);
      })();
    });
    try {
      info.bindPort = await capability.forwardIn(spec.bindHost, spec.bindPort);
      // 服务端可能改派端口：认领跟着搬，否则事件按端口再也认不回来
      claim.move(info.bindPort);
    } catch (error) {
      stopped = true;
      claim.revoke();
      throw new TunnelError(
        "remote-refused",
        "uniterminal: 服务器拒绝了远程转发 " +
          spec.bindHost +
          ":" +
          spec.bindPort +
          "（服务器可能禁用了远程转发，AllowTcpForwarding no）：" +
          messageOf(error),
      );
    }
    return () => {
      stopped = true;
      claim.revoke();
    };
  }

  /** -D：本地 net server → 每个 SOCKS 请求一条 forwardOut 通道。 */
  async #openSocks(
    spec: TunnelSpec,
    capability: TunnelCapability,
    info: TunnelInfo,
    sockets: Set<Duplex>,
  ): Promise<() => void> {
    const listener = this.#net.createListener((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void socksServe(socket, (host, port) => capability.forwardOut(DEFAULT_BIND_HOST, info.bindPort, host, port), info);
    });
    await this.#listen(listener, spec);
    return () => this.#closeListener(listener);
  }

  /** 监听失败（端口占用等）在这里统一成一类可读错误。 */
  async #listen(listener: TunnelListener, spec: TunnelSpec): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      listener.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(bindFailure(spec.bindPort, error));
      });
      listener.listen(spec.bindPort, spec.bindHost, () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }

  #closeListener(listener: TunnelListener): void {
    try {
      listener.close();
    } catch {
      // 已经关了：stop 幂等
    }
  }

  /** 取这条会话的路由；连接换了（重连）就换一条，旧连接上的监听必须摘掉。 */
  #route(sessionId: string, capability: TunnelCapability): RemoteRouter {
    const existing = this.#routers.get(sessionId);
    if (existing !== undefined && existing.capability === capability) return existing;
    if (existing !== undefined) this.#dropRouter(sessionId);
    const owners = new Map<number, (event: TcpipEvent) => void>();
    const revoke = capability.onTcpipEvent((event) => {
      const owner = owners.get(event.destPort);
      if (owner === undefined) {
        // 端口无主（隧道已停，或这条会话根本没为它请求过转发）：明确拒绝，别让远端挂死
        event.reject();
        return;
      }
      owner(event);
    });
    const router: RemoteRouter = {
      capability,
      owners,
      detach: () => {
        if (typeof revoke === "function") revoke();
      },
    };
    this.#routers.set(sessionId, router);
    return router;
  }

  #dropRouter(sessionId: string): void {
    const router = this.#routers.get(sessionId);
    if (router === undefined) return;
    this.#routers.delete(sessionId);
    try {
      router.detach();
    } catch {
      // 连接已经没了：摘不动也不改变「已停用」的事实
    }
  }

  /** 认领一个端口；交回去的取消函数由隧道 teardown 调用。 */
  #claim(router: RemoteRouter, port: number, owner: (event: TcpipEvent) => void): RemoteClaim {
    let current = port;
    router.owners.set(current, owner);
    return {
      move: (next) => {
        if (next === current) return;
        if (router.owners.get(current) === owner) router.owners.delete(current);
        current = next;
        router.owners.set(current, owner);
      },
      revoke: () => {
        if (router.owners.get(current) === owner) router.owners.delete(current);
      },
    };
  }

  #reclaim(sessionId: string): void {
    // 先停隧道再把路由摘掉：端口一交回就没人认领，摘掉之后旧连接上不再留任何回调
    void this.stopSession(sessionId).finally(() => this.#dropRouter(sessionId));
  }
}

const bindFailure = (port: number, error: Error): TunnelError => {
  const code = (error as { code?: unknown }).code;
  if (code === "EADDRINUSE") {
    return new TunnelError("bind-failed", "uniterminal: 本地端口 " + port + " 已被占用，请换一个端口（EADDRINUSE）");
  }
  const reason = typeof code === "string" ? code : messageOf(error);
  return new TunnelError("bind-failed", "uniterminal: 本地端口 " + port + " 监听失败（" + reason + "），请换一个端口");
};
