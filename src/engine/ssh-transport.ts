import type { Duplex } from "node:stream";
import type { TcpipEvent } from "./tunnel.js";
import { DEFAULT_CONNECT_TIMEOUT_MS } from "../connect-limits.js";
import { decideHostKey, type KnownHosts, type UnknownHostKeyPolicy } from "../store/known-hosts.js";
import { sftpFromSsh2, type SftpLike, type Ssh2SftpLike } from "./sftp.js";
import type {
  Capabilities,
  ExecResult,
  ResolvedProfile,
  SessionHandle,
  TransportAdapter,
} from "./types.js";

export interface SshStreamLike {
  write(data: Uint8Array): boolean;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "close", cb: () => void): void;
  close(): void;
}

/**
 * ssh2 client.exec() 拿到的通道：stdout 走 'data'，stderr 走 stream.stderr 的 'data'，
 * 退出码在 'close' 的第一个参数上（拿不到时为 null）。
 */
export interface SshExecStreamLike {
  stderr?: SshExecStreamLike;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "close", cb: (code: number | null, signal?: string) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  close?(): void;
}

/** ssh2 'tcp connection' 事件的载荷：远端有人在被转发的端口上连进来了。 */
export interface SshTcpipData {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

export interface SshClientLike {
  on(event: "ready", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "close", cb: () => void): void;
  /** ssh2 的 'tcp connection'（注意是带空格的写法）：accept() 同步返回通道。 */
  on(event: "tcp connection", cb: (data: SshTcpipData, accept: () => Duplex, reject: () => void) => void): void;
  connect(config: Record<string, unknown>): void;
  shell(
    options: { term: string; cols: number; rows: number },
    cb: (error: Error | undefined, stream: SshStreamLike) => void,
  ): void;
  end(): void;
  destroy(): void;
  /**
   * ssh2 把 TCP_NODELAY 原样转给底层 socket（lib/client.js:1635），自己**不会**调用。
   * 不开的话 Nagle 会把连续小包（逐字符输入、shell 模式的多次写）攒到 ACK 才发，
   * 表现为 ~40ms 一批的顿挫——实测 shell 模式稳定 42ms 正是这个量级。
   */
  setNoDelay?(noDelay: boolean): void;
  /** ssh2 的 client.sftp()：在**同一条**连接上开 SFTP 子系统，不二次认证。 */
  sftp?(callback: (error: Error | undefined, sftp: Ssh2SftpLike) => void): void;
  /** -L / -D：在同一条连接上开一条 direct-tcpip 通道；未连接时 ssh2 会**同步抛**。 */
  forwardOut?(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, channel: Duplex) => void,
  ): void;
  /** -R：请求服务端监听 host:port，回调里拿到实际绑定的端口。 */
  forwardIn?(host: string, port: number, callback: (error: Error | undefined, boundPort: number) => void): void;
  /** M5-1：在同一连接的**独立通道**上跑一条命令，不碰用户的交互式 shell。 */
  exec?(command: string, callback: (error: Error | undefined, stream: SshExecStreamLike) => void): void;
}

export type SshClientFactory = (profile: ResolvedProfile) => SshClientLike;

export interface SshTransportDefaults {
  term?: string;
  connectTimeoutMs?: number;
  /** 注入指纹库后启用 hostVerifier；未注入时沿用 M0 行为（不校验）。 */
  knownHosts?: KnownHosts;
  onUnknownHostKey?: UnknownHostKeyPolicy;
}

const SSH_CAPABILITIES: Capabilities = { exec: true, sftp: true, tunnel: true, resize: true };

const DEFAULT_SSH_PORT = 22;

/** 一跳跳板：user 与 port 可省略（省 user 用档案里的，省 port 用 22）。 */
interface ProxyHop {
  host: string;
  port: number;
  user?: string;
}

/** 错误文案里的跳点定位：`proxy hop 2 (jump2:2222)`。 */
const hopLabel = (index: number, hop: ProxyHop): string =>
  "proxy hop " + (index + 1) + " (" + hop.host + ":" + hop.port + ")";

/**
 * 解析一跳（`user@host:port`）。非法描述立刻报错——写错的跳板链必须看得见，
 * 绝不能悄悄退化成直连（那会把「我以为经跳板」变成「其实直连目标」的安全事故）。
 */
