import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createSshTransport,
  type SshClientFactory,
  type SshClientLike,
  type SshExecStreamLike,
  type SshStreamLike,
} from "../../src/engine/ssh-transport.js";
import type { SftpLike, Ssh2SftpLike } from "../../src/engine/sftp.js";
import type { TcpipEvent } from "../../src/engine/tunnel.js";
import type { ResolvedProfile } from "../../src/engine/types.js";
import { KnownHosts } from "../../src/store/known-hosts.js";

const FINGERPRINT = "SHA256:aaabbbcccdddeee";
/** 明显的假私钥：只用于验证「有没有原样透传到 client.connect」。 */
const FAKE_PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----";
const FAKE_PASSPHRASE = "fake-passphrase-for-tests";
const OTHER_FINGERPRINT = "SHA256:zzzyyyxxxwwwvvv";

type HostVerifierFn = (hashedKey: string, cb: (accept: boolean) => void) => void;

function makeFake(
  options: {
    withSftp?: boolean;
    withForwarding?: boolean;
    /** 不给 exec 方法：用来证明不支持该能力的客户端上，句柄也不暴露 exec。 */
    withExec?: boolean;
    /** 跳板链要一次开多条连接：connect 一调就自己 ready，测试不必逐跳点火。 */
    autoReady?: boolean;
    connectError?: Error;
    forwardOutError?: Error;
    onEnd?: () => void;
  } = {},
) {
  const writes: Uint8Array[] = [];
  const windows: [number, number][] = [];
  const dataCallbacks: ((chunk: Buffer) => void)[] = [];
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const configs: Record<string, unknown>[] = [];
  /** 每次打开 SFTP 子系统记一次：用来证明复用同一条连接，而不是又开一条。 */
  let sftpOpenCount = 0;
  const sftpMethods: string[] = [];
  let sftpError: Error | undefined;
  /** 收口顺序：用来证明 SFTP 通道先于连接关掉。 */
  const order: string[] = [];
  /** 只失败一次的开通道：用来证明失败之后下一次会重新尝试。 */
  let sftpOpenFailure: Error | undefined;
  /** 只失败一次的方法：用来证明通道失效之后允许重建一次。 */
  let sftpMethodFailure: Error | undefined;
  /** M3-2 转发：只记录调用参数，通道用内存 Duplex 顶替（绝不真连）。 */
  const forwardOutCalls: [string, number, string, number][] = [];
  const forwardInCalls: [string, number][] = [];
  const channel = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  let forwardInError: Error | undefined;
  let forwardOutError: Error | undefined = options.forwardOutError;
  let forwardOutThrows: Error | undefined;

  const wrapper: Ssh2SftpLike & { end: () => void } = {
    end: () => {
      order.push("sftp.end");
    },
    readdir(location, callback) {
      sftpMethods.push("readdir:" + location);
      // 通道失效只演一次：重建出来的通道必须恢复正常
      if (sftpMethodFailure !== undefined) {
        const failure = sftpMethodFailure;
        sftpMethodFailure = undefined;
        callback(failure, []);
        return;
      }
      callback(sftpError, [
        {
          filename: "a.txt",
          attrs: { size: 5, mtime: 1700000000, mode: 0o100644, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        },
      ]);
    },
    stat(path, callback) {
      sftpMethods.push("stat:" + path);
      callback(sftpError, { size: 5, mtime: 1700000000, mode: 0o100644 });
    },
    mkdir(path, callback) {
      sftpMethods.push("mkdir:" + path);
      callback(sftpError);
    },
    unlink(path, callback) {
      sftpMethods.push("unlink:" + path);
      callback(sftpError);
    },
    rmdir(path, callback) {
      sftpMethods.push("rmdir:" + path);
      callback(sftpError);
    },
    rename(from, to, callback) {
      sftpMethods.push("rename:" + from + "->" + to);
      callback(sftpError);
    },
    chmod(path, mode, callback) {
      sftpMethods.push("chmod:" + path + ":" + String(mode));
      callback(sftpError);
    },
    createReadStream(path) {
      sftpMethods.push("read:" + path);
      return Readable.from([Buffer.from("payload")]);
    },
    createWriteStream(path) {
      sftpMethods.push("write:" + path);
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    },
  };

  /** M5-1 exec 通道：命令、stdout/stderr 与退出码全由测试点火，绝不真执行。 */
  const execCommands: string[] = [];
  const execStdout: ((chunk: Buffer) => void)[] = [];
  const execStderr: ((chunk: Buffer) => void)[] = [];
  const execClose: ((code: number | null) => void)[] = [];
  let execOpenError: Error | undefined;
  const execStream: SshExecStreamLike = {
    stderr: {
      on: (event: string, cb: never) => {
        if (event === "data") execStderr.push(cb);
      },
    },
    on: (event: string, cb: never) => {
      if (event === "data") execStdout.push(cb);
      if (event === "close") execClose.push(cb);
    },
    close: () => {
      order.push("exec.close");
    },
  };

  const stream: SshStreamLike = {
    write: (data) => { writes.push(data); return true; },
    setWindow: (rows, cols) => { windows.push([rows, cols]); },
    on: (event: string, cb: never) => { if (event === "data") dataCallbacks.push(cb); },
    close: () => {},
  };

  const client: SshClientLike = {
    on: (event: string, cb: never) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    connect: (config) => {
      configs.push(config);
      if (options.connectError !== undefined) {
        emit("error", options.connectError);
        return;
      }
      if (options.autoReady === true) emit("ready");
    },
    shell: (_options, cb) => cb(undefined, stream),
    ...(options.withExec === false
      ? {}
      : {
          exec: (command: string, cb: (error: Error | undefined, stream: SshExecStreamLike) => void) => {
            execCommands.push(command);
            cb(execOpenError, execStream);
          },
        }),
    end: () => {
      order.push("client.end");
      options.onEnd?.();
    },
    destroy: () => {
      order.push("client.destroy");
    },
    ...(options.withSftp === false
      ? {}
      : {
          sftp: (cb: (error: Error | undefined, sftp: Ssh2SftpLike) => void) => {
            sftpOpenCount += 1;
            const failure = sftpOpenFailure;
            sftpOpenFailure = undefined;
            cb(failure ?? sftpError, wrapper);
          },
        }),
    ...(options.withForwarding === false
      ? {}
      : {
          forwardOut(
            srcIP: string,
            srcPort: number,
            dstIP: string,
            dstPort: number,
            cb: (error: Error | undefined, channel: Duplex) => void,
          ) {
            forwardOutCalls.push([srcIP, srcPort, dstIP, dstPort]);
            // ssh2 的 forwardOut 在未连接时**同步抛**：适配器必须转成 rejection
            if (forwardOutThrows !== undefined) throw forwardOutThrows;
            cb(forwardOutError, channel);
          },
          forwardIn(host: string, port: number, cb: (error: Error | undefined, boundPort: number) => void) {
            forwardInCalls.push([host, port]);
            cb(forwardInError, 22022);
          },
        }),
  };

  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of handlers.get(event) ?? []) cb(...args);
  };

  return {
    client,
    writes,
    windows,
    dataCallbacks,
    emit,
    configs,
    sftpMethods,
    order,
    sftpOpenCount: () => sftpOpenCount,
    failNextOpen: (error: Error) => {
      sftpOpenFailure = error;
    },
    failNextMethod: (error: Error) => {
      sftpMethodFailure = error;
    },
    forwardOutCalls,
    forwardInCalls,
    channel,
    setSftpError: (error: Error | undefined) => {
      sftpError = error;
    },
    setForwardInError: (error: Error | undefined) => {
      forwardInError = error;
    },
    setForwardOutError: (error: Error | undefined) => {
      forwardOutError = error;
    },
    setForwardOutThrows: (error: Error | undefined) => {
      forwardOutThrows = error;
    },
    execCommands,
    emitExecStdout: (text: string) => {
      for (const cb of [...execStdout]) cb(Buffer.from(text));
    },
    emitExecStderr: (text: string) => {
      for (const cb of [...execStderr]) cb(Buffer.from(text));
    },
    closeExec: (code: number | null) => {
      for (const cb of [...execClose]) cb(code);
    },
    setExecOpenError: (error: Error | undefined) => {
      execOpenError = error;
    },
  };
}

