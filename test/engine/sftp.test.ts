import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isSftpOp, requireAbsolutePath, runSftpOp, SftpRequestError, sftpFromSsh2 } from "../../src/engine/sftp.js";
import type { SftpStat, Ssh2AttrsLike, Ssh2DirEntryLike, Ssh2SftpLike } from "../../src/engine/sftp.js";

interface RecordedCall {
  method: string;
  args: (string | number)[];
}

interface WrapperFixture {
  wrapper: Ssh2SftpLike;
  calls: RecordedCall[];
  readStream: Readable;
  writeStream: Writable;
  entries: Ssh2DirEntryLike[];
  attrs: Ssh2AttrsLike;
  failure: Error | undefined;
}

/** ssh2 attrs 是 Stats：带 isDirectory()/isFile()/isSymbolicLink()，也带裸 mode 位。 */
const attrs = (
  kind: "file" | "dir" | "symlink",
  fields: { size?: number; mtime?: number; mode?: number } = {},
): Ssh2AttrsLike => ({
  size: fields.size ?? 128,
  mtime: fields.mtime ?? 1700000000,
  mode: fields.mode ?? (kind === "dir" ? 0o040755 : kind === "symlink" ? 0o120777 : 0o100644),
  isDirectory: () => kind === "dir",
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "symlink",
});

const entry = (filename: string, kind: "file" | "dir" | "symlink"): Ssh2DirEntryLike => ({
  filename,
  attrs: attrs(kind),
});

/**
 * 假 SFTP 子系统：record 每次调用再同步回调。
 * 刻意不连真服务器、不碰真文件——这一层只证明「调用映射」与「流原样透传」。
 */
function fakeWrapper(): WrapperFixture {
  const calls: RecordedCall[] = [];
  const readStream = Readable.from([Buffer.from("payload-bytes")]);
  const writeStream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const fixture: WrapperFixture = {
    calls,
    readStream,
    writeStream,
    entries: [entry("index.html", "file"), entry("logs", "dir"), entry("current", "symlink")],
    attrs: attrs("file", { size: 4096, mtime: 1700000123 }),
    failure: undefined,
    wrapper: {
      readdir(location, callback) {
        calls.push({ method: "readdir", args: [location] });
        callback(fixture.failure, fixture.entries);
      },
      stat(path, callback) {
        calls.push({ method: "stat", args: [path] });
        callback(fixture.failure, fixture.attrs);
      },
      mkdir(path, callback) {
        calls.push({ method: "mkdir", args: [path] });
        callback(fixture.failure);
      },
      unlink(path, callback) {
        calls.push({ method: "unlink", args: [path] });
        callback(fixture.failure);
      },
      rmdir(path, callback) {
        calls.push({ method: "rmdir", args: [path] });
        callback(fixture.failure);
      },
      rename(from, to, callback) {
        calls.push({ method: "rename", args: [from, to] });
        callback(fixture.failure);
      },
      chmod(path, mode, callback) {
        calls.push({ method: "chmod", args: [path, mode] });
        callback(fixture.failure);
      },
      createReadStream(path) {
        calls.push({ method: "createReadStream", args: [path] });
        return readStream;
      },
      createWriteStream(path) {
        calls.push({ method: "createWriteStream", args: [path] });
        return writeStream;
      },
    },
  };
  return fixture;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe("sftpFromSsh2", () => {
  it("maps readdir entries to name, path, type, size, mtime and mode", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    const listed = await sftp.list("/srv/www");

    expect(fake.calls).toEqual([{ method: "readdir", args: ["/srv/www"] }]);
    expect(listed).toEqual([
      { name: "index.html", path: "/srv/www/index.html", type: "file", size: 128, mtime: 1700000000, mode: 0o100644 },
      { name: "logs", path: "/srv/www/logs", type: "dir", size: 128, mtime: 1700000000, mode: 0o040755 },
      { name: "current", path: "/srv/www/current", type: "symlink", size: 128, mtime: 1700000000, mode: 0o120777 },
    ]);
  });

  it("keeps a single slash between the directory and the entry name", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    const listed = await sftp.list("/");

    expect(listed.map((item) => item.path)).toEqual(["/index.html", "/logs", "/current"]);
  });

  it("derives the type from the mode bits when attrs carry no type predicates", async () => {
    const fake = fakeWrapper();
    fake.entries = [
      { filename: "plain.txt", attrs: { size: 7, mtime: 1700000001, mode: 0o100644 } },
      { filename: "docs", attrs: { size: 7, mtime: 1700000001, mode: 0o040755 } },
      { filename: "link", attrs: { size: 7, mtime: 1700000001, mode: 0o120777 } },
      { filename: "weird", attrs: { size: 7, mtime: 1700000001, mode: 0o140000 } },
    ];
    const sftp = sftpFromSsh2(fake.wrapper);

    const listed = await sftp.list("/tmp");

    expect(listed.map((item) => item.type)).toEqual(["file", "dir", "symlink", "other"]);
  });

  it("maps stat through ssh2 stat", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    const stats: SftpStat = await sftp.stat("/srv/www/index.html");

    expect(fake.calls).toEqual([{ method: "stat", args: ["/srv/www/index.html"] }]);
    expect(stats).toEqual({ type: "file", size: 4096, mtime: 1700000123, mode: 0o100644 });
  });

  it("forwards mkdir, unlink, rmdir, rename and chmod to ssh2", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    await sftp.mkdir("/srv/www/new");
    await sftp.unlink("/srv/www/old.txt");
    await sftp.rmdir("/srv/www/gone");
    await sftp.rename("/srv/www/a", "/srv/www/b");
    await sftp.chmod("/srv/www/a", 0o600);

    expect(fake.calls).toEqual([
      { method: "mkdir", args: ["/srv/www/new"] },
      { method: "unlink", args: ["/srv/www/old.txt"] },
      { method: "rmdir", args: ["/srv/www/gone"] },
      { method: "rename", args: ["/srv/www/a", "/srv/www/b"] },
      { method: "chmod", args: ["/srv/www/a", 0o600] },
    ]);
  });

  it("hands the ssh2 streams through without buffering the payload", () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    const readable = sftp.createReadStream("/srv/www/big.bin");
    const writable = sftp.createWriteStream("/srv/www/up.bin");

    expect(readable).toBe(fake.readStream);
    expect(writable).toBe(fake.writeStream);
    expect(fake.calls).toEqual([
      { method: "createReadStream", args: ["/srv/www/big.bin"] },
      { method: "createWriteStream", args: ["/srv/www/up.bin"] },
    ]);
  });

  it("passes an ssh2 error through unchanged, code included", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);
    const denied = Object.assign(new Error("Failure"), { code: "EACCES" });
    fake.failure = denied;

    await expect(sftp.list("/root")).rejects.toBe(denied);
    await expect(sftp.mkdir("/root/x")).rejects.toBe(denied);
    expect(messageOf(denied)).toBe("Failure");
  });
});

