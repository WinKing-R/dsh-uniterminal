import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Duplex, Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../src/engine/registry.js";
import { SessionManager } from "../src/engine/session-manager.js";
import { createSshTransport } from "../src/engine/ssh-transport.js";
import type { SshClientLike, SshStreamLike } from "../src/engine/ssh-transport.js";
import type { ResolvedProfile, SessionHandle, TransportAdapter } from "../src/engine/types.js";
import { sftpFromSsh2, type SftpLike, type Ssh2SftpLike } from "../src/engine/sftp.js";
import { TunnelManager } from "../src/engine/tunnel.js";
import { createSessionExec } from "../src/agent-tools.js";
import type { ExecRunner } from "../src/agent-tools.js";
import type { TunnelInfo, TunnelListener, TunnelNet } from "../src/engine/tunnel.js";
import { apply, Config } from "../src/index.js";
import type { PluginContext } from "../src/index.js";
import { AppearanceStore, DEFAULT_APPEARANCE } from "../src/store/appearance.js";
import { KnownHosts } from "../src/store/known-hosts.js";
import { ProfileStore } from "../src/store/profile-store.js";
import { SecurityStore } from "../src/store/security.js";
import { STORAGE_LABEL_FILE, type CredentialBackend } from "../src/store/credential-backend.js";
import {
  UNITERMINAL_ROUTES,
  classifyTransportError,
  createRoutes,
  hostKeyDetails,
  isLoopback,
  matchRoute,
} from "../src/routes.js";
import type { RouteDeps, WebRouteLike } from "../src/routes.js";
import {
  shouldAutoDismissUploads,
  scheduleUploadResultDismiss,
  UPLOAD_CLEAR_LABEL,
  UPLOAD_RESULT_DISMISS_MS,
  uploadResultsView,
} from "../src/client/SftpPanel.js";

/**
 * 本文件顶部的回归锁背景（改断言前先读）：
 * 后端错误响应必须「机器可判别」——传输层失败带 code 分类码，未知主机指纹还带 host/port/fingerprint 三元组，
 * 前端据此写准确文案与「信任并重试」，不必再从英文原文里抠指纹；
 * 同时收紧「只支持 SSH」：注册表里只有 ssh 适配器，建会话只接受 ssh，其它 kind 直接 400。
 * 老前端仍按 payload.error 读文案，因此 error 一个字都不能少。
 */
/**
 * diag 在测试里默认静默（见 host-diag 的 SILENT），这里接管调用记录：
 * 「口令永不进日志」这条安全断言必须看得见 diag 的真实入参。
 */
const diagCalls = vi.hoisted(() => [] as { event: string; data?: Record<string, unknown> }[]);

vi.mock("../src/host-diag.js", () => ({
  diag: (event: string, data?: Record<string, unknown>) => {
    diagCalls.push({ event, data });
  },
}));

/**
 * 客户端面板在 Node 环境里跑不了真 React：本包的 devDependencies 里没有 react/react-dom，
 * 也不允许为断言而装依赖。这里把 hooks 与 jsx 运行时换成记账桩，
 * 「结果行什么时候消失」「进度条什么时候出现」「清除按钮在不在」就能被当普通数据断言。
 */
vi.mock("react", () => ({
  useEffect: () => undefined,
  useRef: () => ({ current: undefined }),
  useState: () => [undefined, () => undefined],
}));
vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));
vi.mock("react/jsx-dev-runtime", () => ({
  jsxDEV: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: null,
}));

const adapter: TransportAdapter = {
  kind: "ssh",
  capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
  open: async (profile) => ({
    id: profile.id,
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  }),
};

function makeManager(): SessionManager {
  const registry = new TransportRegistry();
  registry.register(adapter);
  return new SessionManager(registry, { bufferBytes: 16 });
}

interface SeenAuth {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** 记录 transport 真正收到的凭据：证明解析结果进了连接配置，而不只是过了校验。 */
function keyManager(seen: SeenAuth[]): SessionManager {
  const recording: TransportAdapter = {
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    open: async (profile) => {
      seen.push({ password: profile.password, privateKey: profile.privateKey, passphrase: profile.passphrase });
      return {
        id: profile.id,
        kind: "ssh",
        capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
        write: () => {},
        resize: () => {},
        onData: () => () => {},
        onClose: () => () => {},
        close: async () => {},
      };
    },
  };
  const registry = new TransportRegistry();
  registry.register(recording);
  return new SessionManager(registry, { bufferBytes: 16 });
}

/**
 * 文件后端下的安全状态：这台机器没有可用的系统密码箱，密码明文落盘。
 *
 * M66 起 /security 多了三个字段：storage（存在哪）、storageLabel（人话）、degraded（曾用密码箱、
 * 现在临时降级）。测试进程一律不碰真机密码箱，所以这里恒是文件后端。
 */
const FILE_SECURITY_STATE = {
  mode: "plain",
  legacy: false,
  storage: "file",
  storageLabel: STORAGE_LABEL_FILE,
  degraded: false,
};

/**
 * 一个内存里的假系统密码箱：路由只关心"存在哪"，不关心真机密码箱。
 * （真正的系统密码箱行为由 test/store/security.test.ts 里的假原生模块覆盖。）
 */
class FakeKeychain implements CredentialBackend {
  readonly kind = "keychain" as const;
  readonly label = "密码保存在系统密码箱";
  readonly entries = new Map<string, string>();
  async get(ref: string): Promise<string | undefined> {
    return this.entries.get(ref);
  }
  async put(ref: string, secret: string): Promise<void> {
    this.entries.set(ref, secret);
  }
  async remove(ref: string): Promise<void> {
    this.entries.delete(ref);
  }
  async listRefs(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}

/** 事故现场：存档里是 key 认证，路径是读不到的假路径。 */
const FAKE_KEY_PATH = "C:/ssh/key";
const FORM_SECRET = "form-password-7731";
const FORM_KEY_MARKER = "FORM-KEY-MATERIAL-M2D";
const FORM_KEY_TEXT =
  "-----BEGIN OPENSSH PRIVATE KEY-----\n" + FORM_KEY_MARKER + "\n-----END OPENSSH PRIVATE KEY-----";
const FORM_REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

interface FormFixture {
  routes: WebRouteLike[];
  seen: SeenAuth[];
  profilesPath: string;
}

/** 按事故复刻存档：走真实路由写一条 key 认证 + 假路径的主机。 */
async function setupFakeKeyStored(): Promise<FormFixture> {
  const profilesPath = join(dir, "profiles.json");
  const profiles = new ProfileStore(profilesPath);
  const ready = profiles.load().then(() => undefined);
  const seen: SeenAuth[] = [];
  const routes = createRoutes(keyManager(seen), { profiles, ready });
  await ready;
  const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
    method: "POST",
    body: { profile: { ...PROFILE, id: "p1", auth: { kind: "key", identityPath: FAKE_KEY_PATH } } },
  });
  expect(saved.status).toBe(201);
  return { routes, seen, profilesPath };
}

/** 宿主监听口的替身：ws 端点里的 port 取自 req.socket.localPort（建会话与列表两条路都是它）。 */
const TEST_LOCAL_PORT = 7001;

function fakeRequest(address: string, method = "GET", body?: unknown, url?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = {
    method,
    url,
    socket: { remoteAddress: address, localPort: TEST_LOCAL_PORT },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return request as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  body: unknown;
  /** 响应原文：安全断言要按字节检查（JSON.parse 之后看不出被丢掉的字段）。 */
  raw?: string;
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(payload: string) {
      captured.raw = payload;
      captured.body = JSON.parse(payload);
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function pickRoute(routes: WebRouteLike[], path: string): WebRouteLike {
  const found = routes.find((route) => route.path === path);
  if (found === undefined) throw new Error("route missing: " + path);
  return found;
}

function routeFor(path: string): WebRouteLike {
  return pickRoute(createRoutes(makeManager()), path);
}

const exactRoute = (routes: WebRouteLike[], path: string): WebRouteLike | undefined =>
  routes.find((route) => route.kind === "exact" && route.path === path);

const prefixRoute = (routes: WebRouteLike[], path: string): WebRouteLike | undefined =>
  routes.find((route) => route.kind === "prefix" && route.path === path);

const SSH_CONFIG = [
  "Host web1",
  "  HostName 192.0.2.10",
  "  User deploy",
  "  Port 2222",
  "",
  "Host db1",
  "  HostName 192.0.2.11",
  "  User dba",
  "",
  "Host *",
  "  User nobody",
  "",
].join("\n");

interface Fixture {
  routes: WebRouteLike[];
  profiles: ProfileStore;
  knownHosts: KnownHosts;
  knownHostsPath: string;
  sshConfigPath: string;
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-routes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<Fixture> {
  const profiles = new ProfileStore(join(dir, "profiles.json"));
  const knownHosts = new KnownHosts(join(dir, "known_hosts.json"));
  const sshConfigPath = join(dir, "ssh_config");
  // 与 apply 中一致：同步构造、异步加载，处理器在动作前 await ready
  const ready = Promise.all([profiles.load(), knownHosts.load()]).then(() => undefined);
  const deps: RouteDeps = { profiles, knownHosts, sshConfigPath, ready };
  const routes = createRoutes(makeManager(), deps);
  await ready;
  return { routes, profiles, knownHosts, knownHostsPath: join(dir, "known_hosts.json"), sshConfigPath };
}

/** 走宿主同一套匹配规则（matchRoute）而不是按 path 直接抓 handler。 */
async function call(
  routes: WebRouteLike[],
  pathname: string,
  options: { address?: string; method?: string; body?: unknown; url?: string } = {},
): Promise<Captured> {
  const route = matchRoute(routes, pathname);
  if (route === undefined) throw new Error("no route matches: " + pathname);
  const response = fakeResponse();
  await route.handler(
    fakeRequest(options.address ?? "127.0.0.1", options.method ?? "GET", options.body, options.url ?? pathname),
    response.res,
  );
  return response.captured;
}

/** 分组对外的形状（GET /groups、GET /profiles 的 groups 字段、颜色回写都用它）。 */
type GroupView = { id: string; name: string; parentId: string | null; color?: string };

/** PROFILE 仍按客户端旧契约用 groupPath 入参：M10-A 的兼容面必须被真实覆盖。 */
const PROFILE = {
  id: "p1",
  name: "Web 华东",
  kind: "ssh",
  groupPath: ["生产", "华东"],
  host: "192.0.2.10",
  port: 2222,
  user: "deploy",
};

describe("isLoopback", () => {
  it("accepts loopback forms and rejects everything else", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe("routes", () => {
  it("serves health on loopback only", async () => {
    const route = routeFor(UNITERMINAL_ROUTES.health);
    const ok = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1"), ok.res);
    expect(ok.captured.status).toBe(200);

    const denied = fakeResponse();
    await route.handler(fakeRequest("10.0.0.5"), denied.res);
    expect(denied.captured.status).toBe(403);
  });

  it("creates and lists sessions", async () => {
    const manager = makeManager();
    const route = pickRoute(createRoutes(manager), UNITERMINAL_ROUTES.sessions);

    const created = fakeResponse();
    await route.handler(
      fakeRequest("127.0.0.1", "POST", { profile: { id: "p1", kind: "ssh", host: "h" } }),
      created.res,
    );
    expect(created.captured.status).toBe(201);

    const listed = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1", "GET"), listed.res);
    expect(listed.captured.status).toBe(200);
    expect((listed.captured.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("rejects an invalid profile body", async () => {
    const route = routeFor(UNITERMINAL_ROUTES.sessions);
    const response = fakeResponse();
    await route.handler(fakeRequest("127.0.0.1", "POST", { profile: { id: 1 } }), response.res);
    expect(response.captured.status).toBe(400);
  });
});

describe("close session route", () => {
  async function openSession(routes: WebRouteLike[]): Promise<string> {
    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { id: "p1", kind: "ssh", host: "192.0.2.10" } },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { session?: { id?: string } }).session?.id;
    if (id === undefined) throw new Error("session id missing from the create response");
    return id;
  }

  it("closes an existing session and drops it from the list", async () => {
    const routes = createRoutes(makeManager());
    const id = await openSession(routes);

    const closed = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body: { id } });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ id, closed: true });

    const listed = await call(routes, UNITERMINAL_ROUTES.sessions);
    expect((listed.body as { sessions: unknown[] }).sessions).toHaveLength(0);
  });

  it("answers 200 closed:false for an unknown id and stays idempotent", async () => {
    const routes = createRoutes(makeManager());

    const unknown = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body: { id: "nope" } });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ id: "nope", closed: false });

    const id = await openSession(routes);
    const first = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body: { id } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id, closed: true });

    const second = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body: { id } });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ id, closed: false });
  });

  it("rejects a missing, unparsable or non-string id with a JSON 400 body", async () => {
    const routes = createRoutes(makeManager());
    const bodies: unknown[] = [undefined, {}, { id: 7 }, { id: null }, { id: ["a"] }];
    for (const body of bodies) {
      const response = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(typeof (response.body as { error?: unknown }).error).toBe("string");
    }
  });

  it("refuses a close from a non-loopback peer and leaves the session open", async () => {
    const manager = makeManager();
    const routes = createRoutes(manager);
    const id = await openSession(routes);

    const refused = await call(routes, UNITERMINAL_ROUTES.sessionClose, {
      method: "POST",
      address: "10.0.0.5",
      body: { id },
    });
    expect(refused.status).toBe(403);
    expect(typeof (refused.body as { error?: unknown }).error).toBe("string");
    expect(manager.list()).toHaveLength(1);
  });

  it("keeps the close endpoint on the exact table and answers 405 for other methods", async () => {
    const routes = createRoutes(makeManager());
    expect(UNITERMINAL_ROUTES.sessionClose).toBe("/api/uniterminal/sessions/close");
    expect(matchRoute(routes, UNITERMINAL_ROUTES.sessionClose)).toBe(
      exactRoute(routes, UNITERMINAL_ROUTES.sessionClose),
    );
    // 不得新增 sessions 前缀路由：M1-12 的尾斜杠事故正是前缀匹配造成的
    expect(routes.filter((route) => route.kind === "prefix" && route.path.startsWith("/api/uniterminal/sessions"))).toEqual([]);

    const response = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "GET" });
    expect(response.status).toBe(405);
    expect(typeof (response.body as { error?: unknown }).error).toBe("string");
  });
});

const ORPHAN_PROFILE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };
const LIST_PASSWORD = "orphan-list-pw-3382";
const LIST_PASSPHRASE = "orphan-list-pp-9071";
const LIST_KEY_MARKER = "ORPHAN-LIST-KEY-MATERIAL-M41";
const LIST_KEY_TEXT =
  "-----BEGIN OPENSSH PRIVATE KEY-----\n" + LIST_KEY_MARKER + "\n-----END OPENSSH PRIVATE KEY-----";

/** 建一条会话并回它的 id：孤儿列表的所有用例都从这一步开始。 */
async function openOrphan(routes: WebRouteLike[], profile: Record<string, unknown>): Promise<string> {
  const created = await call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });
  expect(created.status).toBe(201);
  const id = (created.body as { session?: { id?: string } }).session?.id;
  if (id === undefined) throw new Error("session id missing from the create response");
  return id;
}

describe("orphan session list (M4-1)", () => {
  it("lists host, user, port and a ws endpoint for every session", async () => {
    const routes = createRoutes(makeManager());
    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: ORPHAN_PROFILE },
    });
    const id = (created.body as { session?: { id?: string } }).session?.id;
    expect(id).toBeDefined();

    const listed = await call(routes, UNITERMINAL_ROUTES.sessions);
    expect(listed.status).toBe(200);
    const sessions = (listed.body as { sessions: Record<string, unknown>[] }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id,
      kind: "ssh",
      status: "open",
      host: "192.0.2.10",
      user: "deploy",
      port: 2222,
    });
    expect(typeof sessions[0]?.createdAt).toBe("number");
    // 与建会话响应里的 ws 同形：客户端拿到就能直接重连，不必再输密码
    expect(sessions[0]?.ws).toEqual({
      host: "127.0.0.1",
      port: TEST_LOCAL_PORT,
      path: "/api/uniterminal/ws/" + String(id),
    });
    expect((created.body as { ws?: unknown }).ws).toEqual(sessions[0]?.ws);
  });

  it("never serializes a password, passphrase or private key into the list", async () => {
    const routes = createRoutes(makeManager());
    // kind:'both' 让密码与私钥一起进入内存态的 resolved profile：列表要经得住这种会话
    await openOrphan(routes, {
      ...ORPHAN_PROFILE,
      auth: { kind: "both" },
      password: LIST_PASSWORD,
      privateKey: LIST_KEY_TEXT,
      passphrase: LIST_PASSPHRASE,
    });

    const listed = await call(routes, UNITERMINAL_ROUTES.sessions);
    expect(listed.status).toBe(200);
    const raw = listed.raw ?? "";
    expect(raw).not.toContain(LIST_PASSWORD);
    expect(raw).not.toContain(LIST_KEY_MARKER);
    expect(raw).not.toContain(LIST_PASSPHRASE);
    const session = (listed.body as { sessions: Record<string, unknown>[] }).sessions[0] ?? {};
    // 连字段名都不出现：credentials 只活在内存态 profile 里，不进列表
    expect(Object.keys(session)).not.toContain("password");
    expect(Object.keys(session)).not.toContain("privateKey");
    expect(Object.keys(session)).not.toContain("passphrase");
  });

  it("drops a closed session from the list so it can no longer be adopted", async () => {
    const routes = createRoutes(makeManager());
    const id = await openOrphan(routes, ORPHAN_PROFILE);

    const before = await call(routes, UNITERMINAL_ROUTES.sessions);
    expect((before.body as { sessions: unknown[] }).sessions).toHaveLength(1);

    const closed = await call(routes, UNITERMINAL_ROUTES.sessionClose, { method: "POST", body: { id } });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ id, closed: true });

    const after = await call(routes, UNITERMINAL_ROUTES.sessions);
    expect((after.body as { sessions: unknown[] }).sessions).toEqual([]);
  });
});

describe("profile routes", () => {
  it("serves an empty profile list", async () => {
    const { routes } = await setup();
    const body = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect(body.status).toBe(200);
    expect(body.body).toEqual({ profiles: [], groups: [] });
  });

  it("upserts a profile and lists it with its groups afterwards", async () => {
    const { routes, profiles } = await setup();
    const created = await call(routes, UNITERMINAL_ROUTES.profiles, { method: "POST", body: { profile: PROFILE } });
    expect(created.status).toBe(201);

    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect(listed.status).toBe(200);
    const payload = listed.body as { profiles: { id: string; groupId: string | null }[]; groups: GroupView[] };
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]).toMatchObject({ id: "p1", host: "192.0.2.10", port: 2222, user: "deploy" });
    expect(payload.groups.map((group) => group.name)).toEqual(["生产", "华东"]);
    // 旧契约的 groupPath 入参照样被翻译成指向分组表的一条引用
    expect(payload.profiles[0]?.groupId).toBe(profiles.groupByPath(["生产", "华东"])?.id);
  });

  it("generates an id when the body has none", async () => {
    const { routes } = await setup();
    const created = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { name: "无 id 主机", kind: "ssh", host: "192.0.2.12" } },
    });
    expect(created.status).toBe(201);
    const profile = (created.body as { profile: { id?: unknown } }).profile;
    expect(typeof profile.id).toBe("string");
    expect(String(profile.id)).not.toBe("");
  });

  it("rejects a profile that carries a password field and persists nothing", async () => {
    const { routes, profiles } = await setup();
    const response = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, password: "hunter2" } },
    });
    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toMatch(/password/);
    expect(profiles.list()).toHaveLength(0);
  });

  it("removes a profile through the DELETE route", async () => {
    const { routes } = await setup();
    await call(routes, UNITERMINAL_ROUTES.profiles, { method: "POST", body: { profile: PROFILE } });

    const deleted = await call(routes, UNITERMINAL_ROUTES.profiles + "/p1", { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect((listed.body as { profiles: unknown[] }).profiles).toHaveLength(0);
  });

  it("imports hosts from ssh_config and reports the counts", async () => {
    const { routes, sshConfigPath } = await setup();
    await writeFile(sshConfigPath, SSH_CONFIG, "utf8");

    const imported = await call(routes, UNITERMINAL_ROUTES.profilesImport, { method: "POST", body: {} });
    expect(imported.status).toBe(200);
    const result = imported.body as {
      imported: number;
      skipped: { alias: string; reason: string }[];
      directives: string[];
    };
    expect(result.imported).toBe(2);
    expect(result.skipped.map((entry) => entry.alias)).toContain("*");
    expect(result.directives).toEqual([]);

    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    const payload = listed.body as {
      profiles: { name: string; host?: string; port?: number; user?: string }[];
      groups: GroupView[];
    };
    expect(payload.profiles.map((profile) => profile.name).sort()).toEqual(["db1", "web1"]);
    const web1 = payload.profiles.find((profile) => profile.name === "web1");
    expect(web1).toMatchObject({ host: "192.0.2.10", port: 2222, user: "deploy" });
    // 导入的主机统一挂在 ssh-config 分组下（分组由导入动作自己建）
    expect(payload.groups.map((group) => group.name)).toContain("ssh-config");

    const again = await call(routes, UNITERMINAL_ROUTES.profilesImport, { method: "POST", body: {} });
    expect((again.body as { imported: number }).imported).toBe(2);
    const relisted = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect((relisted.body as { profiles: unknown[] }).profiles).toHaveLength(2);
  });

  // M3-3：ssh_config 里的 ProxyJump 以前被解析出来又丢掉，导入的主机于是悄悄变成直连。
  it("persists ProxyJump from ssh_config into the imported profile", async () => {
    const { routes, profiles, sshConfigPath } = await setup();
    await writeFile(
      sshConfigPath,
      [
        "Host single",
        "  HostName 10.0.0.1",
        "  ProxyJump bastion.example.com",
        "",
        "Host one-hop",
        "  HostName 10.0.0.2",
        "  ProxyJump user@host:2222",
        "",
      ].join("\n"),
      "utf8",
    );

    const imported = await call(routes, UNITERMINAL_ROUTES.profilesImport, { method: "POST", body: {} });
    expect(imported.status).toBe(200);

    expect(profiles.get("ssh-config:single")?.proxyJump).toEqual(["bastion.example.com"]);
    expect(profiles.get("ssh-config:one-hop")?.proxyJump).toEqual(["user@host:2222"]);

    // 落盘之后重新加载（走 profile-store 的校验）仍然在
    const reloaded = new ProfileStore(join(dir, "profiles.json"));
    await reloaded.load();
    expect(reloaded.get("ssh-config:single")?.proxyJump).toEqual(["bastion.example.com"]);
    expect(reloaded.get("ssh-config:one-hop")?.proxyJump).toEqual(["user@host:2222"]);
  });

  it("saves a proxyJump given explicitly through the profiles route", async () => {
    const { routes, profiles } = await setup();

    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p-jump", proxyJump: ["ops@bastion.example.com:2222"] } },
    });

    expect(saved.status).toBe(201);
    expect(profiles.get("p-jump")?.proxyJump).toEqual(["ops@bastion.example.com:2222"]);
  });

  it("returns 503 for profile routes when no store was injected", async () => {
    const routes = createRoutes(makeManager());
    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect(listed.status).toBe(503);
    const imported = await call(routes, UNITERMINAL_ROUTES.profilesImport, { method: "POST", body: {} });
    expect(imported.status).toBe(503);
    const trusted = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { host: "192.0.2.10", port: 22, fingerprint: "SHA256:aaa" },
    });
    expect(trusted.status).toBe(503);
  });

  it("refuses profile and trust writes from a non-loopback peer", async () => {
    const { routes } = await setup();
    const created = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      address: "10.0.0.5",
      body: { profile: PROFILE },
    });
    expect(created.status).toBe(403);
    const trusted = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      address: "10.0.0.5",
      body: { host: "192.0.2.10", port: 22, fingerprint: "SHA256:aaa" },
    });
    expect(trusted.status).toBe(403);
  });
});