const connectConfig = (fake: ReturnType<typeof makeFake>): Record<string, unknown> => {
  const config = fake.configs[0];
  if (config === undefined) throw new Error("client.connect was not called");
  return config;
};

const hostVerifierOf = (fake: ReturnType<typeof makeFake>): HostVerifierFn => {
  const verifier = connectConfig(fake).hostVerifier;
  if (typeof verifier !== "function") throw new Error("client.connect received no hostVerifier");
  return verifier as unknown as HostVerifierFn;
};

const withKnownHosts = async (
  run: (knownHosts: KnownHosts) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "uniterminal-transport-known-hosts-"));
  try {
    await run(new KnownHosts(join(dir, "known_hosts.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const collectVerdicts = (verifier: HostVerifierFn, fingerprint: string): boolean[] => {
  const verdicts: boolean[] = [];
  verifier(fingerprint, (accept) => verdicts.push(accept));
  return verdicts;
};

const settle = async (opening: Promise<unknown>): Promise<unknown> =>
  opening.then(
    () => undefined,
    (error: unknown) => error,
  );

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe("createSshTransport", () => {
  it("opens a shell then forwards write, resize and data", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h1", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("ready");
    const handle = await opening;

    handle.write(new Uint8Array([65]));
    expect(fake.writes).toEqual([new Uint8Array([65])]);

    handle.resize(120, 40);
    expect(fake.windows).toEqual([[40, 120]]);

    const received: number[] = [];
    handle.onData((chunk) => received.push(chunk[0]!));
    for (const cb of fake.dataCallbacks) cb(Buffer.from([7]));
    expect(received).toEqual([7]);
  });

  it("rejects when the client reports an error before the shell opens", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h2", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("error", new Error("boom"));
    await expect(opening).rejects.toThrow("boom");
  });

  it("rejects when the signal aborts before ready", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const controller = new AbortController();
    const opening = adapter.open({ id: "h3", kind: "ssh", host: "example.com" }, controller.signal);
    controller.abort();
    await expect(opening).rejects.toThrow(/aborted/);
  });

  it("hands hostHash sha256 and a known_hosts hostVerifier to client.connect", async () => {
    await withKnownHosts(async (knownHosts) => {
      await knownHosts.trust("example.com", 22, FINGERPRINT);

      const fake = makeFake();
      const adapter = createSshTransport(() => fake.client, { knownHosts });
      const opening = adapter.open({ id: "h4", kind: "ssh", host: "example.com" }, new AbortController().signal);

      expect(connectConfig(fake).hostHash).toBe("sha256");
      expect(collectVerdicts(hostVerifierOf(fake), FINGERPRINT)).toEqual([true]);

      fake.emit("ready");
      await expect(opening).resolves.toMatchObject({ id: "h4", kind: "ssh" });
    });
  });

  it("rejects an unknown host key when the policy is reject", async () => {
    await withKnownHosts(async (knownHosts) => {
      const fake = makeFake();
      const adapter = createSshTransport(() => fake.client, { knownHosts, onUnknownHostKey: "reject" });
      const opening = adapter.open({ id: "h5", kind: "ssh", host: "example.com" }, new AbortController().signal);
      const settled = settle(opening);

      expect(collectVerdicts(hostVerifierOf(fake), FINGERPRINT)).toEqual([false]);

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect(messageOf(error)).toMatch(/uniterminal: unknown host key/);
    });
  });

  it("keeps an IPv6 host literal and a custom port as given", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open(
      { id: "h7", kind: "ssh", host: "2001:db8::1", port: 2222 },
      new AbortController().signal,
    );

    expect(connectConfig(fake).host).toBe("2001:db8::1");
    expect(connectConfig(fake).port).toBe(2222);

    fake.emit("ready");
    await expect(opening).resolves.toMatchObject({ id: "h7", kind: "ssh" });
  });

  it("defaults the port to 22 when the profile omits it", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h8", kind: "ssh", host: "example.com" }, new AbortController().signal);

    expect(connectConfig(fake).port).toBe(22);

    fake.emit("ready");
    await expect(opening).resolves.toMatchObject({ id: "h8", kind: "ssh" });
  });

  it("rejects a changed host key with the mismatch message", async () => {
    await withKnownHosts(async (knownHosts) => {
      await knownHosts.trust("example.com", 22, FINGERPRINT);

      const fake = makeFake();
      const adapter = createSshTransport(() => fake.client, { knownHosts });
      const opening = adapter.open({ id: "h6", kind: "ssh", host: "example.com" }, new AbortController().signal);
      const settled = settle(opening);

      expect(collectVerdicts(hostVerifierOf(fake), OTHER_FINGERPRINT)).toEqual([false]);

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect(messageOf(error)).toMatch(/uniterminal: host key changed/);
    });
  });

  it("hands privateKey and passphrase to client.connect when the profile carries them", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open(
      { id: "h9", kind: "ssh", host: "example.com", privateKey: FAKE_PRIVATE_KEY, passphrase: FAKE_PASSPHRASE },
      new AbortController().signal,
    );

    expect(connectConfig(fake).privateKey).toBe(FAKE_PRIVATE_KEY);
    expect(connectConfig(fake).passphrase).toBe(FAKE_PASSPHRASE);

    fake.emit("ready");
    await expect(opening).resolves.toMatchObject({ id: "h9", kind: "ssh" });
  });

  it("hands a privateKey without a passphrase when only the key is present", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open(
      { id: "h10", kind: "ssh", host: "example.com", privateKey: FAKE_PRIVATE_KEY },
      new AbortController().signal,
    );

    expect(connectConfig(fake).privateKey).toBe(FAKE_PRIVATE_KEY);
    expect(connectConfig(fake)).not.toHaveProperty("passphrase");

    fake.emit("ready");
    await expect(opening).resolves.toMatchObject({ id: "h10" });
  });

  it("keeps privateKey and passphrase out of client.connect when the profile has none", async () => {
    const fake = makeFake();
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h11", kind: "ssh", host: "example.com" }, new AbortController().signal);

    expect(connectConfig(fake)).not.toHaveProperty("privateKey");
    expect(connectConfig(fake)).not.toHaveProperty("passphrase");

    fake.emit("ready");
    await expect(opening).resolves.toMatchObject({ id: "h11" });
  });
});