function parseProxyHop(spec: string, index: number): ProxyHop {
  const invalid = (): Error =>
    new Error("uniterminal: invalid proxy jump '" + spec + "' in proxyChain[" + index + "]");
  const trimmed = spec.trim();
  if (trimmed === "") throw invalid();
  const at = trimmed.lastIndexOf("@");
  const user = at > 0 ? trimmed.slice(0, at).trim() : undefined;
  if (user === "") throw invalid();
  const authority = at < 0 ? trimmed : trimmed.slice(at + 1);
  let host = authority;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    // [2001:db8::1]:22：IPv6 字面量必须带方括号，否则冒号分不清是分隔符还是地址
    const closing = authority.indexOf("]");
    if (closing < 0) throw invalid();
    host = authority.slice(1, closing);
    const rest = authority.slice(closing + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) throw invalid();
      portText = rest.slice(1);
    }
  } else {
    const first = authority.indexOf(":");
    // 多个冒号且不带方括号：当作裸 IPv6 地址，没有端口
    if (first >= 0 && first === authority.lastIndexOf(":")) {
      host = authority.slice(0, first);
      portText = authority.slice(first + 1);
    }
  }
  if (host === "") throw invalid();
  const hop: ProxyHop = { host, port: DEFAULT_SSH_PORT };
  if (user !== undefined) hop.user = user;
  if (portText === undefined) return hop;
  if (!/^\d+$/.test(portText)) throw invalid();
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) throw invalid();
  hop.port = port;
  return hop;
}