describe("requireAbsolutePath", () => {
  it("accepts an absolute path and rejects anything else with the required wording", () => {
    expect(requireAbsolutePath("/")).toBe("/");
    expect(requireAbsolutePath("/etc/motd")).toBe("/etc/motd");

    for (const value of ["etc/motd", "./motd", "", "   ", undefined, null, 7, {}]) {
      expect(() => requireAbsolutePath(value)).toThrow(/路径必须是绝对路径/);
    }
  });

  it("names the offending field instead of echoing the value", () => {
    expect(() => requireAbsolutePath("relative", "to")).toThrow(/to/);
    expect(() => requireAbsolutePath("relative", "to")).toThrow(/路径必须是绝对路径/);
  });
});

describe("runSftpOp", () => {
  it("recognises the seven supported operations only", () => {
    for (const op of ["ls", "stat", "mkdir", "unlink", "rmdir", "rename", "chmod"]) {
      expect(isSftpOp(op)).toBe(true);
    }
    for (const op of ["", "put", "LS", "readdir", "download"]) {
      expect(isSftpOp(op)).toBe(false);
    }
  });

  it("dispatches ls and stat", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    const listed = await runSftpOp(sftp, "ls", { path: "/srv/www" });
    const stats = await runSftpOp(sftp, "stat", { path: "/srv/www" });

    expect(listed).toEqual({
      entries: [
        { name: "index.html", path: "/srv/www/index.html", type: "file", size: 128, mtime: 1700000000, mode: 0o100644 },
        { name: "logs", path: "/srv/www/logs", type: "dir", size: 128, mtime: 1700000000, mode: 0o040755 },
        { name: "current", path: "/srv/www/current", type: "symlink", size: 128, mtime: 1700000000, mode: 0o120777 },
      ],
    });
    expect(stats).toEqual({ stat: { type: "file", size: 4096, mtime: 1700000123, mode: 0o100644 } });
    expect(fake.calls).toEqual([
      { method: "readdir", args: ["/srv/www"] },
      { method: "stat", args: ["/srv/www"] },
    ]);
  });

  it("dispatches the five mutating operations and reports ok", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(runSftpOp(sftp, "mkdir", { path: "/srv/www/n" })).resolves.toEqual({ ok: true });
    await expect(runSftpOp(sftp, "unlink", { path: "/srv/www/f" })).resolves.toEqual({ ok: true });
    await expect(runSftpOp(sftp, "rmdir", { path: "/srv/www/d" })).resolves.toEqual({ ok: true });
    await expect(runSftpOp(sftp, "rename", { path: "/srv/www/a", to: "/srv/www/b" })).resolves.toEqual({ ok: true });
    await expect(runSftpOp(sftp, "chmod", { path: "/srv/www/a", mode: 0o640 })).resolves.toEqual({ ok: true });

    expect(fake.calls).toEqual([
      { method: "mkdir", args: ["/srv/www/n"] },
      { method: "unlink", args: ["/srv/www/f"] },
      { method: "rmdir", args: ["/srv/www/d"] },
      { method: "rename", args: ["/srv/www/a", "/srv/www/b"] },
      { method: "chmod", args: ["/srv/www/a", 0o640] },
    ]);
  });

  it("refuses a relative path before touching the subsystem", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(runSftpOp(sftp, "ls", { path: "srv/www" })).rejects.toThrow(/路径必须是绝对路径/);
    await expect(runSftpOp(sftp, "rename", { path: "/srv/a", to: "srv/b" })).rejects.toThrow(/路径必须是绝对路径/);
    await expect(runSftpOp(sftp, "chmod", { path: "/srv/a", mode: 1.5 })).rejects.toThrow(/mode/);
    expect(fake.calls).toEqual([]);
  });

  it("rejects an unknown op with a request error instead of guessing", async () => {
    const fake = fakeWrapper();
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(runSftpOp(sftp, "put", { path: "/srv/a" })).rejects.toBeInstanceOf(SftpRequestError);
    await expect(runSftpOp(sftp, "put", { path: "/srv/a" })).rejects.toThrow(/put/);
    expect(fake.calls).toEqual([]);
  });
});
interface OpenSshFixture {
  wrapper: Ssh2SftpLike;
  calls: RecordedCall[];
}