describe("createSshTransport sftp", () => {
  const openHandle = async (fake: ReturnType<typeof makeFake>) => {
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h12", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("ready");
    return opening;
  };

  const openSftpOf = async (handle: { openSftp?: () => Promise<SftpLike> }): Promise<SftpLike> => {
    const open = handle.openSftp;
    if (open === undefined) throw new Error("openSftp missing on the session handle");
    return open();
  };

  it("opens the sftp subsystem on the same client instead of a second connection", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);

    // 子系统按需打开：shell 建好时不预开
    expect(fake.sftpOpenCount()).toBe(0);

    const sftp = await openSftpOf(handle);

    expect(fake.sftpOpenCount()).toBe(1);
    // 关键断言：整个过程只 connect 过一次（复用连接，没有二次认证）
    expect(fake.configs).toHaveLength(1);
    await expect(sftp.list("/srv")).resolves.toEqual([
      { name: "a.txt", path: "/srv/a.txt", type: "file", size: 5, mtime: 1700000000, mode: 0o100644 },
    ]);
    expect(fake.sftpMethods).toEqual(["readdir:/srv"]);
  });

  it("rejects with the ssh2 text when the sftp subsystem cannot open", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);
    fake.setSftpError(new Error("Channel open failure: administratively prohibited"));

    await expect(openSftpOf(handle)).rejects.toThrow("administratively prohibited");
  });

  it("rejects clearly when the client has no sftp subsystem", async () => {
    const fake = makeFake({ withSftp: false });
    const handle = await openHandle(fake);

    await expect(openSftpOf(handle)).rejects.toThrow(/sftp subsystem unavailable/);
  });

  // M3-5：一条连接只开一个 SFTP 通道。开了不 end 会把 sshd 的 MaxSessions 撞满
  // （终端自己还占一个），随后就是 "Channel open failure: open failed" 与空列表。
  it("opens the sftp subsystem once and reuses it for later calls", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);

    const first = await openSftpOf(handle);
    const second = await openSftpOf(handle);

    expect(fake.sftpOpenCount()).toBe(1);
    expect(second).toBe(first);
  });

  it("opens one sftp subsystem when two calls race", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);
    const open = handle.openSftp;
    if (open === undefined) throw new Error("openSftp missing on the session handle");

    // 不 await 第一个：缓存的是 Promise 本身，并发的第二次必须搭上同一趟
    const racing = [open.call(handle), open.call(handle)];
    const [first, second] = await Promise.all(racing);

    expect(fake.sftpOpenCount()).toBe(1);
    expect(second).toBe(first);
  });

  it("retries the sftp subsystem on the next call after a failed open", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);
    fake.failNextOpen(new Error("Channel open failure: open failed"));

    await expect(openSftpOf(handle)).rejects.toThrow(/Channel open failure/);
    expect(fake.sftpOpenCount()).toBe(1);

    // 失败不写进缓存：下一次调用重新尝试，而不是永久失败
    const sftp = await openSftpOf(handle);
    expect(fake.sftpOpenCount()).toBe(2);
    await expect(sftp.list("/srv")).resolves.toHaveLength(1);
  });

  it("rebuilds the cached sftp subsystem once when it turns out to be dead", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);
    const sftp = await openSftpOf(handle);
    fake.failNextMethod(new Error("Channel open failure: open failed"));

    await expect(sftp.list("/srv")).resolves.toHaveLength(1);

    // 旧通道失效 → 换一条重建一次，业务调用照常成功
    expect(fake.sftpOpenCount()).toBe(2);
  });

  it("ends the cached sftp subsystem before the client on close", async () => {
    const fake = makeFake();
    const handle = await openHandle(fake);
    const sftp = await openSftpOf(handle);
    // 再取一次也只有一个通道：close 只需要收这一条
    expect(await openSftpOf(handle)).toBe(sftp);

    await handle.close();

    expect(fake.order).toEqual(["sftp.end", "client.end"]);
  });
});

