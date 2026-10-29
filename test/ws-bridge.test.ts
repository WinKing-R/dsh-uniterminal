import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { TransportRegistry } from "../src/engine/registry.js";
import { SessionManager } from "../src/engine/session-manager.js";
import type {
  Capabilities,
  ResolvedProfile,
  SessionHandle,
  TransportAdapter,
} from "../src/engine/types.js";
import { UNITERMINAL_ROUTES } from "../src/routes.js";
import { attachWsServer, createWsBridge, parseSessionId } from "../src/ws-bridge.js";
import type { UpgradeRouteLike, WsBridge } from "../src/ws-bridge.js";

const CAPABILITIES: Capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
const PROFILE: ResolvedProfile = { id: "p1", kind: "ssh", host: "example.test", user: "root" };

interface StubHandle extends SessionHandle {
  readonly written: string[];
  readonly resized: [number, number][];
  emit(chunk: Uint8Array): void;
}

interface StubManager {
  manager: SessionManager;
  handles: StubHandle[];
}

function makeManager(): StubManager {
  const handles: StubHandle[] = [];
  const adapter: TransportAdapter = {
    kind: "ssh",
    capabilities: CAPABILITIES,
    open: async (profile) => {
      const listeners = new Set<(chunk: Uint8Array) => void>();
      const handle: StubHandle = {
        id: profile.id,
        kind: "ssh",
        capabilities: CAPABILITIES,
        written: [],
        resized: [],
        write(chunk) {
          handle.written.push(Buffer.from(chunk).toString("utf8"));
        },
        resize(cols, rows) {
          handle.resized.push([cols, rows]);
        },
        onData(listener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        onClose: () => () => {},
        close: async () => {},
        emit(chunk) {
          for (const listener of listeners) listener(chunk);
        },
      };
      handles.push(handle);
      return handle;
    },
  };
  const registry = new TransportRegistry();
  registry.register(adapter);
  return { manager: new SessionManager(registry, { bufferBytes: 1024 }), handles };
}

interface RunningServer {
  base: string;
  close: () => Promise<void>;
}

async function startServer(manager: SessionManager): Promise<RunningServer> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const attachment = attachWsServer({ manager, server });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    base: "ws://127.0.0.1:" + String(address.port),
    async close() {
      await attachment.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

interface ServerFrame {
  type: string;
  /** 二进制输出帧的原始字节（新协议：终端输出直接走二进制，不再 base64） */
  bytes?: Buffer;
  data?: string;
  reason?: string;
}

interface Client {
  socket: WebSocket;
  next: () => Promise<ServerFrame>;
  close: () => Promise<void>;
}

/** 客户端从握手起就缓冲服务端帧：回放帧可能早于测试注册监听器到达。 */
async function openClient(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const queue: ServerFrame[] = [];
  const waiters: ((frame: ServerFrame) => void)[] = [];
  // 第二个参数 isBinary 才是可靠信号：ws 对文本帧也可能给 Buffer
  socket.on("message", (raw, isBinary) => {
    const frame: ServerFrame = isBinary
      ? { type: "data", bytes: Buffer.from(raw as Buffer) }
      : (JSON.parse(String(raw)) as ServerFrame);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(frame);
    else waiter(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    next() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<ServerFrame>((resolve) => {
        waiters.push(resolve);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const done = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      socket.close();
      await done;
    },
  };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function decode(frame: ServerFrame): string {
  if (frame.bytes !== undefined) return frame.bytes.toString("utf8");
  return Buffer.from(frame.data ?? "", "base64").toString("utf8");
}

function fakeRequest(address: string, url: string): IncomingMessage {
  return { url, socket: { remoteAddress: address }, headers: {} } as unknown as IncomingMessage;
}

function sessionUrl(base: string, sessionId: string): string {
  return base + UNITERMINAL_ROUTES.wsPrefix + "/" + sessionId;
}

describe("parseSessionId", () => {
  it("reads the session id out of the websocket path", () => {
    expect(parseSessionId(UNITERMINAL_ROUTES.wsPrefix + "/s1")).toBe("s1");
    expect(parseSessionId(UNITERMINAL_ROUTES.wsPrefix + "/s1?cols=80&rows=24")).toBe("s1");
    expect(parseSessionId(UNITERMINAL_ROUTES.wsPrefix)).toBeUndefined();
    expect(parseSessionId(UNITERMINAL_ROUTES.wsPrefix + "/")).toBeUndefined();
    expect(parseSessionId(UNITERMINAL_ROUTES.wsPrefix + "/s1/extra")).toBeUndefined();
    expect(parseSessionId(UNITERMINAL_ROUTES.health)).toBeUndefined();
  });
});

describe("control frames", () => {
  it("pushes transport output to the client as a binary frame", async () => {
    const { manager, handles } = makeManager();
    const session = await manager.open(PROFILE);
    const running = await startServer(manager);
    try {
      const client = await openClient(sessionUrl(running.base, session.id));
      handles[0]?.emit(new Uint8Array([104, 105]));
      const frame = await client.next();
      expect(frame.type).toBe("data");
      expect(decode(frame)).toBe("hi");
      await client.close();
    } finally {
      await running.close();
    }
  });

  it("forwards client input to the transport handle", async () => {
    const { manager, handles } = makeManager();
    const session = await manager.open(PROFILE);
    const running = await startServer(manager);
    try {
      const client = await openClient(sessionUrl(running.base, session.id));
      client.socket.send(JSON.stringify({ type: "input", data: "ls\r" }));
      await waitFor(() => (handles[0]?.written.join("") ?? "") === "ls\r", "handle.write");
      expect(handles[0]?.written.join("")).toBe("ls\r");
      await client.close();
    } finally {
      await running.close();
    }
  });

  it("maps client resize onto the transport handle", async () => {
    const { manager, handles } = makeManager();
    const session = await manager.open(PROFILE);
    const running = await startServer(manager);
    try {
      const client = await openClient(sessionUrl(running.base, session.id));
      client.socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
      await waitFor(() => (handles[0]?.resized.length ?? 0) === 1, "handle.resize");
      expect(handles[0]?.resized[0]).toEqual([120, 40]);
      await client.close();
    } finally {
      await running.close();
    }
  });

  it("replays buffered output to a client that attaches late", async () => {
    const { manager, handles } = makeManager();
    const session = await manager.open(PROFILE);
    handles[0]?.emit(new Uint8Array([104, 105]));
    const running = await startServer(manager);
    try {
      const client = await openClient(sessionUrl(running.base, session.id));
      expect(decode(await client.next())).toBe("hi");
      await client.close();
    } finally {
      await running.close();
    }
  });

  it("keeps the session alive after the client disconnects", async () => {
    const { manager, handles } = makeManager();
    const session = await manager.open(PROFILE);
    const running = await startServer(manager);
    try {
      const first = await openClient(sessionUrl(running.base, session.id));
      await first.close();
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0]?.status).toBe("open");

      const again = await openClient(sessionUrl(running.base, session.id));
      handles[0]?.emit(new Uint8Array([111, 107]));
      expect(decode(await again.next())).toBe("ok");
      await again.close();
      expect(manager.list()).toHaveLength(1);
    } finally {
      await running.close();
    }
  });

  it("serves the client path through a host-like exact-path upgrade table", async () => {
    const { manager, handles } = makeManager();
    const upgrades = new Map<string, UpgradeRouteLike>();
    const bridge = createWsBridge({
      manager,
      registerUpgrade(route) {
        if (upgrades.has(route.path)) throw new Error("duplicate upgrade route " + route.path);
        upgrades.set(route.path, route);
        return () => void upgrades.delete(route.path);
      },
    });

    const server: Server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    // 与 dsh-host-webserver lib/index.js:432-455 同构：按 pathname 精确查表，未命中即销毁。
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const route = upgrades.get(new URL(request.url ?? "/", "http://x").pathname);
      if (route === undefined) {
        socket.destroy();
        return;
      }
      route.handler(request, socket, head);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const base = "ws://127.0.0.1:" + String(address.port);

    try {
      const session = await manager.open(PROFILE);
      const client = await openClient(sessionUrl(base, session.id));
      handles[0]?.emit(new Uint8Array([104, 105]));
      expect(decode(await client.next())).toBe("hi");
      client.socket.send(JSON.stringify({ type: "input", data: "pwd\r" }));
      await waitFor(() => (handles[0]?.written.join("") ?? "") === "pwd\r", "handle.write");
      await client.close();
    } finally {
      await bridge.dispose();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("closes the socket with a close frame when the session is unknown", async () => {
    const { manager } = makeManager();
    const running = await startServer(manager);
    try {
      const client = await openClient(sessionUrl(running.base, "s99"));
      const frame = await client.next();
      expect(frame.type).toBe("close");
      expect(frame.reason).toContain("unknown session");
      await client.close();
    } finally {
      await running.close();
    }
  });
});

describe("loopback fence", () => {
  it("refuses a non-loopback upgrade before any websocket handshake", async () => {
    const { manager } = makeManager();
    const bridge: WsBridge = createWsBridge({ manager });
    const written: string[] = [];
    let destroyed = 0;
    const socket = {
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
      destroy() {
        destroyed += 1;
      },
    } as unknown as Duplex;

    bridge.handleUpgrade(
      fakeRequest("10.0.0.5", UNITERMINAL_ROUTES.wsPrefix + "/s1"),
      socket,
      Buffer.alloc(0),
    );

    expect(destroyed).toBe(1);
    expect(written.join("")).toContain("403");
    expect(written.join("")).not.toContain("101");
    await bridge.dispose();
  });
});

describe("upgrade seat registration", () => {
  it("registers the prefix seat plus one exact path per session", async () => {
    const { manager } = makeManager();
    const routes: UpgradeRouteLike[] = [];
    const bridge = createWsBridge({
      manager,
      registerUpgrade(route) {
        routes.push(route);
        return () => {
          routes.splice(routes.indexOf(route), 1);
        };
      },
    });

    expect(routes.map((route) => route.path)).toEqual([UNITERMINAL_ROUTES.wsPrefix]);
    const session = await manager.open(PROFILE);
    expect(routes.map((route) => route.path)).toEqual([
      UNITERMINAL_ROUTES.wsPrefix,
      UNITERMINAL_ROUTES.wsPrefix + "/" + session.id,
    ]);
    expect(routes[1]?.handler).toBe(routes[0]?.handler);

    await bridge.dispose();
    expect(routes).toHaveLength(0);
  });

  it("warns instead of throwing when the host refuses the upgrade seat", async () => {
    const { manager } = makeManager();
    const warnings: string[] = [];
    const bridge = createWsBridge({
      manager,
      registerUpgrade() {
        throw new Error("duplicate upgrade route");
      },
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    expect(warnings.join(" ")).toContain("duplicate upgrade route");
    await bridge.dispose();
  });

  it("releases the per-session seat when the session closes", async () => {
    const { manager } = makeManager();
    const routes = new Map<string, UpgradeRouteLike>();
    const bridge = createWsBridge({
      manager,
      registerUpgrade(route) {
        routes.set(route.path, route);
        return () => void routes.delete(route.path);
      },
    });

    const session = await manager.open(PROFILE);
    const sessionPath = UNITERMINAL_ROUTES.wsPrefix + "/" + session.id;
    expect([...routes.keys()]).toEqual([UNITERMINAL_ROUTES.wsPrefix, sessionPath]);

    await manager.close(session.id);
    expect([...routes.keys()]).toEqual([UNITERMINAL_ROUTES.wsPrefix]);

    await bridge.dispose();
    expect(routes.size).toBe(0);
  });

  it("seats a closed session path again without a duplicate-key error", async () => {
    const { manager } = makeManager();
    const routes = new Map<string, UpgradeRouteLike>();
    const bridge = createWsBridge({
      manager,
      registerUpgrade(route) {
        if (routes.has(route.path)) throw new Error("duplicate upgrade route " + route.path);
        routes.set(route.path, route);
        return () => void routes.delete(route.path);
      },
    });

    const session = await manager.open(PROFILE);
    const sessionPath = UNITERMINAL_ROUTES.wsPrefix + "/" + session.id;
    await manager.close(session.id);
    expect(routes.has(sessionPath)).toBe(false);

    bridge.claimSession(session.id);
    expect(routes.has(sessionPath)).toBe(true);

    const reopened = await manager.open(PROFILE);
    expect(routes.has(UNITERMINAL_ROUTES.wsPrefix + "/" + reopened.id)).toBe(true);

    await bridge.dispose();
    expect(routes.size).toBe(0);
  });
});
