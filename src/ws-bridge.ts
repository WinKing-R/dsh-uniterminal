import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import type { SessionManager } from "./engine/session-manager.js";
import { UNITERMINAL_ROUTES, isLoopback } from "./routes.js";
import { diag } from "./host-diag.js";

/**
 * 宿主 `webServer.registerUpgrade` 接受的路由形状。
 * 照抄 dsh-host-webserver lib/index.js:340-346（只认 path + handler，键名精确匹配）
 * 与 @linxin666/dsh-ssh src/routes.ts:456-458 的实际用法。
 */
export interface UpgradeRouteLike {
  path: string;
  handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export interface LoggerLike {
  warn: (message: string, ...args: unknown[]) => void;
}

export interface WsBridgeOptions {
  manager: SessionManager;
  /** 宿主升级路由注册器；缺省时桥接层只在内存里跑，供测试与独立服务器使用。 */
  registerUpgrade?: (route: UpgradeRouteLike) => () => void;
  logger?: LoggerLike;
}

export interface WsBridge {
  /** 所有注册出去的升级路由共用这一个处理器。 */
  handleUpgrade: UpgradeRouteLike["handler"];
  /** 给一个会话占住它的精确升级路径（重复调用无副作用）。 */
  claimSession: (sessionId: string) => void;
  dispose: () => Promise<void>;
}

export interface WsServerAttachmentOptions {
  manager: SessionManager;
  server: Server;
}

export interface WsServerAttachment {
  close: () => Promise<void>;
}

const SESSION_PATH_PREFIX = UNITERMINAL_ROUTES.wsPrefix + "/";

/** 从 WebSocket 请求 URL 里取出 `/api/uniterminal/ws/:id` 的 id。 */
export function parseSessionId(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(SESSION_PATH_PREFIX)) return undefined;
  const segment = pathname.slice(SESSION_PATH_PREFIX.length);
  if (segment.length === 0 || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** 服务端 → 客户端：`{"type":"data","data":"<base64>"}`（与 TerminalView 对齐）。 */
/**
 * 输出走**二进制帧**（直接发 Uint8Array）：
 * 早先用 {"type":"data","data":base64} 的文本帧，带宽多 33%，
 * 客户端还要 atob 之后逐字节跑一遍 JS 循环。控制消息（close）仍是 JSON 文本帧。
 */

function closeMessage(reason: string): string {
  return JSON.stringify({ type: "close", reason });
}

interface ClientFrame {
  type?: unknown;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

function toText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function readFrame(raw: RawData): ClientFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toText(raw));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as ClientFrame;
}

function applyClientFrame(manager: SessionManager, sessionId: string, frame: ClientFrame): void {
  if (frame.type === "input") {
    if (typeof frame.data !== "string") return;
    manager.write(sessionId, Buffer.from(frame.data, "utf8"));
    return;
  }
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    if (typeof cols !== "number" || typeof rows !== "number") return;
    manager.resize(sessionId, cols, rows);
  }
}

interface BridgeCore {
  handleUpgrade: UpgradeRouteLike["handler"];
  close: () => Promise<void>;
}