describe("createSshTransport forwarding (M3-2)", () => {
  const openHandle = async (fake: ReturnType<typeof makeFake>) => {
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "h12", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("ready");
    return opening;
  };

  /** 句柄上的三个转发方法要么都在（ssh2），要么都不在（别的协议）。 */
  const forwardingOf = async (fake: ReturnType<typeof makeFake>) => {
    const handle = await openHandle(fake);
    const { forwardOut, forwardIn, onTcpipEvent } = handle;
    if (forwardOut === undefined || forwardIn === undefined || onTcpipEvent === undefined) {
      throw new Error("session handle does not expose port forwarding");
    }
    return {
      handle,
      forwardOut: (srcHost: string, srcPort: number, dstHost: string, dstPort: number) =>
        forwardOut.call(handle, srcHost, srcPort, dstHost, dstPort),
      forwardIn: (host: string, port: number) => forwardIn.call(handle, host, port),
      onTcpipEvent: (listener: (event: TcpipEvent) => void) => onTcpipEvent.call(handle, listener),
    };
  };

  it("opens a direct-tcpip channel on the same connection", async () => {
    const fake = makeFake();
    const forwarding = await forwardingOf(fake);

    const channel = await forwarding.forwardOut("127.0.0.1", 18080, "127.0.0.1", 5432);

    expect(channel).toBe(fake.channel);
    expect(fake.forwardOutCalls).toEqual([["127.0.0.1", 18080, "127.0.0.1", 5432]]);
    // 复用同一条连接：全程只 connect 过一次
    expect(fake.configs).toHaveLength(1);
  });

  it("asks the server for a remote bind and returns the port it allocated", async () => {
    const fake = makeFake();
    const forwarding = await forwardingOf(fake);

    await expect(forwarding.forwardIn("127.0.0.1", 0)).resolves.toBe(22022);
    expect(fake.forwardInCalls).toEqual([["127.0.0.1", 0]]);
  });

  it("surfaces the server text when the remote bind is refused", async () => {
    const fake = makeFake();
    fake.setForwardInError(new Error("Unable to bind to 127.0.0.1:80"));
    const forwarding = await forwardingOf(fake);

    await expect(forwarding.forwardIn("127.0.0.1", 80)).rejects.toThrow(/Unable to bind/);
  });

  it("turns a synchronous forwardOut throw into a rejection", async () => {
    const fake = makeFake();
    fake.setForwardOutThrows(new Error("Not connected"));
    const forwarding = await forwardingOf(fake);

    await expect(forwarding.forwardOut("127.0.0.1", 1, "127.0.0.1", 2)).rejects.toThrow(/Not connected/);
  });

  it("hands tcp connection events over with accept and reject", async () => {
    const fake = makeFake();
    const forwarding = await forwardingOf(fake);
    const events: TcpipEvent[] = [];
    forwarding.onTcpipEvent((event) => void events.push(event));
    let rejected = 0;

    fake.emit(
      "tcp connection",
      { destIP: "127.0.0.1", destPort: 22022, srcIP: "10.0.0.9", srcPort: 51000 },
      () => fake.channel,
      () => {
        rejected += 1;
      },
    );

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect([event.destIP, event.destPort, event.srcIP, event.srcPort]).toEqual(["127.0.0.1", 22022, "10.0.0.9", 51000]);
    await expect(event.accept()).resolves.toBe(fake.channel);
    event.reject();
    expect(rejected).toBe(1);
  });

  it("returns an unsubscribe that detaches the tcpip listener for good", async () => {
    const fake = makeFake();
    const forwarding = await forwardingOf(fake);
    const seen: TcpipEvent[] = [];
    const cancel = forwarding.onTcpipEvent((event) => void seen.push(event));
    expect(typeof cancel).toBe("function");
    if (typeof cancel !== "function") return;
    cancel();

    let rejected = 0;
    fake.emit(
      "tcp connection",
      { destIP: "127.0.0.1", destPort: 22022, srcIP: "10.0.0.9", srcPort: 51000 },
      () => fake.channel,
      () => {
        rejected += 1;
      },
    );

    // 撤销之后旧回调一个字都收不到；没人接的通道必须被拒，不能让远端挂死
    expect(seen).toEqual([]);
    expect(rejected).toBe(1);
    // 再撤一次是幂等的（stop 幂等靠它）
    cancel();
  });

  it("does not claim forwarding when the client cannot forward", async () => {
    const fake = makeFake({ withForwarding: false });
    const handle = await openHandle(fake);

    expect(handle.forwardOut).toBeUndefined();
    expect(handle.forwardIn).toBeUndefined();
    expect(handle.onTcpipEvent).toBeUndefined();
  });
});

