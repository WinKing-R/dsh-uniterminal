import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import type { TransportRegistry } from "./engine/registry.js";
import type { SessionManager } from "./engine/session-manager.js";
import {
  isSftpOp,
  requireAbsolutePath,
  runSftpOp,
  SftpChannelError,
  SftpRequestError,
  type SftpLike,
} from "./engine/sftp.js";
import { normalizeTunnelSpec, TunnelError } from "./engine/tunnel.js";
import type { TunnelManager, TunnelSpec } from "./engine/tunnel.js";
import { ExecChannelError } from "./engine/types.js";
import type { ProfileAuth, ProfileAuthKind, ProtocolKind, ResolvedProfile } from "./engine/types.js";
import { authKindOr, authKindsText, isAuthKind } from "./auth-kinds.js";
import { nameLimitMessage, nameTooLong } from "./name-limits.js";
import { scrubSecrets, type ExecMode, type ExecRunner } from "./agent-tools.js";
import { diag } from "./host-diag.js";
import { parseMonitor, unsupportedSample, type MonitorPrev } from "./monitor.js";
import { AppearanceError, type AppearanceStore } from "./store/appearance.js";
import type { KnownHosts } from "./store/known-hosts.js";
import type { ProfileStore, StoredGroup, StoredProfile } from "./store/profile-store.js";
import { normalizeFolderPath } from "./store/profile-store.js";
import type { SecurityStore } from "./store/security.js";
import {
  CREDENTIAL_PREFIX,
  CredentialBackendUnavailableError,
  KEY_PREFIX,
  KEY_PASSPHRASE_PREFIX,
  STORAGE_LABEL_FILE,
} from "./store/credential-backend.js";
import { parseSshConfig, type ImportedHost } from "./store/ssh-config-import.js";

export interface WebRouteLike {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

/** 由 apply 注入的持久化依赖；缺省时 profiles / trust 路由一律 503（保持旧调用方式可用）。 */
export interface RouteDeps {
  profiles?: ProfileStore;
  knownHosts?: KnownHosts;
  /** 双档凭据库；缺省时 security 路由一律 503。 */
  security?: SecurityStore;
  /** store 的异步加载：处理器在动作前 await；加载失败按 503 上报，绝不静默清空。 */
  ready?: Promise<void>;
  /** ~/.ssh/config 的路径；缺省走 os.homedir()，测试注入临时文件。 */
  sshConfigPath?: string;
  /**
   * 传输注册表：只有「测试连接」用它建一条临时连接（不经 SessionManager）。
   * 缺省时该路由 503——绝不假装连上了。
   */
  registry?: TransportRegistry;
  /**
   * M3-1 SFTP 通道源：apply 接线成 manager.openSftp，复用**已经建立**的 SSH 连接。
   * 缺省时三个 SFTP 端点一律 503——绝不假装文件能传（接线缺陷已在这个项目踩过两次）。
   */
  sftp?: (sessionId: string) => Promise<SftpLike>;
  /** M3-7 上传完成等待的上限（缺省 60 秒）：只为让测试注入极短超时，线上无需设置。 */
  sftpUploadTimeoutMs?: number;
  /**
   * M3-2 隧道管理器：apply 接线成隧道表 + manager.openTunnels 能力源。
   * 缺省时三个隧道端点一律 503——绝不假装端口已经转发出去。
   */
  tunnels?: TunnelManager;
  /**
   * M5-1 exec 源：apply 接线成 createSessionExec(manager)（exec / shell 两个模式都在那一层）。
   * 缺省时 /sessions/exec 一律 503——绝不假装命令执行过。
   */
  exec?: ExecRunner;
  /** M5-1 开关：off 时该端点 403 并说明已关闭（工具也不会被注册）。 */
  agentExec?: "on" | "off";
  /** M6-1 外观存储：缺省时 /appearance 一律 503——绝不假装外观已经存下来了。 */
  appearance?: AppearanceStore;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROTOCOLS = new Set<ProtocolKind>(["ssh", "local", "telnet", "serial"]);
/**
 * 凭据类字段一律不接受：profiles.json 只有非敏感字段。
 * privateKey 与口令同级——私钥内容只许进 credentials.json。
 */
const CREDENTIAL_FIELDS = ["password", "passphrase", "secret", "privateKey"] as const;
/** 导入的主机统一挂在这个分组下，保证「按分组缩进」在只有导入数据时也可见。 */
const IMPORTED_GROUP = "ssh-config";
// 凭据 ref 的三种前缀（profile: / key: / key-passphrase:）只在 store/credential-backend.ts 定义一处：
// 系统密码箱是按 service 枚举条目的，认"哪几条是我们的"要用同一份前缀——两份实现迟早会走偏。
/**
 * M2d：读不到私钥时给一条能照着做的出路——回表单把认证方式切回「密码」再点「保存配置」。
 * 文案里只出现路径，绝不出现任何密钥内容。
 */
const identityNotReadable = (identityPath: string): string =>
  "私钥文件读不到：" + identityPath + "。可在表单里把认证方式切回「密码」并点「保存配置」。";
/**
 * M2d-3：用户明确「只用私钥」时，私钥读不到就 400，文案必须给出把密码这一路选回来的退路——
 * 静默改用密码（哪怕保险库里正好有）比报错更糟：它绕过了用户的明确表态。
 */
const KEY_ONLY_RETRY_HINT =
  "如果想用密码登录，请勾选「使用密码」后再连接，或点「保存配置」把默认认证方式改成密码。";
/** 中文句号收尾的直接接，英文原文补一个空格，两条文案不会粘在一起。 */
const withKeyOnlyHint = (reason: string): string =>
  reason.endsWith("。") ? reason + KEY_ONLY_RETRY_HINT : reason + " " + KEY_ONLY_RETRY_HINT;
const NO_PRIVATE_KEY = "uniterminal: no private key configured";
// 认证方式白名单只在 src/auth-kinds.ts 维护：这里曾经另存一份，M15 漏改它导致保存 400
/** 私钥类请求体的解析失败文案：JSON 解析错误原文可能带着含私钥的请求体片段。 */
const INVALID_JSON = "body is not valid JSON";
const PASSWORD_REQUIRED = "uniterminal: password required";
/** M2d-2：空私钥配置（kind 为 key 却没有任何私钥）永不落库，落库被摘掉时用它告诉界面。 */
const KEY_AUTH_UNCONFIGURED = "私钥尚未配置，未保存该认证方式";
/** 测试连接的超时缺省：profile 没写 connectTimeoutMs 时用它（口径见计划 M2c-2）。 */
const TEST_CONNECT_TIMEOUT_MS = 15000;
/** M5-1 允许的执行模式：exec 走独立通道，shell 写进用户正在用的那个 shell。 */
const EXEC_MODES: ReadonlySet<string> = new Set<ExecMode>(["exec", "shell"]);
/** M3-7：上传完成等待的上限。写流既不 finish 也不 close 时，绝不永久挂起。 */
const SFTP_UPLOAD_FINISH_TIMEOUT_MS = 60000;
/**
 * M8-20 状态栏取数：一次 exec 把六段指标全拿回来（CPU / 内存 / uptime / 用户数 / 网卡 / df），
 * 减少往返。只用 POSIX sh 与 /proc——Linux 都有；非 Linux 上命令失败或输出不可解析，路由回 supported:false。
 */
/**
 * 状态栏取数命令：只读 /proc 与 who，不再调用 df（用户已要求取消磁盘监控）。
 * 顺带的好处是彻底避开了「远端挂失联 NFS 时 df 永久阻塞」这条挂死路径。
 */
const MONITOR_COMMAND =
  "sh -c 'cat /proc/stat | head -1; echo ---; grep -E \"^(MemTotal|MemAvailable)\" /proc/meminfo; echo ---; cat /proc/uptime; echo ---; who 2>/dev/null | wc -l; echo ---; cat /proc/net/dev'";
/** 状态栏 4 秒轮询一次：单次取数的上限比一轮短，挂住的通道不会一轮压一轮。 */
const MONITOR_TIMEOUT_MS = 6000;

/** 等待写流完成超过上限：单独一类错误，好把「超时」与「写流报错」分开记。 */
class SftpUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super("uniterminal: 上传超时（等待写流完成超过 " + String(Math.round(timeoutMs / 1000)) + " 秒）");
    this.name = "SftpUploadTimeoutError";
  }
}

export const UNITERMINAL_ROUTES = {
  health: "/api/uniterminal/health",
  sessions: "/api/uniterminal/sessions",
  // 关闭会话刻意走 exact 的独立路径，不用 DELETE /sessions/:id：M1-12 的尾斜杠事故出在前缀匹配上。
  sessionClose: "/api/uniterminal/sessions/close",
  // M5-1：给任意 AI 会话用的执行入口。同样用 exact 独立路径，绝不落到 /sessions 的前缀匹配上。
  sessionExec: "/api/uniterminal/sessions/exec",
  wsPrefix: "/api/uniterminal/ws",
  diag: "/api/uniterminal/diag",
  profiles: "/api/uniterminal/profiles",
  // 不带尾斜杠：宿主的 prefix 匹配是 pathname === prefix || pathname.startsWith(prefix + "/")，
  // 带尾斜杠会让 /profiles/<id> 永远匹配不上（实测落到宿主兜底 404）。
  profilesPrefix: "/api/uniterminal/profiles",
  profilesImport: "/api/uniterminal/profiles/import",
  // M2c-2 测试连接：与 import 同理用 exact 独立路径，绝不落到 /profiles/<id> 的 DELETE 上
  profilesTest: "/api/uniterminal/profiles/test",
  // M2b 粘贴私钥：与 /profiles 共享路径空间，因此同样用 exact 独立路径
  profilesKey: "/api/uniterminal/profiles/key",
  profilesKeyDelete: "/api/uniterminal/profiles/key/delete",
  // 取消"记住密码"时清掉已存口令：此前只改 remember 标记，凭据库里的口令还在，
  // 于是列表里的盾牌图标一直亮着（用户实报）
  profilesForget: "/api/uniterminal/profiles/forget-password",
  // 文件夹三个端点都用 exact 路由：/folders/delete 与 /folders/rename 都是独立路径，
  // 绝不靠前缀匹配（尾斜杠事故的教训）
  folders: "/api/uniterminal/folders",
  foldersDelete: "/api/uniterminal/folders/delete",
  foldersRename: "/api/uniterminal/folders/rename",
  // M10-A：分组自己就是一张表，客户端按 id 拿；颜色写进分组，不再进 appearance
  groups: "/api/uniterminal/groups",
  groupsColor: "/api/uniterminal/groups/color",
  hostTrust: "/api/uniterminal/hosts/trust",
  // security 端点全用 exact：/security 与 /security/* 共享路径空间，前缀匹配会把子路径吞成 GET 状态查询。
  security: "/api/uniterminal/security",
  // 旧版凭据的清理入口：删掉已停用的旧档文件，把本机登记回唯一的那一档。破坏性动作，要 confirm。
  securityClearLegacy: "/api/uniterminal/security/clear-legacy",
  // refs 只回名字，永不回密钥。
  securityRefs: "/api/uniterminal/security/refs",
  // M3-1：文件操作只开一条 exact 路由，靠 op 分发；传输另走流式端点（大文件不能 base64）
  sftpOp: "/api/uniterminal/sftp/op",
  sftpDownload: "/api/uniterminal/sftp/download",
  sftpUpload: "/api/uniterminal/sftp/upload",
  /** M8-14：浏览器不发 upload.onprogress 时，客户端靠这条拿"宿主真实收到多少字节"。 */
  sftpUploadProgress: "/api/uniterminal/sftp/upload-progress",
  // M3-2：/tunnels 一条 exact 承载启动(POST)与列表(GET)，停止另走独立 exact 路径
  tunnels: "/api/uniterminal/tunnels",
  tunnelsStop: "/api/uniterminal/tunnels/stop",
  // M6-1：外观一条 exact 承载读取(GET)与保存(POST)，路径按计划里的契约
  appearance: "/api/uniterminal/appearance",
  // M8-20 终端状态栏：GET ?sessionId=，独立 exact 路径，与 sessions/appearance 的路径空间互不干扰
  monitor: "/api/uniterminal/monitor",
} as const;