describe("folder routes", () => {
  it("creates an empty folder through the exact route and lists it in groups", async () => {
    const { routes, profiles } = await setup();

    const created = await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["空分组"] } });
    expect(created.status).toBe(201);
    const body = created.body as { path: string[]; group: GroupView };
    expect(body.path).toEqual(["空分组"]);
    expect(body.group).toMatchObject({ name: "空分组", parentId: null });
    expect(typeof body.group.id).toBe("string");
    expect(profiles.listGroups().map((group) => group.name)).toEqual(["空分组"]);

    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect((listed.body as { groups: GroupView[] }).groups).toEqual([body.group]);
  });

  it("accepts the same folder twice without error or duplication", async () => {
    const { routes, profiles } = await setup();

    const first = await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["运维", "北京"] } });
    const second = await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["运维", "北京"] } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body as { group: GroupView }).group.id).toBe((first.body as { group: GroupView }).group.id);
    expect(profiles.listGroups().map((group) => group.name)).toEqual(["运维", "北京"]);
  });

  it("deletes a folder without deleting the hosts inside it", async () => {
    const { routes } = await setup();
    await call(routes, UNITERMINAL_ROUTES.profiles, { method: "POST", body: { profile: PROFILE } });
    await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["生产", "华东"] } });

    const deleted = await call(routes, UNITERMINAL_ROUTES.foldersDelete, {
      method: "POST",
      body: { path: ["生产", "华东"] },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ path: ["生产", "华东"], removed: true });

    const listed = await call(routes, UNITERMINAL_ROUTES.profiles);
    const payload = listed.body as { profiles: { id: string; groupId: string | null }[]; groups: GroupView[] };
    // 上级「生产」是分组表里真实存在的一行，删掉子分组不该顺手把它也删了
    expect(payload.groups.map((group) => group.name)).toEqual(["生产"]);
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]?.id).toBe("p1");
    expect(payload.profiles[0]?.groupId).toBeNull();
  });

  it("reports removed:false for a folder that was never created", async () => {
    const { routes } = await setup();
    const deleted = await call(routes, UNITERMINAL_ROUTES.foldersDelete, {
      method: "POST",
      body: { path: ["没有这个分组"] },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ path: ["没有这个分组"], removed: false });
  });

  it("rejects a malformed folder path with a JSON 400 body", async () => {
    const { routes, profiles } = await setup();
    for (const path of [[], [""], ["a/b"], "nope", undefined]) {
      const created = await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path } });
      expect(created.status).toBe(400);
      expect(typeof (created.body as { error?: unknown }).error).toBe("string");
      const deleted = await call(routes, UNITERMINAL_ROUTES.foldersDelete, { method: "POST", body: { path } });
      expect(deleted.status).toBe(400);
      expect(typeof (deleted.body as { error?: unknown }).error).toBe("string");
    }
    expect(profiles.listGroups()).toEqual([]);
  });

  it("refuses folder writes from a non-loopback peer", async () => {
    const { routes, profiles } = await setup();
    const created = await call(routes, UNITERMINAL_ROUTES.folders, {
      method: "POST",
      address: "10.0.0.5",
      body: { path: ["生产"] },
    });
    expect(created.status).toBe(403);
    const deleted = await call(routes, UNITERMINAL_ROUTES.foldersDelete, {
      method: "POST",
      address: "10.0.0.5",
      body: { path: ["生产"] },
    });
    expect(deleted.status).toBe(403);
    expect(profiles.listGroups()).toEqual([]);
  });

  it("answers 503 for folder routes when no store was injected", async () => {
    const routes = createRoutes(makeManager());
    const created = await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["生产"] } });
    expect(created.status).toBe(503);
    const deleted = await call(routes, UNITERMINAL_ROUTES.foldersDelete, { method: "POST", body: { path: ["生产"] } });
    expect(deleted.status).toBe(503);
  });

  it("keeps both folder endpoints on the exact table", () => {
    const routes = createRoutes(makeManager());
    expect(matchRoute(routes, UNITERMINAL_ROUTES.folders)).toBe(exactRoute(routes, UNITERMINAL_ROUTES.folders));
    expect(matchRoute(routes, UNITERMINAL_ROUTES.foldersDelete)).toBe(
      exactRoute(routes, UNITERMINAL_ROUTES.foldersDelete),
    );
    // 不得出现 /api/uniterminal/folders 前缀路由：尾斜杠曾把 /folders/delete 变成 404
    expect(routes.filter((route) => route.kind === "prefix" && route.path.startsWith("/api/uniterminal/folders"))).toEqual([]);
  });
});

describe("group routes (M10-A)", () => {
  /** 与 setup() 同款接线，额外注入 appearance：颜色只许落在分组上，外观表必须一动不动。 */
  async function setupGroups(): Promise<{
    routes: WebRouteLike[];
    profiles: ProfileStore;
    appearance: AppearanceStore;
  }> {
    const profiles = new ProfileStore(join(dir, "profiles.json"));
    const appearance = new AppearanceStore(join(dir, "appearance"));
    const ready = Promise.all([profiles.load(), appearance.load()]).then(() => undefined);
    const routes = createRoutes(makeManager(), { profiles, appearance, ready });
    await ready;
    return { routes, profiles, appearance };
  }

  it("serves the group table with id, name, parentId and colour", async () => {
    const { routes, profiles } = await setupGroups();
    const east = await profiles.ensureGroup(["生产", "华东"]);
    await profiles.setGroupColor(east.id, "#ff0000");

    const listed = await call(routes, UNITERMINAL_ROUTES.groups);

    expect(listed.status).toBe(200);
    const groups = (listed.body as { groups: GroupView[] }).groups;
    expect(groups.map((group) => group.name)).toEqual(["生产", "华东"]);
    const parent = groups.find((group) => group.name === "生产");
    expect(groups.find((group) => group.name === "华东")).toEqual({
      id: east.id,
      name: "华东",
      parentId: parent?.id,
      color: "#ff0000",
    });
  });

  it("writes the colour onto the group and never into appearance", async () => {
    const { routes, profiles, appearance } = await setupGroups();
    const group = await profiles.ensureGroup(["生产"]);

    const saved = await call(routes, UNITERMINAL_ROUTES.groupsColor, {
      method: "POST",
      body: { path: ["生产"], color: "#4a9" },
    });

    expect(saved.status).toBe(200);
    expect((saved.body as { group: GroupView }).group).toEqual({
      id: group.id,
      name: "生产",
      parentId: null,
      color: "#4a9",
    });
    expect(profiles.groupById(group.id)?.color).toBe("#4a9");
    // appearance.groupColors 从此只作为迁移来源读一次：这条路径绝不写它
    expect(appearance.current().groupColors).toBeUndefined();
  });

  it("clears a colour with null and addresses the group by id just as well", async () => {
    const { routes, profiles } = await setupGroups();
    const group = await profiles.ensureGroup(["生产"]);
    await profiles.setGroupColor(group.id, "#123456");

    const cleared = await call(routes, UNITERMINAL_ROUTES.groupsColor, {
      method: "POST",
      body: { groupId: group.id, color: null },
    });

    expect(cleared.status).toBe(200);
    expect((cleared.body as { group: GroupView }).group).toEqual({ id: group.id, name: "生产", parentId: null });
    expect(profiles.groupById(group.id)?.color).toBeUndefined();
  });

  it("rejects a malformed colour and a body with neither path nor id", async () => {
    const { routes } = await setupGroups();
    const bodies: unknown[] = [
      { path: ["生产"], color: "red" },
      { path: ["生产"], color: "#12" },
      { color: "#fff" },
      { groupId: "", color: "#fff" },
    ];
    for (const body of bodies) {
      const response = await call(routes, UNITERMINAL_ROUTES.groupsColor, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(typeof (response.body as { error?: unknown }).error).toBe("string");
    }
  });

  it("answers 404 for an unknown group and 405 for a non-POST colour write", async () => {
    const { routes } = await setupGroups();
    const missing = await call(routes, UNITERMINAL_ROUTES.groupsColor, {
      method: "POST",
      body: { path: ["没有这个分组"], color: "#fff" },
    });
    expect(missing.status).toBe(404);
    const notPost = await call(routes, UNITERMINAL_ROUTES.groupsColor);
    expect(notPost.status).toBe(405);
  });

  it("refuses group reads and writes from a non-loopback peer", async () => {
    const { routes } = await setupGroups();
    const listed = await call(routes, UNITERMINAL_ROUTES.groups, { address: "10.0.0.5" });
    expect(listed.status).toBe(403);
    const saved = await call(routes, UNITERMINAL_ROUTES.groupsColor, {
      method: "POST",
      address: "10.0.0.5",
      body: { path: ["生产"], color: "#fff" },
    });
    expect(saved.status).toBe(403);
  });

  it("answers 503 for the group endpoints when no store was injected", async () => {
    const routes = createRoutes(makeManager());
    expect((await call(routes, UNITERMINAL_ROUTES.groups)).status).toBe(503);
    const saved = await call(routes, UNITERMINAL_ROUTES.groupsColor, {
      method: "POST",
      body: { path: ["生产"], color: "#fff" },
    });
    expect(saved.status).toBe(503);
  });

  it("keeps the group endpoints on the exact table", () => {
    expect(UNITERMINAL_ROUTES.groups).toBe("/api/uniterminal/groups");
    expect(UNITERMINAL_ROUTES.groupsColor).toBe("/api/uniterminal/groups/color");
    const routes = createRoutes(makeManager());
    expect(matchRoute(routes, UNITERMINAL_ROUTES.groups)).toBe(exactRoute(routes, UNITERMINAL_ROUTES.groups));
    expect(matchRoute(routes, UNITERMINAL_ROUTES.groupsColor)).toBe(
      exactRoute(routes, UNITERMINAL_ROUTES.groupsColor),
    );
    // 不得出现 /groups 前缀路由：尾斜杠会把 /groups/color 吞成列表
    expect(routes.filter((route) => route.kind === "prefix" && route.path.startsWith("/api/uniterminal/groups"))).toEqual([]);
  });
});

describe("folder rename routes", () => {
  /** 与 setup() 同款接线，额外注入 appearance：改名绝不该再碰颜色表。 */
  async function setupRename(): Promise<{
    routes: WebRouteLike[];
    profiles: ProfileStore;
    appearance: AppearanceStore;
  }> {
    const profiles = new ProfileStore(join(dir, "profiles.json"));
    const appearance = new AppearanceStore(join(dir, "appearance"));
    const ready = Promise.all([profiles.load(), appearance.load()]).then(() => undefined);
    const routes = createRoutes(makeManager(), { profiles, appearance, ready });
    await ready;
    return { routes, profiles, appearance };
  }

  /** 建一台挂在 groupPath 下的主机：走真实路由，免得测试自己伪造列表。 */
  async function addHost(routes: WebRouteLike[], id: string, groupPath: string[]): Promise<void> {
    const created = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { id, name: id, kind: "ssh", groupPath, host: "192.0.2.10", port: 22, user: "root" } },
    });
    expect(created.status).toBe(201);
  }

  const paths = (profiles: ProfileStore): string[][] =>
    profiles.listGroups().map((group) => profiles.groupPath(group.id));

  it("renames only the target group and leaves every host on its own group id", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产", "华东"]);
    await addHost(routes, "p2", ["生产", "华东", "机房A"]);
    await addHost(routes, "p3", ["测试"]);
    await addHost(routes, "p4", ["生产", "华东2"]);
    const before = new Map(profiles.list().map((profile) => [profile.id, profile.groupId]));

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产", "华东"], name: "华南" },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ renamed: 1 });
    // 一台主机都没被搬：分组换了名字，路径是派生的
    expect(new Map(profiles.list().map((profile) => [profile.id, profile.groupId]))).toEqual(before);
    const byId = new Map(profiles.list().map((profile) => [profile.id, profiles.groupPath(profile.groupId)]));
    expect(byId.get("p1")).toEqual(["生产", "华南"]);
    expect(byId.get("p2")).toEqual(["生产", "华南", "机房A"]);
    expect(byId.get("p3")).toEqual(["测试"]);
    expect(byId.get("p4")).toEqual(["生产", "华东2"]);
  });

  it("renames a folder that was declared on its own, leaving no ghost behind", async () => {
    const { routes, profiles } = await setupRename();
    await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["运维", "北京"] } });
    await call(routes, UNITERMINAL_ROUTES.folders, { method: "POST", body: { path: ["运维", "北京", "机房B"] } });

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["运维", "北京"], name: "上海" },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ renamed: 1 });
    // 每一级都是一个真实分组行：改名只动被点名的那个，祖先与子级都跟着走
    expect(paths(profiles)).toEqual([["运维"], ["运维", "上海"], ["运维", "上海", "机房B"]]);
  });

  it("keeps the colour on the group and leaves appearance alone", async () => {
    const { routes, profiles, appearance } = await setupRename();
    await addHost(routes, "p1", ["生产", "华东"]);
    const group = profiles.groupByPath(["生产", "华东"]);
    expect(group).toBeDefined();
    await profiles.setGroupColor(group?.id ?? "", "#ff0000");

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产", "华东"], name: "华南" },
    });

    expect(renamed.status).toBe(200);
    expect(profiles.groupById(group?.id ?? "")).toMatchObject({ name: "华南", color: "#ff0000" });
    // 颜色跟着分组走：改名不再需要搬 key，外观表一个字节都没被写
    expect(appearance.current().groupColors).toBeUndefined();
  });

  it("answers renamed:0 for a path that does not exist and creates nothing", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产"]);

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["没有这个分组"], name: "新名" },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ renamed: 0 });
    expect(paths(profiles)).toEqual([["生产"]]);
  });

  it("refuses folder renames from a non-loopback peer", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产"]);

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      address: "10.0.0.5",
      body: { path: ["生产"], name: "测试" },
    });

    expect(renamed.status).toBe(403);
    expect(profiles.groupByPath(["生产"])).toBeDefined();
  });

  it("rejects an invalid path or name with a JSON 400 body", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产"]);
    const bodies: unknown[] = [
      { path: [], name: "x" },
      { path: [""], name: "x" },
      { name: "x" },
      { path: ["生产"], name: "" },
      { path: ["生产"], name: "   " },
      { path: ["生产"], name: "甲/乙" },
      { path: ["生产"], name: 42 },
      { path: ["生产"], name: "长".repeat(65) },
    ];
    for (const body of bodies) {
      const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, { method: "POST", body });
      expect(renamed.status).toBe(400);
      expect(typeof (renamed.body as { error?: unknown }).error).toBe("string");
    }
    expect(profiles.groupByPath(["生产"])).toBeDefined();
  });

  it("rejects a group name longer than the shared limit", async () => {
    const { NAME_MAX } = await import("../src/name-limits.js");
    const { routes } = await setupRename();
    await addHost(routes, "p1", ["生产"]);

    const tooLong = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产"], name: "长".repeat(NAME_MAX + 1) },
    });

    expect(tooLong.status).toBe(400);
  });
  it("accepts a 16 character name and answers 405 for a non-POST method", async () => {
    const { routes } = await setupRename();
    await addHost(routes, "p1", ["生产"]);

    const notPost = await call(routes, UNITERMINAL_ROUTES.foldersRename);
    expect(notPost.status).toBe(405);

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产"], name: "长".repeat(16) },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ renamed: 1 });
  });

  it("answers 503 when no store was injected", async () => {
    const routes = createRoutes(makeManager());
    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产"], name: "测试" },
    });
    expect(renamed.status).toBe(503);
  });

  it("keeps the rename endpoint on the exact table", () => {
    expect(UNITERMINAL_ROUTES.foldersRename).toBe("/api/uniterminal/folders/rename");
    const routes = createRoutes(makeManager());
    expect(matchRoute(routes, UNITERMINAL_ROUTES.foldersRename)).toBe(
      exactRoute(routes, UNITERMINAL_ROUTES.foldersRename),
    );
  });
});

describe("trust route", () => {
  it("persists a trusted fingerprint into known_hosts.json", async () => {
    const { routes, knownHosts, knownHostsPath } = await setup();
    const fingerprint = "SHA256:aaabbbcccdddeee";

    const response = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { host: "192.0.2.10", port: 2222, fingerprint },
    });
    expect(response.status).toBe(200);

    expect(knownHosts.check("192.0.2.10", 2222, fingerprint)).toBe("match");
    const persisted = await readFile(knownHostsPath, "utf8");
    expect(persisted).toContain(fingerprint);

    const reloaded = new KnownHosts(knownHostsPath);
    await reloaded.load();
    expect(reloaded.check("192.0.2.10", 2222, fingerprint)).toBe("match");
  });

  it("refuses to overwrite a fingerprint that already changed", async () => {
    const { routes, knownHosts } = await setup();
    await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { host: "192.0.2.10", port: 22, fingerprint: "SHA256:original" },
    });

    const changed = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { host: "192.0.2.10", port: 22, fingerprint: "SHA256:attacker" },
    });
    expect(changed.status).toBe(409);
    expect(knownHosts.check("192.0.2.10", 22, "SHA256:original")).toBe("match");
  });

  it("rejects a body without a host or fingerprint", async () => {
    const { routes } = await setup();
    const missingFingerprint = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { host: "192.0.2.10", port: 22 },
    });
    expect(missingFingerprint.status).toBe(400);
    const missingHost = await call(routes, UNITERMINAL_ROUTES.hostTrust, {
      method: "POST",
      body: { port: 22, fingerprint: "SHA256:aaa" },
    });
    expect(missingHost.status).toBe(400);
  });
});

/** 模拟 ssh2：KEX 之后把 SHA256 指纹交给 hostVerifier，被拒则触发 error。 */
function hostKeyClient(fingerprint: string): SshClientLike {
  let onError: (error: Error) => void = () => {};
  let onReady: () => void = () => {};
  const client = {
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "error") onError = cb as (error: Error) => void;
      if (event === "ready") onReady = cb as () => void;
    },
    connect(config: Record<string, unknown>) {
      const verifier = config.hostVerifier as ((hash: string, done: (accept: boolean) => void) => void) | undefined;
      if (verifier === undefined) {
        onReady();
        return;
      }
      try {
        verifier(fingerprint, (accept) => {
          if (accept) onReady();
          else onError(new Error("Host key verification failed"));
        });
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    shell(_options: unknown, done: (error: Error | undefined, stream: unknown) => void) {
      done(undefined, { write: () => true, setWindow: () => {}, on: () => {}, close: () => {} });
    },
    end: () => {},
    destroy: () => {},
  };
  return client as unknown as SshClientLike;
}

describe("known host key enforcement", () => {
  it("fails a session to an untrusted host with the uniterminal error", async () => {
    const knownHosts = new KnownHosts(join(dir, "known_hosts.json"));
    await knownHosts.load();

    const registry = new TransportRegistry();
    registry.register(createSshTransport(() => hostKeyClient("SHA256:unknown"), { knownHosts }));
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const routes = createRoutes(manager, { knownHosts });

    const response = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { id: "probe", kind: "ssh", host: "192.0.2.10", port: 2222 } },
    });
    expect(response.status).toBe(500);
    // 回归意图不变：不受信任的主机连不上（会话没开成），而且失败必须指名「未知指纹」。
    // 英文原文不再原样透出（前端要靠机器可判别的字段写文案），改成 code + 指纹三元组。
    const body = response.body as {
      error?: string;
      code?: string;
      host?: string;
      port?: number;
      fingerprint?: string;
    };
    expect(body.code).toBe("hostkey");
    expect(String(body.error)).toContain("主机指纹未知");
    expect(body.host).toBe("192.0.2.10");
    expect(body.port).toBe(2222);
    expect(body.fingerprint).toBe("SHA256:unknown");
  });

  it("lets the session through once the fingerprint is trusted", async () => {
    const knownHosts = new KnownHosts(join(dir, "known_hosts.json"));
    await knownHosts.load();
    await knownHosts.trust("192.0.2.10", 2222, "SHA256:known");

    const registry = new TransportRegistry();
    registry.register(createSshTransport(() => hostKeyClient("SHA256:known"), { knownHosts }));
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const routes = createRoutes(manager, { knownHosts });

    const response = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { id: "probe", kind: "ssh", host: "192.0.2.10", port: 2222 } },
    });
    expect(response.status).toBe(201);
  });
});