/** 跳板口令/私钥只存在于内存态档案里：用来证明每一跳都带同一套认证材料。 */
const HOP_PASSWORD = "hop-password-for-tests";

interface ChainEntry {
  profile: ResolvedProfile;
  fake: ReturnType<typeof makeFake>;
}

interface ChainFixture {
  factory: SshClientFactory;
  entries: ChainEntry[];
  /** end() 的调用顺序（按主机名）：证明整条链都被收掉，而不是只关最后一跳。 */
  ended: string[];
  at: (host: string) => ChainEntry;
}

/** 每调一次 factory 就多一条独立连接：跳板链要能逐跳断言 sock 与 forwardOut。 */
function makeChain(
  plan: Record<string, { connectError?: Error; forwardOutError?: Error }> = {},
): ChainFixture {
  const entries: ChainEntry[] = [];
  const ended: string[] = [];
  const factory: SshClientFactory = (profile) => {
    const host = profile.host ?? "";
    const fake = makeFake({
      autoReady: true,
      connectError: plan[host]?.connectError,
      forwardOutError: plan[host]?.forwardOutError,
      onEnd: () => ended.push(host),
    });
    entries.push({ profile, fake });
    return fake.client;
  };
  const at = (host: string): ChainEntry => {
    const found = entries.find((entry) => entry.profile.host === host);
    if (found === undefined) throw new Error("no connection was opened for host " + host);
    return found;
  };
  return { factory, entries, ended, at };
}

