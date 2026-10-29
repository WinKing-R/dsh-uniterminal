/**
 * SFTP 通道（M3-1）：复用已建立的 SSH 连接（ssh2 的 client.sftp()），不为文件传输再开一条连接。
 * 本文件只放通道契约、请求校验与 ssh2 适配；路由层与 UI 都不接触 ssh2 类型。
 */

/** 目录项类型：符号链接原样保留，跟随与否是调用方的选择。 */
export type SftpEntryType = "file" | "dir" | "symlink" | "other";

export interface SftpEntry {
  name: string;
  /** 绝对路径（目录 + 名字），永不出现 "//"。 */
  path: string;
  type: SftpEntryType;
  size: number;
  mtime: number;
  mode: number;
}

export interface SftpStat {
  type: SftpEntryType;
  size: number;
  mtime: number;
  mode: number;
}

/** 一个 SSH 会话上的 SFTP 通道；只提供能力，不暴露会话的控制面。 */
export interface SftpLike {
  list(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpStat>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** 覆盖式提交（M3-9）：目标已存在时也必须成功，原子替换优先。 */
  renameOverwrite(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** 大文件只能走流：内容由调用方 pipe，本层绝不把文件读进内存。 */
  createReadStream(path: string): NodeJS.ReadableStream;
  createWriteStream(path: string): NodeJS.WritableStream;
}

/** 打开通道的三类失败：路由层据此分别给出 404 / 400 / 500。 */
export type SftpChannelFailure = "unknown-session" | "unsupported" | "open-failed";

export class SftpChannelError extends Error {
  readonly reason: SftpChannelFailure;

  constructor(reason: SftpChannelFailure, message: string) {
    super(message);
    this.name = "SftpChannelError";
    this.reason = reason;
  }
}

/** 请求本身的错误（未知 op、路径不是绝对路径、mode 非法）：路由层映射成 400。 */
export class SftpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SftpRequestError";
  }
}

/**
 * 路径口径：非空、以 "/" 开头的绝对路径。
 * 相对路径直接拒绝——按服务端 cwd 解析会随登录用户漂移，删错东西的代价太高。
 */
export function requireAbsolutePath(value: unknown, what = "path"): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new SftpRequestError("uniterminal: 参数 " + what + " 的路径必须是绝对路径（以 / 开头）");
  }
  return value;
}

export const SFTP_OPS = ["ls", "stat", "mkdir", "unlink", "rmdir", "rename", "chmod"] as const;

export type SftpOp = (typeof SFTP_OPS)[number];

export const isSftpOp = (value: string): value is SftpOp => (SFTP_OPS as readonly string[]).includes(value);

export type SftpOpResult = { entries: SftpEntry[] } | { stat: SftpStat } | { ok: true };

const requireMode = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o7777) {
    throw new SftpRequestError("uniterminal: 参数 mode 必须是 0..0o7777 之间的整数");
  }
  return value;
};

/** 单一入口的操作分发：七个 op 共用一个路由，避免为每个动作单开一条路径。 */
export async function runSftpOp(sftp: SftpLike, op: string, body: Record<string, unknown>): Promise<SftpOpResult> {
  switch (op) {
    case "ls":
      return { entries: await sftp.list(requireAbsolutePath(body.path)) };
    case "stat":
      return { stat: await sftp.stat(requireAbsolutePath(body.path)) };
    case "mkdir":
      await sftp.mkdir(requireAbsolutePath(body.path));
      return { ok: true };
    case "unlink":
      await sftp.unlink(requireAbsolutePath(body.path));
      return { ok: true };
    case "rmdir":
      await sftp.rmdir(requireAbsolutePath(body.path));
      return { ok: true };
    case "rename": {
      const from = requireAbsolutePath(body.path);
      await sftp.rename(from, requireAbsolutePath(body.to, "to"));
      return { ok: true };
    }
    case "chmod": {
      const mode = requireMode(body.mode);
      await sftp.chmod(requireAbsolutePath(body.path), mode);
      return { ok: true };
    }
    default:
      throw new SftpRequestError("uniterminal: unknown sftp op: " + op);
  }
}

/** ssh2 Stats 的最小形状：类型位既可能来自断言方法，也可能只有裸 mode。 */
export interface Ssh2AttrsLike {
  size: number;
  mtime: number;
  mode: number;
  isDirectory?(): boolean;
  isFile?(): boolean;
  isSymbolicLink?(): boolean;
}

export interface Ssh2DirEntryLike {
  filename: string;
  attrs: Ssh2AttrsLike;
}

/** ssh2 SFTPWrapper 的最小形状：只列本插件真的用到的成员。 */
export interface Ssh2SftpLike {
  readdir(location: string, callback: (error: Error | undefined, list: Ssh2DirEntryLike[]) => void): void;
  stat(path: string, callback: (error: Error | undefined, attrs: Ssh2AttrsLike) => void): void;
  mkdir(path: string, callback: (error?: Error | null) => void): void;
  unlink(path: string, callback: (error?: Error | null) => void): void;
  rmdir(path: string, callback: (error?: Error | null) => void): void;
  rename(from: string, to: string, callback: (error?: Error | null) => void): void;
  /** posix-rename@openssh.com：原子替换。老服务端/别的实现可能没有，因此是可选成员。 */
  ext_openssh_rename?(oldPath: string, newPath: string, callback: (error?: Error | null) => void): void;
  chmod(path: string, mode: number, callback: (error?: Error | null) => void): void;
  createReadStream(path: string): NodeJS.ReadableStream;
  createWriteStream(path: string): NodeJS.WritableStream;
}