/** 可注入的持久化依赖名；storeBlocker 用它判断「未注入」还是「加载失败」。 */
type StoreKind = "profiles" | "knownHosts" | "security" | "appearance";

/**
 * 宿主 WebServer.match 的逐行复刻：先查 exact 表，未命中再按最长 prefix 胜出遍历 prefix 表，
 * 条件是 pathname === prefix || pathname.startsWith(prefix + "/")。
 * 单测用它代替宿主做路由匹配——直接调 handler 会绕过匹配器，从而漏掉 prefix 写错的缺陷。
 */
export function matchRoute(routes: WebRouteLike[], pathname: string): WebRouteLike | undefined {
  const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
  if (exact !== undefined) return exact;
  let best: WebRouteLike | undefined;
  for (const route of routes) {
    if (route.kind !== "prefix") continue;
    if (pathname !== route.path && !pathname.startsWith(route.path + "/")) continue;
    if (best === undefined || route.path.length > best.path.length) best = route;
  }
  return best;
}

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/** 分组单段名的长度上限：与客户端输入框同一口径。 */
// 分组名与主机名共用 src/name-limits.ts 的上限（此前这里是 64，能写成长串撑爆标题行）
/** 分组颜色与 appearance 的旧口径同一形：只认 #rgb 与 #rrggbb。 */
const GROUP_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const requireGroupColor = (value: unknown): string => {
  if (typeof value !== "string" || !GROUP_COLOR_PATTERN.test(value)) {
    throw new TypeError("color must be #rgb or #rrggbb");
  }
  return value;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** M8-1：传输层失败的分类。只有 auth 才是「认证失败」，其它都指向真实原因。 */
export type TransportErrorCode = "timeout" | "refused" | "dns" | "unreachable" | "hostkey" | "auth" | "unknown";

export interface ClassifiedTransportError {
  code: TransportErrorCode;
  message: string;
}

/**
 * 判定表：code 或错误文案命中即归这一类，表序即优先级。
 * 同一类里 code 与文案都要能命中——ssh2 的 readyTimeout 只给文案，socket 层只给 code。
 */
const TRANSPORT_ERROR_RULES: { code: Exclude<TransportErrorCode, "unknown">; needles: string[]; message: string }[] = [
  {
    code: "timeout",
    needles: ["ETIMEDOUT", "Timed out while waiting for handshake", "Timed out while waiting for socket", "timed out"],
    message: "目标主机无响应（连接超时）：主机可能离线、被防火墙拦截，或端口不对",
  },
  {
    code: "refused",
    needles: ["ECONNREFUSED"],
    message: "连接被拒绝：该端口没有 SSH 服务，或端口写错",
  },
  {
    code: "dns",
    needles: ["ENOTFOUND", "EAI_AGAIN"],
    message: "主机名解析失败：检查主机地址或 DNS",
  },
  {
    code: "unreachable",
    needles: ["EHOSTUNREACH", "ENETUNREACH"],
    message: "网络不可达：本机到目标主机之间没有路由",
  },
  {
    code: "hostkey",
    needles: ["host key changed"],
    message: "主机指纹已变更（可能是重装或被冒充）：确认后重新信任",
  },
  {
    // 指纹未知（第一次见这台机器）与指纹变更必须分开说：前者是「还没信任过」，后者是「信任过但变了」。
    // 这条 needle 与上面那条不重叠，表序即优先级，两条各管各的。
    code: "hostkey",
    needles: ["unknown host key"],
    message: "主机指纹未知：这是第一次连接这台主机，确认指纹无误后再信任",
  },
  {
    code: "auth",
    needles: ["All configured authentication methods failed", "Permission denied", "authentication"],
    message: "认证失败：用户名、口令或公钥不被接受",
  },
];

/** 传输层原话：优先取 message（Error 与 { message } 两种形状都认），否则按字符串化兜底。 */
const transportErrorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return String(error);
};

const transportErrorCode = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
};

/**
 * M8-1：把传输层失败按真实原因分类（纯函数，无 IO）。
 * 用户实报：TCP 超时（readyTimeout 的 "Timed out while waiting for handshake"）被报成
 * 「密码：认证失败：…」，把人引去查口令，而真实原因是主机离线 / 网络 / 端口 / 防火墙。
 */
export function classifyTransportError(error: unknown): ClassifiedTransportError {
  const raw = transportErrorText(error);
  const code = transportErrorCode(error);
  const haystack = raw.toLowerCase();
  for (const rule of TRANSPORT_ERROR_RULES) {
    const hit = rule.needles.some((needle) => code === needle || haystack.includes(needle.toLowerCase()));
    if (hit) // 正在进行的上传：sessionId → 已收字节数。浏览器的事件不可靠，这里才是真进度。
 return { code: rule.code, message: rule.message };
  }
  return { code: "unknown", message: raw };
}

/** 指纹三元组：前端据此写「这台机器还没信任过 / 要不要信任」的文案，不必再从英文原文里猜。 */
export interface HostKeyDetails {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * 传输层原文里的指纹三元组（纯函数、无 IO、不抛错；解析不出来返回 undefined）。
 * 原文形态见 src/store/known-hosts.ts：uniterminal: unknown host key for <host>:<port> (<SHA256:...>)
 * 指纹变更那条形态是 (... (presented <SHA256:...>))，指纹同样解得出来。
 * host 里可能有冒号（IPv6，如 [::1]:22），所以端口从**最后一个**冒号切，host 原样回显。
 */
const HOST_KEY_DETAIL =
  /(?:unknown host key for|host key changed for)\s+(\S+):(\d+)\s+\((?:presented\s+)?([^)\s]+)\)/;

export function hostKeyDetails(error: unknown): HostKeyDetails | undefined {
  const matched = HOST_KEY_DETAIL.exec(transportErrorText(error));
  if (matched === null) return undefined;
  const host = matched[1];
  const port = matched[2];
  const fingerprint = matched[3];
  if (host === undefined || port === undefined || fingerprint === undefined) return undefined;
  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return undefined;
  return { host, port: parsedPort, fingerprint };
}

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * 客户端重连用的 ws 端点（M4-1）：建会话与列会话共用同一份拼接，两处形状必须一致，
 * 否则「接管孤儿会话」拿到的地址连不上。port 取当前请求所在监听口——页面 origin 可能是 app://，
 * location.host 不是可连的主机，因此一律由宿主给出回环地址。
 */
function wsEndpoint(req: IncomingMessage, sessionId: string): { host: string; port: number | undefined; path: string } {
  return { host: "127.0.0.1", port: req.socket.localPort, path: UNITERMINAL_ROUTES.wsPrefix + "/" + sessionId };
}

/** 每个路由的第一道闸：非 loopback 一律 403，且不读请求体。 */
function allowLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  sendJson(res, 403, { error: "forbidden" });
  return false;
}

/** 旧版凭据文件在场时的固定文案：用户下一步只有一个动作——清理。 */
const LEGACY_CREDENTIALS = "旧版凭据文件还在，请先清理旧版凭据";
/**
 * 系统密码箱这一刻取不到（被锁 / 服务没起 / 原生模块装不上）。
 *
 * 这是**独立**的一类错误：原来所有异常都被说成"请输入密码"，密码箱不可用时那句话是错的——
 * 用户会以为自己的密码没记住，于是重新输入一遍（而真相是后端暂时用不了）。
 * 底层异常原文（可能带路径、库名）绝不透给界面：这里只有一句固定文案。
 */
const KEYCHAIN_UNAVAILABLE = "系统密码箱不可用，请稍后重试";
/** store 抛这句英文原文时，翻译成用户看得懂的 409，而不是裸奔的 500。 */
const LEGACY_CREDENTIALS_MARK = "legacy credentials are present";

/**
 * store 的异常一律 500：凭据文件读不了 / 写不了是服务端故障，不是用户的请求写错了。
 *
 * 旧档位那套状态码（409「已配置」/ 401「口令错」/ 400「不是严格档」）已随旧档位一起删除——
 * 现在没有"档位"这回事，也就没有与之对应的 4xx。唯一保留的 4xx 是上面那条新状态：旧档在场。
 */
function sendSecurityFailure(res: ServerResponse, error: unknown): void {
  const message = messageOf(error);
  if (message.includes(LEGACY_CREDENTIALS_MARK)) {
    sendJson(res, 409, { error: LEGACY_CREDENTIALS });
    return;
  }
  diag("security.failed", { error: message.slice(0, 160) });
  // 密码箱不可用：只给一句固定文案。底层异常原文（可能带路径、库名）不透给界面。
  if (error instanceof CredentialBackendUnavailableError) {
    sendJson(res, 503, { error: KEYCHAIN_UNAVAILABLE });
    return;
  }
  sendJson(res, 500, { error: message.startsWith("uniterminal: ") ? message : "uniterminal: " + message });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 会话请求里的显式认证选择（M2d-2）：密码与私钥可以共存，kind='both' 表示界面两个都勾了。
 * 与存档层的 ProfileAuth 只差这一个 'both'——存档层仍然只能表达单方法（store 契约不改）。
 */
type RequestAuthKind = ProfileAuthKind;

interface RequestAuth {
  kind: RequestAuthKind;
  identityPath?: string;
}

// 请求层与存档层接受**同一组**取值（both 现在两处都合法），因此共用 isAuthKind

/**
 * 会话请求里的档案：ResolvedProfile 是 engine 的契约（本批不改），
 * 「界面勾了哪种认证」与「直接给的路径」只在本路由层用这两个附带字段携带。
 */
type RequestedProfile = ResolvedProfile & { auth?: RequestAuth; identityPath?: string };

/** 请求体的 auth 校验口径与存档层一致（kind 白名单、identityPath 非空字符串），另加 'both'。 */
function parseRequestAuth(record: Record<string, unknown>): RequestAuth | undefined {
  const value = record.auth;
  if (value === undefined || value === null) return undefined;
  const auth = requireRecord(value, "profile.auth");
  rejectCredentialFields(auth, "auth.");
  const kind = requireText(auth.kind, "profile.auth.kind");
  if (!isAuthKind(kind)) throw new TypeError("profile.auth.kind must be one of " + authKindsText());
  const rawPath = auth.identityPath;
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== "string") {
    throw new TypeError("profile.auth.identityPath must be a string");
  }
  if (typeof rawPath === "string" && rawPath.trim() === "") {
    throw new TypeError("profile.auth.identityPath must be a non-empty string");
  }
  return typeof rawPath === "string"
    ? { kind: kind as RequestAuthKind, identityPath: rawPath }
    : { kind: kind as RequestAuthKind };
}