interface OpenSshOptions {
  /** 服务端对 posix-rename@openssh.com 的态度：支持 / 明确不支持 / wrapper 压根没有这个能力。 */
  extended?: "supported" | "unsupported" | "absent";
  /** 扩展请求真的失败（权限、跨设备），不是「不支持」这一种。 */
  extendedFailure?: Error;
  /** 目标已存在：OpenSSH 的 SSH_FXP_RENAME 直接回 Failure（M3-9 的缺陷现场）。 */
  existingTarget?: boolean;
  /** 让前 N 次普通 rename 失败（0/未给＝全部成功）。 */
  renameFailures?: number;
  /** unlink 失败（目标本来就不存在时服务端就是这么回的）。 */
  unlinkFailure?: Error;
}

const readStreamFixture = (): Readable => Readable.from([Buffer.from("payload-bytes")]);

const writeStreamFixture = (): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

/**
 * 复刻 OpenSSH 的提交语义：SSH_FXP_RENAME **不覆盖**已存在的目标（回 Failure），
 * 原子替换必须靠 posix-rename@openssh.com 扩展。三种能力都能模拟。
 */
function openSshWrapper(options: OpenSshOptions = {}): OpenSshFixture {
  const calls: RecordedCall[] = [];
  let renamesLeft = options.renameFailures ?? 0;
  /** 目标是否已存在：被 unlink 掉之后它就不存在了，普通 rename 随之能成功。 */
  let targetPath: string | undefined;
  let targetExists = options.existingTarget === true;
  const wrapper: Ssh2SftpLike = {
    readdir: (_path, callback) => callback(undefined, []),
    stat: (_path, callback) => callback(undefined, attrs("file")),
    mkdir: (_path, callback) => callback(),
    unlink: (path, callback) => {
      calls.push({ method: "unlink", args: [path] });
      if (path === targetPath) targetExists = false;
      callback(options.unlinkFailure);
    },
    rmdir: (_path, callback) => callback(),
    rename: (from, to, callback) => {
      calls.push({ method: "rename", args: [from, to] });
      targetPath = to;
      if (renamesLeft > 0) {
        renamesLeft -= 1;
        callback(new Error("Failure"));
        return;
      }
      // OpenSSH 的 SSH_FXP_RENAME 不覆盖已存在的目标
      callback(targetExists ? new Error("Failure") : undefined);
    },
    chmod: (_path, _mode, callback) => callback(),
    createReadStream: () => readStreamFixture(),
    createWriteStream: () => writeStreamFixture(),
  };
  if (options.extended !== "absent") {
    wrapper.ext_openssh_rename = (from, to, callback) => {
      calls.push({ method: "ext_openssh_rename", args: [from, to] });
      if (options.extended === "unsupported") {
        callback(new Error("Server does not support this extended request"));
        return;
      }
      callback(options.extendedFailure);
    };
  }
  return { wrapper, calls };
}