const TYPE_MASK = 0o170000;

const typeOf = (attrs: Ssh2AttrsLike): SftpEntryType => {
  if (attrs.isDirectory?.() === true) return "dir";
  if (attrs.isFile?.() === true) return "file";
  if (attrs.isSymbolicLink?.() === true) return "symlink";
  // 老服务端/假实现可能只给裸 mode：退回权限位的高 4 位判断
  const bits = attrs.mode & TYPE_MASK;
  if (bits === 0o040000) return "dir";
  if (bits === 0o100000) return "file";
  if (bits === 0o120000) return "symlink";
  return "other";
};

const joinRemotePath = (directory: string, name: string): string =>
  directory.endsWith("/") ? directory + name : directory + "/" + name;

/** ssh2 的 (err, value) 回调 → Promise；错误原样抛出，绝不改写文案。 */
const callWith = <T>(run: (callback: (error: Error | undefined, value: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    run((error, value) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve(value);
    });
  });

const callDone = (run: (callback: (error?: Error | null) => void) => void): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    run((error) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    });
  });

/** ssh2 在服务端不支持扩展请求时给的原文：只有这一种失败允许降级。 */
const EXTENDED_UNSUPPORTED = /does not support this extended request/i;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 覆盖式提交（M3-9）。缺陷现场：覆盖上传必然失败——OpenSSH 的 SSH_FXP_RENAME 在目标已存在时
 * 直接回 Failure，POSIX rename(2) 的覆盖语义只能靠 posix-rename@openssh.com 扩展拿到。三级策略：
 * 1. 扩展可用 → 用它做原子替换（首选）；
 * 2. 服务端不支持扩展 → 普通 rename（目标不存在时它能成功）；
 * 3. 普通 rename 失败 → unlink 目标，再 rename 一次（目标不存在导致 unlink 失败就忽略）。
 * **权衡（第 3 级）**：unlink 与 rename 之间目标会有极短的一瞬不存在，此刻并发读会看到缺口。
 * 只有服务端不支持 posix-rename 时才会走到这里；比起「覆盖上传必然失败」，这个窗口是划算的。
 */
const renameOverwriteWith = async (wrapper: Ssh2SftpLike, from: string, to: string): Promise<void> => {
  const extended = wrapper.ext_openssh_rename;
  if (typeof extended === "function") {
    try {
      await callDone((callback) => extended.call(wrapper, from, to, callback));
      return;
    } catch (error) {
      // 真正的失败（权限、跨设备）必须原样抛出：降级只会把它改写成另一次失败
      if (!EXTENDED_UNSUPPORTED.test(messageOf(error))) throw error;
    }
  }
  try {
    await callDone((callback) => wrapper.rename(from, to, callback));
    return;
  } catch {
    // 目标已存在（或这次换名不够原子地失败）：退到最后一级
  }
  try {
    await callDone((callback) => wrapper.unlink(to, callback));
  } catch {
    // 目标本来就不存在：服务端就是这么回的，这个失败没有意义，继续换名
  }
  await callDone((callback) => wrapper.rename(from, to, callback));
};

/** 把 ssh2 的 SFTPWrapper 包成通道：只做映射，不缓存任何文件内容。 */
export function sftpFromSsh2(wrapper: Ssh2SftpLike): SftpLike {
  const statOf = (attrs: Ssh2AttrsLike): SftpStat => ({
    type: typeOf(attrs),
    size: attrs.size,
    mtime: attrs.mtime,
    mode: attrs.mode,
  });

  return {
    list: async (path) => {
      const entries = await callWith<Ssh2DirEntryLike[]>((callback) => wrapper.readdir(path, callback));
      return entries.map((entry) => ({
        name: entry.filename,
        path: joinRemotePath(path, entry.filename),
        type: typeOf(entry.attrs),
        size: entry.attrs.size,
        mtime: entry.attrs.mtime,
        mode: entry.attrs.mode,
      }));
    },
    stat: async (path) => statOf(await callWith<Ssh2AttrsLike>((callback) => wrapper.stat(path, callback))),
    mkdir: (path) => callDone((callback) => wrapper.mkdir(path, callback)),
    unlink: (path) => callDone((callback) => wrapper.unlink(path, callback)),
    rmdir: (path) => callDone((callback) => wrapper.rmdir(path, callback)),
    rename: (from, to) => callDone((callback) => wrapper.rename(from, to, callback)),
    renameOverwrite: (from, to) => renameOverwriteWith(wrapper, from, to),
    chmod: (path, mode) => callDone((callback) => wrapper.chmod(path, mode, callback)),
    // 流原样交给调用方：不读、不攒、不 base64
    createReadStream: (path) => wrapper.createReadStream(path),
    createWriteStream: (path) => wrapper.createWriteStream(path),
  };
}