/**
 * 建会话只支持 SSH：注册表里目前只有 ssh 适配器（src/index.ts 只注册它），
 * 其它 kind 能存进档案却连必 500。与其让用户看到一句 transport "local" is not available，
 * 不如在建会话这一步就说清楚「目前只支持 SSH 连接」。
 */
class UnsupportedProtocolError extends Error {
  constructor() {
    super("目前只支持 SSH 连接");
    this.name = "UnsupportedProtocolError";
  }
}

function parseProfile(input: unknown): RequestedProfile {
  const profile = (input as { profile?: unknown } | null)?.profile as Record<string, unknown> | undefined;
  if (profile === null || typeof profile !== "object") throw new TypeError("profile is required");
  const { id, kind } = profile;
  if (typeof id !== "string" || id.length === 0) throw new TypeError("profile.id must be a non-empty string");
  // 只在这里收紧：其它 kind 是留位（档案层仍按 PROTOCOLS 存），建会话则一律拒掉。
  if (kind !== "ssh") throw new UnsupportedProtocolError();
  // 请求里可以直接带私钥内容与口令（M2d-2）：只做类型校验，绝不落库、绝不进日志
  for (const field of ["privateKey", "passphrase"] as const) {
    const value = profile[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TypeError("profile." + field + " must be a string");
    }
  }
  // 请求体的 auth 与存档层同一套校验，非法一律 400；没带就原样返回，由 resolveAuth 回落到磁盘存档。
  const auth = parseRequestAuth(profile);
  const identityPath = optionalText(profile, "identityPath");
  // M3-3 跳板链：带了就必须是字符串数组（每项 user@host:port），非法一律 400
  const proxyChain = optionalStringArray(profile, "proxyChain");
  const requested = profile as unknown as RequestedProfile;
  const withAuth = auth === undefined ? requested : { ...requested, auth };
  const withIdentityPath = identityPath === undefined ? withAuth : { ...withAuth, identityPath };
  return proxyChain === undefined ? withIdentityPath : { ...withIdentityPath, proxyChain };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new TypeError(what + " must be an object");
  return record;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(what + " must be a non-empty string");
  return value;
}

const optionalText = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("profile." + key + " must be a string");
  return value;
};

const optionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("profile." + key + " must be a finite number");
  }
  return value;
};

const optionalPort = (record: Record<string, unknown>, key: string): number | undefined => {
  const port = optionalNumber(record, key);
  if (port === undefined) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("profile." + key + " must be a port");
  return port;
};

const optionalStringArray = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError("profile." + key + " must be a string array");
  }
  return value.map((item) => String(item).trim()).filter((item) => item !== "");
};

const optionalBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError("profile." + key + " must be a boolean");
  return value;
};

const rejectCredentialFields = (record: Record<string, unknown>, prefix = ""): void => {
  for (const field of CREDENTIAL_FIELDS) {
    if (field in record) {
      throw new TypeError("uniterminal: " + prefix + field + " is rejected: profiles never store credentials");
    }
  }
};

/** auth 块只留方式与路径：私钥内容连字段名都不接受。 */
const optionalAuth = (record: Record<string, unknown>): ProfileAuth | undefined => {
  const value = record.auth;
  if (value === undefined || value === null) return undefined;
  const auth = requireRecord(value, "profile.auth");
  rejectCredentialFields(auth, "auth.");
  const kind = auth.kind === undefined ? "password" : requireText(auth.kind, "profile.auth.kind");
  if (!isAuthKind(kind)) throw new TypeError("profile.auth.kind must be one of " + authKindsText());
  const rawPath = auth.identityPath;
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== "string") {
    throw new TypeError("profile.auth.identityPath must be a string");
  }
  if (typeof rawPath === "string" && rawPath.trim() === "") {
    throw new TypeError("profile.auth.identityPath must be a non-empty string");
  }
  return typeof rawPath === "string" ? { kind: kind as ProfileAuthKind, identityPath: rawPath } : { kind: kind as ProfileAuthKind };
};

/** 归档入参：分组的两种寻址方式。客户端旧契约用路径，新契约用 id。 */
interface ProfileInput {
  profile: StoredProfile;
  /** 给了 path（哪怕是空数组）就以路径为准：空数组 = 移回根层。 */
  groupPath?: string[];
}

/** 白名单取值：请求体里没被列出的字段（含任何凭据字段）都不可能进入 profiles.json。 */
function parseProfileInput(input: unknown): ProfileInput {
  const body = requireRecord(input, "body");
  const raw = requireRecord(body.profile ?? body, "profile");

  rejectCredentialFields(raw);

  const id = raw.id === undefined || raw.id === null ? randomUUID() : requireText(raw.id, "profile.id");
  const name = raw.name === undefined || raw.name === null
    ? requireText(raw.host ?? id, "profile.name")
    : requireText(raw.name, "profile.name");
  if (nameTooLong(name)) throw new TypeError(nameLimitMessage("名称"));
  const kind = raw.kind === undefined ? "ssh" : requireText(raw.kind, "profile.kind");
  if (!PROTOCOLS.has(kind as ProtocolKind)) throw new TypeError("profile.kind must be one of ssh|local|telnet|serial");
  const groupId = raw.groupId === undefined || raw.groupId === null ? null : requireText(raw.groupId, "profile.groupId");

  return {
    profile: {
      id,
      name,
      kind: kind as ProtocolKind,
      groupId,
      host: optionalText(raw, "host"),
      port: optionalPort(raw, "port"),
      user: optionalText(raw, "user"),
      keepaliveMs: optionalNumber(raw, "keepaliveMs"),
      connectTimeoutMs: optionalNumber(raw, "connectTimeoutMs"),
      tags: optionalStringArray(raw, "tags"),
      remember: optionalBoolean(raw, "remember"),
      auth: optionalAuth(raw),
      // M3-3 跳板链：从 ssh_config 导入或界面显式给出，都是每项 user@host:port 的字符串数组
      proxyJump: optionalStringArray(raw, "proxyJump"),
      // 时间戳由 ProfileStore 维护；这里给占位值。
      createdAt: 0,
      updatedAt: 0,
    },
    // M10-A 兼容：客户端还按 groupPath 调用；解析成 groupId 在处理器里做（要建表，是异步的）
    groupPath: optionalStringArray(raw, "groupPath"),
  };
}