describe("route matching", () => {
  it("registers the profile prefix without a trailing slash", () => {
    expect(UNITERMINAL_ROUTES.profilesPrefix).toBe("/api/uniterminal/profiles");
    expect(UNITERMINAL_ROUTES.profilesPrefix.endsWith("/")).toBe(false);
  });

  it("matches an encoded profile id to the DELETE route and deletes it", async () => {
    const { routes, profiles } = await setup();
    const id = "ssh-config:192.0.2.25";
    await profiles.upsert({
      id,
      name: "web1",
      kind: "ssh",
      groupId: null,
      host: "192.0.2.25",
      createdAt: 0,
      updatedAt: 0,
    });

    const pathname = "/api/uniterminal/profiles/" + encodeURIComponent(id);
    expect(matchRoute(routes, pathname)).toBe(prefixRoute(routes, UNITERMINAL_ROUTES.profilesPrefix));

    const deleted = await call(routes, pathname, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id, removed: true });
    expect(profiles.get(id)).toBeUndefined();
  });

  it("keeps the profile list and create route on the exact table", () => {
    const routes = createRoutes(makeManager());
    expect(matchRoute(routes, "/api/uniterminal/profiles")).toBe(exactRoute(routes, "/api/uniterminal/profiles"));
  });

  it("keeps the profile import route on the exact table", () => {
    const routes = createRoutes(makeManager());
    expect(matchRoute(routes, "/api/uniterminal/profiles/import")).toBe(
      exactRoute(routes, "/api/uniterminal/profiles/import"),
    );
  });

  it("returns undefined for a path no route claims", () => {
    expect(matchRoute(createRoutes(makeManager()), "/api/uniterminal/nope")).toBeUndefined();
  });

  it("answers 404 with a uniterminal JSON error for an empty profile id", async () => {
    const { routes } = await setup();
    const response = await call(routes, "/api/uniterminal/profiles/", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(String((response.body as { error?: string }).error)).toMatch(/^uniterminal: /);
  });

  it("serves a DELETE for a colon id over real HTTP through the host-style matcher", async () => {
    const { routes, profiles } = await setup();
    const id = "ssh-config:192.0.2.25";
    await profiles.upsert({
      id,
      name: "web1",
      kind: "ssh",
      groupId: null,
      host: "192.0.2.25",
      createdAt: 0,
      updatedAt: 0,
    });

    // 与宿主同一套分派：matchRoute 决定 handler，未命中交给兜底文本 —— 正是缺陷 2 里那句 not found。
    const server = createServer((req, res) => {
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      const route = matchRoute(routes, pathname);
      if (route === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      void route.handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const response = await fetch(
        "http://127.0.0.1:" + String(port) + "/api/uniterminal/profiles/" + encodeURIComponent(id),
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, removed: true });
      expect(profiles.get(id)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers 404 instead of throwing on a malformed percent-encoded id", async () => {
    const { routes } = await setup();
    const response = await call(routes, "/api/uniterminal/profiles/%E0%A4%A", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(String((response.body as { error?: string }).error)).toMatch(/^uniterminal: /);
  });
});
describe("security routes", () => {
  const SECURITY_PATHS: string[] = [
    UNITERMINAL_ROUTES.security,
    UNITERMINAL_ROUTES.securityClearLegacy,
    UNITERMINAL_ROUTES.securityRefs,
  ];
  /**
   * 旧版（已停用）档位的四个路径：公开 API 面上它们必须彻底消失。
   * 留着就是四块没人调的死接口——审阅者会问"谁在用、审过吗"。
   */
  const REMOVED_SECURITY_PATHS: string[] = [
    "/api/uniterminal/security/setup",
    "/api/uniterminal/security/unlock",
    "/api/uniterminal/security/lock",
    "/api/uniterminal/security/reset-to-plain",
  ];

  /** 与 apply 一致：库只用临时目录构造，load 并入同一个 ready，处理器动作前 await 它。 */
  async function setupSecurity(): Promise<{ routes: WebRouteLike[]; security: SecurityStore }> {
    const security = new SecurityStore(join(dir, "security"));
    const ready = security.load().then(() => undefined);
    const routes = createRoutes(makeManager(), { security, ready });
    await ready;
    return { routes, security };
  }

  /**
   * 造一个旧档现场：security.json 登记成 protected + vault.bin 在场。
   * vault.bin 里放什么没人读得了——它在场这件事本身就是全部意义。
   */
  async function setupLegacy(): Promise<{ routes: WebRouteLike[]; security: SecurityStore }> {
    const securityDir = join(dir, "security");
    await mkdir(securityDir, { recursive: true });
    await writeFile(join(securityDir, "security.json"), JSON.stringify({ version: 1, mode: "protected" }) + "\n", "utf8");
    await writeFile(join(securityDir, "vault.bin"), "legacy-bytes-nobody-reads", "utf8");
    const security = new SecurityStore(securityDir);
    const ready = security.load().then(() => undefined);
    const routes = createRoutes(makeManager(), { security, ready });
    await ready;
    return { routes, security };
  }

  it("serves the only mode there is: plain, with legacy=false", async () => {
    const { routes } = await setupSecurity();

    const response = await call(routes, UNITERMINAL_ROUTES.security);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(FILE_SECURITY_STATE);
  });

  /**
   * M66：/security 要说清楚**密码存在哪**——系统密码箱还是本机文件。
   *
   * 界面就靠这三个字段说话（storage / storageLabel / degraded），说错一句用户就会以为
   * 自己的密码存在一个它以为不存在的地方。
   */
  it("says where the password lives: the OS password box when there is one", async () => {
    const security = new SecurityStore(join(dir, "security-keychain"), { backend: new FakeKeychain() });
    const ready = security.load().then(() => undefined);
    const routes = createRoutes(makeManager(), { security, ready });
    await ready;

    const response = await call(routes, UNITERMINAL_ROUTES.security);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      mode: "plain",
      legacy: false,
      storage: "keychain",
      storageLabel: "密码保存在系统密码箱",
      degraded: false,
    });
  });

  /**
   * 错误要诚实：密码箱此刻不可用时，"请输入密码"是**错的**——
   * 用户会以为自己的密码没记住，于是重新输入一遍（而真相是后端暂时用不了）。
   */
  it("the keychain being unavailable is its own error, never 'please enter the password'", async () => {
    const profiles = new ProfileStore(join(dir, "profiles-honest.json"));
    await profiles.load();
    const security = {
      state: () => ({ ...FILE_SECURITY_STATE, storage: "keychain", degraded: true }),
      degraded: () => true,
      get: async () => undefined,
      put: async () => {},
      remove: async () => {},
      listRefs: async () => [],
    } as unknown as SecurityStore;
    const routes = createRoutes(makeManager(), { profiles, security });

    const response = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { id: "p1", kind: "ssh", host: "192.0.2.10" } },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toBe("系统密码箱不可用，请稍后重试");
  });

  it("reports a legacy file as legacy=true and offers no ref at all", async () => {
    const { routes, security } = await setupLegacy();

    const state = await call(routes, UNITERMINAL_ROUTES.security);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ...FILE_SECURITY_STATE, legacy: true });
    expect(security.state()).toEqual({ ...FILE_SECURITY_STATE, legacy: true });

    // 旧档里的密码不解密、不迁移：等价于「没存过密码」
    const refs = await call(routes, UNITERMINAL_ROUTES.securityRefs);
    expect(refs.status).toBe(200);
    expect(refs.body).toEqual({ refs: [] });
  });

  it("never deletes the legacy file while loading: the data stays until the user cleans it", async () => {
    const { security } = await setupLegacy();

    expect(security.state().legacy).toBe(true);
    // load() 之后 vault.bin 还在：升级绝不静默毁数据
    await expect(readFile(join(dir, "security", "vault.bin"), "utf8")).resolves.toContain("legacy-bytes");
  });

  it("clears the legacy file: vault.bin goes, security.json turns plain, credentials.json appears", async () => {
    const { routes, security } = await setupLegacy();

    const cleared = await call(routes, UNITERMINAL_ROUTES.securityClearLegacy, { method: "POST", body: { confirm: true } });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual(FILE_SECURITY_STATE);
    expect(security.state()).toEqual(FILE_SECURITY_STATE);

    await expect(readFile(join(dir, "security", "vault.bin"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(JSON.parse(await readFile(join(dir, "security", "security.json"), "utf8"))).toEqual({
      version: 1,
      mode: "plain",
      storage: "file",
    });
    expect(JSON.parse(await readFile(join(dir, "security", "credentials.json"), "utf8"))).toEqual({
      version: 1,
      entries: {},
    });
    expect((await call(routes, UNITERMINAL_ROUTES.security)).body).toEqual(FILE_SECURITY_STATE);
  });

  it("answers a JSON 400 for clear-legacy without an explicit confirm", async () => {
    const { routes, security } = await setupLegacy();

    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, { confirmed: true }, undefined]) {
      const response = await call(routes, UNITERMINAL_ROUTES.securityClearLegacy, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(typeof (response.body as { error?: unknown }).error).toBe("string");
    }
    // 拒绝之后旧档原样留着：不确认就不动用户的文件
    expect(security.state()).toEqual({ ...FILE_SECURITY_STATE, legacy: true });
    await expect(readFile(join(dir, "security", "vault.bin"), "utf8")).resolves.toContain("legacy-bytes");
  });

  it("keeps the status query and the cleanup action on separate paths", async () => {
    const { routes } = await setupSecurity();

    // 状态查询只认 GET、清理动作只认 POST：两条路由不能串（旧的 setup 被 GET 吞掉就是这么来的）
    const posted = await call(routes, UNITERMINAL_ROUTES.security, { method: "POST", body: {} });
    expect(posted.status).toBe(405);
    const got = await call(routes, UNITERMINAL_ROUTES.securityClearLegacy);
    expect(got.status).toBe(405);
  });

  it("no longer exposes setup, unlock, lock or reset-to-plain", async () => {
    const routes = createRoutes(makeManager());
    for (const pathname of REMOVED_SECURITY_PATHS) {
      // 宿主对没有匹配路由的路径回 404：matchRoute 找不到 = 那条路径已经不存在
      expect(matchRoute(routes, pathname)).toBeUndefined();
    }
    // security 路径空间里只剩这三条
    const securityPaths = routes
      .filter((route) => route.path.startsWith("/api/uniterminal/security"))
      .map((route) => route.path)
      .sort();
    expect(securityPaths).toEqual([
      "/api/uniterminal/security",
      "/api/uniterminal/security/clear-legacy",
      "/api/uniterminal/security/refs",
    ]);
  });

  it("refuses every security route from a non-loopback peer", async () => {
    const { routes, security } = await setupSecurity();
    for (const pathname of SECURITY_PATHS) {
      const response = await call(routes, pathname, {
        method: pathname === UNITERMINAL_ROUTES.securityClearLegacy ? "POST" : "GET",
        address: "10.0.0.5",
        body: { confirm: true },
      });
      expect(response.status).toBe(403);
      expect(typeof (response.body as { error?: unknown }).error).toBe("string");
    }
    expect(security.state()).toEqual(FILE_SECURITY_STATE);
  });

  it("answers 503 for every security route when no store was injected", async () => {
    const routes = createRoutes(makeManager());
    for (const pathname of SECURITY_PATHS) {
      const response = await call(routes, pathname, {
        method: pathname === UNITERMINAL_ROUTES.securityClearLegacy ? "POST" : "GET",
        body: { confirm: true },
      });
      expect(response.status).toBe(503);
      expect(typeof (response.body as { error?: unknown }).error).toBe("string");
    }
  });

  it("keeps every security path on the exact table", () => {
    expect(UNITERMINAL_ROUTES.security).toBe("/api/uniterminal/security");
    expect(UNITERMINAL_ROUTES.securityClearLegacy).toBe("/api/uniterminal/security/clear-legacy");
    expect(UNITERMINAL_ROUTES.securityRefs).toBe("/api/uniterminal/security/refs");
    const routes = createRoutes(makeManager());
    for (const pathname of SECURITY_PATHS) {
      expect(matchRoute(routes, pathname)).toBe(exactRoute(routes, pathname));
      expect(matchRoute(routes, pathname + "/")).toBeUndefined();
    }
    expect(routes.filter((route) => route.kind === "prefix" && route.path.startsWith("/api/uniterminal/security"))).toEqual([]);
  });

  it("maps an unexpected store failure to a JSON 500 instead of letting it escape", async () => {
    const boom = new Error("vault exploded");
    const security = {
      state: () => ({ ...FILE_SECURITY_STATE }),
      load: async () => {},
      clearLegacy: async () => {
        throw boom;
      },
    } as unknown as SecurityStore;
    const routes = createRoutes(makeManager(), { security });
    const response = await call(routes, UNITERMINAL_ROUTES.securityClearLegacy, { method: "POST", body: { confirm: true } });
    expect(response.status).toBe(500);
    expect(String((response.body as { error?: string }).error)).toContain("uniterminal: ");
  });

  it("lists remembered refs without ever leaking a secret", async () => {
    const { routes, security } = await setupSecurity();
    await security.put("profile:p1", "s3cr3t-remembered-4242");
    await security.put("profile:p2", "s3cr3t-remembered-9876");

    const response = await call(routes, UNITERMINAL_ROUTES.securityRefs);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ refs: ["profile:p1", "profile:p2"] });
    const text = JSON.stringify(response.body);
    expect(text).not.toContain("s3cr3t-remembered-4242");
    expect(text).not.toContain("s3cr3t-remembered-9876");
  });

  it("answers an empty refs list before anything was ever remembered", async () => {
    const { routes } = await setupSecurity();
    const response = await call(routes, UNITERMINAL_ROUTES.securityRefs);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ refs: [] });
  });
});

describe("remembered passwords (D10)", () => {
  /** 测试专用口令字面量：它出现在任何落盘文件或 diag 里都是缺陷。 */
  const SECRET = "s3cr3t-remembered-4242";
  const REF = "profile:p1";
  const REMEMBERED = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  interface RememberFixture {
    routes: WebRouteLike[];
    security: SecurityStore;
    seen: { password?: string }[];
    profilesPath: string;
  }

  /** 记录 transport 实际收到的口令：证明「从保险库取到的密码真的用于连接」。 */
  function recordingManager(seen: { password?: string }[]): SessionManager {
    const recording: TransportAdapter = {
      kind: "ssh",
      capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
      open: async (profile) => {
        seen.push({ password: profile.password });
        return {
          id: profile.id,
          kind: "ssh",
          capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
          write: () => {},
          resize: () => {},
          onData: () => () => {},
          onClose: () => () => {},
          close: async () => {},
        };
      },
    };
    const registry = new TransportRegistry();
    registry.register(recording);
    return new SessionManager(registry, { bufferBytes: 16 });
  }

  /**
   * 存档里先有一条 profile（remember 走真实路由写入），库按指定方式准备好。
   * legacy=true 时造的是旧档现场：登记成 protected + vault.bin 在场——那份数据已经没有任何能读它的代码了。
   */
  async function setupRemember(
    options: { remember?: boolean; legacy?: boolean } = {},
  ): Promise<RememberFixture> {
    const profilesPath = join(dir, "profiles.json");
    const profiles = new ProfileStore(profilesPath);
    const securityDir = join(dir, "security");
    if (options.legacy === true) {
      await mkdir(securityDir, { recursive: true });
      await writeFile(join(securityDir, "security.json"), JSON.stringify({ version: 1, mode: "protected" }) + "\n", "utf8");
      await writeFile(join(securityDir, "vault.bin"), "legacy-bytes-nobody-reads", "utf8");
    }
    const security = new SecurityStore(securityDir);
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: { password?: string }[] = [];
    const routes = createRoutes(recordingManager(seen), { profiles, security, ready });
    await ready;

    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", remember: options.remember ?? true } },
    });
    expect(saved.status).toBe(201);

    if (options.legacy !== true) await security.ensureStorage();
    return { routes, security, seen, profilesPath };
  }

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  beforeEach(() => {
    diagCalls.length = 0;
  });

  it("opens a session with the remembered password when the body has none", async () => {
    const fixture = await setupRemember();
    await fixture.security.put(REF, SECRET);

    const response = await connect(fixture.routes, REMEMBERED);

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET }]);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it("answers 400 password required when nothing was ever remembered", async () => {
    const fixture = await setupRemember();

    const response = await connect(fixture.routes, REMEMBERED);

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("uniterminal: password required");
    expect(fixture.seen).toEqual([]);
    expect(await fixture.security.listRefs()).toEqual([]);
  });

  /**
   * 语义修正：remember 表示"连接成功后把口令存下来"，不是"允不允许使用已存口令"。
   * 旧实现用它做使用判据，导致"凭据库里有口令、界面盾牌也亮着，连接却说没密码"——
   * 用户重新导入一次（旧实现覆盖 remember）就会遇到。
   */
  it("uses a stored secret even when remember is off", async () => {
    const fixture = await setupRemember({ remember: false });
    await fixture.security.put(REF, SECRET);

    const response = await connect(fixture.routes, REMEMBERED);

    expect(response.status).toBe(201);
    // 关键：认证用的是凭据库里的口令（不是用户重新输入的），且确实发生了一次尝试
    expect(fixture.seen).toHaveLength(1);
    // seen 记录的是这次认证的参数（含 password 字段）
    expect(fixture.seen[0]).toEqual({ password: await fixture.security.get(REF) });
  });

  it("answers 400 password required when only a legacy file is present: no stored password is available", async () => {
    const fixture = await setupRemember({ legacy: true });

    const response = await connect(fixture.routes, REMEMBERED);

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("uniterminal: password required");
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(fixture.seen).toEqual([]);
    // 旧档里的密码不解密、不迁移：等价于「没存过密码」
    expect(await fixture.security.listRefs()).toEqual([]);
    expect(fixture.security.state()).toEqual({ ...FILE_SECURITY_STATE, legacy: true });
  });

  it("stores a supplied password under profile:<id> once the session opened", async () => {
    const fixture = await setupRemember();
    const put = vi.spyOn(fixture.security, "put");

    const response = await connect(fixture.routes, { ...REMEMBERED, password: SECRET });

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledWith(REF, SECRET);
    expect(await fixture.security.get(REF)).toBe(SECRET);
    // 关键安全断言：口令绝不进 profiles.json，diag 也不回显它
    const persisted = await readFile(fixture.profilesPath, "utf8");
    expect(persisted).not.toContain(SECRET);
    expect(persisted).not.toMatch(/password|passphrase|secret|credential/i);
    expect(JSON.stringify(diagCalls)).not.toContain(SECRET);
  });

  it("never writes the vault when remember is off", async () => {
    const fixture = await setupRemember({ remember: false });
    const put = vi.spyOn(fixture.security, "put");

    const response = await connect(fixture.routes, { ...REMEMBERED, password: SECRET });

    expect(response.status).toBe(201);
    expect(put).not.toHaveBeenCalled();
    expect(await fixture.security.listRefs()).toEqual([]);
  });

  it("still connects with a supplied password while a legacy file is present, storing nothing", async () => {
    const fixture = await setupRemember({ legacy: true });

    const response = await connect(fixture.routes, { ...REMEMBERED, password: SECRET });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET }]);
    // 库不可用：写库失败只进 diag，绝不打断会话；口令也不许进 diag
    expect(diagCalls.some((entry) => entry.event === "credential.store-failed")).toBe(true);
    expect(JSON.stringify(diagCalls)).not.toContain(SECRET);
    expect(fixture.security.state()).toEqual({ ...FILE_SECURITY_STATE, legacy: true });
    expect(await fixture.security.listRefs()).toEqual([]);
  });

  it("keeps the session when the vault write fails and never logs the password", async () => {
    const profiles = new ProfileStore(join(dir, "profiles.json"));
    await profiles.load();
    await profiles.upsert({
      id: "p1",
      name: "Web",
      kind: "ssh",
      groupId: null,
      host: "192.0.2.10",
      createdAt: 0,
      updatedAt: 0,
      remember: true,
    });
    // 最坏情况：put 抛出的错误消息里就带着口令，diag 必须把它抹掉
    const security = {
      state: () => ({ ...FILE_SECURITY_STATE }),
      get: async () => undefined,
      put: async () => {
        throw new Error("disk full while writing " + SECRET);
      },
      listRefs: () => [],
    } as unknown as SecurityStore;
    const routes = createRoutes(makeManager(), { profiles, security });

    const response = await connect(routes, { ...REMEMBERED, password: SECRET });

    expect(response.status).toBe(201);
    const failures = diagCalls.filter((entry) => entry.event === "credential.store-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data).toMatchObject({ id: "p1" });
    expect(JSON.stringify(diagCalls)).not.toContain(SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it("persists remember through the profile route and rejects a non-boolean", async () => {
    const fixture = await setupRemember();

    const listed = await call(fixture.routes, UNITERMINAL_ROUTES.profiles);
    const payload = listed.body as { profiles: { id: string; remember?: boolean }[] };
    expect(payload.profiles[0]).toMatchObject({ id: "p1", remember: true });

    const rejected = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p2", remember: "yes" } },
    });
    expect(rejected.status).toBe(400);
    expect(errorText(rejected.body)).toContain("remember");
  });

  it("keeps the passwordless path working when no profile store is wired", async () => {
    // 未注入 profiles 的装配（无持久化的旧调用方式）不启用强制：口令要求只对启用 D10 的部署生效
    const routes = createRoutes(makeManager(), { knownHosts: new KnownHosts(join(dir, "known_hosts.json")) });

    const response = await connect(routes, REMEMBERED);

    expect(response.status).toBe(201);
  });
});

describe("private key authentication (M2b-1)", () => {
  const KEY_MARKER = "FAKE-KEY-MATERIAL-FOR-TESTS";
  const KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + KEY_MARKER + "\n-----END OPENSSH PRIVATE KEY-----";
  const PASSPHRASE = "fake-key-passphrase-7788";
  const KEY_REF = "key:p1";
  const PASSPHRASE_REF = "key-passphrase:p1";
  const REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  interface KeyFixture {
    routes: WebRouteLike[];
    security: SecurityStore;
    seen: SeenAuth[];
    profilesPath: string;
    identityPath: string;
  }

  /** 私钥内容只写进 mkdtemp 临时目录，auth 缺省为「路径方式」。 */
  async function setupKey(auth?: Record<string, unknown>): Promise<KeyFixture> {
    const profilesPath = join(dir, "profiles.json");
    const profiles = new ProfileStore(profilesPath);
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: SeenAuth[] = [];
    const routes = createRoutes(keyManager(seen), { profiles, security, ready });
    await ready;
    await security.ensureStorage();

    const identityPath = join(dir, "id_ed25519_fake");
    await writeFile(identityPath, KEY_TEXT, "utf8");

    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", auth: auth ?? { kind: "key", identityPath } } },
    });
    expect(saved.status).toBe(201);
    return { routes, security, seen, profilesPath, identityPath };
  }

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  beforeEach(() => {
    diagCalls.length = 0;
  });

  it("connects with the identity file, no password and the stored passphrase", async () => {
    const fixture = await setupKey();
    await fixture.security.put(PASSPHRASE_REF, PASSPHRASE);

    const response = await connect(fixture.routes, REMOTE);

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: KEY_TEXT, passphrase: PASSPHRASE }]);
  });

  it("never answers password required for a key profile without a password (R-17)", async () => {
    const fixture = await setupKey();

    const response = await connect(fixture.routes, REMOTE);

    expect(response.status).toBe(201);
    expect(errorText(response.body)).not.toContain("password required");
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: KEY_TEXT, passphrase: undefined }]);
  });

  it("answers 400 with the identity-unreadable hint when the path cannot be read", async () => {
    const missing = join(dir, "missing-dir", "id_ed25519");
    const fixture = await setupKey({ kind: "key", identityPath: missing });

    const response = await connect(fixture.routes, REMOTE);

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("私钥文件读不到");
    expect(errorText(response.body)).toContain(missing);
    expect(errorText(response.body)).toContain("保存配置");
    expect(fixture.seen).toEqual([]);
  });

  it("answers 400 no private key configured when there is neither a path nor a stored key", async () => {
    // M2d-2：空私钥配置不会再落库，因此「只用私钥」由请求显式表态（auth.kind='key'）
    const fixture = await setupKey({ kind: "key" });

    const response = await connect(fixture.routes, { ...REMOTE, auth: { kind: "key" } });

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("uniterminal: no private key configured");
    expect(fixture.seen).toEqual([]);
  });

  it("connects with a pasted key from the credential store and no password", async () => {
    const fixture = await setupKey({ kind: "key" });
    await fixture.security.put(KEY_REF, KEY_TEXT);

    const response = await connect(fixture.routes, { ...REMOTE, auth: { kind: "key" } });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: KEY_TEXT, passphrase: undefined }]);
  });

  it("stores a pasted key through POST /profiles/key without echoing it", async () => {
    const fixture = await setupKey({ kind: "key" });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.profilesKey, {
      method: "POST",
      body: { profileId: "p1", privateKey: KEY_TEXT, passphrase: PASSPHRASE },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(JSON.stringify(response.body)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(response.body)).not.toContain(PASSPHRASE);
    expect(await fixture.security.get(KEY_REF)).toBe(KEY_TEXT);
    expect(await fixture.security.get(PASSPHRASE_REF)).toBe(PASSPHRASE);
  });

  it("keeps the private key out of profiles.json, diag and both responses", async () => {
    const fixture = await setupKey();
    await fixture.security.put(PASSPHRASE_REF, PASSPHRASE);

    const saved = await call(fixture.routes, UNITERMINAL_ROUTES.profilesKey, {
      method: "POST",
      body: { profileId: "p1", privateKey: KEY_TEXT, passphrase: PASSPHRASE },
    });
    const session = await connect(fixture.routes, REMOTE);

    expect(saved.status).toBe(200);
    expect(session.status).toBe(201);

    const persistedText = await readFile(fixture.profilesPath, "utf8");
    // 落盘只许有路径（Windows 路径在 JSON 里被转义，因此按解析后的值断言）
    const persisted = JSON.parse(persistedText) as { profiles: { id: string; auth?: unknown }[] };
    expect(persisted.profiles.find((entry) => entry.id === "p1")?.auth).toEqual({
      kind: "key",
      identityPath: fixture.identityPath,
    });
    expect(persistedText).not.toContain(KEY_MARKER);
    expect(persistedText).not.toContain(KEY_TEXT);
    expect(JSON.stringify(diagCalls)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(diagCalls)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(saved.body)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(session.body)).not.toContain(KEY_MARKER);
  });

  it("deletes both key refs through POST /profiles/key/delete and stays idempotent", async () => {
    const fixture = await setupKey({ kind: "key" });
    await fixture.security.put(KEY_REF, KEY_TEXT);
    await fixture.security.put(PASSPHRASE_REF, PASSPHRASE);

    const removed = await call(fixture.routes, UNITERMINAL_ROUTES.profilesKeyDelete, {
      method: "POST",
      body: { profileId: "p1" },
    });

    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, removed: 2 });
    expect(await fixture.security.listRefs()).toEqual([]);

    const again = await call(fixture.routes, UNITERMINAL_ROUTES.profilesKeyDelete, {
      method: "POST",
      body: { profileId: "p1" },
    });
    expect(again.body).toEqual({ ok: true, removed: 0 });
  });

  it("rejects a private key smuggled into the auth block and persists nothing", async () => {
    const fixture = await setup();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", auth: { kind: "key", privateKey: KEY_TEXT } } },
    });

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("privateKey");
    expect(fixture.profiles.list()).toEqual([]);
    const text = await readFile(join(dir, "profiles.json"), "utf8").catch(() => "");
    expect(text).not.toContain(KEY_MARKER);
  });

  it("keeps both key routes on the exact table", () => {
    const routes = createRoutes(makeManager());

    expect(UNITERMINAL_ROUTES.profilesKey).toBe("/api/uniterminal/profiles/key");
    expect(UNITERMINAL_ROUTES.profilesKeyDelete).toBe("/api/uniterminal/profiles/key/delete");
    expect(matchRoute(routes, UNITERMINAL_ROUTES.profilesKey)?.kind).toBe("exact");
    expect(matchRoute(routes, UNITERMINAL_ROUTES.profilesKeyDelete)?.kind).toBe("exact");
  });
});

