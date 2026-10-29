import type { Duplex } from "node:stream";
import type { AuthKind } from "../auth-kinds.js";
import type { SftpLike } from "./sftp.js";
import type { TcpipEvent, TcpipUnsubscribe } from "./tunnel.js";

export type ProtocolKind = "ssh" | "local" | "telnet" | "serial";

export interface Capabilities {
  exec: boolean;
  sftp: boolean;
  tunnel: boolean;
  resize: boolean;
}

/**
 * 认证方式；'agent' 留待后续批次。
 *
 * M15：新增 "both" —— 界面允许"两种都试"，但此前存档层只能存单一方式，
 * 于是勾了两个再进来只剩私钥（用户实报）。把 "both" 落进存档，勾选状态才可持久化。
 */
export type ProfileAuthKind = AuthKind;

/** profiles.json 里的认证块：只有方式与路径，私钥内容永不落盘。 */
export interface ProfileAuth {
  kind: ProfileAuthKind;
  /** 路径方式：只存路径字符串，连接时按需 readFile，插件目录不留副本。 */
  identityPath?: string;
}

export interface ResolvedProfile {
  id: string;
  kind: ProtocolKind;
  host?: string;
  port?: number;
  user?: string;
  /** M0 临时字段：明文密码经 loopback 路由传入，M2 由 credentialRef + 保险库取代。禁止写入日志/审计。 */
  password?: string;
  credentialRef?: string;
  shell?: string;
  cwd?: string;
  keepaliveMs?: number;
  connectTimeoutMs?: number;
  /** M2b 私钥内容（PEM/OpenSSH），仅内存：来自 identityPath 读取或凭据库 key:<id>。禁止写入日志/审计。 */
  privateKey?: string;
  /** 私钥口令，仅内存。 */
  passphrase?: string;
  /**
   * M3-3 跳板链：按顺序经这些跳板机连到本主机，每项形如 user@host:port（user 与 port 可省略）。
   * 传输层逐跳串接 forwardOut 通道；**每一跳都用本档案的同一套认证材料**，
   * 逐跳不同凭据（各自的 user/私钥/口令）留待后续批次。
   */
  proxyChain?: string[];
}

/** M5-1 exec 选项：到点就收掉通道并返回 code=null，绝不无限挂着一条命令。 */
export interface ExecOptions {
  timeoutMs?: number;
}

/**
 * 一次 exec 的结果。code 为 null 表示没拿到退出码（超时、通道断开，或交互式 shell 模式）。
 * truncated / timedOut 是**标记**而不是错误：部分输出仍然有价值，调用方自己决定怎么用。
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** 某一路输出（stdout 或 stderr）超过 256 KiB，只保留前 256 KiB。 */
  truncated: boolean;
  /** 超时被强制收掉：此时 code 必为 null。 */
  timedOut: boolean;
}

/** exec 通道类失败：路由层按 reason 映射状态码（未知会话 404 / 不支持 400 / 其余 500）。 */
export class ExecChannelError extends Error {
  readonly reason: "unknown-session" | "unsupported" | "failed";

  constructor(reason: "unknown-session" | "unsupported" | "failed", message: string) {
    super(message);
    this.name = "ExecChannelError";
    this.reason = reason;
  }
}

export interface SessionHandle {
  readonly id: string;
  readonly kind: ProtocolKind;
  readonly capabilities: Capabilities;
  write(chunk: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onClose(cb: (reason: string) => void): () => void;
  close(): Promise<void>;
  /**
   * M3-1 传输层通道能力：复用同一条连接打开 SFTP 子系统（ssh2 的 client.sftp()）。
   * 不支持该协议的适配器不实现这个方法——路由层据此给出 400，而不是赔一条新连接。
   */
  openSftp?(): Promise<SftpLike>;
  /**
   * M3-2 转发能力：三个方法要么都实现（ssh2），要么都不实现（其它协议）。
   * 与 SFTP 同理——复用**同一条**连接，绝不为了转发再开一条（口令/私钥只解一次）。
   */
  forwardOut?(srcHost: string, srcPort: number, dstHost: string, dstPort: number): Promise<Duplex>;
  forwardIn?(host: string, port: number): Promise<number>;
  /** M3-11：注册必须可撤销——返回的取消函数调用后，回调再也收不到事件。 */
  onTcpipEvent?(listener: (event: TcpipEvent) => void): TcpipUnsubscribe;
  /**
   * M5-1 exec 通道：在同一条连接上跑一条命令，与用户的交互式 shell 互不干扰。
   * 不支持该协议的适配器不实现它——路由层据此给出 400，而不是拿用户的终端顶替。
   */
  exec?(command: string, options?: ExecOptions): Promise<ExecResult>;
}

export interface TransportAdapter {
  readonly kind: ProtocolKind;
  readonly capabilities: Capabilities;
  open(profile: ResolvedProfile, signal: AbortSignal): Promise<SessionHandle>;
}