describe("createSshTransport proxy jump chain (M3-3)", () => {
  it("chains two jump hosts, feeding each forwardOut stream into the next sock", async () => {
    const chain = makeChain();
    const adapter = createSshTransport(chain.factory);
    const handle = await adapter.open(
      {
        id: "h20",
        kind: "ssh",
        host: "target.internal",
        port: 22,
        user: "ops",
        password: HOP_PASSWORD,
        privateKey: FAKE_PRIVATE_KEY,
        passphrase: FAKE_PASSPHRASE,
        proxyChain: ["bastion.example.com", "ops@jump2.example.com:2222"],
      },
      new AbortController().signal,
    );

    // 连接顺序：第一跳 → 第二跳 → 目标
    expect(chain.entries.map((entry) => entry.profile.host)).toEqual([
      "bastion.example.com",
      "jump2.example.com",
      "target.internal",
    ]);

    const first = chain.at("bastion.example.com");
    const second = chain.at("jump2.example.com");
    const target = chain.at("target.internal");

    // 第一跳直连，并开出到第二跳的通道
    expect(connectConfig(first.fake)).not.toHaveProperty("sock");
    expect(first.fake.forwardOutCalls).toEqual([["127.0.0.1", 0, "jump2.example.com", 2222]]);
    // 第二跳用第一跳的通道当 sock，再开出到目标的通道
    expect(connectConfig(second.fake).sock).toBe(first.fake.channel);
    expect(second.fake.forwardOutCalls).toEqual([["127.0.0.1", 0, "target.internal", 22]]);
    // 目标用第二跳的通道当 sock
    expect(connectConfig(target.fake).sock).toBe(second.fake.channel);
    // 目标本身不开转发通道：它只是这条通道的终点
    expect(target.fake.forwardOutCalls).toEqual([]);

    // 本批限制：逐跳不同凭据留待后续，每一跳都带与目标相同的认证材料
    for (const entry of chain.entries) {
      expect(connectConfig(entry.fake).password).toBe(HOP_PASSWORD);
      expect(connectConfig(entry.fake).privateKey).toBe(FAKE_PRIVATE_KEY);
      expect(connectConfig(entry.fake).passphrase).toBe(FAKE_PASSPHRASE);
    }
    // user@host:port 的跳板描述被拆进该跳的档案
    expect(second.profile.user).toBe("ops");
    expect(second.profile.port).toBe(2222);

    console.log(
      "[m3-3 sock chain]",
      JSON.stringify({
        order: chain.entries.map((entry) => entry.profile.host),
        hop1ForwardOut: first.fake.forwardOutCalls,
        hop2SockIsHop1Channel: connectConfig(second.fake).sock === first.fake.channel,
        targetSockIsHop2Channel: connectConfig(target.fake).sock === second.fake.channel,
      }),
    );

    await handle.close();
  });

  it("treats a single jump host as one hop in front of the target", async () => {
    const chain = makeChain();
    const adapter = createSshTransport(chain.factory);
    const handle = await adapter.open(
      { id: "h21", kind: "ssh", host: "target.internal", proxyChain: ["ops@bastion.example.com:2200"] },
      new AbortController().signal,
    );

    expect(chain.entries.map((entry) => entry.profile.host)).toEqual(["bastion.example.com", "target.internal"]);
    const hop = chain.at("bastion.example.com");
    expect(connectConfig(hop.fake)).not.toHaveProperty("sock");
    expect(hop.fake.forwardOutCalls).toEqual([["127.0.0.1", 0, "target.internal", 22]]);
    expect(connectConfig(chain.at("target.internal").fake).sock).toBe(hop.fake.channel);
    expect(hop.profile.user).toBe("ops");
    expect(hop.profile.port).toBe(2200);

    await handle.close();
  });

  it("locates the failing hop and host when a jump host cannot be reached", async () => {
    const chain = makeChain({ "jump2.example.com": { connectError: new Error("connect ECONNREFUSED 10.0.0.2:22") } });
    const adapter = createSshTransport(chain.factory);

    const opening = adapter.open(
      { id: "h22", kind: "ssh", host: "target.internal", proxyChain: ["bastion.example.com", "jump2.example.com"] },
      new AbortController().signal,
    );

    await expect(opening).rejects.toThrow(/proxy hop 2 \(jump2\.example\.com:22\) failed: connect ECONNREFUSED/);
    // 第一跳已经建好：失败必须把它收掉，不能留一条悬空连接
    expect(chain.at("bastion.example.com").fake.order).toContain("client.destroy");
    expect(chain.entries.map((entry) => entry.profile.host)).toEqual(["bastion.example.com", "jump2.example.com"]);
  });

  it("attributes a refused hop channel to the hop it was opening", async () => {
    const chain = makeChain({ "bastion.example.com": { forwardOutError: new Error("administratively prohibited") } });
    const adapter = createSshTransport(chain.factory);

    const opening = adapter.open(
      { id: "h23", kind: "ssh", host: "target.internal", proxyChain: ["bastion.example.com", "jump2.example.com"] },
      new AbortController().signal,
    );

    await expect(opening).rejects.toThrow(
      /proxy hop 2 \(jump2\.example\.com:22\) failed: administratively prohibited/,
    );
    // 第二跳根本没建成：只该有第一跳那一条连接
    expect(chain.entries).toHaveLength(1);
  });

  it("names the last hop when the channel to the target cannot be opened", async () => {
    const chain = makeChain({ "jump2.example.com": { forwardOutError: new Error("connect ECONNREFUSED") } });
    const adapter = createSshTransport(chain.factory);

    const opening = adapter.open(
      { id: "h24", kind: "ssh", host: "target.internal", proxyChain: ["bastion.example.com", "jump2.example.com"] },
      new AbortController().signal,
    );

    await expect(opening).rejects.toThrow(
      /proxy hop 2 \(jump2\.example\.com:22\) failed: forward to target\.internal:22: connect ECONNREFUSED/,
    );
  });

  it("rejects an unparsable hop spec instead of quietly connecting directly", async () => {
    const chain = makeChain();
    const adapter = createSshTransport(chain.factory);

    const opening = adapter.open(
      { id: "h25", kind: "ssh", host: "target.internal", proxyChain: ["bastion.example.com:not-a-port"] },
      new AbortController().signal,
    );

    await expect(opening).rejects.toThrow(/invalid proxy jump/);
    expect(chain.entries).toHaveLength(0);
  });

/** 开一条连接并取出 exec：拿不到就直接失败，免得断言变成「什么也没测」。 */
async function openExecHandle(fake: ReturnType<typeof makeFake>) {
  const adapter = createSshTransport(() => fake.client);
  const opening = adapter.open({ id: "e1", kind: "ssh", host: "example.com" }, new AbortController().signal);
  fake.emit("ready");
  const handle = await opening;
  const exec = handle.exec;
  if (exec === undefined) throw new Error("handle has no exec");
  return {
    handle,
    exec: (command: string, options?: { timeoutMs?: number }) => exec.call(handle, command, options),
  };
}

describe("exec over the session handle (M5-1)", () => {
  it("collects stdout, stderr and the exit code of one command", async () => {
    const fake = makeFake();
    const { exec } = await openExecHandle(fake);

    const pending = exec("uname -a");
    expect(fake.execCommands).toEqual(["uname -a"]);
    fake.emitExecStdout("Linux host ");
    fake.emitExecStdout("6.1\n");
    fake.emitExecStderr("warning: locale\n");
    fake.closeExec(0);

    await expect(pending).resolves.toEqual({
      stdout: "Linux host 6.1\n",
      stderr: "warning: locale\n",
      code: 0,
      truncated: false,
      timedOut: false,
    });
  });

  it("reports a non-zero exit code as code instead of throwing", async () => {
    const fake = makeFake();
    const { exec } = await openExecHandle(fake);

    const pending = exec("exit 7");
    fake.emitExecStderr("boom\n");
    fake.closeExec(7);

    await expect(pending).resolves.toMatchObject({ code: 7, stderr: "boom\n", timedOut: false });
  });

  it("returns code null and a timedOut marker when the command outlives the timeout", async () => {
    const fake = makeFake();
    const { exec } = await openExecHandle(fake);

    const result = await exec("sleep 30", { timeoutMs: 5 });

    expect(result).toMatchObject({ code: null, timedOut: true });
    // 超时必须把通道和连接一起收掉：绝不留一条挂着的通道占着 MaxSessions
    expect(fake.order).toContain("exec.close");
    expect(fake.order).toContain("client.destroy");
  });

  it("caps the output at 256 KiB and flags truncated", async () => {
    const fake = makeFake();
    const { exec } = await openExecHandle(fake);

    const pending = exec("cat big.log");
    fake.emitExecStdout("a".repeat(256 * 1024 + 100));
    fake.emitExecStderr("b".repeat(16));
    fake.closeExec(0);

    const result = await pending;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(256 * 1024);
    expect(result.stderr).toBe("b".repeat(16));
    expect(result.code).toBe(0);
  });

  it("rejects when the channel cannot be opened", async () => {
    const fake = makeFake();
    fake.setExecOpenError(new Error("Channel open failure: open failed"));
    const { exec } = await openExecHandle(fake);

    await expect(exec("id")).rejects.toThrow(/Channel open failure/);
  });

  it("keeps exec off the handle when the client cannot exec", async () => {
    const fake = makeFake({ withExec: false });
    const adapter = createSshTransport(() => fake.client);
    const opening = adapter.open({ id: "e2", kind: "ssh", host: "example.com" }, new AbortController().signal);
    fake.emit("ready");
    const handle = await opening;

    expect(handle.exec).toBeUndefined();
  });
});

  it("ends every connection on the chain on close", async () => {
    const chain = makeChain();
    const adapter = createSshTransport(chain.factory);
    const handle = await adapter.open(
      { id: "h26", kind: "ssh", host: "target.internal", proxyChain: ["bastion.example.com", "jump2.example.com:2222"] },
      new AbortController().signal,
    );

    await handle.close();

    const endsOf = (entry: ChainEntry): number => entry.fake.order.filter((step) => step === "client.end").length;
    console.log(
      "[m3-3 close]",
      JSON.stringify({
        endedInOrder: chain.ended,
        endsPerConnection: chain.entries.map((entry) => (entry.profile.host ?? "") + "=" + String(endsOf(entry))),
      }),
    );

    expect(chain.entries).toHaveLength(3);
    for (const entry of chain.entries) expect(endsOf(entry)).toBe(1);
    // 反向收口：先收目标，再逐跳往回，中间跳的连接一条都不许漏
    expect(chain.ended).toEqual(["target.internal", "jump2.example.com", "bastion.example.com"]);
  });
});