describe("profile editing (M2c-1)", () => {
  const KEY_PATH = "/home/deploy/.ssh/id_ed25519";
  const EDITED = { name: "改名后的主机", host: "192.0.2.99", port: 2200, user: "ops" };

  /** 存档里先放一条带 auth / remember / 分组的主机（走真实路由写入，和界面同一条路径）。 */
  async function seed(): Promise<{ routes: WebRouteLike[] }> {
    const fixture = await setup();
    const saved = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", remember: true, auth: { kind: "key", identityPath: KEY_PATH } } },
    });
    expect(saved.status).toBe(201);
    return { routes: fixture.routes };
  }

  const storedList = async (routes: WebRouteLike[]): Promise<Record<string, unknown>[]> => {
    const response = await call(routes, UNITERMINAL_ROUTES.profiles);
    expect(response.status).toBe(200);
    return (response.body as { profiles: Record<string, unknown>[] }).profiles;
  };

  it("loses auth and remember when an edit re-sends only the changed fields", async () => {
    const { routes } = await seed();

    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { id: "p1", kind: "ssh", ...EDITED } },
    });
    expect(saved.status).toBe(201);

    const stored = (await storedList(routes))[0];
    expect(stored).toMatchObject({ id: "p1", name: EDITED.name, host: EDITED.host });
    // ProfileStore.upsert 是整条替换：编辑只回传改动字段时，这些都**静默消失**。
    expect(stored?.auth).toBeUndefined();
    expect(stored?.remember).toBeUndefined();
    expect(stored?.groupId).toBeNull();
  });

  it("keeps auth, remember and groupPath when the UI re-sends the whole stored record", async () => {
    const { routes } = await seed();
    const original = (await storedList(routes))[0];
    expect(original?.auth).toEqual({ kind: "key", identityPath: KEY_PATH });
    expect(original?.remember).toBe(true);
    expect(typeof original?.groupId).toBe("string");

    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      // 与 HostListView 的编辑保存同构：先取存档，再 {...存档, 用户改动的字段, id}
      body: { profile: { ...original, ...EDITED, groupPath: ["生产", "华东"] } },
    });
    expect(saved.status).toBe(201);

    const edited = (await storedList(routes))[0];
    expect(edited).toMatchObject({ id: "p1", kind: "ssh", ...EDITED });
    expect(edited?.auth).toEqual({ kind: "key", identityPath: KEY_PATH });
    expect(edited?.remember).toBe(true);
    // 整份回写里带着 groupPath（客户端旧契约）：它必须翻译回同一个分组 id，绝不另建一个
    expect(edited?.groupId).toBe(original?.groupId);
    expect(edited?.createdAt).toBe(original?.createdAt);

    // 落盘之后仍在：不是只有内存里对。privateKey 一个字节都不该出现在这里。
    const onDisk = await readFile(join(join(dir, "profiles.json")), "utf8");
    expect(onDisk).toContain(KEY_PATH);
    expect(onDisk).toContain('"remember": true');
  });
});

describe("form auth choice wins over stored config (M2d)", () => {
  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  it("connects with the request password even though the stored auth is key", async () => {
    const fixture = await setupFakeKeyStored();

    // 界面上切到「密码」：会话请求显式带上 auth:{kind:'password'} 和口令
    const response = await connect(fixture.routes, { ...FORM_REMOTE, password: FORM_SECRET, auth: { kind: "password" } });

    expect(response.status).toBe(201);
    expect(errorText(response.body)).not.toContain("私钥文件读不到");
    expect(fixture.seen).toEqual([{ password: FORM_SECRET, privateKey: undefined, passphrase: undefined }]);
  });

  it("keeps following the stored key auth when the request carries no auth (regression lock)", async () => {
    const fixture = await setupFakeKeyStored();

    const response = await connect(fixture.routes, FORM_REMOTE);

    expect(response.status).toBe(400);
    expect(errorText(response.body)).toContain("私钥文件读不到");
    expect(errorText(response.body)).toContain(FAKE_KEY_PATH);
    expect(fixture.seen).toEqual([]);
  });

  it("rejects a request auth with an unknown kind, an empty or a non-string identityPath", async () => {
    const fixture = await setupFakeKeyStored();

    const unknownKind = await connect(fixture.routes, { ...FORM_REMOTE, password: FORM_SECRET, auth: { kind: "agent" } });
    expect(unknownKind.status).toBe(400);
    expect(errorText(unknownKind.body)).toContain("profile.auth.kind");

    const emptyPath = await connect(fixture.routes, { ...FORM_REMOTE, auth: { kind: "key", identityPath: "  " } });
    expect(emptyPath.status).toBe(400);
    expect(errorText(emptyPath.body)).toContain("profile.auth.identityPath");

    const nonStringPath = await connect(fixture.routes, { ...FORM_REMOTE, auth: { kind: "key", identityPath: 42 } });
    expect(nonStringPath.status).toBe(400);
    expect(errorText(nonStringPath.body)).toContain("profile.auth.identityPath");

    // 非法 auth 一律 400，绝不「默默回落到存档」把连接放过去
    expect(fixture.seen).toEqual([]);
  });

  it("answers 400 with the save-config hint when the requested key path is unreadable", async () => {
    const fixture = await setupFakeKeyStored();
    const missing = join(dir, "no-such-dir", "id_ed25519");

    const response = await connect(fixture.routes, { ...FORM_REMOTE, auth: { kind: "key", identityPath: missing } });

    expect(response.status).toBe(400);
    const text = errorText(response.body);
    expect(text).toContain("私钥文件读不到");
    expect(text).toContain(missing);
    expect(text).toContain("可在表单里把认证方式切回「密码」并点「保存配置」");
    expect(fixture.seen).toEqual([]);
  });

  it("reads the identity path carried by the request instead of the stored one", async () => {
    const fixture = await setupFakeKeyStored();
    const readable = join(dir, "id_ed25519_form");
    await writeFile(readable, FORM_KEY_TEXT, "utf8");

    const response = await connect(fixture.routes, { ...FORM_REMOTE, auth: { kind: "key", identityPath: readable } });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: FORM_KEY_TEXT, passphrase: undefined }]);
  });

  it("drops the auth field from disk when the form saves a password profile", async () => {
    const fixture = await setupFakeKeyStored();
    const listed = await call(fixture.routes, UNITERMINAL_ROUTES.profiles);
    const stored = (listed.body as { profiles: Record<string, unknown>[] }).profiles.find((item) => item.id === "p1");
    expect(stored?.auth).toEqual({ kind: "key", identityPath: FAKE_KEY_PATH });

    // 与「保存配置」同构：GET /profiles 取存档 → {...存档, 表单字段}；选了密码就把 auth 整个删掉
    const form: Record<string, unknown> = { ...(stored ?? {}) };
    delete form.auth;
    const saved = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...form, host: "192.0.2.55", remember: true } },
    });
    expect(saved.status).toBe(201);

    const onDiskText = await readFile(fixture.profilesPath, "utf8");
    const onDisk = JSON.parse(onDiskText) as { profiles: (Record<string, unknown> & { id: string })[] };
    const record = onDisk.profiles.find((entry) => entry.id === "p1");
    expect(record).toMatchObject({ host: "192.0.2.55", remember: true });
    expect(record?.auth).toBeUndefined();
    // 落盘里连 auth 这个键都不该留下（不写 kind:'password' 占位）
    expect(onDiskText).not.toContain('"auth"');

    // auth 从存档消失之后后端按密码解析：这就是用户能恢复密码登录的那一步
    const needPassword = await connect(fixture.routes, FORM_REMOTE);
    expect(needPassword.status).toBe(400);
    expect(errorText(needPassword.body)).toContain("password required");
    expect(errorText(needPassword.body)).not.toContain("私钥文件读不到");

    const response = await connect(fixture.routes, { ...FORM_REMOTE, password: FORM_SECRET });
    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: FORM_SECRET, privateKey: undefined, passphrase: undefined }]);
  });
});

describe("password and key coexist (M2d-2)", () => {
  const SECRET = "coexist-password-5512";
  const KEY_REF = "key:p1";
  const REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  /** 带凭据库的存档环境（凭据库决定「空私钥 auth」是否合法）。 */
  async function setupVault(): Promise<{ routes: WebRouteLike[]; security: SecurityStore; profilesPath: string }> {
    const profilesPath = join(dir, "profiles.json");
    const profiles = new ProfileStore(profilesPath);
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const routes = createRoutes(makeManager(), { profiles, security, ready });
    await ready;
    await security.ensureStorage();
    return { routes, security, profilesPath };
  }

  /** 事故复刻：profiles.json 里留着「kind 为 key 但没有路径」的旧记录（现在的路由已经不会写出它）。 */
  async function setupLegacyKeyRecord(): Promise<{
    routes: WebRouteLike[];
    security: SecurityStore;
    seen: SeenAuth[];
  }> {
    const profilesPath = join(dir, "profiles.json");
    const legacy = {
      version: 1,
      profiles: [{ ...PROFILE, id: "p1", remember: true, auth: { kind: "key" }, createdAt: 1, updatedAt: 1 }],
      folders: [],
    };
    await writeFile(profilesPath, JSON.stringify(legacy, null, 2), "utf8");
    const profiles = new ProfileStore(profilesPath);
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: SeenAuth[] = [];
    const routes = createRoutes(keyManager(seen), { profiles, security, ready });
    await ready;
    await security.ensureStorage();
    return { routes, security, seen };
  }

  beforeEach(() => {
    diagCalls.length = 0;
  });

  it("connects with the password when the requested key path is unreadable", async () => {
    const fixture = await setupFakeKeyStored();
    const missing = join(dir, "no-such-dir", "id_ed25519");

    // 两个都勾：私钥坏了也必须能用密码连上，绝不 400
    const response = await connect(fixture.routes, {
      ...FORM_REMOTE,
      password: FORM_SECRET,
      auth: { kind: "both", identityPath: missing },
    });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: FORM_SECRET, privateKey: undefined, passphrase: undefined }]);
    const entry = diagCalls.find((call) => call.event === "auth.key-unavailable");
    expect(entry?.data?.fallback).toBe("password");
  });

  it("hands both the password and the private key to the transport", async () => {
    const fixture = await setupFakeKeyStored();
    const readable = join(dir, "id_ed25519_both");
    await writeFile(readable, FORM_KEY_TEXT, "utf8");

    const response = await connect(fixture.routes, {
      ...FORM_REMOTE,
      password: FORM_SECRET,
      auth: { kind: "both", identityPath: readable },
    });

    expect(response.status).toBe(201);
    // 不在这层做二选一：两个凭据一起交给传输层，由 ssh2 自己按顺序尝试
    expect(fixture.seen).toEqual([{ password: FORM_SECRET, privateKey: FORM_KEY_TEXT, passphrase: undefined }]);
  });

  it("accepts a private key handed over directly in the request body", async () => {
    const fixture = await setupFakeKeyStored();

    const response = await connect(fixture.routes, {
      ...FORM_REMOTE,
      privateKey: FORM_KEY_TEXT,
      auth: { kind: "key" },
    });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: FORM_KEY_TEXT, passphrase: undefined }]);
  });

  it("falls back to the remembered password when the stored key auth has no key at all", async () => {
    const fixture = await setupLegacyKeyRecord();
    await fixture.security.put("profile:p1", SECRET);

    // 请求里一个凭据都不带：存档说 key，可既没有路径也没有 key:<id>
    const response = await connect(fixture.routes, REMOTE);

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET, privateKey: undefined, passphrase: undefined }]);
    expect(diagCalls.some((call) => call.event === "auth.key-unavailable")).toBe(true);
  });

  it("reports both authentication paths when neither one works", async () => {
    const missing = join(dir, "no-such-dir", "id_ed25519");
    const registry = new TransportRegistry();
    registry.register({
      kind: "ssh",
      capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
      open: async () => {
        throw new Error("All configured authentication methods failed");
      },
    });
    const routes = createRoutes(new SessionManager(registry, { bufferBytes: 16 }));

    const response = await connect(routes, {
      ...REMOTE,
      password: "wrong-password-42",
      auth: { kind: "both", identityPath: missing },
    });

    expect(response.status).toBe(500);
    const text = errorText(response.body);
    // 两条路各自的原因都要在，用户才知道该改哪一条
    expect(text).toContain("私钥文件读不到");
    expect(text).toContain(missing);
    expect(text).toContain("密码：认证失败");
    expect(text).toContain("All configured authentication methods failed");
  });

  it("never persists a key auth without a path or a stored key", async () => {
    const fixture = await setupVault();

    const empty = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", auth: { kind: "key" } } },
    });
    expect(empty.status).toBe(201);
    expect((empty.body as { warning?: string }).warning).toBe("私钥尚未配置，未保存该认证方式");
    expect((empty.body as { profile?: { auth?: unknown } }).profile?.auth).toBeUndefined();
    expect(await readFile(fixture.profilesPath, "utf8")).not.toContain('"auth"');

    // 凭据库里真有 key:<id> 时这条 auth 才是合法的，必须保留
    await fixture.security.put(KEY_REF, FORM_KEY_TEXT);
    const real = await call(fixture.routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", auth: { kind: "key" } } },
    });
    expect(real.status).toBe(201);
    expect((real.body as { warning?: string }).warning).toBeUndefined();
    expect((real.body as { profile?: { auth?: unknown } }).profile?.auth).toEqual({ kind: "key" });
  });
});

describe("explicit key-only choice is honoured (M2d-3)", () => {
  const SECRET = "remembered-password-m2d3-8801";
  const REF = "profile:p1";
  const REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  interface DecisionFixture {
    routes: WebRouteLike[];
    security: SecurityStore;
    seen: SeenAuth[];
    identityPath: string;
  }

  /** 存档 kind 为 key 且路径可读，保险库里另有一个记住的密码：只勾私钥时密码绝不许出场。 */
  async function setupKeyWithRememberedPassword(): Promise<DecisionFixture> {
    const profilesPath = join(dir, "profiles.json");
    const profiles = new ProfileStore(profilesPath);
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: SeenAuth[] = [];
    const routes = createRoutes(keyManager(seen), { profiles, security, ready });
    await ready;
    await security.ensureStorage();
    const identityPath = join(dir, "id_ed25519_m2d3");
    await writeFile(identityPath, FORM_KEY_TEXT, "utf8");
    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { ...PROFILE, id: "p1", remember: true, auth: { kind: "key", identityPath } } },
    });
    expect(saved.status).toBe(201);
    await security.put(REF, SECRET);
    return { routes, security, seen, identityPath };
  }

  /** 老存档：profiles.json 里留着「kind 为 key 但没有路径」的记录（现在的路由已经不会写出它）。 */
  async function setupLegacyKeyRecord(): Promise<DecisionFixture> {
    const profilesPath = join(dir, "profiles.json");
    const legacy = {
      version: 1,
      profiles: [{ ...PROFILE, id: "p1", remember: true, auth: { kind: "key" }, createdAt: 1, updatedAt: 1 }],
      folders: [],
    };
    await writeFile(profilesPath, JSON.stringify(legacy, null, 2), "utf8");
    const profiles = new ProfileStore(profilesPath);
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: SeenAuth[] = [];
    const routes = createRoutes(keyManager(seen), { profiles, security, ready });
    await ready;
    await security.ensureStorage();
    await security.put(REF, SECRET);
    return { routes, security, seen, identityPath: "" };
  }

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  beforeEach(() => {
    diagCalls.length = 0;
  });

  it("refuses a key-only request instead of silently connecting with the remembered password", async () => {
    const fixture = await setupKeyWithRememberedPassword();
    // 用户实报：只勾「使用私钥」，路径填了一个不存在的 123312
    const missing = join(dir, "123312");

    const response = await connect(fixture.routes, { ...REMOTE, auth: { kind: "key", identityPath: missing } });

    expect(response.status).toBe(400);
    const text = errorText(response.body);
    expect(text).toContain("私钥文件读不到");
    expect(text).toContain(missing);
    // 退路必须写在文案里：用户才知道怎样把密码这一路选回来
    expect(text).toContain("使用密码");
    expect(text).toContain("保存配置");
    // 静默降级才是缺陷：这次一条连接都不许建，保险库里的密码也不参与
    expect(fixture.seen).toEqual([]);
    expect(await fixture.security.get(REF)).toBe(SECRET);
    const entry = diagCalls.find((entry) => entry.event === "auth.key-unavailable");
    expect(entry?.data?.fallback).toBe("none");
  });

  it("falls back to the password when both methods are checked", async () => {
    const fixture = await setupKeyWithRememberedPassword();
    const missing = join(dir, "123312");

    const response = await connect(fixture.routes, { ...REMOTE, auth: { kind: "both", identityPath: missing } });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET, privateKey: undefined, passphrase: undefined }]);
    const entry = diagCalls.find((entry) => entry.event === "auth.key-unavailable");
    expect(entry?.data?.fallback).toBe("password");
  });

  it("keeps the anti-lockout fallback when the request carries no auth at all", async () => {
    const fixture = await setupLegacyKeyRecord();

    const response = await connect(fixture.routes, REMOTE);

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET, privateKey: undefined, passphrase: undefined }]);
    expect(diagCalls.some((entry) => entry.event === "auth.key-unavailable")).toBe(true);
  });

  it("hands only the private key when the key is readable, even with a remembered password", async () => {
    const fixture = await setupKeyWithRememberedPassword();

    const response = await connect(fixture.routes, {
      ...REMOTE,
      auth: { kind: "key", identityPath: fixture.identityPath },
    });

    expect(response.status).toBe(201);
    // 传输层配置里连 password 这个键都不该有值
    expect(fixture.seen).toEqual([{ password: undefined, privateKey: FORM_KEY_TEXT, passphrase: undefined }]);
  });

  it("never touches the stored key when the request asks for password only", async () => {
    const fixture = await setupKeyWithRememberedPassword();

    const response = await connect(fixture.routes, { ...REMOTE, auth: { kind: "password" } });

    expect(response.status).toBe(201);
    expect(fixture.seen).toEqual([{ password: SECRET, privateKey: undefined, passphrase: undefined }]);
    expect(diagCalls.some((entry) => entry.event === "auth.key-unavailable")).toBe(false);
  });
});

describe("test connection (M2c-2)", () => {
  const SECRET = "s3cr3t-for-test-connection-91";
  const REF = "profile:p1";
  const PASSPHRASE = "temporary-connection-passphrase";
  const KEY_MARKER = "TEMPORARY-CONNECTION-KEY-MATERIAL";
  const KEY_TEXT = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + KEY_MARKER + "\n-----END OPENSSH PRIVATE KEY-----";

  type Outcome = "ok" | "hang" | "fail" | "leak";

  interface SeenOpen {
    id: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    connectTimeoutMs?: number;
    aborted: () => boolean;
  }

  interface TestFixture {
    routes: WebRouteLike[];
    manager: SessionManager;
    security: SecurityStore;
    seen: SeenOpen[];
    closes: { count: number };
  }

  /** stub 传输层：不起真网络连接；记录收到的档案与会话句柄有没有被关掉。 */
  function stubRegistry(seen: SeenOpen[], closes: { count: number }, outcome: Outcome): TransportRegistry {
    const stub: TransportAdapter = {
      kind: "ssh",
      capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
      open: async (profile, signal) => {
        seen.push({
          id: profile.id,
          host: profile.host,
          port: profile.port,
          user: profile.user,
          password: profile.password,
          privateKey: profile.privateKey,
          passphrase: profile.passphrase,
          connectTimeoutMs: profile.connectTimeoutMs,
          aborted: () => signal.aborted,
        });
        if (outcome === "fail") throw new Error("uniterminal: handshake failed (bad credentials)");
        if (outcome === "leak") {
          throw new Error("handshake failed for " + String(profile.privateKey) + " / " + String(profile.passphrase));
        }
        if (outcome === "hang") return new Promise<SessionHandle>(() => {});
        return {
          id: profile.id,
          kind: "ssh",
          capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
          write: () => {},
          resize: () => {},
          onData: () => () => {},
          onClose: () => () => {},
          close: async () => {
            closes.count += 1;
          },
        };
      },
    };
    const registry = new TransportRegistry();
    registry.register(stub);
    return registry;
  }

  async function setupTest(
    options: {
      outcome?: Outcome;
      auth?: Record<string, unknown>;
      remember?: boolean;
      connectTimeoutMs?: number;
    } = {},
  ): Promise<TestFixture> {
    const profiles = new ProfileStore(join(dir, "profiles.json"));
    const security = new SecurityStore(join(dir, "security"));
    const ready = Promise.all([profiles.load(), security.load()]).then(() => undefined);
    const seen: SeenOpen[] = [];
    const closes = { count: 0 };
    const registry = stubRegistry(seen, closes, options.outcome ?? "ok");
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const routes = createRoutes(manager, { profiles, security, ready, registry });
    await ready;
    await security.ensureStorage();
    const saved = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: {
        profile: {
          ...PROFILE,
          id: "p1",
          remember: options.remember ?? true,
          auth: options.auth,
          connectTimeoutMs: options.connectTimeoutMs,
        },
      },
    });
    expect(saved.status).toBe(201);
    return { routes, manager, security, seen, closes };
  }

  const testConnection = (routes: WebRouteLike[], id: string, address?: string): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.profilesTest, { method: "POST", body: { id }, address });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  beforeEach(() => {
    diagCalls.length = 0;
  });

  it("opens one temporary connection, closes it and leaves the session manager empty", async () => {
    const fixture = await setupTest();
    await fixture.security.put(REF, SECRET);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; ms?: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ms).toBe("number");
    expect(body.ms).toBeGreaterThanOrEqual(0);
    // 临时连接用的就是存档里记住的口令，用完立刻关
    expect(fixture.seen).toHaveLength(1);
    expect(fixture.seen[0]).toMatchObject({ id: "p1", host: "192.0.2.10", port: 2222, user: "deploy", password: SECRET });
    expect(fixture.closes.count).toBe(1);
    // 不经过 SessionManager：不入 manager，也就不占 ring buffer、不注册升级路由
    expect(fixture.manager.list()).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(JSON.stringify(diagCalls)).not.toContain(SECRET);
  });

  it("keeps /profiles/test on the exact table so the profile prefix cannot swallow it", () => {
    const routes = createRoutes(makeManager());

    expect(UNITERMINAL_ROUTES.profilesTest).toBe("/api/uniterminal/profiles/test");
    expect(matchRoute(routes, "/api/uniterminal/profiles/test")?.kind).toBe("exact");
  });

  it("answers ok:false with the auth error instead of opening anything", async () => {
    const fixture = await setupTest({ remember: false });

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; error?: string; ms?: number };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("uniterminal: password required");
    expect(typeof body.ms).toBe("number");
    expect(fixture.seen).toEqual([]);
    expect(fixture.manager.list()).toEqual([]);
  });

  it("answers a JSON 404 for an unknown id", async () => {
    const fixture = await setupTest();

    const response = await testConnection(fixture.routes, "ghost");

    expect(response.status).toBe(404);
    expect(errorText(response.body)).toContain("unknown profile");
    expect(fixture.seen).toEqual([]);
  });

  it("refuses a test from a non-loopback peer", async () => {
    const fixture = await setupTest();

    const response = await testConnection(fixture.routes, "p1", "10.0.0.5");

    expect(response.status).toBe(403);
    expect(fixture.seen).toEqual([]);
  });

  it("answers 503 without any deps and without a registry", async () => {
    const noDeps = createRoutes(makeManager());
    const refused = await testConnection(noDeps, "p1");
    expect(refused.status).toBe(503);
    expect(errorText(refused.body)).toContain("unavailable");

    const profiles = new ProfileStore(join(dir, "profiles.json"));
    const ready = profiles.load().then(() => undefined);
    await ready;
    // 存档在、注册表不在：临时连接无从建立，必须 503 而不是假装连上了
    const noRegistry = createRoutes(makeManager(), { profiles, ready });
    const missing = await testConnection(noRegistry, "p1");
    expect(missing.status).toBe(503);
    expect(errorText(missing.body)).toContain("registry unavailable");
  });

  it("returns the transport error text as ok:false", async () => {
    const fixture = await setupTest({ outcome: "fail" });
    await fixture.security.put(REF, SECRET);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; error?: string; ms?: number };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("uniterminal: handshake failed (bad credentials)");
    expect(typeof body.ms).toBe("number");
    expect(fixture.closes.count).toBe(0);
    expect(fixture.manager.list()).toEqual([]);
  });

  it("puts the transport code into the /profiles/test failure body", async () => {
    const fixture = await setupTest({ outcome: "hang", connectTimeoutMs: 20 });
    await fixture.security.put(REF, SECRET);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; error?: string; ms?: number; code?: string };
    expect(body.ok).toBe(false);
    // 与建会话同一条分类函数：超时在两个入口给同一个 code
    expect(body.code).toBe("timeout");
    // 文案照旧，老前端不受影响
    expect(String(body.error)).toContain("超时");
  });

  it("still carries a code when the transport text is unknown", async () => {
    const fixture = await setupTest({ outcome: "fail" });
    await fixture.security.put(REF, SECRET);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; error?: string; code?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("uniterminal: handshake failed (bad credentials)");
    // 分类不出来也要给 code：前端据此知道「这条不属于已知的那几类」
    expect(body.code).toBe("unknown");
  });

  it("gives up after profile.connectTimeoutMs and reports the timeout", async () => {
    const fixture = await setupTest({ outcome: "hang", connectTimeoutMs: 20 });
    await fixture.security.put(REF, SECRET);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    const body = response.body as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    // M8-2：与「连接」入口统一——同一物理现象给同一句话，不再透出英文原文
    expect(body.error).toContain("超时");
    expect(body.error).not.toContain("认证失败");
    expect(fixture.seen[0]?.aborted()).toBe(true);
    expect(fixture.manager.list()).toEqual([]);
  });

  it("scrubs the private key and passphrase out of the error text and the diagnostics", async () => {
    const identityPath = join(dir, "id_ed25519_temp");
    await writeFile(identityPath, KEY_TEXT, "utf8");
    const fixture = await setupTest({ outcome: "leak", auth: { kind: "key", identityPath } });
    await fixture.security.put("key-passphrase:p1", PASSPHRASE);

    const response = await testConnection(fixture.routes, "p1");

    expect(response.status).toBe(200);
    expect((response.body as { ok?: boolean }).ok).toBe(false);
    expect(fixture.seen[0]).toMatchObject({ privateKey: KEY_TEXT, passphrase: PASSPHRASE });
    expect(JSON.stringify(response.body)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(response.body)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(diagCalls)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(diagCalls)).not.toContain(PASSPHRASE);
  });
});