describe("renameOverwrite (M3-9)", () => {
  const FROM = "/srv/www/app.log.uniterminal-part-a1b2c3";
  const TO = "/srv/www/app.log";

  // 首选路径：服务端支持 posix-rename@openssh.com 时它是原子替换，普通 rename 一次都不该调
  it("commits through posix-rename@openssh.com and never touches the plain rename", async () => {
    const fake = openSshWrapper({ extended: "supported" });
    const sftp = sftpFromSsh2(fake.wrapper);

    await sftp.renameOverwrite(FROM, TO);

    expect(fake.calls).toEqual([{ method: "ext_openssh_rename", args: [FROM, TO] }]);
  });

  // 服务器不支持扩展：ssh2 抛的那句固定文案必须被识别出来，然后退到普通 rename
  it("falls back to the plain rename when the server rejects the extended request", async () => {
    const fake = openSshWrapper({ extended: "unsupported" });
    const sftp = sftpFromSsh2(fake.wrapper);

    await sftp.renameOverwrite(FROM, TO);

    expect(fake.calls).toEqual([
      { method: "ext_openssh_rename", args: [FROM, TO] },
      { method: "rename", args: [FROM, TO] },
    ]);
  });

  // 缺陷 1 的根因路径：普通 rename 因目标已存在而失败 → 先 unlink 目标，再 rename 一次
  it("unlinks the existing target and renames again when the plain rename refuses to overwrite", async () => {
    const fake = openSshWrapper({ extended: "absent", existingTarget: true });
    const sftp = sftpFromSsh2(fake.wrapper);

    await sftp.renameOverwrite(FROM, TO);

    expect(fake.calls).toEqual([
      { method: "rename", args: [FROM, TO] },
      { method: "unlink", args: [TO] },
      { method: "rename", args: [FROM, TO] },
    ]);
  });

  // 目标本来就不存在时 unlink 会失败：这个失败没有意义，绝不能因此放弃提交
  it("swallows an unlink failure and retries the rename", async () => {
    const fake = openSshWrapper({
      extended: "absent",
      renameFailures: 1,
      unlinkFailure: new Error("No such file"),
    });
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(sftp.renameOverwrite(FROM, TO)).resolves.toBeUndefined();

    expect(fake.calls).toEqual([
      { method: "rename", args: [FROM, TO] },
      { method: "unlink", args: [TO] },
      { method: "rename", args: [FROM, TO] },
    ]);
  });

  // 三级都失败：把最后一次 rename 的错误原样抛给调用方（路由层据此 500 + 清临时文件）
  it("rejects with the last rename error when every strategy fails", async () => {
    const fake = openSshWrapper({
      extended: "absent",
      renameFailures: 2,
      unlinkFailure: new Error("No such file"),
    });
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(sftp.renameOverwrite(FROM, TO)).rejects.toThrow("Failure");

    expect(fake.calls).toEqual([
      { method: "rename", args: [FROM, TO] },
      { method: "unlink", args: [TO] },
      { method: "rename", args: [FROM, TO] },
    ]);
  });

  // 扩展请求的真实失败不能被降级掩盖：否则权限错误会被改写成一次普通 rename
  it("does not mask a real extended-request failure with the fallback", async () => {
    const denied = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const fake = openSshWrapper({ extended: "supported", extendedFailure: denied });
    const sftp = sftpFromSsh2(fake.wrapper);

    await expect(sftp.renameOverwrite(FROM, TO)).rejects.toBe(denied);
    expect(fake.calls).toEqual([{ method: "ext_openssh_rename", args: [FROM, TO] }]);
  });
});