export function createSshTransport(
  factory: SshClientFactory,
  defaults: SshTransportDefaults = {},
): TransportAdapter {
  const term = defaults.term ?? "xterm-256color";

  /** 这台主机的 known_hosts 校验器：跳板逐跳共用同一个指纹库（跳板自己也可能是首次见到的机器）。 */
  const hostKeyVerifierFor = (profile: ResolvedProfile): ((fingerprint: string) => boolean) | undefined => {
    if (defaults.knownHosts === undefined) return undefined;
    return decideHostKey(
      { knownHosts: defaults.knownHosts, onUnknownHostKey: defaults.onUnknownHostKey ?? "reject" },
      profile.host ?? "",
      profile.port ?? DEFAULT_SSH_PORT,
    );
  };

  const connectConfigFor = (profile: ResolvedProfile, sock: Duplex | undefined): Record<string, unknown> => {
    const config: Record<string, unknown> = {
      host: profile.host,
      port: profile.port ?? DEFAULT_SSH_PORT,
      username: profile.user,
      // M0：明文密码仅在内存中传递；M2 改为从保险库解析 credentialRef。
      password: profile.password,
      keepaliveInterval: profile.keepaliveMs,
      readyTimeout: profile.connectTimeoutMs ?? defaults.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      hostHash: "sha256",
    };
    // M2b：私钥只在连接这一刻进内存；有才传，不用 undefined 冒充空私钥
    if (profile.privateKey !== undefined) config.privateKey = profile.privateKey;
    if (profile.passphrase !== undefined) config.passphrase = profile.passphrase;
    // M3-3：上一跳 forwardOut 出来的通道就是下一跳的 sock，绝不再开一条 TCP
    if (sock !== undefined) config.sock = sock;
    return config;
  };

  /** 建立一条连接并等到 'ready'；wrap 负责把失败定位到具体跳点。 */
  const connectOnce = (
    client: SshClientLike,
    profile: ResolvedProfile,
    sock: Duplex | undefined,
    signal: AbortSignal,
    wrap?: (reason: Error) => Error,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => fail(new Error("uniterminal: connection aborted"));
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        try {
          client.destroy();
        } catch {
          // 连接已经没了：destroy 再抛一次没有任何新信息
        }
        const reason = asError(error);
        reject(wrap === undefined ? reason : wrap(reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      client.on("error", fail);
      client.on("ready", () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        // 交互式 SSH 必须关掉 Nagle：逐字符输入与连续小写都会被它攒成 ~40ms 一批
        try {
          client.setNoDelay?.(true);
        } catch {
          // 拿不到底层 socket 时不影响连接本身
        }
        resolve();
      });

      const config = connectConfigFor(profile, sock);
      const checkHostKey = hostKeyVerifierFor(profile);
      if (checkHostKey !== undefined) {
        config.hostVerifier = (hashedKey: string, callback: (accept: boolean) => void): void => {
          try {
            callback(checkHostKey(hashedKey));
          } catch (error) {
            // 先用自己的错误定住 open()，再拒绝握手，避免被 ssh2 的通用错误覆盖
            fail(error);
            try {
              callback(false);
            } catch {
              // destroy 之后 ssh2 不再接受回调
            }
          }
        };
      }
      client.connect(config);
    });

  /**
   * 在这条连接上开一条 direct-tcpip 通道（ssh2 未连接时会**同步抛**）。
   * 失败一律带跳点定位：`proxy hop N (host:port) failed: <原因>`。
   */
  const openForward = async (
    client: SshClientLike,
    destHost: string,
    destPort: number,
    label: string,
    context?: string,
  ): Promise<Duplex> => {
    const forwardOut = client.forwardOut;
    try {
      if (typeof forwardOut !== "function") throw new Error("direct-tcpip forwarding is unavailable");
      return await new Promise<Duplex>((resolve, reject) => {
        try {
          forwardOut.call(client, "127.0.0.1", 0, destHost, destPort, (error, channel) => {
            if (error !== undefined) reject(error);
            else resolve(channel);
          });
        } catch (error) {
          reject(asError(error));
        }
      });
    } catch (error) {
      const detail = context === undefined ? "" : context + ": ";
      throw new Error(label + " failed: " + detail + asError(error).message);
    }
  };

  /** 拿到 shell 后组装 SessionHandle；close 由调用方的 closeAll 负责收掉整条链。 */
  const startShell = (
    client: SshClientLike,
    profile: ResolvedProfile,
    closeAll: () => void,
  ): Promise<SessionHandle> =>
    new Promise<SessionHandle>((resolve, reject) => {
      client.shell({ term, cols: 80, rows: 24 }, (error, stream) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        const dataListeners = new Set<(chunk: Uint8Array) => void>();
        const closeListeners = new Set<(reason: string) => void>();
        stream.on("data", (chunk) => {
          const bytes = new Uint8Array(chunk);
          for (const listener of dataListeners) listener(bytes);
        });
        stream.on("close", () => {
          for (const listener of closeListeners) listener("stream closed");
        });
        const sftp = createSftpChannel(client);
        resolve({
          id: profile.id,
          kind: "ssh",
          capabilities: SSH_CAPABILITIES,
          write: (chunk) => void stream.write(chunk),
          resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
          onData: (cb) => {
            dataListeners.add(cb);
            return () => void dataListeners.delete(cb);
          },
          onClose: (cb) => {
            closeListeners.add(cb);
            return () => void closeListeners.delete(cb);
          },
          close: async () => {
            // 顺序不能反：先收掉 SFTP 通道，再关连接
            sftp.close();
            stream.close();
            // 跳板链上每条连接都要收：只关最后一跳会让中间跳的连接一直挂着
            closeAll();
          },
          // M3-5：同一条连接上只留一个 SFTP 通道；路由层照旧每个请求调一次，这里已是廉价操作
          openSftp: () => sftp.open(),
          // M3-2：转发通道同一条连接（三个方法要么都在、要么都不在）
          ...forwardingOf(client),
          // M5-1：exec 走同一条连接上的独立通道，输出上限与超时由 execOf 兜
          ...execOf(client),
        });
      });
    });

  /**
   * M3-3 跳板链：直连第一跳 → 用它的 forwardOut 通道当第二跳的 sock → 依此类推，
   * 最后一跳的 forwardOut 通道则作为目标连接的 sock。
   * **限制**：每一跳都带与目标相同的认证材料（同一口令/私钥）——逐跳不同凭据留待后续。
   */
  const openOverChain = async (profile: ResolvedProfile, signal: AbortSignal): Promise<SessionHandle> => {
    // 先解析整条链：描述写错就立刻失败，绝不带着半条链去连
    const hops = (profile.proxyChain ?? []).map((spec, index) => parseProxyHop(spec, index));
    const targetHost = profile.host ?? "";
    const targetPort = profile.port ?? DEFAULT_SSH_PORT;
    /** 链上所有连接（跳板 + 目标）：任何一步失败与 close() 都要逐个收掉。 */
    const clients: SshClientLike[] = [];
    const closeAll = (how: "end" | "destroy"): void => {
      // 反向收口：先断下游，再逐跳收上游
      for (const created of [...clients].reverse()) {
        try {
          created[how]();
        } catch {
          // 已经关了：再收一次没有意义，close 必须幂等
        }
      }
    };

    try {
      let upstream: SshClientLike | undefined;
      for (let index = 0; index < hops.length; index += 1) {
        const hop = hops[index]!;
        const label = hopLabel(index, hop);
        // 上一跳的通道就是这一跳的 sock；第一跳没有上游，直连
        const sock = upstream === undefined ? undefined : await openForward(upstream, hop.host, hop.port, label);
        const hopProfile: ResolvedProfile = {
          ...profile,
          host: hop.host,
          port: hop.port,
          user: hop.user ?? profile.user,
          // 跳板自己的档案里不能再有链：factory 拿到的档案必须自洽
          proxyChain: undefined,
        };
        const hopClient = factory(hopProfile);
        clients.push(hopClient);
        await connectOnce(hopClient, hopProfile, sock, signal, (reason) => new Error(label + " failed: " + reason.message));
        upstream = hopClient;
      }
      const lastHop = hops[hops.length - 1];
      const targetSock =
        upstream === undefined || lastHop === undefined
          ? undefined
          : await openForward(
              upstream,
              targetHost,
              targetPort,
              hopLabel(hops.length - 1, lastHop),
              "forward to " + targetHost + ":" + targetPort,
            );
      const client = factory(profile);
      clients.push(client);
      await connectOnce(client, profile, targetSock, signal);
      return await startShell(client, profile, () => closeAll("end"));
    } catch (error) {
      // 半条链比没有链更糟：失败必须把已建的每一跳都收掉
      closeAll("destroy");
      throw error;
    }
  };

  return {
    kind: "ssh",
    capabilities: SSH_CAPABILITIES,
    open(profile, signal) {
      return openOverChain(profile, signal);
    },
  };
}