const LISTED_ENTRY = {
  name: "index.html",
  path: "/srv/www/index.html",
  type: "file" as const,
  size: 128,
  mtime: 1700000000,
  mode: 0o100644,
};

interface SftpCall {
  method: string;
  args: (string | number)[];
}

interface FakeSftp {
  sftp: SftpLike;
  calls: SftpCall[];
  uploaded: Buffer[];
  /** 每次 createWriteStream 造出来的写流：中断用例要断言它确实被销毁了。 */
  sinks: Writable[];
  setFailure(error: Error): void;
}

interface FakeSftpOptions {
  download?: string[];
  backpressure?: boolean;
  /** M3-7：注入自定义写流，重现 ssh2「只发 close 不发 finish」等真实路径。 */
  writeStream?: () => Writable;
  /** M3-7：注入自定义读流，重现「没有 end 也没有 error 的提前 close」。 */
  readStream?: () => NodeJS.ReadableStream;
  /** M3-8/M3-9：只让提交（renameOverwrite）失败，用来证明「提交失败」同样要清掉临时文件。 */
  renameFailure?: Error;
  /** M8-13：只有这些路径"存在"（上传覆盖守卫需要区分存在/不存在）。默认什么都没。 */
  existingPaths?: readonly string[];
}

/** 注入的假 SFTP 子系统：只记录调用映射，读走内存 Readable，写进内存 Writable。 */
function fakeSftp(options: FakeSftpOptions = {}): FakeSftp {
  let failure: Error | undefined;
  const calls: SftpCall[] = [];
  const uploaded: Buffer[] = [];
  const sinks: Writable[] = [];
  const chunks = options.download ?? ["hello ", "world"];
  const check = (): void => {
    if (failure !== undefined) throw failure;
  };
  const sftp: SftpLike = {
    list: async (path) => {
      calls.push({ method: "list", args: [path] });
      check();
      return [LISTED_ENTRY];
    },
    stat: async (path) => {
      calls.push({ method: "stat", args: [path] });
      check();
      // 默认"什么文件都没有"：上传守卫据此放行；要测已存在就传 existingPaths
      if (!(options.existingPaths ?? []).includes(path)) throw new Error("ENOENT: no such file");
      return { type: "file", size: 128, mtime: 1700000000, mode: 0o100644 };
    },
    mkdir: async (path) => {
      calls.push({ method: "mkdir", args: [path] });
      check();
    },
    unlink: async (path) => {
      calls.push({ method: "unlink", args: [path] });
      check();
    },
    rmdir: async (path) => {
      calls.push({ method: "rmdir", args: [path] });
      check();
    },
    rename: async (from, to) => {
      calls.push({ method: "rename", args: [from, to] });
      check();
    },
    // M3-9：上传的提交走覆盖式换名，失败时依旧要清掉临时文件
    renameOverwrite: async (from, to) => {
      calls.push({ method: "renameOverwrite", args: [from, to] });
      if (options.renameFailure !== undefined) throw options.renameFailure;
      check();
    },
    chmod: async (path, mode) => {
      calls.push({ method: "chmod", args: [path, mode] });
      check();
    },
    createReadStream: (path) => {
      calls.push({ method: "createReadStream", args: [path] });
      if (options.readStream !== undefined) return options.readStream();
      return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
    },
    createWriteStream: (path) => {
      calls.push({ method: "createWriteStream", args: [path] });
      // backpressure：write 恒返回 false 且永不 drain，用来证明 drain 等待能被中断打断
      const stream =
        options.writeStream !== undefined
          ? options.writeStream()
          : options.backpressure === true
            ? new Writable({ highWaterMark: 1, write: () => {} })
            : new Writable({
                write(chunk, _encoding, callback) {
                  uploaded.push(Buffer.from(chunk as Buffer));
                  callback();
                },
              });
      sinks.push(stream);
      return stream;
    },
  };
  return { sftp, calls, uploaded, sinks, setFailure: (error) => { failure = error; } };
}

/**
 * 与 index.ts 同一条装配路径：handle 上有 openSftp 才有 SFTP 能力。
 * 其它协议留位：注册表里目前只有 ssh 适配器（src/index.ts 只注册它），建会话也只接受 ssh，
 * 因此这里的 kind 只可能是 ssh——「这条会话没有 SFTP」用能力位表达，不用协议名表达。
 */
function sftpManager(options: { kind: "ssh"; openSftp?: () => Promise<SftpLike> }): SessionManager {
  const capabilities = { exec: true, sftp: options.openSftp !== undefined, tunnel: true, resize: true };
  const adapter: TransportAdapter = {
    kind: options.kind,
    capabilities,
    open: async (profile) => {
      const handle: SessionHandle = {
        id: profile.id,
        kind: options.kind,
        capabilities,
        write: () => {},
        resize: () => {},
        onData: () => () => {},
        onClose: () => () => {},
        close: async () => {},
      };
      return options.openSftp === undefined ? handle : { ...handle, openSftp: options.openSftp };
    },
  };
  const registry = new TransportRegistry();
  registry.register(adapter);
  return new SessionManager(registry, { bufferBytes: 16 });
}

interface SftpSetup {
  withoutSftp?: boolean;
  openFailure?: string;
  withoutSource?: boolean;
  download?: string[];
  backpressure?: boolean;
  writeStream?: () => Writable;
  readStream?: () => NodeJS.ReadableStream;
  /** M3-7：注入极短的上传完成等待上限，超时路径不用真等 60 秒。 */
  uploadTimeoutMs?: number;
  /** M3-8/M3-9：只让提交失败（其余调用照常成功）。 */
  renameFailure?: Error;
  /** M8-13：让这些路径"已存在"，用于覆盖守卫。 */
  existingPaths?: readonly string[];
}

interface SftpFixture {
  routes: WebRouteLike[];
  manager: SessionManager;
  sftp: FakeSftp;
  sessionId: string;
}

async function setupSftp(options: SftpSetup = {}): Promise<SftpFixture> {
  const fake = fakeSftp({
    download: options.download,
    backpressure: options.backpressure,
    writeStream: options.writeStream,
    readStream: options.readStream,
    renameFailure: options.renameFailure,
    existingPaths: options.existingPaths,
  });
  // 其它协议留位：以前这里借 kind:"local" 造一条「不是 ssh 的会话」，
  // 现在建会话只接受 ssh（routes.ts 的 parseProfile），同一条意图改用「能力位没有 SFTP」表达。
  const kind = "ssh";
  const openSftp =
    options.withoutSftp === true
      ? undefined
      : async (): Promise<SftpLike> => {
          if (options.openFailure !== undefined) throw new Error(options.openFailure);
          return fake.sftp;
        };
  const manager = sftpManager(openSftp === undefined ? { kind } : { kind, openSftp });
  const deps: RouteDeps =
    options.withoutSource === true
      ? {}
      : { sftp: (id) => manager.openSftp(id), sftpUploadTimeoutMs: options.uploadTimeoutMs };
  const routes = createRoutes(manager, deps);
  const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
    method: "POST",
    body: { profile: { ...PROFILE, kind } },
  });
  expect(created.status).toBe(201);
  const sessionId = (created.body as { session?: { id?: string } }).session?.id ?? "";
  expect(sessionId).not.toBe("");
  return { routes, manager, sftp: fake, sessionId };
}

interface ByteResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
}

/** 流式端点要真实字节：请求体按块喂、响应按块收（全程不拼 JSON）。 */
async function callBytes(
  routes: WebRouteLike[],
  pathname: string,
  options: { method?: string; chunks?: Uint8Array[]; url?: string; address?: string } = {},
): Promise<ByteResponse> {
  const route = matchRoute(routes, pathname);
  if (route === undefined) throw new Error("no route matches: " + pathname);
  const captured: ByteResponse = { status: 0, headers: {}, body: Buffer.alloc(0), ended: false };
  const parts: Buffer[] = [];
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    write(chunk: Uint8Array) {
      parts.push(Buffer.from(chunk));
      return true;
    },
    end(payload?: string) {
      if (typeof payload === "string" && payload !== "") parts.push(Buffer.from(payload));
      captured.body = Buffer.concat(parts);
      captured.ended = true;
    },
  };
  const body = options.chunks ?? [];
  const listeners = new Map<string, (() => void)[]>();
  const request = {
    method: options.method ?? "GET",
    url: options.url ?? pathname,
    socket: { remoteAddress: options.address ?? "127.0.0.1" },
    // 真实 IncomingMessage 收完整个请求体后 complete 为 true
    complete: true,
    on(event: string, listener: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return request;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) yield Buffer.from(chunk);
      // 真节点读完之后还会发一次 close：收完整个请求体不算中断（M3-6 的假阳性就在这里）
      for (const listener of listeners.get("close") ?? []) listener();
    },
  };
  await route.handler(request as unknown as IncomingMessage, res as unknown as ServerResponse);
  return captured;
}

/**
 * 处理器不响应就是「响应永远发不出去」：让回归锁快速失败，而不是等 vitest 超时。
 * 修复前 close-only 那条用例就在这里红。
 */
async function respondedWithin(call: Promise<ByteResponse>, ms: number): Promise<ByteResponse> {
  const outcome = await Promise.race([
    call,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
  if (outcome === "timeout") throw new Error("upload handler never answered");
  return outcome;
}

/**
 * M3-7 回归锁：ssh2 的 SFTP 写流在某些路径下跳过 finish，只发 close。
 * 这条假写流重现那个路径——数据照写收下，end() 之后 finish 永远不来，只有 close。
 */
class CloseOnlySink extends Writable {
  readonly written: Buffer[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.written.push(Buffer.from(chunk));
    callback();
  }
  // 故意不回调：数据已经写完，但 finish 不会再发生
  override _final(_callback: (error?: Error | null) => void): void {}
  /** 写完数据后 ssh2 只发 close。 */
  signalClose(): void {
    this.emit("close");
  }
}

/** 收下数据后报错的写流：error 仍然必须让上传失败。 */
class FailingSink extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
  override _final(callback: (error?: Error | null) => void): void {
    callback(new Error("ssh2: write failed"));
  }
}

interface AbortableUpload {
  request: IncomingMessage;
  /** 按真实顺序中断：先 aborted 再 close；complete 保持 false（请求体永远没收完）。 */
  abort(): void;
}

/**
 * 可中断的假上传请求（M3-6）：客户端中途断开的真实序列是 aborted → close，
 * 之后的读取像真套接字一样抛错，handler 必须据此销毁写流而不是当成正常收尾。
 */
function abortableUpload(url: string, chunks: string[], when: "before-second-chunk" | "manual"): AbortableUpload {
  const listeners = new Map<string, (() => void)[]>();
  let aborted = false;
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    emit("aborted");
    emit("close");
  };
  const request = {
    method: "POST",
    url,
    socket: { remoteAddress: "127.0.0.1" },
    complete: false,
    on(event: string, listener: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return request;
    },
    async *[Symbol.asyncIterator]() {
      let index = 0;
      for (const chunk of chunks) {
        if (index > 0 && when === "before-second-chunk") abort();
        index += 1;
        if (aborted) throw Object.assign(new Error("aborted"), { code: "ECONNRESET" });
        yield Buffer.from(chunk);
      }
    },
  };
  return { request: request as unknown as IncomingMessage, abort };
}

interface CapturedResponse {
  status: number;
  body: string;
  ended: boolean;
}

/** 只记账的响应桩：中断场景要能断言「一个字节的 JSON 都没写出去」。 */
function captureResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: "", ended: false };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    write(chunk: Uint8Array) {
      captured.body += Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(payload?: string) {
      if (typeof payload === "string") captured.body += payload;
      captured.ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

const sftpQuery = (sessionId: string, path: string): string =>
  "?sessionId=" + encodeURIComponent(sessionId) + "&path=" + encodeURIComponent(path);

/** M3-8：上传先写同目录的临时文件，这里从调用记录里取回这一次用的临时路径。 */
function writeStreamPathOf(calls: SftpCall[]): string {
  const write = calls.find((entry) => entry.method === "createWriteStream");
  if (write === undefined) throw new Error("no createWriteStream call");
  return String(write.args[0]);
}

interface FakeSsh2 {
  client: SshClientLike;
  /** 底层 SFTP 子系统被打开的累加次数：M3-5 要求它恒为 1。 */
  sftpOpenCount: () => number;
}

/**
 * 真实 transport 的最小假 ssh2 client：connect 一调就 ready，SFTP 只记账。
 * 用来在路由层证明「两次文件操作 = 一个通道」，全程不连真服务器。
 */
function fakeSsh2(): FakeSsh2 {
  let opened = 0;
  const handlers = new Map<string, (() => void)[]>();
  const stream: SshStreamLike = {
    write: () => true,
    setWindow: () => {},
    on: (_event: string, _cb: never) => {},
    close: () => {},
  };
  const done = (callback: (error?: Error | null) => void): void => callback(undefined);
  const wrapper: Ssh2SftpLike = {
    readdir: (_location, callback) =>
      callback(undefined, [
        {
          filename: "index.html",
          attrs: {
            size: 128,
            mtime: 1700000000,
            mode: 0o100644,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          },
        },
      ]),
    stat: (_path, callback) => callback(undefined, { size: 128, mtime: 1700000000, mode: 0o100644 }),
    mkdir: (_path, callback) => done(callback),
    unlink: (_path, callback) => done(callback),
    rmdir: (_path, callback) => done(callback),
    rename: (_from, _to, callback) => done(callback),
    chmod: (_path, _mode, callback) => done(callback),
    createReadStream: () => Readable.from([Buffer.from("payload")]),
    createWriteStream: () => new Writable({ write: (_chunk, _encoding, callback) => callback() }),
  };
  const client: SshClientLike = {
    on: (event: string, cb: never) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    connect: () => {
      for (const cb of handlers.get("ready") ?? []) cb();
    },
    shell: (_options, cb) => cb(undefined, stream),
    end: () => {},
    destroy: () => {},
    sftp: (callback) => {
      opened += 1;
      callback(undefined, wrapper);
    },
  };
  return { client, sftpOpenCount: () => opened };
}

interface ChainConnection {
  host?: string;
  port?: number;
  user?: string;
  /** 目标/下一跳连接拿到的 sock（第一跳为 undefined）。 */
  sock?: unknown;
  forwardOut: [string, number, string, number][];
  ends: number;
  channel: Duplex;
}

/**
 * 跳板链用的假 ssh2（M3-3）：每次 factory 调用 = 一条独立连接。
 * connect 一调就 ready，并记下它收到的 sock 与开过的 forwardOut，全程不连真服务器。
 */
function chainSsh2(): {
  factory: (profile: ResolvedProfile) => SshClientLike;
  connections: ChainConnection[];
} {
  const connections: ChainConnection[] = [];
  const factory = (profile: ResolvedProfile): SshClientLike => {
    const connection: ChainConnection = {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      forwardOut: [],
      ends: 0,
      channel: new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }),
    };
    connections.push(connection);
    const handlers = new Map<string, (() => void)[]>();
    const stream: SshStreamLike = {
      write: () => true,
      setWindow: () => {},
      on: (_event: string, _cb: never) => {},
      close: () => {},
    };
    const client: SshClientLike = {
      on: (event: string, cb: never) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      connect: (config) => {
        connection.sock = config.sock;
        for (const cb of handlers.get("ready") ?? []) cb();
      },
      shell: (_options, cb) => cb(undefined, stream),
      end: () => {
        connection.ends += 1;
      },
      destroy: () => {},
      forwardOut: (srcIP, srcPort, dstIP, dstPort, cb) => {
        connection.forwardOut.push([srcIP, srcPort, dstIP, dstPort]);
        cb(undefined, connection.channel);
      },
    };
    return client;
  };
  return { factory, connections };
}

