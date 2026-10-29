import { RingBuffer } from "./ring-buffer.js";
import type { TransportRegistry } from "./registry.js";
import { SftpChannelError, type SftpLike } from "./sftp.js";
import { TunnelError, type TunnelCapability } from "./tunnel.js";
import { ExecChannelError } from "./types.js";
import type { Capabilities, ExecOptions, ExecResult, ProtocolKind, ResolvedProfile, SessionHandle } from "./types.js";

export interface SessionInfo {
  id: string;
  kind: ProtocolKind;
  capabilities: Capabilities;
  createdAt: number;
  status: "open" | "closed";
  /**
   * M4-1 接回所需的非敏感元数据：建会话时从 profile 抄一份地址。
   * 只抄 host / user / port——口令、私钥、口令短语一个字节都不许进这里（列表会原样序列化出去）。
   */
  host?: string;
  user?: string;
  port?: number;
}

/** 非主动断线的退避表；表长即重连次数上限。 */
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** 重连成功后推给订阅者的一行提示：客户端 WS 路径不变，但用户需要知道链路已重建。 */
const RECONNECT_NOTICE = "\n[uniterminal] reconnected\n";

interface SessionEntry {
  info: SessionInfo;
  profile: ResolvedProfile;
  buffer: RingBuffer;
  handle: SessionHandle;
  listeners: Set<(chunk: Uint8Array) => void>;
  detachers: (() => void)[];
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 缓存的转发能力：同一条连接只给一个对象，重连换连接就跟着换。 */
  tunnels: { handle: SessionHandle; capability: TunnelCapability } | undefined;
  /** 用户已主动关闭或已放弃：此后的 onClose 一律不得再触发重连。 */
  closing: boolean;
}

export interface SessionManagerOptions {
  bufferBytes?: number;
  now?: () => number;
  /** 缺省 [1000,2000,4000,8000,16000]；传空数组即关闭自动重连。 */
  autoReconnect?: { delaysMs: number[] };
}

export class SessionManager {
  readonly #registry: TransportRegistry;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #bufferBytes: number;
  readonly #now: () => number;
  readonly #reconnectDelaysMs: number[];
  readonly #openedListeners = new Set<(info: SessionInfo) => void>();
  readonly #closedListeners = new Set<(id: string) => void>();
  #sequence = 0;

  constructor(registry: TransportRegistry, options: SessionManagerOptions = {}) {
    this.#registry = registry;
    this.#bufferBytes = options.bufferBytes ?? 1 << 20;
    this.#now = options.now ?? Date.now;
    const delays = options.autoReconnect?.delaysMs;
    this.#reconnectDelaysMs = delays === undefined ? DEFAULT_RECONNECT_DELAYS_MS : [...delays];
  }

  /** 会话 open 成功后回调；返回取消订阅函数。 */
  onOpened(cb: (info: SessionInfo) => void): () => void {
    this.#openedListeners.add(cb);
    return () => void this.#openedListeners.delete(cb);
  }

  /** 会话关闭后回调（含重连用尽与用户主动 close）；返回取消订阅函数。 */
  onClosed(cb: (id: string) => void): () => void {
    this.#closedListeners.add(cb);
    return () => void this.#closedListeners.delete(cb);
  }