/** ssh2 的 SFTPWrapper 还带 end()：sftp.ts 的契约只声明能力，收通道的口在这里补。 */
type ClosableSftp = Ssh2SftpLike & { end?(): void };

/**
 * 通道类失败：ssh2 在通道被服务端或网络收掉之后给这些文案。
 * 换一条通道重试有意义；路径不存在、权限不足这类业务失败不在此列，绝不拿重试去掩盖。
 */
const CHANNEL_FAILED = /channel|not connected|no response|econnreset|epipe|eof/i;

export interface SftpChannel {
  /** 取这条连接上的 SFTP 通道：懒开、复用同一条；并发调用共享同一个 Promise。 */
  open(): Promise<SftpLike>;
  /** 收掉通道：handle.close() 必须在 client.end() 之前调用它。 */
  close(): void;
}

/**
 * 一条 SSH 连接上的 SFTP 通道（M3-5）：懒开、复用、可重建。
 * 缺陷现场：早先每次文件操作都 client.sftp() 一遍且从不 end，终端自己还占一个通道，
 * 攒到 sshd 的 MaxSessions（默认 10）就再也开不出通道——列表先能用，随后报
 * "Channel open failure: open failed" 并变空。这里缓存的是「开通道」这个 Promise 本身，
 * 因此并发的第二次调用会搭上同一趟，通道数恒为 1。
 */