describe("sftp backend (M3-1)", () => {
  it("keeps all three sftp endpoints on the exact table", async () => {
    const { routes } = await setupSftp();

    expect(exactRoute(routes, UNITERMINAL_ROUTES.sftpOp)?.kind).toBe("exact");
    expect(exactRoute(routes, UNITERMINAL_ROUTES.sftpDownload)?.kind).toBe("exact");
    expect(exactRoute(routes, UNITERMINAL_ROUTES.sftpUpload)?.kind).toBe("exact");
  });

  it("lists a directory through the single exact op route", async () => {
    const fixture = await setupSftp();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "/srv/www" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ op: "ls", entries: [LISTED_ENTRY] });
    expect(fixture.sftp.calls).toEqual([{ method: "list", args: ["/srv/www"] }]);
  });

  it("dispatches mkdir, rmdir, unlink, rename and chmod through the same route", async () => {
    const fixture = await setupSftp();
    const send = async (body: Record<string, unknown>): Promise<number> =>
      (await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
        method: "POST",
        body: { sessionId: fixture.sessionId, ...body },
      })).status;

    expect(await send({ op: "mkdir", path: "/srv/www/new" })).toBe(200);
    expect(await send({ op: "rmdir", path: "/srv/www/gone" })).toBe(200);
    expect(await send({ op: "unlink", path: "/srv/www/old.txt" })).toBe(200);
    expect(await send({ op: "rename", path: "/srv/www/a", to: "/srv/www/b" })).toBe(200);
    expect(await send({ op: "chmod", path: "/srv/www/a", mode: 0o640 })).toBe(200);

    expect(fixture.sftp.calls).toEqual([
      { method: "mkdir", args: ["/srv/www/new"] },
      { method: "rmdir", args: ["/srv/www/gone"] },
      { method: "unlink", args: ["/srv/www/old.txt"] },
      { method: "rename", args: ["/srv/www/a", "/srv/www/b"] },
      { method: "chmod", args: ["/srv/www/a", 0o640] },
    ]);
  });

  it("answers a JSON 400 for an unknown op", async () => {
    const fixture = await setupSftp();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "put", path: "/srv/www/a" },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain("put");
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers a JSON 404 for an unknown session", async () => {
    const fixture = await setupSftp();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: "s404", op: "ls", path: "/srv/www" },
    });

    expect(response.status).toBe(404);
    expect(String((response.body as { error?: string }).error)).toContain("unknown session");
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers a JSON 400 when the session cannot do sftp", async () => {
    const fixture = await setupSftp({ withoutSftp: true });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "/srv/www" },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toMatch(/sftp/i);
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers a JSON 400 for a relative path", async () => {
    const fixture = await setupSftp();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "srv/www" },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain("路径必须是绝对路径");
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers a JSON 503 when no sftp source was injected", async () => {
    const fixture = await setupSftp({ withoutSource: true });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "/srv/www" },
    });

    expect(response.status).toBe(503);
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers 405 for a non-POST op request", async () => {
    const fixture = await setupSftp();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, { method: "GET" });

    expect(response.status).toBe(405);
  });

  it("answers a JSON 500 with the ssh2 text when the subsystem cannot open", async () => {
    const fixture = await setupSftp({ openFailure: "Channel open failure: administratively prohibited" });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "/srv/www" },
    });

    expect(response.status).toBe(500);
    expect(String((response.body as { error?: string }).error)).toContain("administratively prohibited");
  });

  it("passes an ssh2 error through unchanged on the op route", async () => {
    const fixture = await setupSftp();
    fixture.sftp.setFailure(Object.assign(new Error("No such file"), { code: "ENOENT" }));

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId: fixture.sessionId, op: "ls", path: "/srv/missing" },
    });

    expect(response.status).toBe(500);
    expect(String((response.body as { error?: string }).error)).toContain("No such file");
  });

  it("writes the downloaded bytes into the response stream", async () => {
    const fixture = await setupSftp({
      download: ["first-", "second", "third"],
      existingPaths: ["/srv/www/big.bin"],
    });

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpDownload, {
      url: UNITERMINAL_ROUTES.sftpDownload + sftpQuery(fixture.sessionId, "/srv/www/big.bin"),
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    // M8-11：有 Content-Length 才可能有真实进度条
    expect(response.headers["content-length"]).toMatch(/^\d+$/);
    expect(response.headers["content-disposition"]).toContain("big.bin");
    expect(response.body.toString("utf8")).toBe("first-secondthird");
    expect(response.ended).toBe(true);
    // M8-11：先 stat 拿大小，才能带上 Content-Length —— 没有它客户端无法显示真实进度
    expect(fixture.sftp.calls).toEqual([
      { method: "stat", args: ["/srv/www/big.bin"] },
      { method: "createReadStream", args: ["/srv/www/big.bin"] },
    ]);
  });

  it("refuses to overwrite an existing file without an explicit overwrite flag (M8-13)", async () => {
    const fixture = await setupSftp({ existingPaths: ["/srv/www/up.bin"] });

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/up.bin"),
      chunks: [Buffer.from("hello")],
    });

    // 静默覆盖会丢掉用户的真实文件：没有 overwrite 就必须拒绝，且一个字节都不写
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ code: "exists" });
    expect(fixture.sftp.uploaded).toHaveLength(0);
    expect(fixture.sftp.calls.some((entry) => entry.method === "createWriteStream")).toBe(false);
  });

  it("overwrites when the caller passes overwrite=true (M8-13)", async () => {
    const fixture = await setupSftp({ existingPaths: ["/srv/www/up.bin"] });

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/up.bin") + "&overwrite=true",
      chunks: [Buffer.from("replaced")],
    });

    expect(response.status).toBe(200);
    expect(Buffer.concat(fixture.sftp.uploaded).toString("utf8")).toBe("replaced");
  });

  it("streams the request body straight into the sftp write stream", async () => {
    const fixture = await setupSftp();

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/up.bin"),
      chunks: [Buffer.from("hello "), Buffer.from("upload")],
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true, path: "/srv/www/up.bin" });
    expect(Buffer.concat(fixture.sftp.uploaded).toString("utf8")).toBe("hello upload");
    // M3-8：目标路径不再被直接写——写完临时文件才 rename 过去
    const tempPath = writeStreamPathOf(fixture.sftp.calls);
    expect(fixture.sftp.calls.slice(1)).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "renameOverwrite", args: [tempPath, "/srv/www/up.bin"] },
    ]);
  });

  // M3-8 回归锁：用户点「取消上传」后文件仍完整出现在远端。写入必须先是临时文件，
  // 成功才 rename 到目标；成功后响应里也不许出现临时名。
  it("writes to a temporary path and renames it onto the target only after success", async () => {
    const fixture = await setupSftp();
    diagCalls.length = 0;

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/atomic.bin"),
      chunks: [Buffer.from("atomic "), Buffer.from("payload")],
    });

    expect(response.status).toBe(200);
    // 响应只回目标 path：临时名不得泄露给客户端
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ ok: true, path: "/srv/www/atomic.bin" });
    expect(response.body.toString("utf8")).not.toContain("uniterminal-part");
    const tempPath = writeStreamPathOf(fixture.sftp.calls);
    expect(tempPath).toMatch(/^\/srv\/www\/atomic\.bin\.uniterminal-part-[0-9a-f]+$/);
    expect(fixture.sftp.calls.slice(1)).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "renameOverwrite", args: [tempPath, "/srv/www/atomic.bin"] },
    ]);
    expect(Buffer.concat(fixture.sftp.uploaded).toString("utf8")).toBe("atomic payload");
    expect(diagCalls.filter((entry) => entry.event === "sftp.upload")).toHaveLength(1);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(false);
  });

  // 取消＝远端什么都没有：临时文件被 unlink，目标路径从头到尾没被写过。
  it("unlinks the temporary file on abort and never writes the target path", async () => {
    const fixture = await setupSftp();
    diagCalls.length = 0;
    const route = matchRoute(fixture.routes, UNITERMINAL_ROUTES.sftpUpload);
    if (route === undefined) throw new Error("no upload route");
    const { res, captured } = captureResponse();
    const target = "/srv/www/cancelled.bin";
    const upload = abortableUpload(
      UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, target),
      ["CANCEL-PARTIAL-MARKER", "never-written"],
      "before-second-chunk",
    );

    await route.handler(upload.request, res);

    const tempPath = writeStreamPathOf(fixture.sftp.calls);
    expect(tempPath).toMatch(/^\/srv\/www\/cancelled\.bin\.uniterminal-part-[0-9a-f]+$/);
    expect(fixture.sftp.calls.slice(1)).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "unlink", args: [tempPath] },
    ]);
    // 目标路径既没被写，也没被换名提交过
    expect(fixture.sftp.calls.some((entry) => entry.method === "rename")).toBe(false);
    expect(fixture.sftp.calls.some((entry) => entry.method === "renameOverwrite")).toBe(false);
    expect(fixture.sftp.calls.some((entry) => entry.method !== "stat" && entry.args.includes(target))).toBe(false);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-aborted")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(true);
    expect(captured.ended).toBe(false);
    expect(JSON.stringify(diagCalls)).not.toContain("CANCEL-PARTIAL-MARKER");
  });

  it("unlinks the temporary file when the write stream errors", async () => {
    const fixture = await setupSftp({ writeStream: () => new FailingSink() });
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/broken-temp.bin"),
        chunks: [Buffer.from("doomed")],
      }),
      1000,
    );

    expect(response.status).toBe(500);
    expect(String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error)).toContain("write failed");
    const tempPath = writeStreamPathOf(fixture.sftp.calls);
    expect(fixture.sftp.calls.slice(1)).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "unlink", args: [tempPath] },
    ]);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(false);
  });

  // 写完了却提交不过去：同样不许让半成品或临时文件留在远端。
  it("unlinks the temporary file and answers 500 when the commit fails", async () => {
    const fixture = await setupSftp({ renameFailure: new Error("ssh2: rename failed") });
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/rename-fails.bin"),
        chunks: [Buffer.from("written")],
      }),
      1000,
    );

    expect(response.status).toBe(500);
    const text = String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error);
    expect(text).toContain("rename failed");
    expect(text).toContain("提交失败");
    const tempPath = writeStreamPathOf(fixture.sftp.calls);
    expect(fixture.sftp.calls.slice(1)).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "renameOverwrite", args: [tempPath, "/srv/www/rename-fails.bin"] },
      { method: "unlink", args: [tempPath] },
    ]);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(false);
  });

  // M3-6：用户实测 104MB 上传「卡住且不能取消」。客户端一断开，后端必须立刻收手。
  it("destroys the write stream and logs sftp.upload-aborted when the client aborts mid-upload", async () => {
    const fixture = await setupSftp();
    diagCalls.length = 0;
    const route = matchRoute(fixture.routes, UNITERMINAL_ROUTES.sftpUpload);
    if (route === undefined) throw new Error("no upload route");
    const { res, captured } = captureResponse();
    const upload = abortableUpload(
      UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/big.bin"),
      ["UPLOAD-BODY-MARKER", "never-written"],
      "before-second-chunk",
    );

    // handler 必须自己收尾：它 reject 就等于「中断把协程挂死了」
    await route.handler(upload.request, res);

    expect(fixture.sftp.sinks).toHaveLength(1);
    expect(fixture.sftp.sinks[0]?.destroyed).toBe(true);
    const aborted = diagCalls.find((entry) => entry.event === "sftp.upload-aborted");
    expect(aborted?.data).toEqual({ sessionId: fixture.sessionId, path: "/srv/www/big.bin" });
    // 诊断只记 sessionId 与 path：内容字节一个都不许进日志
    expect(JSON.stringify(diagCalls)).not.toContain("UPLOAD-BODY-MARKER");
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-failed")).toBe(false);
    // 对端已经没了：不写响应，也不该惊动 handler 的兜底 catch
    expect(captured.ended).toBe(false);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-handler-failed")).toBe(false);
  });

  // 背压时 handler 只等 drain；中断必须能把这次等待拉出来，而不是挂着 fd 到最后。
  it("gives up a blocked drain wait instead of hanging when the client aborts", async () => {
    const fixture = await setupSftp({ backpressure: true });
    diagCalls.length = 0;
    const route = matchRoute(fixture.routes, UNITERMINAL_ROUTES.sftpUpload);
    if (route === undefined) throw new Error("no upload route");
    const { res, captured } = captureResponse();
    const upload = abortableUpload(
      UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/congested.bin"),
      ["first-chunk"],
      "manual",
    );

    // 写流永不 drain：handler 此刻正卡在 drain 等待里，断开必须把它拉出来
    setTimeout(() => upload.abort(), 0);
    const outcome = await Promise.race([
      (async () => {
        await route.handler(upload.request, res);
        return "resolved" as const;
      })(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    expect(outcome).toBe("resolved");
    expect(fixture.sftp.sinks[0]?.destroyed).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-aborted")).toBe(true);
    expect(captured.ended).toBe(false);
  });

  // aborted/close 的假阳性防线：请求体读完之后的 close 不是中断，上传仍然是成功。
  it("never reports a completed upload as an abort", async () => {
    const fixture = await setupSftp();
    diagCalls.length = 0;

    const response = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/ok.bin"),
      chunks: [Buffer.from("done"), Buffer.from("-body")],
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true, path: "/srv/www/ok.bin" });
    expect(Buffer.concat(fixture.sftp.uploaded).toString("utf8")).toBe("done-body");
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-aborted")).toBe(false);
  });

  // M3-7 回归锁：用户实测「文件确实落盘（415 B 与 512 KB 都验过），客户端却 Failed to fetch」。
  // 决定性证据是 diag 里 sftp.upload / sftp.upload-failed 一条都没有——处理器根本没走到发响应。
  // 根因：ssh2 的写流只发 close、不发 finish，只监听 finish 的等待永远不返回。
  it("answers 200 when the write stream closes without ever finishing", async () => {
    const sink = new CloseOnlySink();
    const fixture = await setupSftp({ writeStream: () => sink });
    diagCalls.length = 0;
    // 数据写进流之后再 close：这就是 ssh2 在真实上传里做的事
    setTimeout(() => sink.signalClose(), 5);

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/close-only.bin"),
        chunks: [Buffer.from("415-byte "), Buffer.from("payload")],
      }),
      1000,
    );

    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toContain('"ok":true');
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true, path: "/srv/www/close-only.bin" });
    // 字节确实进了写流：这不是「提前当成功」
    expect(Buffer.concat(sink.written).toString("utf8")).toBe("415-byte payload");
    expect(diagCalls.filter((entry) => entry.event === "sftp.upload")).toHaveLength(1);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-failed")).toBe(false);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-timeout")).toBe(false);
  });

  it("answers 200 when the write stream finishes normally", async () => {
    const fixture = await setupSftp();
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/finished.bin"),
        chunks: [Buffer.from("finish "), Buffer.from("path")],
      }),
      1000,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true, path: "/srv/www/finished.bin" });
    expect(Buffer.concat(fixture.sftp.uploaded).toString("utf8")).toBe("finish path");
    expect(diagCalls.filter((entry) => entry.event === "sftp.upload")).toHaveLength(1);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-timeout")).toBe(false);
  });

  it("answers 500 and logs sftp.upload-failed when the write stream errors", async () => {
    const fixture = await setupSftp({ writeStream: () => new FailingSink() });
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/broken.bin"),
        chunks: [Buffer.from("doomed")],
      }),
      1000,
    );

    expect(response.status).toBe(500);
    expect(String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error)).toContain("write failed");
    const failed = diagCalls.find((entry) => entry.event === "sftp.upload-failed");
    expect(failed?.data).toMatchObject({ sessionId: fixture.sessionId, path: "/srv/www/broken.bin" });
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(false);
  });

  // 兜底：写流既不 finish 也不 close 也不 error 时，等待必须有上限，绝不永久挂起。
  it("answers 500 with 上传超时 when the write stream never completes", async () => {
    const stalled = new Writable({ write: () => {} });
    const fixture = await setupSftp({ writeStream: () => stalled, uploadTimeoutMs: 20 });
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "/srv/www/stalled.bin"),
        chunks: [Buffer.from("stalled-body")],
      }),
      1000,
    );

    expect(response.status).toBe(500);
    expect(String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error)).toContain("上传超时");
    const timeoutEvent = diagCalls.find((entry) => entry.event === "sftp.upload-timeout");
    // 诊断只记 sessionId 与 path：内容字节一个都不许进日志
    expect(timeoutEvent?.data).toEqual({ sessionId: fixture.sessionId, path: "/srv/www/stalled.bin" });
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-failed")).toBe(false);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(false);
  });

  // 下载同类问题：读流提前 close（没有 end、也没有 error）时，等待同样不能永久挂着。
  it("answers 500 instead of hanging when the download stream closes early", async () => {
    const stream = new Readable({ read: () => {} });
    const fixture = await setupSftp({ readStream: () => stream });
    diagCalls.length = 0;
    setTimeout(() => stream.destroy(), 5);

    const response = await respondedWithin(
      callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpDownload, {
        url: UNITERMINAL_ROUTES.sftpDownload + sftpQuery(fixture.sessionId, "/srv/www/cut.bin"),
      }),
      1000,
    );

    expect(response.status).toBe(500);
    expect(String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error)).toContain("closed before it ended");
    expect(diagCalls.some((entry) => entry.event === "sftp.download-failed")).toBe(true);
  });

  it("rejects a relative path on both streaming endpoints without touching the subsystem", async () => {
    const fixture = await setupSftp();

    const download = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpDownload, {
      url: UNITERMINAL_ROUTES.sftpDownload + sftpQuery(fixture.sessionId, "srv/www/big.bin"),
    });
    const upload = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(fixture.sessionId, "srv/www/up.bin"),
      chunks: [Buffer.from("ignored")],
    });

    expect(download.status).toBe(400);
    expect(download.body.toString("utf8")).toContain("路径必须是绝对路径");
    expect(upload.status).toBe(400);
    expect(upload.body.toString("utf8")).toContain("路径必须是绝对路径");
    expect(fixture.sftp.calls).toEqual([]);
  });

  it("answers 404 for an unknown session on the streaming endpoints", async () => {
    const fixture = await setupSftp();

    const download = await callBytes(fixture.routes, UNITERMINAL_ROUTES.sftpDownload, {
      url: UNITERMINAL_ROUTES.sftpDownload + sftpQuery("s404", "/srv/www/big.bin"),
    });

    expect(download.status).toBe(404);
    expect(download.body.toString("utf8")).toContain("unknown session");
    expect(fixture.sftp.calls).toEqual([]);
  });

  // M3-5 回归：用户实测的缺陷是「列表先能用，之后 Channel open failure、列表变空」。
  // 这里走真实 transport：两次文件操作必须共用同一个底层 SFTP 通道。
  it("keeps two consecutive sftp operations on a single channel", async () => {
    const fake = fakeSsh2();
    const registry = new TransportRegistry();
    registry.register(createSshTransport(() => fake.client));
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const deps: RouteDeps = { sftp: (id) => manager.openSftp(id) };
    const routes = createRoutes(manager, deps);

    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { ...PROFILE } },
    });
    expect(created.status).toBe(201);
    const sessionId = (created.body as { session?: { id?: string } }).session?.id ?? "";
    expect(sessionId).not.toBe("");

    const first = await call(routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId, op: "ls", path: "/srv/www" },
    });
    const second = await call(routes, UNITERMINAL_ROUTES.sftpOp, {
      method: "POST",
      body: { sessionId, op: "ls", path: "/srv/www" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.sftpOpenCount()).toBe(1);
  });
});

describe("sftp wiring under apply (M3-1)", () => {
  it("serves the sftp endpoints instead of 503 after a real apply", async () => {
    const home = await mkdtemp(join(tmpdir(), "uniterminal-home-"));
    const previousProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const registered: WebRouteLike[] = [];
      const ctx: PluginContext = {
        logger: { warn: () => {} },
        webServer: {
          register(route) {
            registered.push(route);
            return () => {};
          },
        },
        effect(run) {
          run();
        },
      };

      apply(ctx, { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 });

      for (const path of [
        UNITERMINAL_ROUTES.sftpOp,
        UNITERMINAL_ROUTES.sftpDownload,
        UNITERMINAL_ROUTES.sftpUpload,
      ]) {
        expect(exactRoute(registered, path)?.path).toBe(path);
      }

      // 生产装配下的运行时探针：未知会话必须是 404；只有 sftp 源没接线才会是 503
      const response = await call(registered, UNITERMINAL_ROUTES.sftpOp, {
        method: "POST",
        body: { sessionId: "s404", op: "ls", path: "/srv/www" },
      });
      // 原样打印探针结果：接线缺陷（503）在 CI 日志里一眼可见
      console.log("[m3-1 wiring] POST /api/uniterminal/sftp/op ->", response.status, JSON.stringify(response.body));
      expect(response.status).not.toBe(503);
      expect(response.status).toBe(404);
      expect(String((response.body as { error?: string }).error)).toContain("unknown session");
    } finally {
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("tunnel backend (M3-2)", () => {
  /** 内存 Duplex：转发链路要真的能 pipe，但绝不碰真端口。 */
  const memoryStream = (): Duplex => new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });

  class FakeTunnelListener implements TunnelListener {
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

  interface FakeTunnelNet {
    net: TunnelNet;
    listeners: FakeTunnelListener[];
    dialed: { port: number; host: string }[];
  }

  function fakeTunnelNet(options: { bindError?: Error } = {}): FakeTunnelNet {
    const listeners: FakeTunnelListener[] = [];
    const dialed: { port: number; host: string }[] = [];
    return {
      listeners,
      dialed,
      net: {
        createListener: (onConnection) => {
          const listener = new FakeTunnelListener(onConnection, options.bindError);
          listeners.push(listener);
          return listener;
        },
        connect: (port, host) => {
          dialed.push({ port, host });
          return memoryStream();
        },
      },
    };
  }

  interface TunnelRouteSetup {
    /** 其它协议留位：注册表里只有 ssh 适配器，建会话也只接受 ssh，所以这里只能是 ssh。 */
    kind?: "ssh";
    forwarding?: boolean;
    bindError?: Error;
    remoteError?: Error;
    boundPort?: number;
    withoutManager?: boolean;
  }

  interface TunnelRouteFixture {
    routes: WebRouteLike[];
    manager: SessionManager;
    tunnels: TunnelManager;
    net: FakeTunnelNet;
    sessionId: string;
  }

  /** 与 index.ts 同一条装配路径：handle 上有三个转发方法才谈得上隧道。 */
  async function setupTunnelRoutes(options: TunnelRouteSetup = {}): Promise<TunnelRouteFixture> {
    const kind = options.kind ?? "ssh";
    const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
    const adapter: TransportAdapter = {
      kind,
      capabilities,
      open: async (profile) => {
        const handle: SessionHandle = {
          id: profile.id,
          kind,
          capabilities,
          write: () => {},
          resize: () => {},
          onData: () => () => {},
          onClose: () => () => {},
          close: async () => {},
        };
        if (options.forwarding === false) return handle;
        return {
          ...handle,
          forwardOut: async () => memoryStream(),
          forwardIn: async (_host, port) => {
            if (options.remoteError !== undefined) throw options.remoteError;
            return options.boundPort ?? port;
          },
          onTcpipEvent: () => {},
        };
      },
    };
    const registry = new TransportRegistry();
    registry.register(adapter);
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const net = fakeTunnelNet({ bindError: options.bindError });
    const tunnels = new TunnelManager({
      sessions: (id) => manager.openTunnels(id),
      net: net.net,
      onSessionClosed: (listener) => manager.onClosed(listener),
    });
    const deps: RouteDeps = options.withoutManager === true ? {} : { tunnels };
    const routes = createRoutes(manager, deps);
    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { ...PROFILE, kind } },
    });
    expect(created.status).toBe(201);
    const sessionId = (created.body as { session?: { id?: string } }).session?.id ?? "";
    expect(sessionId).not.toBe("");
    return { routes, manager, tunnels, net, sessionId };
  }

  const localBody = (sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId,
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 18080,
    destHost: "127.0.0.1",
    destPort: 5432,
    ...overrides,
  });

  it("keeps both tunnel endpoints on the exact table", async () => {
    const fixture = await setupTunnelRoutes();

    expect(exactRoute(fixture.routes, UNITERMINAL_ROUTES.tunnels)?.kind).toBe("exact");
    expect(exactRoute(fixture.routes, UNITERMINAL_ROUTES.tunnelsStop)?.kind).toBe("exact");
  });

  it("starts a loopback tunnel, lists it and stops it again", async () => {
    const fixture = await setupTunnelRoutes();

    const started = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body: localBody(fixture.sessionId) });
    console.log("[m3-2] POST /api/uniterminal/tunnels ->", started.status, JSON.stringify(started.body));
    expect(started.status).toBe(201);
    const tunnel = (started.body as { tunnel?: TunnelInfo }).tunnel;
    expect(tunnel).toMatchObject({
      sessionId: fixture.sessionId,
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 18080,
      destHost: "127.0.0.1",
      destPort: 5432,
      state: "active",
      bytesIn: 0,
      bytesOut: 0,
    });
    // 硬性安全口径：只有 127.0.0.1 上的一条监听
    expect(fixture.net.listeners[0]?.listens).toEqual([{ port: 18080, host: "127.0.0.1" }]);

    const listed = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels);
    expect(listed.status).toBe(200);
    expect((listed.body as { tunnels: TunnelInfo[] }).tunnels.map((item) => item.id)).toEqual([tunnel?.id]);

    const stopped = await call(fixture.routes, UNITERMINAL_ROUTES.tunnelsStop, {
      method: "POST",
      body: { id: tunnel?.id },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ ok: true, stopped: true });
    expect(fixture.net.listeners[0]?.closed).toBe(true);

    const after = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels);
    expect((after.body as { tunnels: TunnelInfo[] }).tunnels).toEqual([]);
    expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnelsStop, { method: "POST", body: { id: tunnel?.id } })).body).toEqual({
      ok: true,
      stopped: false,
    });
  });

  it("answers 404 for an unknown session", async () => {
    const fixture = await setupTunnelRoutes();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body: localBody("s404") });

    expect(response.status).toBe(404);
    expect(String((response.body as { error?: string }).error)).toContain("unknown session");
    expect(fixture.net.listeners).toEqual([]);
  });

  it("answers a JSON 400 when the session cannot forward", async () => {
    // 其它协议留位：以前这里借 kind:"local" 造一条「不是 ssh 的会话」，
    // 现在建会话只接受 ssh（routes.ts 的 parseProfile），同一条意图改用「能力位没有转发」表达。
    const fixture = await setupTunnelRoutes({ forwarding: false });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body: localBody(fixture.sessionId) });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toMatch(/does not support port forwarding/);
    expect(fixture.net.listeners).toEqual([]);
  });

  it("answers 400 for a busy local port and suggests another one", async () => {
    const fixture = await setupTunnelRoutes({ bindError: Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }) });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body: localBody(fixture.sessionId) });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain("换一个端口");
    expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnels)).body).toEqual({ tunnels: [] });
  });

  it("answers 400 instead of listening when bindHost is not loopback", async () => {
    const fixture = await setupTunnelRoutes();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, {
      method: "POST",
      body: localBody(fixture.sessionId, { bindHost: "0.0.0.0" }),
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain("127.0.0.1");
    // 一条监听都没建：拒绝对外暴露端口
    expect(fixture.net.listeners).toEqual([]);
  });

  it("answers 400 with a readable reason when the server refuses the remote bind", async () => {
    const fixture = await setupTunnelRoutes({ remoteError: new Error("Unable to bind to 127.0.0.1:22000") });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, {
      method: "POST",
      body: { sessionId: fixture.sessionId, mode: "remote", bindHost: "127.0.0.1", bindPort: 22000, destHost: "127.0.0.1", destPort: 22 },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: string }).error)).toContain("服务器可能禁用了远程转发");
  });

  it("answers 400 for a body that fails validation", async () => {
    const fixture = await setupTunnelRoutes();

    for (const body of [
      localBody(fixture.sessionId, { bindPort: 0 }),
      localBody(fixture.sessionId, { bindPort: 70000 }),
      localBody(fixture.sessionId, { mode: "dynamic" }),
      { sessionId: fixture.sessionId, mode: "local", bindPort: 18080 },
    ]) {
      const response = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body });
      expect(response.status).toBe(400);
    }
    expect(fixture.net.listeners).toEqual([]);
  });

  it("answers a JSON 503 when no tunnel manager was injected", async () => {
    const fixture = await setupTunnelRoutes({ withoutManager: true });

    for (const path of [UNITERMINAL_ROUTES.tunnels, UNITERMINAL_ROUTES.tunnelsStop]) {
      const response = await call(fixture.routes, path, { method: "POST", body: { sessionId: fixture.sessionId } });
      expect(response.status).toBe(503);
    }
    expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnels)).status).toBe(503);
  });

  it("answers 405 for the wrong methods", async () => {
    const fixture = await setupTunnelRoutes();

    expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "DELETE" })).status).toBe(405);
    expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnelsStop)).status).toBe(405);
  });

  it("drops the tunnel from the list when the session closes", async () => {
    const fixture = await setupTunnelRoutes();
    const started = await call(fixture.routes, UNITERMINAL_ROUTES.tunnels, { method: "POST", body: localBody(fixture.sessionId) });
    expect(started.status).toBe(201);

    await fixture.manager.close(fixture.sessionId);

    await vi.waitFor(async () => {
      expect((await call(fixture.routes, UNITERMINAL_ROUTES.tunnels)).body).toEqual({ tunnels: [] });
    });
    expect(fixture.net.listeners[0]?.closed).toBe(true);
  });
});