function importedToStored(host: ImportedHost, groupId: string | null): StoredProfile {
  return {
    id: IMPORTED_GROUP + ":" + host.alias,
    name: host.alias,
    kind: "ssh",
    groupId,
    host: host.host ?? host.alias,
    port: host.port,
    user: host.user,
    // M3-3：ssh_config 的 ProxyJump 不再丢弃——丢了导入出来的档案就会悄悄直连
    proxyJump: host.proxyJump,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 依赖是否可用：未注入或加载失败都返回可直接回给客户端的原因。 */
async function storeBlocker(deps: RouteDeps | undefined, kind: StoreKind): Promise<string | undefined> {
  if (deps?.[kind] === undefined) return "uniterminal: " + kind + " store unavailable";
  try {
    await deps?.ready;
    return undefined;
  } catch (error) {
    return "uniterminal: " + kind + " store unavailable (" + messageOf(error) + ")";
  }
}

const requestPath = (req: IncomingMessage): string => (req.url ?? "").split("?")[0] ?? "";

/** 缺省模式就是 exec：AI 会话默认不该往用户的终端里打字。 */
function parseExecMode(value: unknown): ExecMode {
  if (value === undefined || value === null) return "exec";
  if (typeof value !== "string" || !EXEC_MODES.has(value)) {
    throw new TypeError("mode must be 'exec' or 'shell'");
  }
  return value === "shell" ? "shell" : "exec";
}

const optionalTimeoutMs = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  return value;
};

/* M5-5：命令与命令输出都可能带着口令或私钥，抹除只有一份实现（见 agent-tools.ts 的 scrubSecrets）。 */

/** 从 /profiles/<id> 里取 id：去一位斜杠后再解码（id 可能含 ":"，如 ssh-config:192.0.2.25）。 */
function profileIdFrom(pathname: string): string | undefined {
  const prefix = UNITERMINAL_ROUTES.profilesPrefix;
  if (!pathname.startsWith(prefix + "/")) return undefined;
  const raw = pathname.slice(prefix.length + 1);
  if (raw === "") return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (id === "" || id.includes("/")) return undefined;
  return id;
}

const defaultSshConfigPath = (): string => join(homedir(), ".ssh", "config");

export function createRoutes(manager: SessionManager, deps?: RouteDeps): WebRouteLike[] {
  // 正在进行的上传：sessionId → 已收字节数。浏览器可能根本不发 upload.onprogress，
  // 所以进度以宿主**真实收到**的字节为准，客户端定时来问。
  const activeUploads = new Map<string, { path: string; receivedBytes: number }>();
  const profiles = deps?.profiles;
  const knownHosts = deps?.knownHosts;
  const security = deps?.security;
  const registry = deps?.registry;
  const sftpSource = deps?.sftp;
  const uploadTimeoutMs = deps?.sftpUploadTimeoutMs ?? SFTP_UPLOAD_FINISH_TIMEOUT_MS;
  const tunnelManager = deps?.tunnels;
  const execSource = deps?.exec;
  const agentExecEnabled = (deps?.agentExec ?? "on") !== "off";
  const appearance = deps?.appearance;
  /**
   * M8-20 状态栏：sessionId → 上一份样本（参考 activeUploads 的写法）。
   * CPU 与网络都是累计计数器，差值只能在宿主侧算；按会话隔离，别的会话的差值不会串进来。
   */
  const monitorPrev = new Map<string, MonitorPrev>();

  /** 诊断文案永不回显口令：命中即整体抹掉（put 抛出的错误消息里也可能拼着口令）。 */
  const scrub = (message: string, secret: string): string =>
    secret === "" ? message : message.split(secret).join("***");

  /** store 未注入或加载失败一律视为「没有存档档案」：口令路径不给任何特权，也不会误存。 */
  const storedProfile = async (id: string): Promise<StoredProfile | undefined> => {
    if (profiles === undefined) return undefined;
    try {
      await deps?.ready;
    } catch {
      return undefined;
    }
    return profiles.get(id);
  };

  /**
   * D10 口令解析：请求体给了就用请求体的；没给才查保险库。
   * profiles 未注入 = 这台宿主没启用持久化（旧的调用方式），此时不做强制，行为保持不变。
   */
  const resolvePassword = async (
    profile: ResolvedProfile,
  ): Promise<{ ok: true; password: string | undefined } | { ok: false; error: string }> => {
    const supplied = typeof profile.password === "string" && profile.password !== "" ? profile.password : undefined;
    if (supplied !== undefined) return { ok: true, password: supplied };
    if (profiles === undefined) return { ok: true, password: undefined };

    const stored = await storedProfile(profile.id);
    // 只看"库里有没有"，不看 remember：remember 的语义是"连接成功后保存口令"，
    // 不是"允不允许使用已存口令"。用它做使用判据会出现：重新导入覆盖了 remember，
    // 库里明明有口令却报 password required，而界面盾牌（按 refs 判断）还亮着——两边说法不一致。
    if (security === undefined) return { ok: false, error: PASSWORD_REQUIRED };
    try {
      const saved = await security.get(CREDENTIAL_PREFIX + profile.id);
      if (saved === undefined || saved === "") {
        // 降级状态下"取不到"**不等于**"没存过"：密码箱里那份可能只是暂时读不到。
        // 说成"请输入密码"是在骗用户——他会以为自己的密码没记住。
        if (security.degraded()) return { ok: false, error: KEYCHAIN_UNAVAILABLE };
        return { ok: false, error: PASSWORD_REQUIRED };
      }
      return { ok: true, password: saved };
    } catch (error) {
      if (error instanceof CredentialBackendUnavailableError) return { ok: false, error: KEYCHAIN_UNAVAILABLE };
      return { ok: false, error: PASSWORD_REQUIRED };
    }
  };

  /** 只在会话成功打开之后写库，remember 取存档里的真值；写失败绝不影响已经建立的会话。 */
  const rememberPassword = async (profile: ResolvedProfile, password: string): Promise<void> => {
    if (security === undefined) return;
    const stored = await storedProfile(profile.id);
    if (stored?.remember !== true) return;
    try {
      await security.put(CREDENTIAL_PREFIX + profile.id, password);
    } catch (error) {
      diag("credential.store-failed", { id: profile.id, error: scrub(messageOf(error), password).slice(0, 160) });
    }
  };

  /** 每种认证方式「为什么没用上」：既可能是私钥读不到，也可能是没记住密码。 */
  type AuthNotes = { key?: string; password?: string };

  type AuthResolution =
    | { ok: true; password?: string; privateKey?: string; passphrase?: string; notes: AuthNotes }
    | { ok: false; error: string };

  /** 私钥口令（可选）：取不到只影响带口令的私钥，绝不把库状态拼进响应。 */
  const resolvePassphrase = async (id: string): Promise<string | undefined> => {
    if (security === undefined) return undefined;
    try {
      const saved = await security.get(KEY_PASSPHRASE_PREFIX + id);
      return saved === undefined || saved === "" ? undefined : saved;
    } catch {
      return undefined;
    }
  };

  /**
   * 私钥材料（M2d-2）：请求里的路径 > 请求里直接给的私钥内容 > 存档里的路径 > 凭据库里的粘贴私钥。
   * 拿不到只是「这条方式不可用」：原因写进 notes，交给密码继续，绝不在这里把连接判死。
   */
  const resolveKeyMaterial = async (
    profile: RequestedProfile,
    stored: StoredProfile | undefined,
    notes: AuthNotes,
  ): Promise<{ privateKey?: string; passphrase?: string }> => {
    const requestPath = profile.auth?.identityPath ?? profile.identityPath;
    const identityPath = requestPath ?? stored?.auth?.identityPath;
    let privateKey: string | undefined;
    /** 路径方式：读不到只记原因，绝不在这里判死（可能还有密码、也可能还有存档路径）。 */
    const readIdentity = async (path: string): Promise<void> => {
      try {
        const text = await readFile(path, "utf8");
        if (text.trim() !== "") privateKey = text;
      } catch {
        privateKey = undefined;
      }
      if (privateKey === undefined) notes.key = identityNotReadable(path);
    };
    if (requestPath !== undefined) {
      await readIdentity(requestPath);
    } else if (typeof profile.privateKey === "string" && profile.privateKey !== "") {
      privateKey = profile.privateKey;
    } else if (identityPath !== undefined) {
      await readIdentity(identityPath);
    } else if (security !== undefined) {
      try {
        const saved = await security.get(KEY_PREFIX + profile.id);
        if (saved !== undefined && saved !== "") privateKey = saved;
        else notes.key = security.degraded() ? KEYCHAIN_UNAVAILABLE : NO_PRIVATE_KEY;
      } catch (error) {
        // 密码箱不可用时说成"没配私钥"同样是骗用户（他会以为自己的私钥被删了）。
        notes.key = error instanceof CredentialBackendUnavailableError ? KEYCHAIN_UNAVAILABLE : NO_PRIVATE_KEY;
      }
    } else {
      notes.key = NO_PRIVATE_KEY;
    }
    if (privateKey === undefined) return {};
    const passphrase = profile.passphrase ?? (await resolvePassphrase(profile.id));
    return passphrase === undefined ? { privateKey } : { privateKey, passphrase };
  };

  /** 请求显式勾选的认证方式优先；没表态才用存档里的 kind（D10 口令 / M2b 私钥的旧口径）。 */
  const requestedMethods = (
    profile: RequestedProfile,
    stored: StoredProfile | undefined,
  ): { password: boolean; key: boolean } => {
    // 没有显式表态时按存档还原；authKindOr 会把不认识的值收敛到默认值
  const kind: RequestAuthKind = profile.auth?.kind ?? authKindOr(stored?.auth?.kind);
    return { password: kind !== "key", key: kind !== "password" };
  };

  /**
   * 认证解析（M2d-3）：请求里的 auth.kind 是用户的明确表态，必须被尊重——
   *  - 显式 key：只有私钥这一条路，读不到就 400 并给出退路，绝不静默改用密码；
   *  - 显式 both：两条路都交给传输层，私钥读不到就降级用密码并记一条 diag；
   *  - 显式 password：只走密码，即使存档里留着 key 配置也不碰；
   *  - 没表态（老数据、直接调 API）：保留防锁死兜底——私钥不可用但有密码就继续用密码，同样记 diag。
   */
  const resolveAuth = async (profile: RequestedProfile): Promise<AuthResolution> => {
    const stored = await storedProfile(profile.id);
    const explicit = profile.auth?.kind !== undefined;
    const methods = requestedMethods(profile, stored);
    const notes: AuthNotes = {};
    const key = methods.key ? await resolveKeyMaterial(profile, stored, notes) : {};
    const secret = await resolvePassword(profile);
    let password = secret.ok ? secret.password : undefined;
    if (!secret.ok) notes.password = secret.error;
    const keyOk = key.privateKey !== undefined;
    // 「没勾密码」就不动用密码：私钥已经可用时，密码绝不参与这次连接
    if (!methods.password && keyOk) password = undefined;
    // 显式只用私钥却没读到私钥：拒绝降级（静默拿密码顶上正是 M2d-3 的缺陷）
    const keyOnlyRefusal = !methods.password && !keyOk && explicit;
    if (methods.key && !keyOk) {
      diag("auth.key-unavailable", {
        id: profile.id,
        reason: (notes.key ?? NO_PRIVATE_KEY).slice(0, 160),
        fallback: keyOnlyRefusal || password === undefined ? "none" : "password",
      });
    }
    if (keyOnlyRefusal) {
      const reason = notes.key ?? NO_PRIVATE_KEY;
      // 密码箱不可用时，"改用密码登录"那条提示是误导（密码走的是同一个后端）：只给真实原因。
      return { ok: false, error: reason === KEYCHAIN_UNAVAILABLE ? reason : withKeyOnlyHint(reason) };
    }
    if (!keyOk && password === undefined && (notes.key !== undefined || !secret.ok)) {
      return { ok: false, error: notes.key ?? notes.password ?? NO_PRIVATE_KEY };
    }
    return { ok: true, password, privateKey: key.privateKey, passphrase: key.passphrase, notes };
  };

  /**
   * 传输层失败的用户文案：先看分类（M8-1），只有 auth 才拼 M2d-2 的合并文案
   * ——「私钥为什么没用上 / 密码为什么没用上」各一句，再附上传输层的原话；
   * 其余分类（超时/拒绝/解析/不可达/指纹）只给分类结论，用户才不会被引去查口令。
   */
  const describeAuthFailure = (
    error: string,
    auth: AuthResolution,
    classification: ClassifiedTransportError,
  ): string => {
    // M8-1：只有真是认证问题才拼「私钥：/密码：」这两句。超时/拒绝/解析/不可达/指纹
    // 拼上它们只会把用户引去查口令，而真实原因在网络、端口或防火墙。
    if (classification.code !== "auth") return classification.message;
    if (!auth.ok) return error;
    const keyNote = auth.privateKey !== undefined ? "认证失败" : auth.notes.key;
    const passwordNote = auth.password !== undefined ? "认证失败" : auth.notes.password;
    const parts: string[] = [];
    if (keyNote !== undefined) parts.push("私钥：" + keyNote);
    if (passwordNote !== undefined) parts.push("密码：" + passwordNote);
    return parts.length === 0 ? error : parts.join(" / ") + "：" + error;
  };

  const guard = async (res: ServerResponse, kind: StoreKind): Promise<boolean> => {
    const blocker = await storeBlocker(deps, kind);
    if (blocker === undefined) return true;
    sendJson(res, 503, { error: blocker });
    return false;
  };

  /**
   * 测试连接（M2c-2）：按存档解析认证，直接走传输层建一条**临时**连接再立刻关掉。
   * 刻意不经过 SessionManager——不入 manager、不占 ring buffer、不注册升级路由。
   */
  const testProfileConnection = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (registry === undefined) {
      sendJson(res, 503, { error: "uniterminal: transport registry unavailable" });
      return;
    }
    let id: string;
    try {
      id = requireText(requireRecord(await readJson(req), "body").id, "id");
    } catch (error) {
      diag("profile.test-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const stored = profiles?.get(id);
    if (stored === undefined) {
      diag("profile.test", { id, ok: false, reason: "unknown-profile" });
      sendJson(res, 404, { error: "uniterminal: unknown profile" });
      return;
    }
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;
    const target: ResolvedProfile = {
      id: stored.id,
      kind: stored.kind,
      host: stored.host,
      port: stored.port,
      user: stored.user,
      keepaliveMs: stored.keepaliveMs,
      connectTimeoutMs: stored.connectTimeoutMs,
      // M3-3：测试连接必须走与真实会话同一条跳板链，否则「连通」结论会骗人
      proxyChain: stored.proxyJump,
    };
    const auth = await resolveAuth(target);
    if (!auth.ok) {
      // 认证都没过就不该建连接：结论是「连不通」，原因照原话给
      const ms = elapsed();
      diag("profile.test", { id, kind: stored.kind, host: stored.host, port: stored.port, ok: false, ms, error: auth.error });
      sendJson(res, 200, { ok: false, error: auth.error, ms });
      return;
    }
    // 凭据只活在这一次内存态档案里：不写库、不进响应、不进诊断
    const resolved: ResolvedProfile = { ...target };
    if (auth.password !== undefined) resolved.password = auth.password;
    if (auth.privateKey !== undefined) resolved.privateKey = auth.privateKey;
    if (auth.passphrase !== undefined) resolved.passphrase = auth.passphrase;
    const scrubFailure = (message: string): string =>
      scrub(scrub(scrub(message, auth.password ?? ""), auth.privateKey ?? ""), auth.passphrase ?? "");
    const timeoutMs = stored.connectTimeoutMs ?? TEST_CONNECT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // 先 abort 让传输层自己收尾，再让等连接的一方立刻拿到定时错误
        controller.abort();
        reject(new Error("uniterminal: connection timed out after " + timeoutMs + " ms"));
      }, timeoutMs);
    });
    try {
      const opening = registry.require(stored.kind).open(resolved, controller.signal);
      // 超时先到时这次 open 的拒绝必须已被接管，否则会变成 unhandledRejection
      void opening.catch(() => undefined);
      const handle = await Promise.race([opening, timedOut]);
      try {
        await handle.close();
      } catch {
        // 已经连通，close 的失败不改变结论
      }
      const ms = elapsed();
      diag("profile.test", { id, kind: stored.kind, host: stored.host, port: stored.port, ok: true, ms });
      sendJson(res, 200, { ok: true, ms });
    } catch (error) {
      // M8-1：按真实原因分类，超时不再被说成认证失败
      const classification = classifyTransportError(error);
      const detail = scrubFailure(classification.message);
      const ms = elapsed();
      diag("profile.test", {
        id,
        kind: stored.kind,
        host: stored.host,
        port: stored.port,
        ok: false,
        ms,
        code: classification.code,
        error: detail.slice(0, 160),
      });
      // 与建会话同一条分类函数：同一个物理失败在两个入口给同一个 code。
      sendJson(res, 200, { ok: false, error: detail, ms, code: classification.code });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const listProfiles = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    // groups 是分组表的原样输出：路径是客户端自己派生的，宿主不再拼一份给它
    sendJson(res, 200, { profiles: profiles?.list() ?? [], groups: profiles?.listGroups() ?? [] });
  };

  /**
   * M2d-2：绝不让「空私钥配置」落库——kind 为 key 却没有路径、凭据库里也没有 key:<id> 时，
   * 整条 auth 都不写（回落到密码），并回一条 warning 让界面说清楚为什么没保存。
   */
  const persistableAuth = async (profile: StoredProfile): Promise<StoredProfile> => {
    const authKind = profile.auth?.kind;
  // both 与 key 一样：没有路径就得看凭据库里有没有私钥，否则这半条路进不了存档
  if ((authKind !== "key" && authKind !== "both") || profile.auth?.identityPath !== undefined) {
    return profile;
  }
    let hasKey = false;
    if (security !== undefined) {
      try {
        const saved = await security.get(KEY_PREFIX + profile.id);
        hasKey = saved !== undefined && saved !== "";
      } catch {
        hasKey = false;
      }
    }
    return hasKey ? profile : { ...profile, auth: undefined };
  };

  const upsertProfile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let parsed: StoredProfile;
    try {
      parsed = await groupFromPath(parseProfileInput(await readJson(req)));
    } catch (error) {
      diag("profile.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const profile = await persistableAuth(parsed);
    const authDropped = parsed.auth !== undefined && profile.auth === undefined;
    await profiles?.upsert(profile);
    if (authDropped) diag("profile.auth-dropped", { id: profile.id });
    diag("profile.upserted", { id: profile.id, kind: profile.kind, host: profile.host, port: profile.port });
    const saved = profiles?.get(profile.id) ?? profile;
    sendJson(res, 201, authDropped ? { profile: saved, warning: KEY_AUTH_UNCONFIGURED } : { profile: saved });
  };

  const importProfiles = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    // 客户端可以传 { dryRun: true } 只做预览（不写盘）；空 body 是旧契约，按真正导入处理
    let dryRun = false;
    try {
      const body = requireRecord(await readJson(req), "body");
      dryRun = body.dryRun === true;
    } catch {
      dryRun = false;
    }
    const configPath = deps?.sshConfigPath ?? defaultSshConfigPath();
    let text = "";
    let missing = false;
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      missing = true;
    }
    const result = parseSshConfig(text);
    if (dryRun) {
      // 预览：让用户先看到"会加进来几台"，确认后才真正写盘
      diag("profile.import-preview", { path: configPath, found: result.hosts.length, skipped: result.skipped });
      sendJson(res, 200, {
        preview: true,
        found: result.hosts.length,
        skipped: result.skipped,
        path: configPath,
        missing,
        hosts: result.hosts.map((host) => host.alias),
      });
      return;
    }
    const importedGroup = profiles === undefined ? undefined : await profiles.ensureGroup([IMPORTED_GROUP]);
    for (const host of result.hosts) {
      const fresh = importedToStored(host, importedGroup?.id ?? null);
      // 导入是"补配置"，不是"重置档案"：已有的 remember / 分组 / 创建时间都要保住。
      // 否则重新导入一次就把"记住密码"清掉（用户实报：盾牌还在，测试却报没密码）。
      const existing = profiles?.get(fresh.id);
      await profiles?.upsert(
        existing === undefined
          ? fresh
          : {
              ...fresh,
              remember: existing.remember,
              groupId: existing.groupId ?? fresh.groupId,
              createdAt: existing.createdAt,
            },
      );
    }
    diag("profile.imported", { path: configPath, imported: result.hosts.length, skipped: result.skipped.length, missing });
    sendJson(res, 200, {
      imported: result.hosts.length,
      skipped: result.skipped,
      directives: result.directives,
      path: configPath,
    });
  };

  const removeProfile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "DELETE") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const id = profileIdFrom(requestPath(req));
    if (id === undefined) {
      sendJson(res, 404, { error: "uniterminal: profile id missing or malformed" });
      return;
    }
    const removed = profiles?.get(id) !== undefined;
    await profiles?.remove(id);
    diag("profile.removed", { id, removed });
    sendJson(res, 200, { id, removed });
  };

  /** 客户端旧契约：groupPath 路径 → 分组 id（不存在就建整条链）。空路径 = 根层。 */
  const groupFromPath = async (input: ProfileInput): Promise<StoredProfile> => {
    const path = input.groupPath;
    if (path === undefined) return input.profile;
    if (path.length === 0) return { ...input.profile, groupId: null };
    const group = await profiles?.ensureGroup(path);
    return { ...input.profile, groupId: group?.id ?? null };
  };

  /** 分组端点的公共寻址：group id 优先，其次路径（客户端旧契约）。 */
  const groupOf = (body: Record<string, unknown>): StoredGroup | undefined => {
    const groupId = body.groupId;
    if (typeof groupId === "string" && groupId !== "") return profiles?.groupById(groupId);
    const path = body.path;
    if (path === undefined) throw new TypeError("body must carry 'path' or 'groupId'");
    return profiles?.groupByPath(normalizeFolderPath(path));
  };

  /** M10-A：客户端要的是 {id, name, parentId, color}，不是拼出来的路径。 */
  const listGroups = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, { groups: profiles?.listGroups() ?? [] });
  };

  /**
   * M10-A：颜色写进 group.color。appearance.groupColors 从此只作为迁移来源，
   * 这张表不再被写——改名也就不必再搬颜色键（M9-22 的那段迁移代码随之消失）。
   */
  const saveGroupColor = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let group: StoredGroup | undefined;
    let color: string | null;
    try {
      const body = requireRecord(await readJson(req), "body");
      color = body.color === undefined || body.color === null ? null : requireGroupColor(body.color);
      group = groupOf(body);
    } catch (error) {
      diag("group.color-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    if (group === undefined) {
      sendJson(res, 404, { error: "uniterminal: group not found" });
      return;
    }
    const saved = await profiles?.setGroupColor(group.id, color);
    diag("group.color-saved", { id: group.id, color });
    sendJson(res, 200, { group: saved ?? group });
  };

  const addFolder = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let path: string[];
    try {
      const body = requireRecord(await readJson(req), "body");
      path = normalizeFolderPath(body.path);
    } catch (error) {
      diag("folder.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const group = await profiles?.ensureGroup(path);
    diag("folder.added", { path, id: group?.id });
    sendJson(res, 201, { path, group: group ?? null });
  };

  const deleteFolder = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let path: string[];
    try {
      const body = requireRecord(await readJson(req), "body");
      path = normalizeFolderPath(body.path);
    } catch (error) {
      diag("folder.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    // 只有真的动过东西才算 removed：整棵子树连同挂在里面的主机引用
    const removed = (await profiles?.removeFolder(path)) ?? false;
    diag("folder.removed", { path, removed });
    sendJson(res, 200, { path, removed });
  };

  /**
   * M9-22 的分组改名，M10-A 起内里只改一个字段：主机按 id 引用分组，
   * 子分组与其中的主机因此跟着组走——**没有一台主机会被重写**。
   * 路径参数保留以兼容客户端；名字与删除端点同款：先 loopback，再校验。
   */
  const renameFolder = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "profiles"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let path: string[];
    let name: string;
    try {
      const body = requireRecord(await readJson(req), "body");
      path = normalizeFolderPath(body.path);
      if (typeof body.name !== "string") throw new TypeError("name must be a string");
      name = body.name.trim();
      if (name === "") throw new TypeError("name must be a non-empty string");
      if (name.includes("/")) throw new TypeError("name must not contain '/'");
      if (nameTooLong(name)) throw new TypeError(nameLimitMessage("分组名"));
    } catch (error) {
      diag("folder.rename-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const group = profiles?.groupByPath(path);
    // 新旧同名 / 路径不存在都算没改名：绝不为了凑数去建或删任何分组
    const renamed = group === undefined ? false : ((await profiles?.renameGroup(group.id, name)) ?? false);
    diag("folder.renamed", { path, name, id: group?.id, renamed });
    if (!renamed || group === undefined) {
      sendJson(res, 200, { renamed: 0 });
      return;
    }
    sendJson(res, 200, { renamed: 1, group: profiles?.groupById(group.id) ?? group });
  };

  const trustHost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "knownHosts"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let host: string;
    let port: number;
    let fingerprint: string;
    try {
      const body = requireRecord(await readJson(req), "body");
      host = requireText(body.host, "host");
      if (/\s/.test(host)) throw new TypeError("host must not contain whitespace");
      const rawPort = body.port;
      if (rawPort === undefined || rawPort === null) {
        port = 22;
      } else if (typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) {
        port = rawPort;
      } else {
        throw new TypeError("port must be an integer between 1 and 65535");
      }
      fingerprint = requireText(body.fingerprint, "fingerprint");
      if (/\s/.test(fingerprint) || fingerprint.length > 512) throw new TypeError("fingerprint is malformed");
    } catch (error) {
      diag("host.trust-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    if (knownHosts?.check(host, port, fingerprint) === "mismatch") {
      diag("host.trust-refused", { host, port });
      sendJson(res, 409, { error: "uniterminal: host key changed for " + host + ":" + port });
      return;
    }
    await knownHosts?.trust(host, port, fingerprint);
    diag("host.trusted", { host, port });
    sendJson(res, 200, { host, port, fingerprint });
  };

  /**
   * 关闭会话：未知名与已关闭会话一律 closed:false（幂等，不报错），
   * 只有真的从 list 里摘掉一个活会话才算 closed:true。
   */
  const closeSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let id: string;
    try {
      const body = requireRecord(await readJson(req), "body");
      if (typeof body.id !== "string") throw new TypeError("id must be a string");
      id = body.id;
    } catch (error) {
      diag("session.close-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const closed = manager.list().some((session) => session.id === id);
    if (closed) {
      await manager.close(id);
      diag("session.closed", { id });
    }
    sendJson(res, 200, { id, closed });
  };

  /** 状态查询只读内存，恒 200：mode 恒为 "plain"，legacy 说明本机是否还留着已停用的旧版文件。 */
  const readSecurity = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "security"))) return;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, security?.state() ?? {
      mode: "plain",
      legacy: false,
      storage: "file",
      storageLabel: STORAGE_LABEL_FILE,
      degraded: false,
    });
  };

  /**
   * 清理旧版凭据：删掉已停用的旧档文件，把本机登记回唯一的那一档。破坏性动作，body 必须是 { confirm: true }。
   * store 侧幂等：没有旧档时它自己直接返回，不会误清用户已经记住的密码。
   */
  const clearSecurityLegacy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "security"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      const body = requireRecord(await readJson(req), "body");
      if (body.confirm !== true) throw new TypeError("confirm must be true: this drops every saved password");
    } catch (error) {
      diag("security.clear-legacy-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    try {
      await security?.clearLegacy();
    } catch (error) {
      sendSecurityFailure(res, error);
      return;
    }
    diag("security.legacy-cleared", {});
    // 回应体与 /security 同一形状：清理旧档不改变"密码存在哪"，界面不用重新对形状。
    sendJson(res, 200, security?.state() ?? {
      mode: "plain",
      legacy: false,
      storage: "file",
      storageLabel: STORAGE_LABEL_FILE,
      degraded: false,
    });
  };

  /** 只回 ref 名字（profile:<id>），密钥一个字节都不出现在响应里；还没记住任何密码时就是空列表。 */
  const readSecurityRefs = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "security"))) return;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let refs: string[];
    try {
      // listRefs 现在是异步的（系统密码箱那一边本来就是异步 IO）：handler 必须 await。
      refs = (await security?.listRefs()) ?? [];
    } catch (error) {
      sendSecurityFailure(res, error);
      return;
    }
    diag("security.refs", { count: refs.length });
    sendJson(res, 200, { refs });
  };

  /**
   * 粘贴方式写入私钥：内容只进凭据库，响应体恒为 { ok: true }。
   * JSON 解析错误一律换成正文字案——V8 的解析错误会带上请求体片段，那里面就有私钥。
   */
  const saveProfileKey = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "security"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let raw: unknown;
    try {
      raw = await readJson(req);
    } catch {
      diag("profile.key-bad-request", { error: INVALID_JSON });
      sendJson(res, 400, { error: INVALID_JSON });
      return;
    }
    let profileId: string;
    let privateKey: string;
    let passphrase: string | undefined;
    try {
      const body = requireRecord(raw, "body");
      profileId = requireText(body.profileId, "profileId");
      privateKey = requireText(body.privateKey, "privateKey");
      const rawPassphrase = body.passphrase;
      if (rawPassphrase !== undefined && rawPassphrase !== null && typeof rawPassphrase !== "string") {
        throw new TypeError("passphrase must be a string");
      }
      passphrase = typeof rawPassphrase === "string" && rawPassphrase !== "" ? rawPassphrase : undefined;
    } catch (error) {
      // 只回字段规则，绝不回显请求体里的私钥
      diag("profile.key-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    try {
      await security?.put(KEY_PREFIX + profileId, privateKey);
      if (passphrase === undefined) await security?.remove(KEY_PASSPHRASE_PREFIX + profileId);
      else await security?.put(KEY_PASSPHRASE_PREFIX + profileId, passphrase);
    } catch (error) {
      sendSecurityFailure(res, error);
      return;
    }
    diag("profile.key-stored", { id: profileId, hasPassphrase: passphrase !== undefined });
    sendJson(res, 200, { ok: true });
  };

  /** 删除两条 ref，返回真的删掉了几个；重复调用幂等（removed: 0）。 */
  