export function createSftpChannel(client: SshClientLike): SftpChannel {
  /** 缓存的 Promise：首次调用才创建；开失败即清掉，让下一次调用重新尝试而不是永久失败。 */
  let opening: Promise<SftpLike> | undefined;
  /** 当前可用的通道，以及它背后的 ssh2 wrapper（close 要按 wrapper 收口）。 */
  let active: SftpLike | undefined;
  let wrapper: ClosableSftp | undefined;

  const openOnce = (): Promise<SftpLike> =>
    new Promise<SftpLike>((resolve, reject) => {
      const openSftp = client.sftp;
      if (openSftp === undefined) {
        reject(new Error("uniterminal: sftp subsystem unavailable"));
        return;
      }
      openSftp.call(client, (error, opened) => {
        if (error !== undefined) {
          // ssh2 原文透传：路由层按 500 上报，不吞成通用失败
          reject(error);
          return;
        }
        const channel = sftpFromSsh2(opened);
        wrapper = opened;
        active = channel;
        resolve(channel);
      });
    });

  /** 只丢掉刚失败的那一条：并发里别的调用可能已经建好了新的。 */
  const drop = (channel: SftpLike): void => {
    if (active !== channel) return;
    active = undefined;
    wrapper = undefined;
    opening = undefined;
  };

  const take = (): Promise<SftpLike> => {
    const cached = opening;
    if (cached !== undefined) return cached;
    const started = openOnce();
    opening = started;
    // 失败不写进缓存：下一次调用重新尝试（否则一次抖动就永久坏掉）
    started.then(undefined, () => {
      if (opening === started) opening = undefined;
    });
    return started;
  };

  /** 通道类失败换一条重建一次；第二次仍失败就把 ssh2 原文抛给调用方。 */
  const run = async <T>(action: (channel: SftpLike) => Promise<T>): Promise<T> => {
    const channel = await take();
    try {
      return await action(channel);
    } catch (error) {
      if (!CHANNEL_FAILED.test(error instanceof Error ? error.message : String(error))) throw error;
      drop(channel);
      return await action(await take());
    }
  };

  /** 流是同步返回的，没法重试：只交给当前通道（open() 成功即保证它存在）。 */
  const streaming = (): SftpLike => {
    if (active === undefined) throw new Error("uniterminal: sftp channel is not open");
    return active;
  };

  /** 恒定返回同一个 wrapper：通道重建对调用方透明，路由层拿到的引用不会变。 */
  const facade: SftpLike = {
    list: (path) => run((channel) => channel.list(path)),
    stat: (path) => run((channel) => channel.stat(path)),
    mkdir: (path) => run((channel) => channel.mkdir(path)),
    unlink: (path) => run((channel) => channel.unlink(path)),
    rmdir: (path) => run((channel) => channel.rmdir(path)),
    rename: (from, to) => run((channel) => channel.rename(from, to)),
    renameOverwrite: (from, to) => run((channel) => channel.renameOverwrite(from, to)),
    chmod: (path, mode) => run((channel) => channel.chmod(path, mode)),
    createReadStream: (path) => streaming().createReadStream(path),
    createWriteStream: (path) => streaming().createWriteStream(path),
  };

  return {
    open: async () => {
      await take();
      return facade;
    },
    close: () => {
      const closing = wrapper;
      active = undefined;
      wrapper = undefined;
      opening = undefined;
      if (closing === undefined) return;
      try {
        closing.end?.();
      } catch {
        // 通道已经没了：再 end 一次没有意义，close 必须幂等
      }
    },
  };
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * exec 每路输出（stdout、stderr 各自）的上限：超出即截断并打标记，
 * 绝不让一条命令把内存吃光，也不会让 stderr 被 stdout 挤掉。
 */
const EXEC_OUTPUT_LIMIT = 256 * 1024;

/**
 * M5-1：把 ssh2 的 client.exec 变成句柄能力。
 * 客户端没有 exec 就整体不暴露（与 forwardOut 同一口径）——句柄上不会出现半条能力。
 * 超时是**收掉整条连接**（destroy）：挂着一条跑不完的命令比断开更糟，
 * SessionManager 的退避重连会随后把会话接回来。
 */
function execOf(client: SshClientLike): Partial<Pick<SessionHandle, "exec">> {
  const exec = client.exec;
  if (typeof exec !== "function") return {};
  return {
    exec: (command, options) =>
      new Promise<ExecResult>((resolve, reject) => {
        const timeoutMs = options?.timeoutMs;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let truncated = false;
        let timedOut = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stream: SshExecStreamLike | undefined;

        const stopTimer = (): void => {
          if (timer === undefined) return;
          clearTimeout(timer);
          timer = undefined;
        };

        const finish = (code: number | null, extraStderr = ""): void => {
          if (settled) return;
          settled = true;
          stopTimer();
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8") + extraStderr,
            code,
            truncated,
            timedOut,
          });
        };

        /** 每路各自计数：stdout 撑满上限不该把 stderr 一起挤没。 */
        const sink = (target: Buffer[]): ((chunk: Buffer) => void) => {
          let bytes = 0;
          return (chunk) => {
            const room = EXEC_OUTPUT_LIMIT - bytes;
            if (room <= 0) {
              truncated = true;
              return;
            }
            if (chunk.length > room) {
              target.push(chunk.subarray(0, room));
              bytes += room;
              truncated = true;
              return;
            }
            target.push(chunk);
            bytes += chunk.length;
          };
        };
        const appendStdout = sink(stdout);
        const appendStderr = sink(stderr);

        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          stopTimer();
          // ssh2 原文透传：路由层按 500 上报，不吞成通用失败
          reject(error);
        };

        try {
          exec.call(client, command, (error, opened) => {
            if (error !== undefined) {
              fail(error);
              return;
            }
            stream = opened;
            // 通道迟到了（超时先结算）：立刻收掉，绝不留一条悬空通道占着 MaxSessions
            if (settled) {
              try {
                opened.close?.();
              } catch {
                // 已经关了：再收一次没有意义
              }
              return;
            }
            opened.on("data", (chunk) => {
              appendStdout(chunk);
            });
            opened.stderr?.on("data", (chunk) => {
              appendStderr(chunk);
            });
            opened.on("close", (code) => {
              finish(code);
            });
            // 通道级错误不吞成 rejection：已经收到的输出仍然有价值
            opened.on("error", (failure) => {
              finish(null, (failure.message === "" ? "" : "\n" + failure.message));
            });
          });
        } catch (error) {
          fail(asError(error));
          return;
        }

        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              stream?.close?.();
            } catch {
              // 通道已经没了：继续收连接
            }
            try {
              client.destroy();
            } catch {
              // 连接已经没了：destroy 再抛一次没有任何新信息
            }
            finish(null);
          }, timeoutMs);
        }
      }),
  };
}