describe("tunnel wiring under apply (M3-2)", () => {
  it("serves the tunnel endpoints instead of 503 after a real apply", async () => {
    const home = await mkdtemp(join(tmpdir(), "uniterminal-home-"));
    const previousProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const registered: WebRouteLike[] = [];
      const ctx: PluginContext = {
        logger: { warn: () => {} },
        webServer: {
          register(route) {
            registered.push(route);
            return () => {};
          },
        },
        effect(run) {
          run();
        },
      };

      apply(ctx, { bufferBytes: 1024, term: "xterm-256color", connectTimeoutMs: 1000 });

      for (const path of [UNITERMINAL_ROUTES.tunnels, UNITERMINAL_ROUTES.tunnelsStop]) {
        expect(exactRoute(registered, path)?.path).toBe(path);
      }

      // 生产装配下的运行时探针：列表必须是 200 空表；只有隧道管理器没接线才会是 503
      const listed = await call(registered, UNITERMINAL_ROUTES.tunnels);
      console.log("[m3-2 wiring] GET /api/uniterminal/tunnels ->", listed.status, JSON.stringify(listed.body));
      expect(listed.status).not.toBe(503);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({ tunnels: [] });

      // 启动探针走未知会话：404 说明控制器真的握在 SessionManager 上（503 才是接线缺陷）
      const started = await call(registered, UNITERMINAL_ROUTES.tunnels, {
        method: "POST",
        body: { sessionId: "s404", mode: "local", bindHost: "127.0.0.1", bindPort: 18080, destHost: "127.0.0.1", destPort: 5432 },
      });
      console.log("[m3-2 wiring] POST /api/uniterminal/tunnels ->", started.status, JSON.stringify(started.body));
      expect(started.status).not.toBe(503);
      expect(started.status).toBe(404);
    } finally {
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("proxy jump chain (M3-3)", () => {
  it("creates a session through the proxyChain carried by the profile", async () => {
    const chain = chainSsh2();
    const registry = new TransportRegistry();
    registry.register(createSshTransport(chain.factory));
    const manager = new SessionManager(registry, { bufferBytes: 16 });
    const routes = createRoutes(manager);

    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { ...PROFILE, proxyChain: ["ops@bastion.example.com:2222"] } },
    });

    expect(created.status).toBe(201);
    // 真正走过链：先连跳板，再经跳板的通道连目标
    expect(chain.connections.map((entry) => entry.host)).toEqual(["bastion.example.com", PROFILE.host]);

    const [hop, target] = chain.connections;
    if (hop === undefined || target === undefined) throw new Error("the proxy chain was not built");
    expect(hop.sock).toBeUndefined();
    expect(hop.forwardOut).toEqual([["127.0.0.1", 0, PROFILE.host, PROFILE.port]]);
    expect(target.sock).toBe(hop.channel);
    expect(hop.user).toBe("ops");

    console.log(
      "[m3-3 routes] chain:",
      JSON.stringify({
        hosts: chain.connections.map((entry) => entry.host),
        hopForwardOut: hop.forwardOut,
        targetSockIsHopChannel: target.sock === hop.channel,
      }),
    );
  });

  it("rejects a proxyChain that is not a string array", async () => {
    const routes = createRoutes(makeManager());

    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { ...PROFILE, proxyChain: "bastion.example.com" } },
    });

    expect(created.status).toBe(400);
    expect(String((created.body as { error?: string }).error)).toMatch(/proxyChain/);
  });
});


interface OpenSshFiles {
  /** 真正的 sftpFromSsh2 通道：三级提交策略在下面这个复刻 OpenSSH 语义的假子系统上跑 */
  sftp: SftpLike;
  calls: SftpCall[];
  files: Map<string, string>;
}

interface OpenSshFilesOptions {
  /** 远端已经存在的文件：目标存在时 SSH_FXP_RENAME 必须失败（M3-9 的缺陷现场） */
  existing?: Record<string, string>;
  /** 服务端是否支持 posix-rename@openssh.com */
  extended?: boolean;
  /** 每一次提交尝试都失败：三级策略全部失效 */
  commitBroken?: boolean;
}

/**
 * M3-9：把路由层接在**真正的** sftpFromSsh2 上，假子系统按 OpenSSH 的真实语义回话——
 * SSH_FXP_RENAME 不覆盖已存在的目标（回 Failure），原子替换只能靠 posix-rename 扩展。
 * 全程不连真服务器，但「覆盖上传必然失败」这条实测缺陷在这里被复现并锁死。
 */
function openSshFiles(options: OpenSshFilesOptions = {}): OpenSshFiles {
  const calls: SftpCall[] = [];
  const files = new Map<string, string>(Object.entries(options.existing ?? {}));
  const wrapper: Ssh2SftpLike = {
    readdir: (_path, callback) => callback(undefined, []),
    stat: (_path, callback) => callback(undefined, { size: 0, mtime: 0, mode: 0o100644 }),
    mkdir: (_path, callback) => callback(),
    unlink: (path, callback) => {
      calls.push({ method: "unlink", args: [path] });
      if (!files.delete(path)) {
        callback(new Error("No such file"));
        return;
      }
      callback();
    },
    rmdir: (_path, callback) => callback(),
    rename: (from, to, callback) => {
      calls.push({ method: "rename", args: [from, to] });
      if (options.commitBroken === true || files.has(to) || !files.has(from)) {
        callback(new Error("Failure"));
        return;
      }
      files.set(to, files.get(from) ?? "");
      files.delete(from);
      callback();
    },
    chmod: (_path, _mode, callback) => callback(),
    createReadStream: (path) => Readable.from([Buffer.from(files.get(path) ?? "")]),
    createWriteStream: (path) => {
      calls.push({ method: "createWriteStream", args: [path] });
      const parts: Buffer[] = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          parts.push(Buffer.from(chunk as Buffer));
          callback();
        },
        final(callback) {
          files.set(path, Buffer.concat(parts).toString("utf8"));
          callback();
        },
      });
    },
  };
  if (options.extended === true) {
    // posix-rename@openssh.com：原子的覆盖式替换
    wrapper.ext_openssh_rename = (from, to, callback) => {
      calls.push({ method: "ext_openssh_rename", args: [from, to] });
      if (options.commitBroken === true || !files.has(from)) {
        callback(new Error("Failure"));
        return;
      }
      files.set(to, files.get(from) ?? "");
      files.delete(from);
      callback();
    };
  }
  return { sftp: sftpFromSsh2(wrapper), calls, files };
}

/** 与 index.ts 同一条装配路径，只是通道换成了复刻 OpenSSH 语义的那个。 */
async function setupOverwriteUpload(
  options: OpenSshFilesOptions = {},
): Promise<{ routes: WebRouteLike[]; sessionId: string; remote: OpenSshFiles }> {
  const remote = openSshFiles(options);
  const manager = sftpManager({ kind: "ssh", openSftp: async () => remote.sftp });
  const routes = createRoutes(manager, { sftp: (id) => manager.openSftp(id) });
  const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
    method: "POST",
    body: { profile: { ...PROFILE, kind: "ssh" } },
  });
  expect(created.status).toBe(201);
  const sessionId = (created.body as { session?: { id?: string } }).session?.id ?? "";
  expect(sessionId).not.toBe("");
  return { routes, sessionId, remote };
}

describe("sftp upload overwrite (M3-9)", () => {
  const TARGET = "/srv/www/replace.txt";

  it("commits through posix-rename@openssh.com when the server supports it", async () => {
    const { routes, sessionId, remote } = await setupOverwriteUpload({ existing: { [TARGET]: "old payload" }, extended: true });
    diagCalls.length = 0;

    const response = await callBytes(routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(sessionId, TARGET) + "&overwrite=true",
      chunks: [Buffer.from("new "), Buffer.from("payload")],
    });

    expect(response.status).toBe(200);
    expect(remote.files.get(TARGET)).toBe("new payload");
    const tempPath = writeStreamPathOf(remote.calls);
    expect(remote.calls).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "ext_openssh_rename", args: [tempPath, TARGET] },
    ]);
  });

  // 缺陷 1 的回归锁：目标已存在时普通 rename 必然 Failure，覆盖上传必须照样 200。
  it("unlinks the existing target and renames again when the plain rename refuses to overwrite", async () => {
    const { routes, sessionId, remote } = await setupOverwriteUpload({ existing: { [TARGET]: "old payload" } });
    diagCalls.length = 0;

    const response = await callBytes(routes, UNITERMINAL_ROUTES.sftpUpload, {
      method: "POST",
      url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(sessionId, TARGET) + "&overwrite=true",
      chunks: [Buffer.from("new "), Buffer.from("payload")],
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ ok: true, path: TARGET });
    expect(remote.files.get(TARGET)).toBe("new payload");
    const tempPath = writeStreamPathOf(remote.calls);
    expect(remote.calls).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "rename", args: [tempPath, TARGET] },
      { method: "unlink", args: [TARGET] },
      { method: "rename", args: [tempPath, TARGET] },
    ]);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(false);
  });

  // 三级都失败：500，并且 M3-8 的清理语义一个字都不能丢——临时文件必须被 unlink 掉。
  it("answers 500 and unwinds the temporary file when every commit strategy fails", async () => {
    const { routes, sessionId, remote } = await setupOverwriteUpload({ commitBroken: true });
    diagCalls.length = 0;

    const response = await respondedWithin(
      callBytes(routes, UNITERMINAL_ROUTES.sftpUpload, {
        method: "POST",
        url: UNITERMINAL_ROUTES.sftpUpload + sftpQuery(sessionId, "/srv/www/never.bin") + "&overwrite=true",
        chunks: [Buffer.from("doomed")],
      }),
      1000,
    );

    expect(response.status).toBe(500);
    const text = String((JSON.parse(response.body.toString("utf8")) as { error?: string }).error);
    expect(text).toContain("提交失败");
    expect(text).toContain("Failure");
    const tempPath = writeStreamPathOf(remote.calls);
    expect(remote.calls).toEqual([
      { method: "createWriteStream", args: [tempPath] },
      { method: "rename", args: [tempPath, "/srv/www/never.bin"] },
      { method: "unlink", args: ["/srv/www/never.bin"] },
      { method: "rename", args: [tempPath, "/srv/www/never.bin"] },
      { method: "unlink", args: [tempPath] },
    ]);
    expect(remote.files.has(tempPath)).toBe(false);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload-cleaned")).toBe(true);
    expect(diagCalls.some((entry) => entry.event === "sftp.upload")).toBe(false);
  });
});

/** 记账桩拼出来的元素树：jsx 运行时被换成 { type, props }，因此可以直接遍历断言。 */
interface StubNode {
  type: unknown;
  props: Record<string, unknown>;
}

const isStubNode = (value: unknown): value is StubNode =>
  typeof value === "object" && value !== null && "type" in value && "props" in value;

function walkElements(node: unknown, visit: (element: StubNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkElements(item, visit);
    return;
  }
  if (!isStubNode(node)) return;
  visit(node);
  walkElements(node.props.children, visit);
}

function textOfStub(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => textOfStub(item)).join("");
  if (!isStubNode(node)) return "";
  return textOfStub(node.props.children);
}

function buttonLabelsOf(node: unknown): string[] {
  const labels: string[] = [];
  walkElements(node, (element) => {
    if (element.type === "button") labels.push(textOfStub(element.props.children));
  });
  return labels;
}

function buttonByLabel(node: unknown, label: string): StubNode {
  let found: StubNode | undefined;
  walkElements(node, (element) => {
    if (element.type === "button" && textOfStub(element.props.children) === label) found = element;
  });
  if (found === undefined) throw new Error("no button labelled " + label);
  return found;
}

function progressBarsOf(node: unknown): StubNode[] {
  const bars: StubNode[] = [];
  walkElements(node, (element) => {
    // 断言钩子是"类名里含 uniterminal-upload-bar"：轨道类（uniterminal-progress-track）是并列追加的，
    // 严格相等会把多类名判成"没有进度条"。
    if (String(element.props.className ?? "").split(" ").includes("uniterminal-upload-bar")) bars.push(element);
  });
  return bars;
}

describe("SftpPanel upload result rows (M3-9)", () => {
  type RowStatus = "uploading" | "done" | "failed" | "cancelled";

  const row = (name: string, status: RowStatus, extra: { loaded?: number; total?: number; error?: string } = {}) => ({
    name,
    status,
    loaded: extra.loaded ?? 0,
    total: extra.total ?? 0,
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the result row six seconds after every file succeeded", () => {
    const clear = vi.fn();
    const cancel = scheduleUploadResultDismiss([row("a.bin", "done"), row("b.bin", "cancelled")], clear);

    expect(UPLOAD_RESULT_DISMISS_MS).toBe(6000);
    vi.advanceTimersByTime(UPLOAD_RESULT_DISMISS_MS - 1);
    expect(clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clear).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("keeps the row and schedules nothing when any file failed", () => {
    const clear = vi.fn();
    const cancel = scheduleUploadResultDismiss(
      [row("a.bin", "done"), row("b.bin", "failed", { error: "提交失败：Failure" })],
      clear,
    );

    expect(shouldAutoDismissUploads([row("b.bin", "failed")])).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(UPLOAD_RESULT_DISMISS_MS * 10);
    expect(clear).not.toHaveBeenCalled();
    cancel();
  });

  it("cancels the pending dismissal when the panel unmounts", () => {
    const clear = vi.fn();
    const cancel = scheduleUploadResultDismiss([row("a.bin", "done")], clear);
    expect(vi.getTimerCount()).toBe(1);

    cancel();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(UPLOAD_RESULT_DISMISS_MS * 2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("shows 清除 on the result row and hides the progress bar outside uploading", () => {
    const clear = vi.fn();
    const tree = uploadResultsView([row("a.bin", "done", { loaded: 10, total: 10 }), row("b.bin", "cancelled")], {
      clear,
      cancel: vi.fn(),
    }, 0);

    expect(UPLOAD_CLEAR_LABEL).toBe("清除");
    expect(buttonLabelsOf(tree)).toContain(UPLOAD_CLEAR_LABEL);
    expect(progressBarsOf(tree)).toHaveLength(0);
    expect(textOfStub(tree)).toContain("上传完成");
    expect(textOfStub(tree)).toContain("已取消（远端未生成文件）");

    // 「清除」真的挂在这个按钮上：点一下就是关掉结果行
    (buttonByLabel(tree, UPLOAD_CLEAR_LABEL).props.onClick as () => void)();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("keeps the progress bar while a file is uploading", () => {
    const tree = uploadResultsView([row("big.bin", "uploading", { loaded: 5, total: 10 })], {
      clear: vi.fn(),
      cancel: vi.fn(),
    }, 0);

    expect(progressBarsOf(tree)).toHaveLength(1);
    expect(textOfStub(tree)).toContain("已传 5 B / 10 B");
    expect(buttonLabelsOf(tree)).toEqual(expect.arrayContaining([UPLOAD_CLEAR_LABEL, "取消上传"]));
  });

  it("keeps a failing row readable for the user", () => {
    const tree = uploadResultsView([row("bad.bin", "failed", { error: "上传完成但提交失败：Failure" })], {
      clear: vi.fn(),
      cancel: vi.fn(),
    }, 0);

    expect(textOfStub(tree)).toContain("上传失败：上传完成但提交失败：Failure");
    expect(buttonLabelsOf(tree)).toContain(UPLOAD_CLEAR_LABEL);
    expect(progressBarsOf(tree)).toHaveLength(0);
  });
});

/**
 * M5-1 的假会话：exec 走独立通道（测试直接答），write 模拟 tty 回显。
 * 回显必须演——不演就测不出 shell 模式「echo <标记>」会不会把标记混进命令输出。
 */
function execManager(options: { exec?: ExecRunner; passwords?: (string | undefined)[] } = {}) {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const writes: string[] = [];
  const encoder = new TextEncoder();
  const print = (text: string): void => {
    const bytes = encoder.encode(text);
    for (const cb of [...dataListeners]) cb(bytes);
  };
  const capabilities = { exec: true, sftp: true, tunnel: true, resize: true };
  const adapter: TransportAdapter = {
    kind: "ssh",
    capabilities,
    open: async (profile) => {
      options.passwords?.push(profile.password);
      return {
        id: profile.id,
        kind: "ssh",
        capabilities,
        write: (chunk) => {
          const text = new TextDecoder().decode(chunk);
          writes.push(text);
          for (const line of text.split("\n").filter((item) => item !== "")) {
            // tty 回显：敲进来的命令行原样打回来，然后再执行它
            print(line + "\r\n");
            print(line.startsWith("echo ") ? line.slice(5) + "\r\n" : "ran:" + line + "\r\n");
          }
        },
        resize: () => {},
        onData: (cb) => {
          dataListeners.add(cb);
          return () => void dataListeners.delete(cb);
        },
        onClose: () => () => {},
        close: async () => {},
        exec: async (command, execOptions) =>
          options.exec === undefined
            ? { stdout: "out:" + command, stderr: "", code: 0, truncated: false, timedOut: false }
            : { ...(await options.exec({ sessionId: profile.id, command, mode: "exec", timeoutMs: execOptions?.timeoutMs })), mode: "exec", ms: 1 },
      };
    },
  };
  const registry = new TransportRegistry();
  registry.register(adapter);
  return { manager: new SessionManager(registry, { bufferBytes: 8192 }), writes };
}

/** 建好一条可 exec 的会话，路由与 runner 共用同一个 manager。 */
async function execFixture(options: { exec?: ExecRunner; passwords?: (string | undefined)[] } = {}) {
  const fixture = execManager(options);
  const info = await fixture.manager.open({ id: "p1", kind: "ssh", host: "192.0.2.10", user: "deploy", port: 22 });
  const routes = createRoutes(fixture.manager, { exec: createSessionExec(fixture.manager) });
  return { ...fixture, info, routes };
}

describe("agent exec route (M5-1)", () => {
  it("is an exact route and runs a command through the injected exec runner", async () => {
    const requests: unknown[] = [];
    const routes = createRoutes(makeManager(), {
      exec: async (request) => {
        requests.push(request);
        return { mode: request.mode, stdout: "Linux host\n", stderr: "warn\n", code: 0, truncated: false, timedOut: false, ms: 12 };
      },
    });

    expect(matchRoute(routes, UNITERMINAL_ROUTES.sessionExec)?.kind).toBe("exact");

    const response = await call(routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: "s1", command: "uname -a", timeoutMs: 500 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: "exec",
      stdout: "Linux host\n",
      stderr: "warn\n",
      code: 0,
      truncated: false,
      ms: 12,
    });
    expect(requests).toEqual([{ sessionId: "s1", command: "uname -a", mode: "exec", timeoutMs: 500 }]);
  });

  it("reads shell output back between markers instead of touching the user's buffer", async () => {
    const fixture = await execFixture();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: fixture.info.id, command: "uname -a", mode: "shell" },
    });

    const body = response.body as { mode: string; stdout: string; code: number | null };
    expect(response.status).toBe(200);
    expect(body.mode).toBe("shell");
    expect(body.stdout).toContain("ran:uname -a");
    // 交互式 shell 没有退出码可拿：code 必须是 null，而不是编一个 0 出来
    expect(body.code).toBeNull();
    // 标记是我们自己敲进去的，绝不能当成命令输出回给模型
    expect(response.raw).not.toContain("__UT_");
    // M8-9：三行合成**一次**写入，避免三次小包各自等 ACK；顺序仍是 BEGIN → 命令 → END
    expect(fixture.writes).toHaveLength(1);
    const shellLines = (fixture.writes[0] ?? "").split("\n").filter((line) => line !== "");
    expect(shellLines[0]).toMatch(/^echo __UT_BEGIN_\d+_[0-9a-f]+__$/);
    expect(shellLines[1]).toBe("uname -a");
    expect(shellLines[2]).toMatch(/^echo __UT_END_\d+_[0-9a-f]+__$/);
  });

  it("answers 404 for an unknown session", async () => {
    const fixture = await execFixture();

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: "s404", command: "id" },
    });

    expect(response.status).toBe(404);
  });

  it("answers 400 for an empty command or an unknown mode", async () => {
    const fixture = await execFixture();

    const blank = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: fixture.info.id, command: "   " },
    });
    expect(blank.status).toBe(400);

    const badMode = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: fixture.info.id, command: "id", mode: "telepathy" },
    });
    expect(badMode.status).toBe(400);
  });

  it("answers 403 for a non-loopback caller and 405 for a non-POST request", async () => {
    const fixture = await execFixture();

    const remote = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      address: "10.0.0.5",
      method: "POST",
      body: { sessionId: fixture.info.id, command: "id" },
    });
    expect(remote.status).toBe(403);

    const wrongMethod = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });

  it("answers 503 when no exec source is wired in", async () => {
    const routes = createRoutes(makeManager());

    const response = await call(routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: "s1", command: "id" },
    });

    expect(response.status).toBe(503);
  });

  it("answers 403 and runs nothing when agentExec is off", async () => {
    const ran: unknown[] = [];
    const routes = createRoutes(makeManager(), {
      agentExec: "off",
      exec: async (request) => {
        ran.push(request);
        return { mode: request.mode, stdout: "", stderr: "", code: 0, truncated: false, timedOut: false, ms: 1 };
      },
    });

    const response = await call(routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: "s1", command: "id" },
    });

    expect(response.status).toBe(403);
    expect(String((response.body as { error?: unknown }).error)).toContain("agentExec");
    expect(ran).toEqual([]);
  });

  it("never echoes a password from the command into the response or the diag log", async () => {
    const password = "Sup3r-Secret-9911";
    const passwords: (string | undefined)[] = [];
    const fixture = execManager({ passwords });
    const routes = createRoutes(fixture.manager, { exec: createSessionExec(fixture.manager) });

    // 事故形状：带口令的 profile 建会话，随后命令里又写了一次口令
    const created = await call(routes, UNITERMINAL_ROUTES.sessions, {
      method: "POST",
      body: { profile: { id: "p1", kind: "ssh", host: "192.0.2.10", port: 22, user: "deploy", password } },
    });
    expect(created.status).toBe(201);
    const sessionId = (created.body as { session: { id: string } }).session.id;
    expect(passwords).toEqual([password]);

    diagCalls.length = 0;
    const response = await call(routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId, command: "login --password=" + password, mode: "shell" },
    });

    expect(response.status).toBe(200);
    // 命令确实执行了：口令被抹掉，而不是整段输出被丢掉
    expect((response.body as { stdout: string }).stdout).toContain("login --password=***");
    expect(response.raw).not.toContain(password);

    const execDiag = diagCalls.find((entry) => entry.event === "session.exec");
    expect(execDiag).toBeDefined();
    expect(JSON.stringify(diagCalls)).not.toContain(password);
    expect(String(execDiag?.data?.commandPreview)).toContain("--password=***");
    expect(String(execDiag?.data?.commandPreview).length).toBeLessThanOrEqual(120);
  });

  it("records exactly one session.exec for a run through the route path", async () => {
    const fixture = await execFixture();

    diagCalls.length = 0;
    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: fixture.info.id, command: "uname -a" },
    });

    expect(response.status).toBe(200);
    // M5-5：审计下沉到 createSessionExec，路由层不再重复记——一次执行恰好一条
    const audited = diagCalls.filter((entry) => entry.event === "session.exec");
    expect(audited).toHaveLength(1);
    expect(audited[0]?.data).toMatchObject({
      sessionId: fixture.info.id,
      mode: "exec",
      code: 0,
      commandPreview: "uname -a",
    });
    expect(diagCalls.some((entry) => entry.event === "session.exec-failed")).toBe(false);
  });

  it("refuses an interactive program in shell mode before touching the user's shell", async () => {
    const fixture = await execFixture();

    diagCalls.length = 0;
    const response = await call(fixture.routes, UNITERMINAL_ROUTES.sessionExec, {
      method: "POST",
      body: { sessionId: fixture.info.id, command: "cd /opt && vim /opt/test.sh", mode: "shell" },
    });

    expect(response.status).toBe(400);
    expect(String((response.body as { error?: unknown }).error)).toContain("mode=exec");
    // 一行都没有敲进用户的终端
    expect(fixture.writes).toEqual([]);
    // 拒绝也是一次执行尝试：留痕，但只记在失败事件上
    expect(diagCalls.filter((entry) => entry.event === "session.exec")).toHaveLength(0);
    expect(diagCalls.filter((entry) => entry.event === "session.exec-failed")).toHaveLength(1);
  });
});