  async open(profile: ResolvedProfile): Promise<SessionInfo> {
    const adapter = this.#registry.require(profile.kind);
    const handle = await adapter.open(profile, new AbortController().signal);
    const id = "s" + String(++this.#sequence);
    const info: SessionInfo = {
      id,
      kind: profile.kind,
      capabilities: adapter.capabilities,
      createdAt: this.#now(),
      status: "open",
      // 白名单抄地址字段：profile 里还带着凭据（重连要用），但绝不可能被顺手搬进 info
      host: profile.host,
      user: profile.user,
      port: profile.port,
    };
    const entry: SessionEntry = {
      info,
      profile,
      buffer: new RingBuffer(this.#bufferBytes),
      handle,
      listeners: new Set(),
      detachers: [],
      reconnectAttempts: 0,
      reconnectTimer: undefined,
      tunnels: undefined,
      closing: false,
    };
    this.#attach(entry);
    this.#sessions.set(id, entry);
    this.#emit(this.#openedListeners, info);
    return info;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((entry) => entry.info);
  }

  write(id: string, chunk: Uint8Array): void {
    this.#entry(id).handle.write(chunk);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#entry(id).handle.resize(cols, rows);
  }

  read(id: string, cursor: number): { data: Uint8Array; cursor: number } {
    return this.#entry(id).buffer.since(cursor);
  }

  subscribe(id: string, listener: (chunk: Uint8Array) => void): () => void {
    const entry = this.#entry(id);
    entry.listeners.add(listener);
    return () => void entry.listeners.delete(listener);
  }

  /**
   * M3-1 能力入口：在**已有**会话上打开 SFTP 通道，复用同一条 SSH 连接。
   * 刻意不返回 SessionHandle——写/关/订阅这类控制面不该交给调用方；
   * 三类失败用 SftpChannelError.reason 区分，路由层据此给出 404 / 400 / 500。
   */
  async openSftp(id: string): Promise<SftpLike> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) {
      throw new SftpChannelError("unknown-session", "uniterminal: unknown session '" + id + "'");
    }
    const openSftp = entry.handle.openSftp;
    if (openSftp === undefined) {
      throw new SftpChannelError("unsupported", "uniterminal: session '" + id + "' does not support sftp (ssh only)");
    }
    try {
      return await openSftp.call(entry.handle);
    } catch (error) {
      throw new SftpChannelError("open-failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * M3-2 能力入口：取**已有**会话的端口转发能力（forwardOut / forwardIn / onTcpipEvent）。
   * 同样不返回 SessionHandle：写/关/订阅这类控制面不该交给调用方。
   * 会话当场不支持就立刻抛出（而不是等到第一条连接才失败），路由层据此给出 404 / 400。
   * 与 openSftp 同一条口径：能力握在取用那一刻的句柄上。重连会换掉底层连接，通道随之失效，
   * 因此隧道不跨重连存活——会话彻底关闭时由 TunnelManager 的回收兜底，绝不留悬空的端口。
   */
  async openTunnels(id: string): Promise<TunnelCapability> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) {
      throw new TunnelError("unknown-session", "uniterminal: unknown session '" + id + "'");
    }
    const handle = entry.handle;
    // 同一条连接只交出**一个**能力对象：隧道表按对象身份认「连接换没换」，
    // 每次都给新对象会让会话级 tcpip 监听随启动次数累积（M3-11 的真机残留）。
    const cached = entry.tunnels;
    if (cached !== undefined && cached.handle === handle) return cached.capability;
    const { forwardOut, forwardIn, onTcpipEvent } = handle;
    if (forwardOut === undefined || forwardIn === undefined || onTcpipEvent === undefined) {
      throw new TunnelError(
        "unsupported",
        "uniterminal: session '" + id + "' does not support port forwarding (ssh only)",
      );
    }
    const capability: TunnelCapability = {
      forwardOut: (srcHost, srcPort, dstHost, dstPort) => forwardOut.call(handle, srcHost, srcPort, dstHost, dstPort),
      forwardIn: (host, port) => forwardIn.call(handle, host, port),
      onTcpipEvent: (listener) => onTcpipEvent.call(handle, listener),
    };
    entry.tunnels = { handle, capability };
    return capability;
  }

  /**
   * M5-1 能力入口：在**已有**会话上跑一条命令（ssh2 的独立通道，不碰用户的交互式 shell）。
   * 与 openSftp 同一口径——刻意不返回 SessionHandle；失败用 ExecChannelError.reason 区分，
   * 路由层据此给出 404 / 400 / 500，而不是拿一条含糊的 500 盖住「会话不存在」。
   */
  async exec(id: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) {
      throw new ExecChannelError("unknown-session", "uniterminal: unknown session '" + id + "'");
    }
    const exec = entry.handle.exec;
    if (exec === undefined) {
      throw new ExecChannelError("unsupported", "uniterminal: session '" + id + "' does not support exec (ssh only)");
    }
    try {
      return await exec.call(entry.handle, command, options);
    } catch (error) {
      throw new ExecChannelError("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async close(id: string): Promise<void> {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return;
    entry.closing = true;
    this.#clearReconnectTimer(entry);
    this.#detachAll(entry);
    this.#sessions.delete(id);
    try {
      await entry.handle.close();
    } finally {
      entry.info.status = "closed";
      this.#emit(this.#closedListeners, id);
    }
  }

  #attach(entry: SessionEntry): void {
    entry.detachers.push(
      entry.handle.onData((chunk) => {
        this.#deliver(entry, chunk);
      }),
    );
    entry.detachers.push(
      entry.handle.onClose(() => {
        if (entry.closing) return;
        this.#scheduleReconnect(entry);
      }),
    );
  }

  #deliver(entry: SessionEntry, chunk: Uint8Array): void {
    entry.buffer.push(chunk);
    for (const listener of entry.listeners) listener(chunk);
  }

  #scheduleReconnect(entry: SessionEntry): void {
    const delayMs = this.#reconnectDelaysMs[entry.reconnectAttempts];
    if (delayMs === undefined) {
      this.#abandon(entry);
      return;
    }
    entry.reconnectAttempts += 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      void this.#reconnect(entry);
    }, delayMs);
  }

  async #reconnect(entry: SessionEntry): Promise<void> {
    if (entry.closing) return;
    this.#detachAll(entry);
    let handle: SessionHandle;
    try {
      handle = await this.#registry.require(entry.profile.kind).open(entry.profile, new AbortController().signal);
    } catch {
      if (entry.closing) return;
      this.#scheduleReconnect(entry);
      return;
    }
    if (entry.closing) {
      await handle.close().catch(() => {});
      return;
    }
    entry.handle = handle;
    this.#attach(entry);
    this.#deliver(entry, new TextEncoder().encode(RECONNECT_NOTICE));
  }

  /** 退避用尽：会话就此结束，与主动关闭走同一条收尾路径。 */
  #abandon(entry: SessionEntry): void {
    const id = entry.info.id;
    entry.closing = true;
    this.#clearReconnectTimer(entry);
    this.#detachAll(entry);
    this.#sessions.delete(id);
    entry.info.status = "closed";
    this.#emit(this.#closedListeners, id);
  }

  #clearReconnectTimer(entry: SessionEntry): void {
    if (entry.reconnectTimer === undefined) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
  }

  #detachAll(entry: SessionEntry): void {
    for (const detach of entry.detachers.splice(0)) {
      try {
        detach();
      } catch {
        // 句柄已消失。
      }
    }
  }

  #emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        // 钩子不得打断会话。
      }
    }
  }

  #entry(id: string): SessionEntry {
    const entry = this.#sessions.get(id);
    if (entry === undefined) throw new Error("uniterminal: unknown session '" + id + "'");
    return entry;
  }
}