/** ssh2 'tcp connection' 的分发器：一条连接只挂一个监听，订阅者随注册/撤销增减。 */
type TcpipOpen = (data: SshTcpipData, accept: () => Duplex, reject: () => void) => void;

/**
 * ssh2 的三件套 → SessionHandle 的可选转发方法。
 * ssh2 在未连接时**同步抛**（forwardOut/forwardIn 都直接 throw 'Not connected'），
 * 因此这里必须 try/catch：上层拿到的永远是一个 Promise，不会变成未捕获异常。
 */
function forwardingOf(
  client: SshClientLike,
): Partial<Pick<SessionHandle, "forwardOut" | "forwardIn" | "onTcpipEvent">> {
  const { forwardOut, forwardIn } = client;
  if (typeof forwardOut !== "function" || typeof forwardIn !== "function") return {};
  /** 当前订阅者：撤销就从这里摘掉，旧回调之后再收不到事件。 */
  const subscribers = new Set<(event: TcpipEvent) => void>();
  let attached = false;
  const openTcpip: TcpipOpen = (data, accept, rejectRequest) => {
    if (subscribers.size === 0) {
      // 没人认领就拒：ssh2 没有取消转发的办法，端口还挂在服务端，
      // 不答等于让远端一直挂着——拒绝才是「停止之后」该有的观感。
      rejectRequest();
      return;
    }
    const event: TcpipEvent = {
      destIP: data.destIP,
      destPort: data.destPort,
      srcIP: data.srcIP,
      srcPort: data.srcPort,
      // ssh2 的 accept 是同步返回通道的：包成 Promise 是为了给上层统一异步口径
      accept: async () => accept(),
      reject: () => rejectRequest(),
    };
    // 快照派发：订阅者在派发过程中撤销不该改变这一次的投递集合
    for (const subscriber of [...subscribers]) subscriber(event);
  };
  return {
    forwardOut: (srcHost, srcPort, dstHost, dstPort) =>
      new Promise<Duplex>((resolve, reject) => {
        try {
          forwardOut.call(client, srcHost, srcPort, dstHost, dstPort, (error, channel) => {
            // ssh2 原文透传：上层据此判断是通道开不了还是目标拒绝
            if (error !== undefined) reject(error);
            else resolve(channel);
          });
        } catch (error) {
          reject(asError(error));
        }
      }),
    forwardIn: (host, port) =>
      new Promise<number>((resolve, reject) => {
        try {
          forwardIn.call(client, host, port, (error, boundPort) => {
            if (error !== undefined) reject(error);
            else resolve(boundPort);
          });
        } catch (error) {
          reject(asError(error));
        }
      }),
    onTcpipEvent: (listener) => {
      subscribers.add(listener);
      if (!attached) {
        attached = true;
        // 一条连接只挂一个 ssh2 监听：从前每次注册都 client.on，监听随启动次数累积
        client.on("tcp connection", openTcpip);
      }
      let live = true;
      // 撤销 = 从订阅者集合里摘掉：这个回调之后再收不到任何事件（M3-11）
      return () => {
        if (!live) return;
        live = false;
        subscribers.delete(listener);
      };
    },
  };
}

export async function loadSshClientFactory(): Promise<SshClientFactory> {
  // 懒加载：ssh2 是可选依赖，加载失败只禁用该协议
  const { Client } = await import("ssh2");
  return () => new Client() as unknown as SshClientLike;
}