/** 外观响应体的形状断言：先把 JSON 收窄成契约里的 { appearance }。 */
const appearanceOf = (body: unknown): typeof DEFAULT_APPEARANCE =>
  (body as { appearance: typeof DEFAULT_APPEARANCE }).appearance;

const errorOf = (body: unknown): string => String((body as { error?: unknown }).error);

describe("appearance routes (M6-1)", () => {
  /** 与 apply 一致：同步构造、异步加载，处理器动作前 await ready。 */
  async function setupAppearance(): Promise<{ routes: WebRouteLike[]; appearance: AppearanceStore }> {
    const appearance = new AppearanceStore(join(dir, "appearance"));
    const ready = appearance.load().then(() => undefined);
    await ready;
    return { routes: createRoutes(makeManager(), { appearance, ready }), appearance };
  }

  /** 契约里的完整外观（自定义主题全部字段都给全）。 */
  const SAVED = {
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 18,
    lineHeight: 1.4,
    letterSpacing: 0.5,
    themeMode: "custom",
    background: "#0b0f14",
    foreground: "#d6dde4",
    cursor: "#7aa2f7",
    selectionBackground: "#2a3441",
  };

  it("is an exact route on the contract path", async () => {
    const { routes } = await setupAppearance();

    expect(UNITERMINAL_ROUTES.appearance).toBe("/api/uniterminal/appearance");
    // 经 matchRoute 断言：直接抓 handler 会绕过宿主的匹配规则
    const matched = matchRoute(routes, UNITERMINAL_ROUTES.appearance);
    expect(matched?.kind).toBe("exact");
    expect(matched?.path).toBe(UNITERMINAL_ROUTES.appearance);
  });

  it("GET returns the defaults when nothing was saved", async () => {
    const { routes } = await setupAppearance();

    const response = await call(routes, UNITERMINAL_ROUTES.appearance);

    expect(response.status).toBe(200);
    expect(appearanceOf(response.body)).toEqual(DEFAULT_APPEARANCE);
  });

  it("POST saves and the following GET returns the same appearance", async () => {
    const { routes } = await setupAppearance();

    const saved = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: SAVED },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, appearance: SAVED });

    const listed = await call(routes, UNITERMINAL_ROUTES.appearance);
    expect(listed.status).toBe(200);
    expect(appearanceOf(listed.body)).toEqual(SAVED);
  });

  it("POST accepts a partial patch and keeps the other fields", async () => {
    const { routes } = await setupAppearance();

    const saved = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: { fontSize: 22 } },
    });
    expect(saved.status).toBe(200);

    const listed = await call(routes, UNITERMINAL_ROUTES.appearance);
    const appearance = appearanceOf(listed.body);
    expect(appearance.fontSize).toBe(22);
    // 没 POST 的字段仍取默认：patch 绝不把别的字段清空
    expect(appearance.fontFamily).toBe(DEFAULT_APPEARANCE.fontFamily);
    expect(appearance.themeMode).toBe(DEFAULT_APPEARANCE.themeMode);
  });

  it("rejects an out-of-range value with 400 naming the field", async () => {
    const { routes } = await setupAppearance();

    const badSize = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: { fontSize: 99 } },
    });
    expect(badSize.status).toBe(400);
    expect(errorOf(badSize.body)).toContain("fontSize");

    const badMode = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: { themeMode: "neon" } },
    });
    expect(badMode.status).toBe(400);
    expect(errorOf(badMode.body)).toContain("themeMode");

    // 被拒的请求一个字节都没落盘：GET 仍是默认值
    const listed = await call(routes, UNITERMINAL_ROUTES.appearance);
    expect(appearanceOf(listed.body)).toEqual(DEFAULT_APPEARANCE);
  });

  it("rejects non-loopback callers with 403 and writes nothing", async () => {
    const { routes } = await setupAppearance();

    const read = await call(routes, UNITERMINAL_ROUTES.appearance, { address: "10.0.0.5" });
    expect(read.status).toBe(403);

    const write = await call(routes, UNITERMINAL_ROUTES.appearance, {
      address: "10.0.0.5",
      method: "POST",
      body: { appearance: { fontSize: 20 } },
    });
    expect(write.status).toBe(403);

    const stored = await readdir(join(dir, "appearance")).catch(() => [] as string[]);
    expect(stored).toEqual([]);
  });

  it("returns 503 when the appearance store was not injected", async () => {
    // 旧调用方式：createRoutes 没有 deps，绝不能假装外观存下来了
    const routes = createRoutes(makeManager());

    const read = await call(routes, UNITERMINAL_ROUTES.appearance);
    expect(read.status).toBe(503);

    const write = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: { fontSize: 20 } },
    });
    expect(write.status).toBe(503);
  });

  it("returns 405 for methods other than GET and POST", async () => {
    const { routes } = await setupAppearance();

    const rejected = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "PUT",
      body: { appearance: { fontSize: 20 } },
    });

    expect(rejected.status).toBe(405);
  });

  it("rejects a malformed body with 400, naming the offending field", async () => {
    const { routes } = await setupAppearance();

    const missing = await call(routes, UNITERMINAL_ROUTES.appearance, { method: "POST", body: {} });
    expect(missing.status).toBe(400);
    expect(errorOf(missing.body)).toContain("appearance");

    const unknown = await call(routes, UNITERMINAL_ROUTES.appearance, {
      method: "POST",
      body: { appearance: { colour: "#ffffff" } },
    });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown.body)).toContain("colour");
  });
});

describe("appearance config seed (M6-1)", () => {
  const BASE_CONFIG = { bufferBytes: 1 << 20, term: "xterm-256color", connectTimeoutMs: 20000 };

  it("keeps a partial appearance block from the plugin config", () => {
    const parsed = Config({ ...BASE_CONFIG, appearance: { fontSize: 18, themeMode: "dark" } });

    expect(parsed.appearance).toEqual({ fontSize: 18, themeMode: "dark" });
    // 不配外观也是合法的：seed 为空对象，全部取内置默认
    expect(Config({ ...BASE_CONFIG }).appearance).toEqual({});
  });

  it("seeds the store defaults with the configured appearance", async () => {
    const appearance = new AppearanceStore(join(dir, "seeded-appearance"), { fontSize: 20, themeMode: "light" });
    const ready = appearance.load().then(() => undefined);
    await ready;
    const routes = createRoutes(makeManager(), { appearance, ready });

    const response = await call(routes, UNITERMINAL_ROUTES.appearance);

    expect(response.status).toBe(200);
    expect(appearanceOf(response.body)).toMatchObject({ fontSize: 20, themeMode: "light" });
  });
});

describe("transport failure classification: profile test timer (M8-2)", () => {
  it("classifies the test-path timer message as a timeout, not an unknown", () => {
    const classified = classifyTransportError(new Error("uniterminal: connection timed out after 15000 ms"));
    expect(classified.code).toBe("timeout");
    // 同一个物理现象在两个入口必须给同一句话
    expect(classified.message).toContain("超时");
  });
});

describe("transport failure classification (M8-1)", () => {
  const REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  const errorText = (body: unknown): string => String((body as { error?: unknown }).error);

  /** 传输层必失败的一套路由：open 直接抛给定错误，别的都不参与。 */
  const failingRoutes = (error: Error): WebRouteLike[] => {
    const registry = new TransportRegistry();
    registry.register({
      kind: "ssh",
      capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
      open: async () => {
        throw error;
      },
    });
    return createRoutes(new SessionManager(registry, { bufferBytes: 16 }));
  };

  it("classifies both timeout shapes as timeout", () => {
    // 两种真实形状：ssh2 的 readyTimeout 只带 message，socket 层带 code
    const byCode = classifyTransportError({ code: "ETIMEDOUT" });
    const byMessage = classifyTransportError(new Error("Timed out while waiting for handshake"));
    const bySocket = classifyTransportError(new Error("Timed out while waiting for socket"));

    expect(byCode.code).toBe("timeout");
    expect(byMessage.code).toBe("timeout");
    expect(bySocket.code).toBe("timeout");
    // 文案必须点出真实原因，绝不能把用户引去查口令
    expect(byMessage.message).toContain("超时");
    expect(byMessage.message).not.toContain("认证失败");
  });

  it("classifies a refused connection", () => {
    expect(classifyTransportError({ code: "ECONNREFUSED" }).code).toBe("refused");
    expect(classifyTransportError(new Error("connect ECONNREFUSED 192.0.2.10:2222")).message).toContain("拒绝");
  });

  it("classifies DNS failures", () => {
    expect(classifyTransportError({ code: "ENOTFOUND" }).code).toBe("dns");
    expect(classifyTransportError({ code: "EAI_AGAIN" }).code).toBe("dns");
    expect(classifyTransportError({ code: "ENOTFOUND" }).message).toContain("主机名");
  });

  it("classifies unreachable networks", () => {
    expect(classifyTransportError({ code: "EHOSTUNREACH" }).code).toBe("unreachable");
    expect(classifyTransportError({ code: "ENETUNREACH" }).code).toBe("unreachable");
    expect(classifyTransportError({ code: "ENETUNREACH" }).message).toContain("不可达");
  });

  it("classifies a changed host key", () => {
    const classified = classifyTransportError(new Error("uniterminal: host key changed for 192.0.2.10:2222 (presented SHA256:abc)"));

    expect(classified.code).toBe("hostkey");
    expect(classified.message).toContain("指纹");
  });

  it("classifies real authentication failures", () => {
    expect(classifyTransportError(new Error("All configured authentication methods failed")).code).toBe("auth");
    expect(classifyTransportError(new Error("Permission denied (publickey)")).code).toBe("auth");
    expect(classifyTransportError(new Error("Client authentication failed")).code).toBe("auth");
    expect(classifyTransportError(new Error("All configured authentication methods failed")).message).toContain("认证失败");
  });

  it("keeps other transport text verbatim", () => {
    const raw = "uniterminal: connection closed by peer";
    const classified = classifyTransportError(new Error(raw));

    expect(classified.code).toBe("unknown");
    // 原样返回：分类表里没有的失败就照原话说，绝不替它编一个原因
    expect(classified.message).toBe(raw);
  });

  it("classifies an unknown host key as hostkey instead of dumping the raw text", () => {
    const classified = classifyTransportError(new Error("uniterminal: unknown host key for 192.0.2.10:2222 (SHA256:abc)"));

    // 首次连接的未知指纹必须单独成类：它是「还没信任过」，不是「传输层出了怪事」
    expect(classified.code).toBe("hostkey");
    expect(classified.message).toContain("主机指纹未知");
    // 指纹未知与指纹变更分开说，两句不许互相顶替
    expect(classified.message).not.toContain("已变更");
    expect(classified.message).not.toContain("认证失败");
  });

  it("reports a transport timeout as a timeout instead of blaming the credentials", async () => {
    const routes = failingRoutes(Object.assign(new Error("Timed out while waiting for handshake"), { code: "ETIMEDOUT" }));

    const response = await connect(routes, { ...REMOTE, password: "wrong-password-42", auth: { kind: "password" } });

    expect(response.status).toBe(500);
    const text = errorText(response.body);
    expect(text).toContain("超时");
    // 用户实报：超时被报成「密码：认证失败：…」，把人引去查口令
    expect(text).not.toContain("认证失败");
    expect(text).not.toContain("密码：");
  });

  it("still says 认证失败 when the transport really rejected the credentials", async () => {
    const routes = failingRoutes(new Error("All configured authentication methods failed"));

    const response = await connect(routes, { ...REMOTE, password: "wrong-password-42", auth: { kind: "password" } });

    expect(response.status).toBe(500);
    const text = errorText(response.body);
    expect(text).toContain("密码：认证失败");
    expect(text).toContain("All configured authentication methods failed");
    expect(text).not.toContain("超时");
  });
});

/**
 * 机器可判别的错误响应：前端按 code 决定文案形态，hostkey 再拿 host/port/fingerprint 三元组。
 * 老前端仍按 payload.error 读文案，所以 error 一个字都不能少——只增加字段。
 */
describe("transport failure response shape (code + host key details)", () => {
  const REMOTE = { id: "p1", kind: "ssh", host: "192.0.2.10", port: 2222, user: "deploy" };

  const connect = (routes: WebRouteLike[], profile: Record<string, unknown>): Promise<Captured> =>
    call(routes, UNITERMINAL_ROUTES.sessions, { method: "POST", body: { profile } });

  /** 传输层必失败的一套路由：open 直接抛给定错误，别的都不参与。 */
  const failingRoutes = (error: Error): WebRouteLike[] => {
    const registry = new TransportRegistry();
    registry.register({
      kind: "ssh",
      capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
      open: async () => {
        throw error;
      },
    });
    return createRoutes(new SessionManager(registry, { bufferBytes: 16 }));
  };

  it("puts host, port and fingerprint into the hostkey response body", async () => {
    const routes = failingRoutes(new Error("uniterminal: unknown host key for 192.0.2.10:2222 (SHA256:abc)"));

    const response = await connect(routes, REMOTE);

    expect(response.status).toBe(500);
    const body = response.body as {
      error?: string;
      code?: string;
      host?: string;
      port?: number;
      fingerprint?: string;
    };
    expect(body.code).toBe("hostkey");
    expect(body.host).toBe("192.0.2.10");
    expect(body.port).toBe(2222);
    expect(body.fingerprint).toBe("SHA256:abc");
    // 文案改成中文结论：英文原文不再原样透出，前端不必再从原文里抠指纹
    expect(String(body.error)).toContain("主机指纹未知");
    expect(String(body.error)).not.toContain("unknown host key");
  });

  it("parses the host key details of an IPv6 target", () => {
    const details = hostKeyDetails(new Error("uniterminal: unknown host key for [::1]:22 (SHA256:abc)"));

    expect(details).toEqual({ host: "[::1]", port: 22, fingerprint: "SHA256:abc" });
  });

  it("parses the presented fingerprint of a changed host key", () => {
    const details = hostKeyDetails(new Error("uniterminal: host key changed for 192.0.2.10:2222 (presented SHA256:abc)"));

    expect(details).toEqual({ host: "192.0.2.10", port: 2222, fingerprint: "SHA256:abc" });
  });

  it("answers undefined when the transport text carries no host key details", () => {
    expect(hostKeyDetails(new Error("connect ECONNREFUSED 192.0.2.10:2222"))).toBeUndefined();
    expect(hostKeyDetails(undefined)).toBeUndefined();
  });

  it("puts the transport code into the session failure body", async () => {
    const cases: { error: Error; code: string }[] = [
      { error: Object.assign(new Error("Timed out while waiting for handshake"), { code: "ETIMEDOUT" }), code: "timeout" },
      { error: Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:2222"), { code: "ECONNREFUSED" }), code: "refused" },
      { error: Object.assign(new Error("getaddrinfo ENOTFOUND host.invalid"), { code: "ENOTFOUND" }), code: "dns" },
      { error: Object.assign(new Error("connect EHOSTUNREACH 192.0.2.10:2222"), { code: "EHOSTUNREACH" }), code: "unreachable" },
      { error: new Error("All configured authentication methods failed"), code: "auth" },
    ];

    for (const item of cases) {
      const routes = failingRoutes(item.error);

      const response = await connect(routes, { ...REMOTE, password: "wrong-password-42", auth: { kind: "password" } });

      expect(response.status).toBe(500);
      const body = response.body as { error?: string; code?: string };
      expect(body.code).toBe(item.code);
      // 老前端按 payload.error 读文案：文案必须还在，一个字都不能少
      expect(String(body.error).length).toBeGreaterThan(0);
    }
  });

  it("refuses a non-ssh protocol kind with a clear 400", async () => {
    const routes = createRoutes(makeManager());

    for (const kind of ["local", "telnet", "serial"]) {
      const response = await connect(routes, { id: "p1", kind, host: "192.0.2.10", port: 2222, user: "deploy" });

      expect(response.status).toBe(400);
      // 其它协议只是留位：注册表里没有它们的适配器，连必 500，不如在建会话这一步说清楚
      expect(String((response.body as { error?: string }).error)).toBe("目前只支持 SSH 连接");
    }
  });
});

/**
 * M8-20 终端状态栏：宿主一条 exact 路由，一次 exec 取回全部指标。
 * fixture 与 test/monitor.test.ts 取自同一份真实样本（地址换作文档保留段 192.0.2.0/24）。
 */
interface MonitorBody {
  supported: boolean;
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  uptimeSec: number;
  users: number;
  reason?: string;
}

const MONITOR_CPU_LINE = "cpu  28018 1386 67680 48805903 526421 14069 32965 0 0 0";
const MONITOR_MEM_LINES = ["MemTotal:        3708744 kB", "MemAvailable:    2607676 kB"].join("\n");
const MONITOR_UPTIME_LINE = "123886.29 488059.04";
const MONITOR_NET_LINES = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 37126423   75758    0    0    0     0          0         0 37126423   75758    0    0    0     0       0          0",
  "ens160: 24697243356 26539191    0    0    0     0          0       586 22571156081 17492024    0    3    0     0       0          0",
].join("\n");
const MONITOR_RAW = [
  MONITOR_CPU_LINE,
  MONITOR_MEM_LINES,
  MONITOR_UPTIME_LINE,
  "3",
  MONITOR_NET_LINES,
].join("\n---\n");
/** 第二份：Δtotal=1000 / Δidle=250 → 75%；两个方向各 +1000000 字节、Δt=2s → 500000 B/s。 */
const MONITOR_SECOND_RAW = MONITOR_RAW.replace(
  "cpu  28018 1386 67680 48805903 526421 14069 32965 0 0 0",
  "cpu  28768 1386 67680 48806153 526421 14069 32965 0 0 0",
)
  .replace("123886.29 488059.04", "123888.29 488059.04")
  .replace(
    "ens160: 24697243356 26539191    0    0    0     0          0       586 22571156081 17492024    0    3    0     0       0          0",
    "ens160: 24698243356 26539191    0    0    0     0          0       586 22572156081 17492024    0    3    0     0       0          0",
  );

/** 监控路由的假会话：exec 走独立通道，调用记录用来断言"非 loopback 一条命令都不跑"。 */
async function monitorFixture(options: { stdout?: string[]; fail?: () => never } = {}) {
  const ran: { command: string; timeoutMs?: number }[] = [];
  const queue = [...(options.stdout ?? [])];
  const fixture = execManager({
    exec: async (request) => {
      ran.push({ command: request.command, timeoutMs: request.timeoutMs });
      if (options.fail !== undefined) options.fail();
      return {
        mode: "exec",
        stdout: queue.shift() ?? "",
        stderr: "",
        code: 0,
        truncated: false,
        timedOut: false,
        ms: 1,
      };
    },
  });
  const first = await fixture.manager.open({ id: "p1", kind: "ssh", host: "192.0.2.25", user: "root", port: 22 });
  const second = await fixture.manager.open({ id: "p2", kind: "ssh", host: "192.0.2.25", user: "root", port: 22 });
  const routes = createRoutes(fixture.manager);
  const url = (sessionId: string): string =>
    UNITERMINAL_ROUTES.monitor + "?sessionId=" + encodeURIComponent(sessionId);
  return { ...fixture, routes, ran, sessionId: first.id, otherSessionId: second.id, url };
}

describe("monitor route (M8-20)", () => {
  it("is an exact route and answers 403 without running anything for a non-loopback caller", async () => {
    const fixture = await monitorFixture({ stdout: [MONITOR_RAW] });

    expect(matchRoute(fixture.routes, UNITERMINAL_ROUTES.monitor)?.kind).toBe("exact");

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, {
      address: "10.0.0.5",
      url: fixture.url(fixture.sessionId),
    });

    expect(response.status).toBe(403);
    // 闸门在 exec 之前：被拒的请求一条命令都不许跑
    expect(fixture.ran).toEqual([]);
  });

  it("serves the contract shape over one exec channel for a loopback caller", async () => {
    const fixture = await monitorFixture({ stdout: [MONITOR_RAW] });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, {
      url: fixture.url(fixture.sessionId),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      supported: true,
      cpuPct: null,
      memUsedBytes: (3708744 - 2607676) * 1024,
      memTotalBytes: 3708744 * 1024,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      uptimeSec: 123886.29,
      users: 3,
    });
    // 一次 exec 拿全部指标；必须走独立通道（用户终端里的 shell 不许被写进任何东西）
    expect(fixture.ran).toHaveLength(1);
    const command = fixture.ran[0]?.command ?? "";
    expect(command.startsWith("sh -c ")).toBe(true);
    expect(command).toContain("/proc/stat");
    expect(command).toContain("/proc/meminfo");
    expect(command).toContain("/proc/uptime");
    expect(command).toContain("/proc/net/dev");
    // M8-24：磁盘监控已按用户要求取消，命令里不再有 df
    expect(command).not.toContain("df");
    // 给命令一个上限：轮询每 4 秒一次，挂住的通道不能越积越多
    expect(fixture.ran[0]?.timeoutMs).toBeGreaterThan(0);
    // 用户终端里必须一个字节都没写
    expect(fixture.writes).toEqual([]);
  });

  it("keeps the previous sample per session so cpu and rates come from the delta", async () => {
    const fixture = await monitorFixture({ stdout: [MONITOR_RAW, MONITOR_SECOND_RAW, MONITOR_RAW] });

    const first = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, { url: fixture.url(fixture.sessionId) });
    expect((first.body as MonitorBody).cpuPct).toBeNull();

    const second = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, { url: fixture.url(fixture.sessionId) });
    expect(second.body).toMatchObject({ cpuPct: 75, rxBytesPerSec: 500000, txBytesPerSec: 500000 });

    // 上一份样本按 sessionId 隔离：另一条会话不能被别的会话的差值污染
    const other = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, {
      url: fixture.url(fixture.otherSessionId),
    });
    expect((other.body as MonitorBody).cpuPct).toBeNull();
  });

  it("answers 200 with supported:false instead of 500 when the exec channel fails", async () => {
    const fixture = await monitorFixture({
      fail: () => {
        throw new Error("channel closed");
      },
    });

    const response = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, {
      url: fixture.url(fixture.sessionId),
    });

    expect(response.status).toBe(200);
    const body = response.body as MonitorBody;
    expect(body.supported).toBe(false);
    expect(body.reason).toContain("channel closed");
    expect(body.memTotalBytes).toBe(0);
  });

  it("answers 405 for a non-GET request and 400 without a sessionId", async () => {
    const fixture = await monitorFixture({ stdout: [MONITOR_RAW] });

    const wrongMethod = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, { method: "POST" });
    expect(wrongMethod.status).toBe(405);

    const noSession = await call(fixture.routes, UNITERMINAL_ROUTES.monitor, { url: UNITERMINAL_ROUTES.monitor });
    expect(noSession.status).toBe(400);
    expect(fixture.ran).toEqual([]);
  });
});