/** 一个 noServer 的 ws 服务器 + 会话绑定；升级协议本身由 ws 完成。 */
function createCore(manager: SessionManager): BridgeCore {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const bind = (socket: WebSocket, sessionId: string): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.once("error", () => {
      sockets.delete(socket);
    });

    let initial: { data: Uint8Array; cursor: number };
    try {
      initial = manager.read(sessionId, 0);
    } catch (error) {
      diag("ws.bind-failed", { sessionId, error: String(error).slice(0, 160) });
      try {
        socket.send(closeMessage(String(error)));
      } catch {
        // 对端已消失。
      }
      socket.close();
      return;
    }
    if (initial.data.length > 0) socket.send(initial.data);

    let unsubscribe: (() => void) | undefined = manager.subscribe(sessionId, (chunk) => {
      try {
        socket.send(chunk);
      } catch {
        // 对端已消失：等 close 事件统一退订。
      }
    });
    const detach = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    socket.once("close", detach);
    socket.once("error", detach);

    // 回放与订阅之间的增量不能丢：补一次 cursor 之后的读取。
    const missed = manager.read(sessionId, initial.cursor);
    if (missed.data.length > 0) socket.send(missed.data);

    socket.on("close", (code: number, reason: Buffer) => diag("ws.client-close", { sessionId, code, reason: String(reason).slice(0, 80) }));
    socket.on("message", (raw: RawData) => {
      const frame = readFrame(raw);
      if (frame === undefined) return;
      try {
        applyClientFrame(manager, sessionId, frame);
      } catch (error) {
        detach();
        try {
          socket.send(closeMessage(String(error)));
        } catch {
          // 对端已消失。
        }
        socket.close();
      }
    });
  };

  const handleUpgrade: UpgradeRouteLike["handler"] = (request, socket, head) => {
    const pathname = (() => { try { return new URL(request.url ?? "/", "http://x").pathname; } catch { return String(request.url); } })();
    diag("ws.upgrade", { pathname, remote: request.socket.remoteAddress, loopback: isLoopback(request.socket.remoteAddress), sessionId: parseSessionId(request.url ?? "/") ?? null });
    if (!isLoopback(request.socket.remoteAddress)) {
      diag("ws.reject", { reason: "not-loopback", pathname, remote: request.socket.remoteAddress });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = parseSessionId(request.url ?? "/");
    if (sessionId === undefined) {
      diag("ws.reject", { reason: "no-session-id", pathname });
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      bind(client, sessionId);
    });
  };

  return {
    handleUpgrade,
    async close() {
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // 已经断开。
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

/**
 * 把 WebSocket 终端桥接到宿主的升级路由表。
 *
 * 键名精确匹配这一事实（dsh-host-webserver lib/index.js:445 用 pathname 直接查表）
 * 决定了每个会话必须各占一个键：客户端连的是 `/ws/<sessionId>`，所以这里订阅
 * `manager.onOpened` —— 新会话拿到 id 的那一刻注册它的精确路径；`onClosed` 则
 * 释放同一条路径，让路由表与会话生命周期严格同步（重连保持同一 id，故无需换键）。
 */
export function createWsBridge(options: WsBridgeOptions): WsBridge {
  const { manager, registerUpgrade, logger } = options;
  const core = createCore(manager);
  const prefixDisposers: (() => void)[] = [];
  const seats = new Map<string, () => void>();
  const claimed = new Set<string>();

  const seat = (path: string): (() => void) | undefined => {
    if (registerUpgrade === undefined) {
      diag("seat.skipped", { path, reason: "registerUpgrade-missing" });
      return undefined;
    }
    try {
      const dispose = registerUpgrade({ path, handler: core.handleUpgrade });
      diag("seat.registered", { path });
      return dispose;
    } catch (error) {
      diag("seat.failed", { path, error: String(error).slice(0, 160) });
      logger?.warn("uniterminal: upgrade route " + path + " not registered: " + String(error));
      return undefined;
    }
  };

  const claimSession = (sessionId: string): void => {
    if (claimed.has(sessionId)) return;
    claimed.add(sessionId);
    const dispose = seat(SESSION_PATH_PREFIX + sessionId);
    if (dispose !== undefined) seats.set(sessionId, dispose);
  };

  const releaseSession = (sessionId: string): void => {
    if (!claimed.delete(sessionId)) return;
    const dispose = seats.get(sessionId);
    seats.delete(sessionId);
    if (dispose === undefined) return;
    try {
      dispose();
      diag("seat.released", { path: SESSION_PATH_PREFIX + sessionId });
    } catch {
      // 宿主已释放该路由。
    }
  };

  const prefixDispose = seat(UNITERMINAL_ROUTES.wsPrefix);
  if (prefixDispose !== undefined) prefixDisposers.push(prefixDispose);

  const unobserveOpened = manager.onOpened((info) => {
    claimSession(info.id);
  });
  const unobserveClosed = manager.onClosed((id) => {
    releaseSession(id);
  });

  return {
    handleUpgrade: core.handleUpgrade,
    claimSession,
    async dispose() {
      unobserveOpened();
      unobserveClosed();
      for (const sessionId of [...claimed]) releaseSession(sessionId);
      for (const dispose of prefixDisposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 宿主已释放该路由。
        }
      }
      await core.close();
    },
  };
}

/** 独立 http 服务器用法（测试与自托管）：按前缀接管 `upgrade` 事件。 */
export function attachWsServer(options: WsServerAttachmentOptions): WsServerAttachment {
  const core = createCore(options.manager);
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (parseSessionId(request.url ?? "/") === undefined) {
      socket.destroy();
      return;
    }
    core.handleUpgrade(request, socket, head);
  };
  options.server.on("upgrade", onUpgrade);
  return {
    async close() {
      options.server.off("upgrade", onUpgrade);
      await core.close();
    },
  };
}