/**
 * 取消"记住密码"时调用：只删这条主机的口令（profile:<id>），
 * **不碰** key:<id> 与 key-passphrase:<id> —— 用户只是不想再记口令，不是要废掉私钥。
 */
const forgetProfilePassword = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  let profileId: string;
  try {
    profileId = requireText(requireRecord(await readJson(req), "body").profileId, "profileId");
  } catch (error) {
    diag("profile.forget-bad-request", { error: messageOf(error).slice(0, 160) });
    sendJson(res, 400, { error: messageOf(error) });
    return;
  }
  const ref = CREDENTIAL_PREFIX + profileId;
  let removed = 0;
  try {
    if (((await security?.listRefs()) ?? []).includes(ref)) {
      await security?.remove(ref);
      removed = 1;
    }
  } catch (error) {
    sendSecurityFailure(res, error);
    return;
  }
  diag("profile.password-forgotten", { id: profileId, removed });
  sendJson(res, 200, { ok: true, removed });
};

const deleteProfileKey = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "security"))) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let raw: unknown;
    try {
      raw = await readJson(req);
    } catch {
      diag("profile.key-delete-bad-request", { error: INVALID_JSON });
      sendJson(res, 400, { error: INVALID_JSON });
      return;
    }
    let profileId: string;
    try {
      profileId = requireText(requireRecord(raw, "body").profileId, "profileId");
    } catch (error) {
      diag("profile.key-delete-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const refs = [KEY_PREFIX + profileId, KEY_PASSPHRASE_PREFIX + profileId];
    let removed: number;
    try {
      const existing = new Set((await security?.listRefs()) ?? []);
      for (const ref of refs) await security?.remove(ref);
      removed = refs.filter((ref) => existing.has(ref)).length;
    } catch (error) {
      sendSecurityFailure(res, error);
      return;
    }
    diag("profile.key-deleted", { id: profileId, removed });
    sendJson(res, 200, { ok: true, removed });
  };

  /**
   * M3-1：SFTP 通道源未注入时三个端点一律 503。打开失败按 reason 映射状态码：
   * 未知会话 404、不支持 SFTP 400、其余（含 ssh2 原文）500。拿到的只有通道能力。
   */
  const openSftpChannel = async (sessionId: string, res: ServerResponse): Promise<SftpLike | undefined> => {
    if (sftpSource === undefined) {
      sendJson(res, 503, { error: "uniterminal: sftp session source unavailable" });
      return undefined;
    }
    try {
      return await sftpSource(sessionId);
    } catch (error) {
      const failure = error instanceof SftpChannelError ? error.reason : "open-failed";
      const status = failure === "unknown-session" ? 404 : failure === "unsupported" ? 400 : 500;
      diag("sftp.channel-failed", { sessionId, reason: failure, status, error: messageOf(error).slice(0, 160) });
      sendJson(res, status, { error: messageOf(error) });
      return undefined;
    }
  };

  /** 流式端点用 query 传 sessionId/path：请求体整个留给文件内容。 */
  const sftpTargetOf = (req: IncomingMessage): { sessionId: string; path: string } => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    return {
      sessionId: requireText(url.searchParams.get("sessionId") ?? undefined, "sessionId"),
      path: requireAbsolutePath(url.searchParams.get("path") ?? undefined),
    };
  };

  /**
   * M8-14：报告当前上传进度。
   * Chromium 在部分环境下**不派发 xhr.upload.onprogress**（实测：宿主已收 1.4 GB，
   * 界面仍显示 0 B），因此进度以宿主收到的字节为准，客户端定时来问。
   */
  const sftpUploadProgress = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let sessionId: string;
    try {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      sessionId = requireText(url.searchParams.get("sessionId") ?? undefined, "sessionId");
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const active = activeUploads.get(sessionId);
    sendJson(res, 200, active === undefined ? {} : { path: active.path, receivedBytes: active.receivedBytes });
  };

    /** 七个文件操作共用这一条路由：{ sessionId, op, ... }。 */
  const sftpOp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let body: Record<string, unknown>;
    let sessionId: string;
    let op: string;
    try {
      body = requireRecord(await readJson(req), "body");
      sessionId = requireText(body.sessionId, "sessionId");
      op = requireText(body.op, "op");
    } catch (error) {
      diag("sftp.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    if (!isSftpOp(op)) {
      diag("sftp.bad-request", { op: op.slice(0, 32) });
      sendJson(res, 400, { error: "uniterminal: unknown sftp op: " + op });
      return;
    }
    const channel = await openSftpChannel(sessionId, res);
    if (channel === undefined) return;
    try {
      const result = await runSftpOp(channel, op, body);
      diag("sftp.op", { sessionId, op });
      sendJson(res, 200, { op, ...result });
    } catch (error) {
      const status = error instanceof SftpRequestError ? 400 : 500;
      diag("sftp.op-failed", { sessionId, op, status, error: messageOf(error).slice(0, 160) });
      sendJson(res, status, { error: messageOf(error) });
    }
  };

  /**
   * 下载：createReadStream 直接 pipe 进响应。
   * 内容一个字节都不经过本进程的缓冲——按块转发，不拼字符串、不 base64。
   */
  const sftpDownload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let target: { sessionId: string; path: string };
    try {
      target = sftpTargetOf(req);
    } catch (error) {
      diag("sftp.download-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const channel = await openSftpChannel(target.sessionId, res);
    if (channel === undefined) return;
    // 先取大小：没有 Content-Length 浏览器/客户端就无法显示真实进度（此前是 chunked）
    let totalBytes: number | undefined;
    try {
      totalBytes = (await channel.stat(target.path)).size;
    } catch {
      // 拿不到大小就退回 chunked：宁可没有进度条，也不能让下载失败
    }
    let stream: NodeJS.ReadableStream;
    try {
      stream = channel.createReadStream(target.path);
    } catch (error) {
      diag("sftp.download-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(error).slice(0, 160) });
      sendJson(res, 500, { error: messageOf(error) });
      return;
    }
    await new Promise<void>((resolve) => {
      let started = false;
      // M3-7：收尾只做一次。end / error / close 谁先到算谁，后到的绝不再写一段响应。
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const start = (): void => {
        if (started) return;
        started = true;
        const headers: Record<string, string> = { "content-type": "application/octet-stream" };
        if (totalBytes !== undefined) headers["content-length"] = String(totalBytes);
        // 文件名走 RFC 5987 形式：非 ASCII 名也不能让头部的引号/换行破坏响应
        headers["content-disposition"] =
          "attachment; filename*=UTF-8''" + encodeURIComponent(basename(target.path));
        res.writeHead(200, headers);
      };
      stream.on("data", (chunk: Uint8Array) => {
        if (settled) return;
        start();
        res.write(chunk);
      });
      stream.on("end", () => {
        if (settled) return;
        start();
        settled = true;
        res.end();
        resolve();
      });
      stream.on("error", (error: Error) => {
        if (settled) return;
        settled = true;
        // 还没发头才能给 JSON；已经流出去就只收尾，绝不再写一段 JSON 污染文件
        if (started) res.end();
        else sendJson(res, 500, { error: messageOf(error) });
        diag("sftp.download-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(error).slice(0, 160) });
        resolve();
      });
      // 读流被提前掐断时既没有 end 也没有 error，只发 close：不接住它就会永久挂着（同 M3-7）
      stream.on("close", () => {
        if (settled) return;
        settled = true;
        const reason = "uniterminal: sftp download stream closed before it ended";
        if (started) res.end();
        else sendJson(res, 500, { error: reason });
        diag("sftp.download-failed", { sessionId: target.sessionId, path: target.path, error: reason });
        resolve();
      });
    });
  };

  /**
   * 上传：把请求体按块写进 sftp 的 writable。
   * 同样是流对流的转发；只有背压时才等一下 drain，不做整体缓存。
   * M3-6：请求体还没收完客户端就断开（aborted/close）＝上传被取消：销毁 sftp 写流、
   * 记一条只含 sessionId 与 path 的 sftp.upload-aborted，并且让等在那里的 drain 立刻返回，
   * 既不挂 fd 也不留悬挂的等待。响应已经发出去时只收尾。
   * M3-8：写入是原子的——数据先进同目录的临时文件，写成功后换名到目标；
   * 中断或失败则 unlink 临时文件，因此「取消」等于远端没有这个文件，
   * 也不会把同名旧文件覆盖成半截。
   * M3-9：提交走 renameOverwrite——普通 rename 在目标已存在时必然失败，
   * 覆盖上传必须用 posix-rename 扩展（不支持时才退化到 unlink + rename）。
   */
  const sftpUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let target: { sessionId: string; path: string };
    try {
      target = sftpTargetOf(req);
    } catch (error) {
      diag("sftp.upload-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const channel = await openSftpChannel(target.sessionId, res);
    if (channel === undefined) return;
    // M8-13 覆盖保护：目标已存在时必须显式 overwrite=true 才写，且一个字节都不写就返回。
    // 静默覆盖会让用户丢掉服务器上的文件；AI 工具走的也是这条路由，所以必须服务端兜底。
    const overwrite = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("overwrite") === "true";
    if (!overwrite) {
      let existingSize: number | undefined;
      try {
        existingSize = (await channel.stat(target.path)).size;
      } catch {
        // stat 失败＝目标不存在（或该服务器不支持 stat）：按新文件继续
      }
      if (existingSize !== undefined) {
        diag("sftp.upload-exists-refused", { sessionId: target.sessionId, path: target.path });
        sendJson(res, 409, {
          error: "uniterminal: target already exists",
          code: "exists",
          path: target.path,
          size: existingSize,
        });
        return;
      }
    }
    // 临时文件与目标同目录：rename 不跨设备，也就不会退化成「先删再拷」
    const tempPath = target.path + ".uniterminal-part-" + randomBytes(6).toString("hex");
    /** 清掉临时文件：清理失败只记 diag，绝不改写调用处已经确定的语义（尤其不覆盖 abort）。 */
    const discardTemp = async (): Promise<void> => {
      try {
        await channel.unlink(tempPath);
        diag("sftp.upload-cleaned", { sessionId: target.sessionId, path: tempPath });
      } catch (error) {
        diag("sftp.upload-cleanup-failed", {
          sessionId: target.sessionId,
          path: tempPath,
          error: messageOf(error).slice(0, 160),
        });
      }
    };
    let sink: NodeJS.WritableStream;
    try {
      sink = channel.createWriteStream(tempPath);
    } catch (error) {
      diag("sftp.upload-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(error).slice(0, 160) });
      sendJson(res, 500, { error: messageOf(error) });
      return;
    }
    // M3-7：ssh2 的写流在某些路径下只发 close、不发 finish，只等 finish 会让响应永远发不出去。
    // finish 与 close 先到先算（同一个 settled 守卫），error 仍然失败。
    const finished = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      sink.once("finish", () => settle(() => resolve()));
      sink.once("close", () => settle(() => resolve()));
      sink.once("error", (error: Error) => settle(() => reject(error)));
    });
    // 中断/失败后可能不再 await 它：先挂空 catch，避免 unhandledRejection
    void finished.catch(() => undefined);

    /** 响应只发一次：连接已经作废时再写 JSON 只会污染套接字。 */
    let responded = false;
    const respond = (status: number, body: unknown): void => {
      if (responded) return;
      responded = true;
      sendJson(res, status, body);
    };

    // 收请求体的窗口：只有窗口内的断开才算「上传被取消」
    let receiving = true;
    let aborted = false;
    let sinkFailure: Error | undefined;
    // 写流失败与客户端断开会打断 drain 等待：绝不留在 await 里挂着
    let wakeWait: (() => void) | undefined;
    const waitGate = new Promise<void>((resolve) => {
      wakeWait = resolve;
    });
    const onDisconnect = (): void => {
      // 请求体已收完（req.complete）、已经回过响应、或此前已中断：都不是新的一次中断
      if (aborted || !receiving || responded || req.complete === true) return;
      aborted = true;
      // ssh2 的写流是 Writable：destroy 归还 fd，之后的 write/drain 都不会再发生
      if (sink instanceof Writable) sink.destroy(new Error("upload aborted"));
      diag("sftp.upload-aborted", { sessionId: target.sessionId, path: target.path });
      wakeWait?.();
    };
    sink.on("error", (error: Error) => {
      sinkFailure = error;
      wakeWait?.();
    });
    req.on("aborted", onDisconnect);
    req.on("close", onDisconnect);

    // 上传字节计数：每 16 MiB 记一条**真实收到**的字节数（声明必须在 try 之外，收尾时还要用）
    const PROGRESS_REPORT_BYTES = 16 * 1024 * 1024;
    let receivedBytes = 0;
    let reportedBytes = 0;
    let failure: Error | undefined;
    try {
      // 「进度条一直 0」分不清是浏览器不发事件还是数据没在流：
      // 每 16 MiB 记一条**真实收到**的字节数，diag 一看便知。
      for await (const chunk of req) {
        if (aborted) break;
        receivedBytes += (chunk as Uint8Array).byteLength;
        activeUploads.set(target.sessionId, { path: target.path, receivedBytes });
        if (receivedBytes - reportedBytes >= PROGRESS_REPORT_BYTES) {
          reportedBytes = receivedBytes;
          diag("sftp.upload-progress", { sessionId: target.sessionId, receivedBytes });
        }
        if (sink.write(chunk as Uint8Array) === false) {
          await Promise.race([
            new Promise<void>((resolve) => {
              sink.once("drain", () => resolve());
            }),
            waitGate,
          ]);
          if (aborted) break;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(messageOf(error));
    }
    receiving = false;
    activeUploads.delete(target.sessionId);
    diag("sftp.upload-received", { sessionId: target.sessionId, receivedBytes, aborted });
    if (aborted) {
      // 已经记过 sftp.upload-aborted；临时文件仍要作废，对端没了就不再写响应
      await discardTemp();
      return;
    }
    if (failure === undefined && sinkFailure !== undefined) failure = sinkFailure;
    if (failure !== undefined) {
      await discardTemp();
      diag("sftp.upload-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(failure).slice(0, 160) });
      respond(500, { error: messageOf(failure) });
      return;
    }
    // 等完成的上限：定时器一定清掉，写完就退出的进程不被它拖着
    let finishTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      finishTimer = setTimeout(() => reject(new SftpUploadTimeoutError(uploadTimeoutMs)), uploadTimeoutMs);
      finishTimer.unref();
    });
    try {
      sink.end();
      await Promise.race([finished, timeout]);
    } catch (error) {
      if (error instanceof SftpUploadTimeoutError) {
        // 写流可能还挂在通道上：先销毁再回答，绝不把 fd 留到会话结束
        if (sink instanceof Writable) sink.destroy();
        diag("sftp.upload-timeout", { sessionId: target.sessionId, path: target.path });
        await discardTemp();
        respond(500, { error: messageOf(error) });
        return;
      }
      await discardTemp();
      diag("sftp.upload-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(error).slice(0, 160) });
      respond(500, { error: messageOf(error) });
      return;
    } finally {
      clearTimeout(finishTimer);
    }
    // 字节真的写完才提交换名：目标文件此前从未被动过，同名旧文件也就不会被截断
    try {
      // M3-9：覆盖式提交，目标已存在时同样要成功（详见 sftp.ts 的三级策略）
      await channel.renameOverwrite(tempPath, target.path);
    } catch (error) {
      await discardTemp();
      diag("sftp.upload-failed", { sessionId: target.sessionId, path: target.path, error: messageOf(error).slice(0, 160) });
      respond(500, { error: "uniterminal: 上传完成但提交失败：" + messageOf(error) });
      return;
    }
    diag("sftp.upload", { sessionId: target.sessionId, path: target.path });
    // 响应只回目标 path：临时名是服务端内部细节
    respond(200, { ok: true, path: target.path });
  };

  /**
   * M3-2：隧道端点未注入时一律 503。失败按 reason 映射：
   * 未知会话 404；端口占用 / 远端拒绝 / 参数不合法 400；其余 500。
   */
  const tunnelStatusOf = (error: unknown): number => {
    if (!(error instanceof TunnelError)) return 500;
    if (error.reason === "unknown-session") return 404;
    if (error.reason === "open-failed") return 500;
    return 400;
  };

  /** 启动一条隧道：body { sessionId, mode, bindHost?, bindPort, destHost?, destPort? }。 */
  const startTunnel = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (tunnelManager === undefined) {
      sendJson(res, 503, { error: "uniterminal: tunnel manager unavailable" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let spec: TunnelSpec;
    try {
      spec = normalizeTunnelSpec(requireRecord(await readJson(req), "body"));
    } catch (error) {
      diag("tunnel.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    try {
      const tunnel = await tunnelManager.start(spec);
      // 诊断只记地址与模式：这条链路上从来就没有凭据
      diag("tunnel.started", {
        id: tunnel.id,
        sessionId: tunnel.sessionId,
        mode: tunnel.mode,
        bindHost: tunnel.bindHost,
        bindPort: tunnel.bindPort,
        destHost: tunnel.destHost,
        destPort: tunnel.destPort,
      });
      sendJson(res, 201, { tunnel });
    } catch (error) {
      const status = tunnelStatusOf(error);
      diag("tunnel.failed", { sessionId: spec.sessionId, mode: spec.mode, status, error: messageOf(error).slice(0, 160) });
      sendJson(res, status, { error: messageOf(error) });
    }
  };

  /** 停止一条隧道：body { id }；不存在的 id 同样 200（stopped:false），幂等。 */
  const stopTunnel = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (tunnelManager === undefined) {
      sendJson(res, 503, { error: "uniterminal: tunnel manager unavailable" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let id: string;
    try {
      id = requireText(requireRecord(await readJson(req), "body").id, "id");
    } catch (error) {
      diag("tunnel.stop-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    const stopped = await tunnelManager.stop(id);
    diag("tunnel.stopped", { id, stopped });
    sendJson(res, 200, { ok: true, stopped });
  };

  const listTunnels = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (tunnelManager === undefined) {
      sendJson(res, 503, { error: "uniterminal: tunnel manager unavailable" });
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, { tunnels: tunnelManager.list() });
  };

  /**
   * M5-1：给**任意** AI 会话用的执行入口。两个模式都在 createSessionExec 里实现：
   * exec 走独立通道（不碰用户的终端），shell 写进用户正在用的那个 shell 并靠一对随机标记取回。
   * 命令、输出与诊断都必须先过 scrubSecrets——用户完全可能在命令行里写口令或贴私钥。
   * 审计不在这里记：createSessionExec 是两条路径共用的唯一实现，记录放在那一层。
   */
  const sessionExec = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!agentExecEnabled) {
      diag("session.exec-disabled", {});
      sendJson(res, 403, { error: "uniterminal: agent exec is disabled (agentExec: off)" });
      return;
    }
    let sessionId: string;
    let command: string;
    let mode: ExecMode;
    let timeoutMs: number | undefined;
    try {
      const body = requireRecord(await readJson(req), "body");
      sessionId = requireText(body.sessionId, "sessionId");
      command = requireText(body.command, "command");
      mode = parseExecMode(body.mode);
      timeoutMs = optionalTimeoutMs(body.timeoutMs);
    } catch (error) {
      diag("session.exec-bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    if (execSource === undefined) {
      sendJson(res, 503, { error: "uniterminal: exec session source unavailable" });
      return;
    }
    try {
      const outcome = await execSource({ sessionId, command, mode, timeoutMs });
      // 审计（session.exec / -timeout / -failed）由 execSource 自己记：工具路径也走同一个实现，
      // 在这里再记一次就是一次执行两条记录。
      sendJson(res, 200, {
        ok: true,
        mode: outcome.mode,
        stdout: scrubSecrets(outcome.stdout),
        stderr: scrubSecrets(outcome.stderr),
        code: outcome.code,
        truncated: outcome.truncated,
        ms: outcome.ms,
      });
    } catch (error) {
      const reason = error instanceof ExecChannelError ? error.reason : "failed";
      const status = reason === "unknown-session" ? 404 : reason === "unsupported" ? 400 : 500;
      sendJson(res, status, { error: messageOf(error) });
    }
  };

  /**
   * M6-1 外观：GET 取当前值（文件不存在即默认值），POST 存 patch（只给想改的字段）。
   * store 的越界/格式错是 AppearanceError → 400 且文案带字段名；其它失败才是 500。
   */
  const serveAppearance = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await guard(res, "appearance"))) return;
    const store = appearance;
    // guard 已经确认注入（缺省时 503 并返回），这里只是给类型收窄
    if (store === undefined) return;
    if (req.method === "GET") {
      sendJson(res, 200, { appearance: store.current() });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let patch: unknown;
    try {
      patch = requireRecord(await readJson(req), "body").appearance;
    } catch (error) {
      diag("appearance.bad-request", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, appearance: await store.save(patch) });
    } catch (error) {
      if (error instanceof AppearanceError) {
        sendJson(res, 400, { error: messageOf(error) });
        return;
      }
      diag("appearance.save-failed", { error: messageOf(error).slice(0, 160) });
      sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
    }
  };

  /**
   * M8-20 终端状态栏：GET ?sessionId=，返回 MonitorSample。
   * 取数一律走 manager.exec（独立通道）——绝不写进用户正在用的交互式 shell，
   * 否则一条 ps 之类的命令就会把用户的终端刷乱。
   * exec 失败或输出不可解析都回 200 + supported:false：状态栏渲染 null，不弹错误。
   */
  const serveMonitor = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let sessionId: string;
    try {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      sessionId = requireText(url.searchParams.get("sessionId") ?? undefined, "sessionId");
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) });
      return;
    }
    let raw = "";
    try {
      const outcome = await manager.exec(sessionId, MONITOR_COMMAND, { timeoutMs: MONITOR_TIMEOUT_MS });
      raw = outcome.stdout;
    } catch (error) {
      // 会话没了 / 通道崩了都是状态栏的日常：如实回 supported:false + 原因，不抛给客户端
      const reason = messageOf(error);
      diag("monitor.exec-failed", { sessionId, error: reason.slice(0, 160) });
      sendJson(res, 200, unsupportedSample("exec failed: " + reason));
      return;
    }
    const parsed = parseMonitor(raw, monitorPrev.get(sessionId));
    if (parsed.next !== undefined) monitorPrev.set(sessionId, parsed.next);
    sendJson(res, 200, parsed.sample);
  };

  return [
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.diag,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          const payload = await readJson(req);
          diag("client", payload as Record<string, unknown>);
        } catch {
          // 诊断上报失败不得影响任何功能
        }
        sendJson(res, 204, {});
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.health,
      handler: (req, res) => {
        if (!allowLoopback(req, res)) return;
        sendJson(res, 200, { ok: true });
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sessions,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        if (req.method === "GET") {
          // M4-1：每项带上接回所需的非敏感信息（host/user/port 来自建会话时的 profile，ws 与建会话响应同形）。
          // 列表是原样序列化出去的，因此凭据只能在 SessionInfo 之外活着——它本来就不在里面。
          sendJson(res, 200, {
            sessions: manager.list().map((session) => ({ ...session, ws: wsEndpoint(req, session.id) })),
          });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        let profile: RequestedProfile;
        try {
          profile = parseProfile(await readJson(req));
        } catch (error) {
          diag("session.bad-request", { error: String(error).slice(0, 160) });
          // 协议留位这一条要给干净文案：别把 "TypeError: " 前缀甩给界面。
          sendJson(res, 400, { error: error instanceof UnsupportedProtocolError ? error.message : String(error) });
          return;
        }
        const auth = await resolveAuth(profile);
        if (!auth.ok) {
          // 只记 id 与错误类别：诊断里永不出现口令/私钥
          diag("session.password-required", { id: profile.id, kind: profile.kind, error: auth.error });
          sendJson(res, 400, { error: auth.error });
          return;
        }
        // 私钥/口令只在这一刻拼进内存态 profile，绝不回写 profiles.json。
        // 只搬 engine 认的字段：请求里没被选中的那一路（含 auth / identityPath）绝不能偷偷生效。
        const resolved: ResolvedProfile = {
          id: profile.id,
          kind: profile.kind,
          host: profile.host,
          port: profile.port,
          user: profile.user,
          shell: profile.shell,
          cwd: profile.cwd,
          keepaliveMs: profile.keepaliveMs,
          connectTimeoutMs: profile.connectTimeoutMs,
          credentialRef: profile.credentialRef,
          // M3-3：跳板链随档案进传输层；没有就保持 undefined（直连）
          proxyChain: profile.proxyChain,
        };
        if (auth.password !== undefined) resolved.password = auth.password;
        if (auth.privateKey !== undefined) resolved.privateKey = auth.privateKey;
        if (auth.passphrase !== undefined) resolved.passphrase = auth.passphrase;
        try {
          const session = await manager.open(resolved);
          // 会话真的开了才落库：连接失败不该把错口令记下来
          if (auth.password !== undefined) await rememberPassword(profile, auth.password);
          const localPort = req.socket.localPort;
          diag("session.created", { sessionId: session.id, kind: session.kind, host: profile.host, port: profile.port, localPort, requestHost: req.headers?.host ?? null });
          // 页面 origin 可能是 app://（Electron），location.host 不是可连的 WS 主机；
          // 因此由宿主给出确切的回环地址，浏览器照用即可。
          sendJson(res, 201, { session, ws: wsEndpoint(req, session.id) });
        } catch (error) {
          // 兜底再抹一遍：私钥/口令绝不出现在错误文案与诊断里
          const scrubAll = (text: string): string => scrub(scrub(text, auth.privateKey ?? ""), auth.passphrase ?? "");
          // M8-1：先按真实原因分类；unknown 分支会原样带出传输层文案，所以同样先抹掉机密
          const classification = classifyTransportError(error);
          // 真是认证问题才拼上两条路各自的原因（私钥为什么没用上 / 密码为什么没用上）
          const combined = describeAuthFailure(scrubAll(String(error)), auth, {
            code: classification.code,
            message: scrubAll(classification.message),
          });
          diag("session.failed", { kind: profile.kind, host: profile.host, port: profile.port, code: classification.code, error: combined.slice(0, 160) });
          // 机器可判别：code 告诉前端这是哪一类失败；hostkey 再给出指纹三元组，
          // 前端不必再从英文原文里抠指纹（老前端仍按 payload.error 读文案）。
          const details = classification.code === "hostkey" ? hostKeyDetails(error) : undefined;
          sendJson(res, 500, {
            error: combined,
            code: classification.code,
            ...(details === undefined ? {} : { host: details.host, port: details.port, fingerprint: details.fingerprint }),
          });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sessionExec,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await sessionExec(req, res);
        } catch (error) {
          diag("session.exec-handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sessionClose,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await closeSession(req, res);
        } catch (error) {
          diag("session.close-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profiles,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          if (req.method === "GET") {
            await listProfiles(req, res);
            return;
          }
          await upsertProfile(req, res);
        } catch (error) {
          diag("profile.failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profilesImport,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          await importProfiles(req, res);
        } catch (error) {
          diag("profile.import-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profilesTest,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await testProfileConnection(req, res);
        } catch (error) {
          diag("profile.test-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profilesKey,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await saveProfileKey(req, res);
        } catch (error) {
          diag("profile.key-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profilesForget,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await forgetProfilePassword(req, res);
        } catch (error) {
          diag("profile.forget-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.profilesKeyDelete,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await deleteProfileKey(req, res);
        } catch (error) {
          diag("profile.key-delete-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.folders,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await addFolder(req, res);
        } catch (error) {
          diag("folder.add-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.foldersDelete,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await deleteFolder(req, res);
        } catch (error) {
          diag("folder.delete-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.foldersRename,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await renameFolder(req, res);
        } catch (error) {
          diag("folder.rename-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.groups,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await listGroups(req, res);
        } catch (error) {
          diag("group.list-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.groupsColor,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await saveGroupColor(req, res);
        } catch (error) {
          diag("group.color-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "prefix",
      path: UNITERMINAL_ROUTES.profilesPrefix,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          const pathname = requestPath(req);
          // 前缀路由与 /profiles/import、/profiles/test 共享路径空间：无论宿主的匹配顺序如何，
          // 这两个都是独立动作，绝不落到「删除 /profiles/<id>」上。
          if (pathname === UNITERMINAL_ROUTES.profilesImport) {
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "method not allowed" });
              return;
            }
            await importProfiles(req, res);
            return;
          }
          if (pathname === UNITERMINAL_ROUTES.profilesTest) {
            await testProfileConnection(req, res);
            return;
          }
          await removeProfile(req, res);
        } catch (error) {
          diag("profile.delete-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.hostTrust,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await trustHost(req, res);
        } catch (error) {
          diag("host.trust-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.security,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await readSecurity(req, res);
        } catch (error) {
          diag("security.state-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.securityClearLegacy,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await clearSecurityLegacy(req, res);
        } catch (error) {
          diag("security.clear-legacy-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.securityRefs,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await readSecurityRefs(req, res);
        } catch (error) {
          diag("security.refs-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sftpOp,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await sftpOp(req, res);
        } catch (error) {
          diag("sftp.op-handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sftpDownload,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await sftpDownload(req, res);
        } catch (error) {
          diag("sftp.download-handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sftpUploadProgress,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        await sftpUploadProgress(req, res);
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.sftpUpload,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await sftpUpload(req, res);
        } catch (error) {
          diag("sftp.upload-handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.tunnels,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          if (req.method === "GET") await listTunnels(req, res);
          else await startTunnel(req, res);
        } catch (error) {
          diag("tunnel.handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.tunnelsStop,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await stopTunnel(req, res);
        } catch (error) {
          diag("tunnel.stop-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.appearance,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await serveAppearance(req, res);
        } catch (error) {
          diag("appearance.handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
    {
      kind: "exact",
      path: UNITERMINAL_ROUTES.monitor,
      handler: async (req, res) => {
        if (!allowLoopback(req, res)) return;
        try {
          await serveMonitor(req, res);
        } catch (error) {
          diag("monitor.handler-failed", { error: messageOf(error).slice(0, 160) });
          sendJson(res, 500, { error: "uniterminal: " + messageOf(error) });
        }
      },
    },
  ];
}
