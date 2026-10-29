import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { useConnectCountdown } from "./use-connect-countdown.js";
import { useNotice, noticeClassName, noticeLiveProps } from "./notice.js";
import { requestKindForSelection, storedKindForSelection, type AuthKind } from "../auth-kinds.js";
import { initialAuthSelection } from "./auth-selection.js";
import { droppedSecrets, droppedSecretsMessage, type DroppedSecret } from "./save-confirm.js";
import {
  APPEARANCE_ENDPOINT,
  AppearancePanel,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type Appearance,
} from "./AppearancePanel.js";
import { HostListView, type HostProfile } from "./HostListView.js";
import { ensureUniterminalCss } from "./inject-css.js";
import {
  parseSessionIdFromTabId,
  parseSessionTabMeta,
  sanitizeProfileSnapshot,
  type ProfileSnapshot,
  type SidebarTabLike,
} from "./right-pane.js";
import { reportClient } from "./report.js";
import { SftpPanel } from "./SftpPanel.js";
import { StatusBar } from "./StatusBar.js";
import {
  activateSession,
  addSession,
  adoptHostSessions,
  claimSessionTab,
  forgetSessionTab,
  readPersistedSessionSet,
  readProfileSnapshot,
  removeSession,
  uniqueSessionTitle,
  writePersistedSessionSet,
  type SessionEntry,
  type SessionSet,
} from "./tab-state.js";
import { TerminalView } from "./TerminalView.js";
import { COLOR_DANGER, COLOR_SUCCESS } from "./tokens.js";
import { TunnelPanel } from "./TunnelPanel.js";

/** 会话内视图：终端 / 文件（SFTP）/ 隧道。 */
type PaneView = "terminal" | "files" | "tunnels";

/**
 * 建会话失败响应体里与「未知主机指纹」有关的字段。
 *
 * 后端（P0-6）已把失败响应体改成结构化形状：{ error, code, host?, port?, fingerprint? }，
 * 三个指纹字段只有 hostkey 类失败才有。类型放宽到 unknown：后端给数字或数字串都要能读。
 */
export interface UnknownHostKeyPayload {
  error?: string;
  /** 失败分类（hostkey / auth / timeout……）：机器可判别，不必从文案里猜。 */
  code?: string;
  host?: unknown;
  port?: unknown;
  fingerprint?: unknown;
}

interface CreateSessionResponse extends UnknownHostKeyPayload {
  session?: { id?: string };
  ws?: { host?: string; port?: number; path?: string };
}

interface PendingTrust {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * GET /sessions 的一项（M4-1）：宿主侧还活着的会话。ws 与建会话响应同形，
 * 因此接管时不必再输密码——直接用同一个回环地址重连即可。
 */
interface RemoteSessionInfo {
  id?: string;
  host?: string;
  user?: string;
  port?: number;
  createdAt?: number;
  ws?: { host?: string; port?: number; path?: string };
}

interface SessionsResponse {
  sessions?: RemoteSessionInfo[];
  error?: string;
}

/** 连接进度文案的地址部分：user@host:port，缺哪段就省哪段。 */
function connectTargetText(user: string, host: string, port: string): string {
  return (user === "" ? "" : user + "@") + host + ":" + port;
}

/** 孤儿会话那一行的地址文案：user@host:port，缺哪段就省哪段。 */
function sessionEndpointText(session: RemoteSessionInfo): string {
  const user = session.user === undefined || session.user === "" ? "" : session.user + "@";
  const host = session.host === undefined || session.host === "" ? "(未知主机)" : session.host;
  return session.port === undefined ? user + host : user + host + ":" + String(session.port);
}

/** 创建时间：取不到或不是有限数就留空，绝不让一行坏数据把整块列表打断。 */
function sessionCreatedText(createdAt: number | undefined): string {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return "";
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const orphanSummary = (count: number): string => "发现 " + String(count) + " 个未接管的会话";

/** GET/POST /appearance 的响应形态：成功时的 appearance 由 normalizeAppearance 逐字段兜底。 */
interface AppearanceResponse {
  appearance?: unknown;
  error?: string;
}

/**
 * GET /security 的响应形态：mode 恒为 "plain"；legacy=true 表示本机还留着已停用的旧版凭据文件。
 *
 * storage / storageLabel / degraded 说明**密码存在哪**：
 * 系统密码箱（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）还是本机文件。
 * degraded=true 表示曾经用密码箱、现在临时改用本机文件保存。
 */
interface SecurityState {
  mode?: "plain";
  legacy?: boolean;
  storage?: "keychain" | "file";
  storageLabel?: string;
  degraded?: boolean;
  error?: string;
}

/** 存档档案里本 UI 关心的只有 remember，其余字段原样回写（后端白名单只取它认识的键）。 */
interface StoredProfileShape {
  id?: string;
  remember?: boolean;
  [key: string]: unknown;
}

interface ProfilesResponse {
  profiles?: StoredProfileShape[];
  error?: string;
}

/** 会话请求里 profile 的非敏感部分：id 恒为字符串，且永不含口令。 */
type ProfileIdentity = { id: string } & Record<string, unknown>;

/** 写进 profiles.json 的 auth 块：只有方式与路径，密钥内容永远走 /profiles/key。 */
interface ProfileAuthBlock {
  // "password" 仍是"不写 auth 块"，所以这里排除它
  kind: Exclude<AuthKind, "password">;
  identityPath?: string;
}

/**
 * 会话请求里显式带上的认证选择（M2d-2）：两个勾选框可以同时生效，
 * kind='both' 表示密码与私钥一起交给后端（由 ssh2 依次尝试）。
 */
interface RequestAuthBlock {
  kind: AuthKind;
  identityPath?: string;
}

/** 与 routes.ts 的两条 D10 文案对应：命中就翻译成用户能照做的动作。 */
const PASSWORD_REQUIRED = "password required";
const VAULT_LOCKED = "vault is locked";
/** 与 routes.ts 的两条私钥文案对应；后端原文里已经带上了「切回密码 + 保存配置」这条出路。 */
const IDENTITY_NOT_READABLE = "私钥文件读不到";
const NO_PRIVATE_KEY = "no private key configured";

/** 私钥类失败的用户文案；命中不到返回 undefined，由调用点沿用后端原文。 */
function mapKeyAuthError(message: string): string | undefined {
  // 后端原文本身就可操作，原样展示，别再套一层「连接失败：」
  if (message.includes(IDENTITY_NOT_READABLE)) return message;
  if (message.includes(NO_PRIVATE_KEY)) return "尚未配置私钥：请填写路径或粘贴私钥内容";
  return undefined;
}

const SECURITY_CLEAR_ENDPOINT = "/api/uniterminal/security/clear-legacy";
/** 横幅标题：只陈述事实（旧格式已停用），不提任何已取消的能力。 */
const LEGACY_BANNER_TITLE = "旧版凭据文件（该格式已停用）";
const CLEAR_LEGACY_LABEL = "清理旧版凭据（不影响已保存的密码）";
const CLEAR_LEGACY_NOTE = "旧版凭据文件已停用，不能再被读取。清理只删掉那个旧文件；明文库里已记住的密码不受影响。";
const CLEAR_LEGACY_CONFIRM =
  "将删除旧版凭据文件。旧档里读不出来的那份密码需要重新输入一次，明文库里已记住的密码不受影响。确定清理吗？";

/**
 * 凭据存在哪：常驻表单页的那一句小字，**按后端变化**。
 *
 * - 文件后端：验收单锁定的那句原文——那时密码确实在本机文件里，这句判据不许被改写；
 * - 系统密码箱：密码交给操作系统保管（服务端按平台给一句准确的话）；
 * - 降级：密码箱这一刻用不了，已临时改用本机文件保存。
 *
 * 「加密」「主密码」「解锁」「锁定」这四个词**不许出现在界面文案里**
 * （docs/acceptance-m2a.md 判据 3）——描述的是操作系统密码箱，不是本插件自造的档位。
 */
const PLAIN_STORAGE_NOTE = "密码以明文保存在本机凭据文件，受 Windows 账户权限保护";
/** 降级时的那一句：如实告诉用户"为什么现在不在密码箱里"。 */
const STORAGE_DEGRADED_NOTE = "系统密码箱暂时不可用，已临时改用本机文件保存";
/** 服务端没给出具体平台时的一句兜底。 */
const STORAGE_KEYCHAIN_NOTE = "密码保存在系统密码箱";

/** 宿主拒绝未知指纹时的旧文案形态，见 store/known-hosts.ts 的 decideHostKey。 */
const UNKNOWN_HOST_KEY = /unknown host key for (.+):(\d+) \(([^)]+)\)/;

/**
 * 未知主机指纹：两段式。
 *
 * ① 结构化字段优先：后端把 hostkey 的 error 文案改成了中文，正则再也匹配不上，
 *    host / port / fingerprint 三元组才是可靠来源（宿主在 code === "hostkey" 时才给这三个字段）。
 * ② 读不到才退回旧正则：兼容只回英文原文的老宿主——这段必须留着，不能删。
 *
 * 三者缺一不可：缺任何一个都返回 undefined，界面上就不出现「信任该主机并重试」按钮。
 */
export function parseUnknownHostKey(payload: UnknownHostKeyPayload | undefined): PendingTrust | undefined {
  const structured = structuredHostKey(payload);
  if (structured !== undefined) return structured;
  return messageHostKey(typeof payload?.error === "string" ? payload.error : "");
}

/** 结构化三元组：host 非空字符串、port 是数字或可转的数字串、fingerprint 非空字符串。 */
function structuredHostKey(payload: UnknownHostKeyPayload | undefined): PendingTrust | undefined {
  if (payload === undefined) return undefined;
  const host = typeof payload.host === "string" ? payload.host.trim() : "";
  const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint.trim() : "";
  if (host === "" || fingerprint === "") return undefined;
  const port = hostPortNumber(payload.port);
  if (port === undefined) return undefined;
  return { host, port, fingerprint };
}

/** port 允许数字，也允许能转成数字的数字串；转不成就不算结构化三元组。 */
function hostPortNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 建会话请求里的跳板链（P0-9）：存档里的 proxyJump 原样透传成请求里的 proxyChain。
 *
 * - 字段名必须是 proxyChain：宿主只认这个名字（routes.ts 的 parseProfile 读的就是它）；
 * - 只有非空数组才带：绝不发空数组——后端缺省即直连（与主机列表保存档案时的做法一致）；
 * - 原样透传：跳板项就是 "user@host:port" 字符串，客户端不重新拼；
 * - 手动连接没有跳板链（selected 为空），返回 undefined = 请求里不带这个字段。
 */
export function proxyChainFor(profile: HostProfile | undefined): string[] | undefined {
  const hops = profile?.proxyJump;
  if (hops === undefined || hops.length === 0) return undefined;
  return hops;
}

/**
 * 复制会话的跳板链：快照里的 proxyJump 原样转成请求里的 proxyChain。
 *
 * 与主路（proxyChainFor）同一个约定：
 * - 字段名必须是 proxyChain（宿主只认它，routes.ts 的 parseProfile 读的就是它）；
 * - 只有非空数组才带：绝不发空数组，后端缺省即直连；
 * - 原样透传：跳板项就是 "user@host:port" 字符串，客户端不重新拼。
 *
 * 快照本身已经过白名单校验（sanitizeProfileSnapshot），这里再挡一次：
 * 手改过的存档里混进非字符串项就当没有跳板链，绝不把坏链发给宿主。
 */
export function snapshotProxyChainFor(snapshot: ProfileSnapshot | undefined): string[] | undefined {
  const hops = snapshot?.proxyJump;
  if (!Array.isArray(hops) || hops.length === 0) return undefined;
  for (const hop of hops) {
    if (typeof hop !== "string" || hop.trim() === "") return undefined;
  }
  return hops;
}

/** 旧宿主：只有英文原文，从原文里抠三元组。 */
function messageHostKey(message: string): PendingTrust | undefined {
  const matched = UNKNOWN_HOST_KEY.exec(message);
  if (matched === null) return undefined;
  const host = matched[1];
  const port = matched[2];
  const fingerprint = matched[3];
  if (host === undefined || port === undefined || fingerprint === undefined) return undefined;
  const parsed = hostPortNumber(port);
  if (parsed === undefined) return undefined;
  return { host, port: parsed, fingerprint };
}

/**
 * 初始会话集（M9-4）：本机原生右栏只给插件一个不透明标签，所以改成一个标签里装多条会话。
 * 两条来源：旧版本遗留的会话标签（标签 id 就是会话 id）把它自己那条当成会话栏的第一条；
 * 其余情况读本标签的会话集存档，刷新后照样接得回来。
 */
function initialSessionSet(
  tabId: string,
  legacyId: string | undefined,
  legacyProfile: ProfileSnapshot | undefined,
): SessionSet {
  if (legacyId !== undefined) {
    const entry: SessionEntry = { id: legacyId, title: snapshotTitle(legacyProfile ?? {}, "SSH 会话") };
    if (legacyProfile !== undefined) entry.profile = legacyProfile;
    return { entries: [entry], activeId: legacyId };
  }
  return readPersistedSessionSet(tabId) ?? { entries: [] };
}

/** 宿主回报的一条会话 → ws 回环地址；缺字段一律当作「这条接不回来」。 */
function sessionWsUrl(session: RemoteSessionInfo): string | undefined {
  const endpoint = session.ws;
  if (endpoint?.host === undefined || endpoint.port === undefined || endpoint.path === undefined) return undefined;
  return "ws://" + endpoint.host + ":" + String(endpoint.port) + endpoint.path;
}
/** 会话标签的标题：user@host:port，缺哪段就省哪段。 */
/**
 * 会话标题：**优先用主机配置里的名字**（用户实报：标签上显示 root@ip:22，而不是他配的 "xxx-AI_Agent"）。
 * 名字缺失才退回 user@host:port；两者都没有才用兜底文案。
 */
function snapshotTitle(snapshot: ProfileSnapshot, fallback: string): string {
  const name = snapshot.name === undefined ? "" : snapshot.name.trim();
  if (name !== "") return name;
  const user = snapshot.user === undefined || snapshot.user === "" ? "" : snapshot.user + "@";
  const host = snapshot.host ?? "";
  const port = snapshot.port === undefined ? "" : ":" + String(snapshot.port);
  const text = user + host + port;
  return text === "" ? fallback : text;
}

/**
 * 断开连接的三条路（会话栏 / 孤儿 / 复制会话的泄漏保险）共用的那一份实现，差别只由参数表达。
 *
 * 三条路的差别说清楚（不再各写一份复制品）：
 * - notifyFailure：失败要不要打扰用户。复制会话的泄漏保险那一路只记诊断，不打扰用户。
 * - removeFromBar：要不要把条目从会话栏拿掉，以及**什么时候**拿——会话栏那条路在请求**发出前**
 *   就拿掉（用户已经明确要它消失，失败也不塞回去）；孤儿那条路本来就不在会话栏里，不碰它。
 * - removeOrphanRow：孤儿那一行的移除时机是请求**成功之后**（失败要保留该行，绝不假装关掉了）。
 * - failedEvent / closedEvent：诊断事件名，会话栏与孤儿各一套。
 */
interface CloseSessionOptions {
  /** 失败时给用户一条提示（false = 只记诊断，不打扰用户）。 */
  notifyFailure: boolean;
  /** 失败时记的诊断事件名。 */
  failedEvent: string;
  /** 成功时记的诊断事件名。 */
  closedEvent: string;
  /** 请求发出前就把条目从会话栏拿掉。 */
  removeFromBar: boolean;
  /** 请求成功后才把这一行从孤儿列表里去掉。 */
  removeOrphanRow: boolean;
}

/** 宿主传给标签组件的 props（只声明本插件用到的字段；缺了就按启动器降级）。 */
export interface UniterminalTabProps {
  ctx?: Record<string, unknown> | undefined;
  tab?: SidebarTabLike | undefined;
  visible?: boolean | undefined;
}

/**
 * 右栏标签：本插件自己画一条会话栏，一个标签里同时跑多条会话（M9-4）。
 *
 * 会话集是纯数据（tab-state.ts 的 SessionSet），组件只负责把它画出来——
 * 关键是每条会话的终端**只隐藏、不卸载**：卸载会丢终端缓冲与 socket，切回来要重放。
 */
export function UniterminalTab(props: UniterminalTabProps = {}) {
  /**
   * 旧版本把会话身份放在标签 id 里（`uniterminal:<sessionId>`）。那条路已证明不可行
   * （原生右栏只给一个不透明 id），保留解析只为接回遗留标签：它那条会话就是会话栏里的第一条。
   */
  const legacySessionId = parseSessionIdFromTabId(props.tab?.id);
  /** 会话集存档按标签 id 分开：每个侧边栏标签有自己的会话栏。 */
  const tabId = typeof props.tab?.id === "string" ? props.tab.id : "";
  /** 非活动标签必须停掉轮询：宿主会同时保留多个标签，看不见的那些不该继续打扰服务器。 */
  const tabVisible = props.visible !== false;
  const [legacyProfile] = useState<ProfileSnapshot | undefined>(() =>
    legacySessionId === undefined
      ? undefined
      : parseSessionTabMeta(props.tab?.meta) ?? readProfileSnapshot(legacySessionId),
  );
  /** 会话栏的全部状态：条目顺序就是显示顺序，activeId 是当前会话。 */
  const [sessions, setSessions] = useState<SessionSet>(() =>
    initialSessionSet(tabId, legacySessionId, legacyProfile),
  );
  const activeId = sessions.activeId;
  const activeEntry = sessions.entries.find((entry) => entry.id === activeId);
  /** 启动器（主机列表 / 连接表单）是否占着主区域；会话一条都不卸载，只是被藏起来。 */
  const [launcherOpen, setLauncherOpen] = useState<boolean>(() => sessions.entries.length === 0);
  const launcherVisible = launcherOpen || sessions.entries.length === 0;
  /** 「接回会话」的重试计数：变化即重新向宿主索取一次地址。 */
  const [reattachKey, setReattachKey] = useState(0);
  /** 「复制会话」请求中：按钮禁用，防止连点开出两条连接。 */
  const [duplicating, setDuplicating] = useState(false);
  const [view, setView] = useState<"list" | "form">("list");
  /**
   * 会话栏空了就回主机列表。
   * 断开最后一条会话时 launcherVisible 会重新变成 true，但 view 还停在 "form"，
   * 于是用户被扔回「刚才那台主机的连接表单」——那不是他点的东西（用户实报）。
   */
  useEffect(() => {
    if (sessions.entries.length === 0) setView("list");
  }, [sessions.entries.length]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<HostProfile | undefined>(undefined);
  const [selectedRemembered, setSelectedRemembered] = useState(false);
  /**
   * 一次性提示走共享模型（notice.ts）：成功是绿、失败是红，6 秒过期规则由那一个来源统一负责。
   * 「终端连接已断开」这类信息会一直挂在标题下，久看成干扰；真正需要长期呈现的是状态本身
   * （终端还在、会话栏还在），不是这句一次性的提示。
   */
  const { notice, setNotice, setOk, clear } = useNotice();
  // 把浏览器里的未捕获错误也记进宿主 diag：界面"点了没反应"时，症状往往只剩控制台里的一行
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      reportClient("client.error", { message: String(event.message).slice(0, 200) });
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      reportClient("client.unhandled-rejection", { reason: String(event.reason).slice(0, 200) });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | undefined>(undefined);
  // M8-1：连接不是一个瞬时的动作，界面必须自始至终说清「正在连」
  const [connecting, setConnecting] = useState(false);
  // 连接超过 5 秒后显示超时倒计时：主机不在线时用户才知道还要等多久
  const connectCountdown = useConnectCountdown(connecting);
  /** 当前会话的视图（M3-4a/4b）：默认终端；「文件」复用同一会话的 SFTP，「隧道」看本会话的端口转发。 */
  const [paneView, setPaneView] = useState<PaneView>("terminal");
  /** 待确认断开的会话：× 与「断开连接」都先问一句，避免误触把会话关掉。 */
  const [pendingClose, setPendingClose] = useState<{ id: string; title: string }>();
  /** 确认弹框居中用的锚点：整个侧栏面板（不是整个窗口）。 */
  const mainPaneRef = useRef<HTMLDivElement>(null);
  /**
   * 访问过的视图：首次点进去才挂载，之后**只隐藏不卸载**。
   * 卸载会丢掉 SftpPanel 的上传/下载进度（XHR 还在跑，界面却没了），
   * 也会丢掉当前目录、选中项与隧道列表。
   */
  const [visitedViews, setVisitedViews] = useState<ReadonlySet<PaneView>>(() => new Set<PaneView>(["terminal"]));
  // 进入某个视图后一直保留它（只隐藏），上面的注释解释了为什么要这样
  useEffect(() => {
    setVisitedViews((current) => (current.has(paneView) ? current : new Set(current).add(paneView)));
  }, [paneView]);

  const [host, setHost] = useState("127.0.0.1");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState("22");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  /** 是否把私钥**路径**写进存档；取消勾选并保存会清掉已存路径（私钥文件本身不动）。 */
  const [rememberKeyPath, setRememberKeyPath] = useState(false);
  /** 保存前的确认：非空即弹框，列出这次会丢掉的已存项。 */
  const [saveConfirm, setSaveConfirm] = useState<DroppedSecret[] | undefined>(undefined);
  /** 弹框居中用的锚点：连接表单这一块。 */
  const formRef = useRef<HTMLDivElement>(null);
  const [passwordVisible, setPasswordVisible] = useState(false);
  /** 认证方式（M2d-2）：密码与私钥各有一个开关，可以同时用，切换立刻影响下一次连接。 */
  const [usePassword, setUsePassword] = useState(true);
  const [useKey, setUseKey] = useState(false);
  const [identityPath, setIdentityPath] = useState("");
  /** 「粘贴私钥内容」是否已展开；内容本身只在内存里活到提交成功那一刻。 */
  const [keyPasteOpen, setKeyPasteOpen] = useState(false);
  const [privateKeyText, setPrivateKeyText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [security, setSecurity] = useState<SecurityState | undefined>(undefined);
  const [resetBusy, setResetBusy] = useState(false);
  /** true = 已点过一次按钮，正在等用户二次确认（不用原生弹窗：嵌入面板里它可能被直接吞掉）。 */
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | undefined>(undefined);
  /** 「保存配置」请求中：按钮禁用，防止连点重复 upsert。 */
  const [saving, setSaving] = useState(false);
  /** 宿主上活着、但本页没有跟踪的会话（M4-1）：刷新后它们原先只能变成孤儿，占着服务器连接配额。 */
  const [orphans, setOrphans] = useState<RemoteSessionInfo[]>([]);
  const [orphanBusy, setOrphanBusy] = useState(false);
  /**
   * 外观（M6-2）：这份 state 就是终端预览值——面板每次改动都写回这里，TerminalView 立刻跟着变；
   * 只有面板里的「保存」才会 POST 到宿主。
   */
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /** 打开面板时的外观快照：未保存就关闭时回滚到它（编辑期间的实时预览不受影响）。 */
  const [appearanceSnapshot, setAppearanceSnapshot] = useState<Appearance | undefined>(undefined);

  useEffect(() => {
    ensureUniterminalCss();
  }, []);

  /**
   * 遗留会话标签（M9-2）挂载即认领：启动器的泄漏保险据此知道「这标签确实开了」。
   * M9-4 不再开新标签，这一条只剩接回旧标签的作用。
   */
  useEffect(() => {
    if (legacySessionId === undefined) return;
    claimSessionTab(legacySessionId);
  }, [legacySessionId]);

  /** 会话栏落档：每次变化写一份，面板容器卸载或刷新页面后按同一份接回来。 */
  useEffect(() => {
    writePersistedSessionSet(tabId, sessions);
  }, [tabId, sessions]);

  /**
   * M4-1：进入启动器时问一次宿主还活着哪些会话。差集就是孤儿——
   * 刷新页面后原先那批「界面看不到、也接不回」的会话。本会话栏里的不算孤儿。
   */
  useEffect(() => {
    if (!launcherVisible) return;
    let cancelled = false;
    const owned = new Set(sessions.entries.map((entry) => entry.id));
    void (async () => {
      try {
        const res = await api.get<SessionsResponse>("/api/uniterminal/sessions");
        if (cancelled) return;
        if (!res.ok) {
          reportClient("client.sessions-failed", {
            status: res.error.status,
            error: res.error.message.slice(0, 200),
          });
          return;
        }
        // 没有 id 的项接不回来也关不掉，直接丢掉；本会话栏里的会话也不算孤儿——
        // 那会把一条活会话摆成一行「可以关掉」的孤儿，用户一点就会关掉自己的终端
        setOrphans(
          (res.data.sessions ?? []).filter(
            (item) => typeof item.id === "string" && item.id !== "" && !owned.has(item.id),
          ),
        );
      } catch (error) {
        if (!cancelled) reportClient("client.sessions-failed", { error: String(error).slice(0, 200) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // 会话数变化也要重算差集：刚连上的会话不该再被摆成一行「可以关掉」的孤儿
  }, [launcherVisible, refreshKey, sessions.entries.length]);

  /**
   * 刷新 / 面板重挂载后的恢复（M9-4）：会话集里缺回环地址的条目问一次宿主，
   * 宿主还活着的补上地址直接重连，宿主里没有的标记「会话已结束」——
   * 而不是把一条连不回来的终端当成还在用。已经连上的条目一个字都不动。
   */
  const needsReattach = sessions.entries.some((entry) => entry.ended !== true && entry.wsUrl === undefined);
  useEffect(() => {
    if (!needsReattach) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<SessionsResponse>("/api/uniterminal/sessions");
        if (cancelled) return;
        if (!res.ok) {
          reportClient("client.session-reattach-failed", {
            status: res.error.status,
            error: res.error.message.slice(0, 200),
          });
          return;
        }
        const alive = new Map<string, string>();
        for (const item of res.data.sessions ?? []) {
          const id = item.id;
          const url = sessionWsUrl(item);
          if (typeof id !== "string" || id === "" || url === undefined) continue;
          alive.set(id, url);
        }
        setSessions((prev) => adoptHostSessions(prev, alive));
        reportClient("client.session-reattached", { alive: alive.size });
      } catch (error) {
        if (!cancelled) reportClient("client.session-reattach-failed", { error: String(error).slice(0, 200) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsReattach, reattachKey]);

  // 取不到状态（store 未注入 → 503）就保持 undefined：既不出提示，也不假装已经是明文档。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<SecurityState>("/api/uniterminal/security");
        if (cancelled) return;
        if (!res.ok) {
          reportClient("client.security-failed", { status: res.error.status, error: res.error.message.slice(0, 200) });
          return;
        }
        setSecurity({
          mode: "plain",
          legacy: res.data.legacy === true,
          storage: res.data.storage,
          storageLabel: res.data.storageLabel,
          degraded: res.data.degraded === true,
        });
      } catch (error) {
        if (!cancelled) reportClient("client.security-failed", { error: String(error).slice(0, 200) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 外观（M6-2）：挂载时问一次宿主当前值，作为面板与终端的初值。
   * 失败（503/404/离线）静默用默认值——只记诊断，绝不出提示、绝不打断终端。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<AppearanceResponse>(APPEARANCE_ENDPOINT);
        if (cancelled) return;
        if (!res.ok) {
          reportClient("client.appearance-failed", {
            status: res.error.status,
            error: res.error.message.slice(0, 200),
          });
          return;
        }
        setAppearance(normalizeAppearance(res.data.appearance));
      } catch (error) {
        if (!cancelled) reportClient("client.appearance-failed", { error: String(error).slice(0, 200) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const backToList = useCallback(() => {
    // 只切视图，绝不清存档：存档恢复的会话重新挂载后还要能回到终端，只有「断开连接」才算结束
    setView("list");
    clear();
    setPendingTrust(undefined);
    setRefreshKey((key) => key + 1);
  }, []);

  /** ＋ / 会话栏末尾的新建入口：回到启动器。会话一条都不卸载，只是把主区域让给主机列表。 */
  const openLauncher = useCallback(() => {
    setLauncherOpen(true);
    setView("list");
    clear();
    setPendingTrust(undefined);
    setRefreshKey((key) => key + 1);
  }, []);

  /** 点会话栏里的条目：切到那条会话并收起启动器。 */
  const showSession = useCallback((id: string) => {
    setSessions((prev) => activateSession(prev, id));
    setLauncherOpen(false);
  }, []);

  /**
   * 断开一条会话（会话栏的 × 与工具栏的「断开连接」都走这里）：先把它从会话栏拿掉，
   * 再去关宿主会话。宿主关没关都以界面为准——用户已经明确要它消失，失败只补一条提示，
   * 绝不把已经点掉的条目再塞回去。
   */
  const closeSessionEntry = useCallback(async (id: string): Promise<void> => {
    await closeSession(id, {
      notifyFailure: true,
      failedEvent: "client.close-failed",
      closedEvent: "client.session-closed",
      removeFromBar: true,
      removeOrphanRow: false,
    });
  }, []);

  /** 断开连接的三条路共用这一份实现：三条路的差别只由参数表达，不各写一份复制品。 */
  async function closeSession(id: string, options: CloseSessionOptions): Promise<void> {
    if (options.removeFromBar) {
      setSessions((prev) => removeSession(prev, id));
      forgetSessionTab(id);
    }
    try {
      const res = await api.post<{ closed?: boolean; error?: string }>("/api/uniterminal/sessions/close", { id });
      if (!res.ok) {
        if (options.notifyFailure) setNotice("断开连接失败：" + res.error.message);
        reportClient(options.failedEvent, { id, status: res.error.status, error: res.error.message.slice(0, 200) });
        return;
      }
      if (options.removeOrphanRow) setOrphans((items) => items.filter((item) => item.id !== id));
      reportClient(options.closedEvent, { id, closed: res.data.closed === true });
    } catch (error) {
      if (options.notifyFailure) setNotice("断开连接失败：" + String(error));
      reportClient(options.failedEvent, { id, error: String(error).slice(0, 200) });
    }
  }

  /**
   * 关掉一条会话（复制会话的失败路径用）：只发关闭请求，
   * 不碰会话栏、也不打扰用户——失败只记诊断。
   */
  async function closeSessionById(sessionId: string): Promise<void> {
    await closeSession(sessionId, {
      notifyFailure: false,
      failedEvent: "client.close-failed",
      closedEvent: "client.session-closed",
      removeFromBar: false,
      removeOrphanRow: false,
    });
  }

  /**
   * 复制会话（M9-4）：用当前会话的快照新开一条连接，直接加进会话栏并激活。
   * 快照只含白名单字段（sanitizeProfileSnapshot），口令 / 私钥 / 口令短语永远由宿主凭据库提供，
   * 请求里一个都不会出现。失败不改变现状：会话栏里一条都不多、也不少。
   */
  const duplicateSession = useCallback(async (): Promise<void> => {
    if (activeEntry === undefined || duplicating) return;
    const snapshot = activeEntry.profile;
    if (snapshot === undefined) {
      setNotice("缺少连接快照，无法复制会话：请从主机列表重新连接一次");
      return;
    }
    setDuplicating(true);
    clear();
    try {
      // 请求里只有连接所需的非敏感字段：口令仍然由宿主凭据库提供
      const request: Record<string, unknown> = { kind: "ssh" };
      if (snapshot.id !== undefined) request["id"] = snapshot.id;
      if (snapshot.host !== undefined) request["host"] = snapshot.host;
      if (snapshot.port !== undefined) request["port"] = snapshot.port;
      if (snapshot.user !== undefined) request["user"] = snapshot.user;
      if (snapshot.auth !== undefined) request["auth"] = snapshot.auth;
      // 复制会话也要走跳板链：快照里的 proxyJump 原样转成请求里的 proxyChain（字段名必须是 proxyChain）。
      // 只有非空数组才带：绝不发空数组，后端缺省即直连。
      const proxyChain = snapshotProxyChainFor(snapshot);
      if (proxyChain !== undefined) request["proxyChain"] = proxyChain;
      const res = await api.post<CreateSessionResponse>("/api/uniterminal/sessions", { profile: request });
      if (!res.ok) {
        const reason = res.error.message;
        setNotice(mapKeyAuthError(reason) ?? reason);
        reportClient("client.duplicate-failed", { status: res.error.status, error: reason.slice(0, 200) });
        return;
      }
      const payload = res.data;
      const id = payload.session?.id;
      if (id === undefined) {
        setNotice("复制会话失败：服务返回异常，请重试");
        reportClient("client.duplicate-failed", { reason: "session id missing" });
        return;
      }
      const endpoint = payload.ws;
      const url = endpoint === undefined ? undefined : sessionWsUrl({ ws: endpoint });
      if (url === undefined) {
        // 连接建好了却凑不出地址：这条会话没人能看见，立刻关掉，绝不留残留
        await closeSessionById(id);
        setNotice("复制会话失败：服务返回异常，请重试");
        reportClient("client.duplicate-failed", { reason: "missing-ws" });
        return;
      }
      const entry: SessionEntry = { id, wsUrl: url, title: snapshotTitle(snapshot, "SSH 会话"), profile: snapshot };
      setSessions((prev) =>
        addSession(prev, { ...entry, title: uniqueSessionTitle(prev.entries.map((item) => item.title), entry.title) }),
      );
      setLauncherOpen(false);
      setPaneView("terminal");
      reportClient("client.session-duplicated", { from: activeEntry.id, id });
    } catch (error) {
      setNotice("复制会话失败：" + String(error));
    } finally {
      setDuplicating(false);
    }
  }, [activeEntry, duplicating]);

  /**
   * 接管一个孤儿会话（M4-1）：直接用它自己的 ws 进会话栏，不需要密码——
   * 宿主侧这条连接早就建好了，ws bridge 只按会话 id 回放缓冲。
   */
  const adoptSession = useCallback((session: RemoteSessionInfo) => {
    const id = session.id;
    const url = sessionWsUrl(session);
    if (id === undefined || url === undefined) {
      setNotice("接管失败：服务返回异常，请重试");
      reportClient("client.adopt-failed", {
        id: String(session.id ?? ""),
        reason: id === undefined ? "session id missing" : "missing-ws",
      });
      return;
    }
    setSessions((prev) =>
      addSession(prev, {
        id,
        wsUrl: url,
        title: uniqueSessionTitle(prev.entries.map((item) => item.title), sessionEndpointText(session)),
      }),
    );
    setLauncherOpen(false);
    setPaneView("terminal");
    clear();
    setPendingTrust(undefined);
    setOrphans((items) => items.filter((item) => item.id !== id));
    reportClient("client.session-adopted", { id });
  }, []);

  /** 关闭一个孤儿会话：释放宿主上的连接配额；端点失败时保留该行，绝不假装关掉了。 */
  const closeOrphanSession = useCallback(async (session: RemoteSessionInfo) => {
    const id = session.id;
    if (id === undefined) return;
    setOrphanBusy(true);
    try {
      // 孤儿本来就不在会话栏里：removeFromBar = false；那一行等成功了才从孤儿列表去掉。
      await closeSession(id, {
        notifyFailure: true,
        failedEvent: "client.orphan-close-failed",
        closedEvent: "client.orphan-closed",
        removeFromBar: false,
        removeOrphanRow: true,
      });
    } finally {
      setOrphanBusy(false);
    }
  }, []);

  const selectHost = useCallback((profile: HostProfile, remembered: boolean) => {
    setSelected(profile);
    setSelectedRemembered(remembered);
    setHost(profile.host ?? profile.name);
    setUser(profile.user ?? "");
    setPort(profile.port === undefined ? "22" : String(profile.port));
    setPassword("");
    setPasswordVisible(false);
    setRemember(true);
    // 勾选状态**只看存档**：不再因为"本机还记得口令"就把「使用密码」自动勾回去
    const initialAuth = initialAuthSelection(profile.auth?.kind);
    setUseKey(initialAuth.useKey);
    setUsePassword(initialAuth.usePassword);
    setIdentityPath(profile.auth?.identityPath ?? "");
    // 存档里有路径就默认勾上"保存私钥路径"；没有则默认不勾（不要凭空保存一个空路径）
    setRememberKeyPath((profile.auth?.identityPath ?? "").trim() !== "");
    setKeyPasteOpen(false);
    setPrivateKeyText("");
    setPassphrase("");
    setPassphraseVisible(false);
    clear();
    setPendingTrust(undefined);
    setView("form");
  }, []);

  const manualConnect = useCallback(() => {
    setSelected(undefined);
    setSelectedRemembered(false);
    setHost("127.0.0.1");
    setUser("root");
    setPort("22");
    setPassword("");
    setPasswordVisible(false);
    setRemember(true);
    setUsePassword(true);
    setUseKey(false);
    setIdentityPath("");
    setKeyPasteOpen(false);
    setPrivateKeyText("");
    setPassphrase("");
    setPassphraseVisible(false);
    clear();
    setPendingTrust(undefined);
    setView("form");
  }, []);

  /**
   * D10：宿主只认 profiles.json 里的 remember 真值，会话请求里的 remember 并不落库。
   * 勾选时先把档案写成 remember:true——空密码也照写，否则这条主机永远没有地方存口令；
   * 取消勾选则写回 false，免得下次仍被当成「已记住」。档案已对齐时一个请求都不发。
   * identity 永远不含口令：/profiles 会拒绝任何口令字段。任何失败只记诊断，绝不挡住连接。
   */
  async function syncRemember(identity: ProfileIdentity, wanted: boolean): Promise<void> {
    try {
      const listed = await api.get<ProfilesResponse>("/api/uniterminal/profiles");
      if (!listed.ok) return;
      const stored = (listed.data.profiles ?? []).find((item) => item.id === identity.id);
      if (stored?.remember === wanted) return;
      // 档案不存在又不记住密码时没什么可写：不凭空建档案
      if (stored === undefined && !wanted) return;
      // 存档已有就整份回写（保留分组等字段），否则用本次连接的非敏感字段建档案
      const res = await api.post<{ error?: string }>("/api/uniterminal/profiles", {
        profile: { ...(stored ?? identity), remember: wanted },
      });
      if (!res.ok) {
        reportClient("client.remember-failed", { id: identity.id, status: res.error.status, error: res.error.message.slice(0, 200) });
      }
    } catch (error) {
      reportClient("client.remember-failed", { id: identity.id, error: String(error).slice(0, 200) });
    }
  }

  /** 取一份存档原样：upsert 是整条替换，不带着已有字段回写就会丢分组与名称。 */
  async function fetchStoredProfile(id: string): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await api.get<ProfilesResponse>("/api/uniterminal/profiles");
      if (!res.ok) return undefined;
      const found = (res.data.profiles ?? []).find((item) => item.id === id);
      return found === undefined ? undefined : { ...found };
    } catch {
      return undefined;
    }
  }

  /** 界面上的认证选择 → 这次请求要发的 auth 块；路径空串时整个字段都不带（后端把它当非法输入）。 */
  function authBlockFor(): RequestAuthBlock {
    const path = identityPath.trim();
    const kind = requestKindForSelection(usePassword, useKey);
    return useKey && path !== "" ? { kind, identityPath: path } : { kind };
  }

  /**
   * 界面的选择 → 写进 profiles.json 的 auth 块（存档层只能表达单方法）。
   * 勾了私钥就写 {kind:'key',identityPath}；没勾私钥就返回 undefined（auth 整个删掉，回落到密码）。
   * 两个都勾时存档只能记住私钥这一半：密码那一半靠「记住密码」与每次连接输入的明文，永不进 profiles.json。
   */
  function storedAuthFor(): ProfileAuthBlock | undefined {
    // 存档 kind 的推导只在 auth-kinds.ts 里做一次（含"只勾密码 = 不写 auth"这条规则）
    const kind = storedKindForSelection(usePassword, useKey);
    if (kind === undefined) return undefined;
    // 取消"保存私钥路径"就不写路径：存档里只留认证方式，路径由用户下次自己填
    const path = rememberKeyPath ? identityPath.trim() : "";
    return path === "" ? { kind } : { kind, identityPath: path };
  }

  /** 从存档（unknown 形状）里取出私钥路径，取不到就是 undefined。 */
function storedKeyPathOf(stored: Record<string, unknown> | undefined): string | undefined {
  const auth = stored?.auth;
  if (typeof auth !== "object" || auth === null) return undefined;
  const path = (auth as Record<string, unknown>).identityPath;
  return typeof path === "string" ? path : undefined;
}

/** 取消"记住密码"后清掉已存口令；失败只是留下 diag，不影响"配置已保存"这条主流程。 */
async function forgetStoredPassword(profileId: string): Promise<void> {
  try {
    await api.post("/api/uniterminal/profiles/forget-password", { profileId });
  } catch {
    // 清不掉最多是盾牌多亮一会儿，不该让保存失败
  }
}

/** 整份 upsert（upsert 是整条替换，调用方负责先取存档再合并）。 */
  async function saveProfileRecord(
    record: Record<string, unknown>,
  ): Promise<{ id: string; warning?: string } | undefined> {
    try {
      const res = await api.post<{ profile?: { id?: string }; error?: string; warning?: string }>(
        "/api/uniterminal/profiles",
        { profile: record },
      );
      if (!res.ok) {
        const reason = res.error.message;
        setNotice(mapKeyAuthError(reason) ?? reason);
        reportClient("client.profile-save-failed", { status: res.error.status, error: reason.slice(0, 200) });
        return undefined;
      }
      return { id: res.data.profile?.id ?? String(record.id ?? ""), warning: res.data.warning };
    } catch (error) {
      setNotice(String(error));
      return undefined;
    }
  }

  /**
   * 私钥方式的准备：profiles.json 只拿 auth（方式 + 路径），私钥内容只能走 /profiles/key。
   * 顺序固定：先把档案落库拿到 id，再存密钥——否则凭据库里的 key:<id> 找不到宿主。
   * 粘贴的私钥要**先**进凭据库再写 auth：服务端会拒收「既没有路径、凭据库里也没有密钥」的空私钥配置。
   * 返回档案 id；undefined 表示准备失败，提示已经写好。
   */
  async function prepareKeyAuth(base: ProfileIdentity): Promise<string | undefined> {
    const auth = storedAuthFor() ?? { kind: "key" as const };
    const pasted = identityPath.trim() === "" && privateKeyText !== "";
    // upsert 是整条替换：存档已存在就整份回写（分组、名称、标签、remember 全保留），只覆盖 auth
    const stored = await fetchStoredProfile(base.id);
    const record: Record<string, unknown> = { ...(stored ?? base) };
    if (pasted) delete record.auth;
    else record.auth = auth;
    const saved = await saveProfileRecord(record);
    if (saved === undefined) return undefined;
    if (pasted) {
      if (!(await storePastedKey(saved.id))) return undefined;
      // 凭据库里已经有 key:<id>，这时写 auth 才是合法的一条私钥配置
      const withAuth = await saveProfileRecord({ ...record, id: saved.id, auth });
      if (withAuth === undefined) return undefined;
    }
    // 提交成功：私钥内容与口令立刻离开组件状态（这次走路径也一样，不留无用的粘贴内容）
    setPrivateKeyText("");
    setPassphrase("");
    setKeyPasteOpen(false);
    return saved.id;
  }

  /**
   * 粘贴的私钥内容只在这条路径上提交（M2b 的硬约束）：profiles.json 永远只有方式与路径。
   * 成功后立刻清空组件状态；失败返回 false，提示已经写好。
   */
  async function storePastedKey(profileId: string): Promise<boolean> {
    const body =
      passphrase === ""
        ? { profileId, privateKey: privateKeyText }
        : { profileId, privateKey: privateKeyText, passphrase };
    const res = await api.post<{ ok?: boolean; error?: string }>("/api/uniterminal/profiles/key", body);
    if (!res.ok) {
      const reason = res.error.message;
      setNotice(mapKeyAuthError(reason) ?? "保存私钥失败：" + reason);
      // 诊断只记状态与类别文案：私钥内容永不进上报
      reportClient("client.key-store-failed", { id: profileId, status: res.error.status, error: reason.slice(0, 200) });
      return false;
    }
    setPrivateKeyText("");
    setPassphrase("");
    setKeyPasteOpen(false);
    return true;
  }

  /** 清理旧版凭据：二次确认之后的那一步，删掉已停用的旧档文件（**不动明文库里已记住的密码**）。 */
  async function clearLegacy(): Promise<void> {
    setResetPending(false);
    setResetError(undefined);
    setResetBusy(true);
    try {
      const res = await api.post<{ mode?: string; legacy?: boolean; error?: string }>(SECURITY_CLEAR_ENDPOINT, {
        confirm: true,
      });
      if (!res.ok) {
        setResetError(res.error.message);
        return;
      }
      // 只改 legacy：密码存在哪（storage / storageLabel / degraded）不受清理动作影响。
      setSecurity((prev) => ({ ...(prev ?? { mode: "plain" as const }), legacy: false }));
      setOk("旧版凭据已清理");
      reportClient("client.security-legacy-cleared", {});
    } catch (error) {
      setResetError(String(error));
    } finally {
      setResetBusy(false);
    }
  }

  async function connect(): Promise<void> {
    // M8-1：连接全程给进度——点完「连接」界面原地不动，用户会以为没反应
    setConnecting(true);
    clear();
    setPendingTrust(undefined);
    try {
      // 一个都不勾就没有认证方式可用：本地直接拦下，不发请求
      if (!usePassword && !useKey) {
        setNotice("请至少选择一种认证方式");
        return;
      }
      // 口令只在内存里随一次请求传递：profiles.json 永不落口令，凭据文件由宿主在连接成功后写入
      const identity: ProfileIdentity = {
        id: selected?.id ?? host,
        kind: "ssh",
        host,
        port: Number(port),
        user: user === "" ? undefined : user,
        remember,
      };
      let profileId = identity.id;
      if (useKey) {
        // 私钥方式的准备：先把路径/粘贴内容落到正确的地方（profiles.json 只有路径，内容只进凭据库）
        const ready = await prepareKeyAuth(identity);
        if (ready === undefined) return;
        profileId = ready;
      }
      if (usePassword) {
        // 空密码也要同步 remember：不写这一笔，宿主连接成功后没有档案可以挂口令
        await syncRemember(identity, remember);
      }
      // 显式发这次的勾选结果（M2d-2）：存档里残留的单方法认证再也劫持不了这次连接；
      // 两个都勾就把密码和私钥一起交给后端，由 ssh2 自己按顺序尝试。
      const auth = authBlockFor();
      const profile: Record<string, unknown> = {
        id: profileId,
        kind: "ssh",
        host,
        port: Number(port),
        user: identity.user,
        auth,
      };
      // M3-3 跳板链（P0-9）：存档里的 proxyJump 原样透传成请求里的 proxyChain——字段名必须是 proxyChain。
      // 只有非空数组才带：绝不发空数组（后端缺省即直连）。手动连接没有跳板链，selected 为空，同样不带。
      const proxyChain = proxyChainFor(selected);
      if (proxyChain !== undefined) profile.proxyChain = proxyChain;
      if (usePassword && password !== "") profile.password = password;
      try {
        const res = await api.post<CreateSessionResponse>("/api/uniterminal/sessions", { profile });
        // 宿主对未知路径的兜底是纯文本 "not found"：api.ts 先取 text 再 parse，绝不直接按 JSON 解
        if (!res.ok) {
          const reason = res.error.message;
          // 未知指纹优先读响应体的结构化字段（host/port/fingerprint），读不到才退回英文原文里的正则
          const payload = res.error.payload as UnknownHostKeyPayload;
          setPendingTrust(parseUnknownHostKey(payload));
          if (reason.includes(VAULT_LOCKED)) {
            // 兜底：只有旧宿主的旧档会这样回话——现在只有一种存储，唯一的动作是清理旧版凭据
            setSecurity((prev) => ({ ...(prev ?? { mode: "plain" as const }), legacy: true }));
            setNotice("本机凭据当前不可读：请先清理旧版凭据后重试");
            reportClient("client.credentials-unreadable", { id: identity.id });
            return;
          }
          if (reason.includes(PASSWORD_REQUIRED)) {
            setNotice("该主机尚未保存密码，请输入一次并连接，之后会自动记住");
            reportClient("client.password-required", { id: identity.id });
            return;
          }
          const mapped = mapKeyAuthError(reason);
          if (mapped !== undefined) {
            // 私钥类失败：路径读不到 / 根本没配私钥，都给一条照着做就能过的提示
            setNotice(mapped);
            reportClient("client.key-auth-failed", { id: identity.id, status: res.error.status, error: reason.slice(0, 200) });
            return;
          }
          setNotice(reason);
          reportClient("client.create-failed", { status: res.error.status, error: reason.slice(0, 200) });
          return;
        }
        const payload = res.data;
        const id = payload.session?.id;
        if (id === undefined) {
          setNotice("连接失败：服务返回异常，请重试");
          reportClient("client.create-failed", { reason: "session id missing" });
          return;
        }
        const info = payload.ws;
        if (info?.host === undefined || info.port === undefined || info.path === undefined) {
          setNotice("连接失败：服务返回异常，请重试");
          reportClient("client.create-failed", { reason: "missing-ws" });
          return;
        }
        const url = "ws://" + info.host + ":" + String(info.port) + info.path;
        // 快照只含白名单字段：口令 / 私钥 / 口令短语无论怎么塞都会在这里被丢掉
        const nextSnapshot = sanitizeProfileSnapshot({
          id: profileId,
          kind: "ssh",
          // 主机名要带上：会话标签与工具栏显示的就是它（用户实报"显示的和我配的名字不一致"）
          ...(selected?.name === undefined ? {} : { name: selected.name }),
          host,
          port: Number(port),
          user: identity.user,
          remember,
          auth,
          // 跳板链也进快照：「复制会话」靠它重连（快照里没有它，复制出来必然直连）
          ...(selected?.proxyJump === undefined ? {} : { proxyJump: selected.proxyJump }),
        });
        const nextEntry: SessionEntry = {
          id,
          wsUrl: url,
          title: snapshotTitle(nextSnapshot ?? {}, connectTargetText(user, host, port)),
        };
        if (nextSnapshot !== undefined) nextEntry.profile = nextSnapshot;
        // 会话进会话栏并立刻成为当前会话：这一路不再开任何侧边栏标签（M9-4）
        setSessions((prev) =>
          addSession(prev, { ...nextEntry, title: uniqueSessionTitle(prev.entries.map((item) => item.title), nextEntry.title) }),
        );
        setLauncherOpen(false);
        setPaneView("terminal");
        clear();
        setPendingTrust(undefined);
        // 口令与私钥只活在这一次请求里：它们从未进过会话集，也就进不了存档
        setPassword("");
        setPrivateKeyText("");
        setPassphrase("");
        setKeyPasteOpen(false);
      } catch (error) {
        setNotice("连接失败：" + String(error));
      }
    } finally {
      setConnecting(false);
    }
  }

  /**
   * 「保存配置」（M2d）：把这屏表单的配置写进 profiles.json，认证方式以界面为准。
   * upsert 是整条替换，所以先 GET 存档再 {...存档, 表单字段}，否则会丢分组、名称、标签。
   * 选「密码」就把 auth 字段整个删掉（不写 kind:'password' 占位），选「私钥」才写 auth 块。
   * 口令与私钥内容永远不进 profiles.json：私钥内容只走 /profiles/key。
   */
  async function saveProfile(): Promise<void> {
    if (saving) return;
    setSaving(true);
    clear();
    const id = selected?.id ?? host;
    try {
      const portNumber = port.trim() === "" ? undefined : Number(port);
      if (portNumber !== undefined && !Number.isInteger(portNumber)) {
        setNotice("保存配置失败：端口必须是整数");
        return;
      }
      const stored = await fetchStoredProfile(id);
      // 取消勾选 = 主动丢弃已存的口令/私钥路径，先问一句；不确认就不写
      const drops = droppedSecrets(
        { rememberedPassword: stored?.remember === true, storedKeyPath: storedKeyPathOf(stored) },
        { usePassword, remember, useKey, rememberKeyPath, identityPath },
      );
      if (drops.length > 0 && saveConfirm === undefined) {
        setSaveConfirm(drops);
        setSaving(false);
        return;
      }
      setSaveConfirm(undefined);
      const next: Record<string, unknown> = { ...(stored ?? { id, kind: "ssh", name: host === "" ? id : host }) };
      next.host = host;
      next.user = user === "" ? undefined : user;
      next.port = portNumber;
      // 显式写 false，而不是"只在不勾时才不动"：反选后必须真的不记住
      next.remember = usePassword && remember;
      const auth = storedAuthFor();
      const pasted = useKey && identityPath.trim() === "" && privateKeyText !== "";
      // 认证方式以界面为准：勾了私钥才写 auth，否则整个字段删掉（后端据此走密码，M2d ③）
      if (auth === undefined) delete next.auth;
      // 粘贴的私钥还没进凭据库：先不写 auth，等服务端确认凭据库里有 key:<id> 再补写
      else if (pasted) delete next.auth;
      else next.auth = auth;
      const first = await saveProfileRecord(next);
      if (first === undefined) return;
      let profileId = first.id;
      let warning = first.warning;
      if (pasted) {
        // 私钥内容只走 /profiles/key：profiles.json 里永远只有方式与路径
        if (!(await storePastedKey(profileId))) return;
        const settled = await saveProfileRecord({ ...next, id: profileId, auth });
        if (settled === undefined) return;
        warning = settled.warning;
        profileId = settled.id;
      }
      // 不再记住口令时，把凭据库里的口令也清掉：只改 remember 标记的话，
      // 列表面板仍从 /security/refs 看到它，"已记住"盾牌会一直亮着。
      if (!next.remember) await forgetStoredPassword(profileId);
      // 服务端拒收了空私钥配置：如实告诉用户这条认证方式没有保存（失败语义，仍是红）
      if (warning !== undefined) setNotice(warning);
      else setOk("已保存配置");
      setRefreshKey((key) => key + 1);
      reportClient("client.profile-saved", { id: profileId, usePassword, useKey, warning: warning !== undefined });
    } catch (error) {
      setNotice("保存配置失败：" + String(error));
    } finally {
      setSaving(false);
    }
  }

  async function trustAndRetry(): Promise<void> {
    if (pendingTrust === undefined) return;
    clear();
    try {
      const res = await api.post<{ error?: string }>("/api/uniterminal/hosts/trust", pendingTrust);
      if (!res.ok) {
        setNotice("信任主机失败：" + res.error.message);
        return;
      }
      setPendingTrust(undefined);
      reportClient("client.host-trusted", { host: pendingTrust.host, port: pendingTrust.port });
      await connect();
    } catch (error) {
      setNotice("信任主机失败：" + String(error));
    }
  }

  /**
   * 常驻小字：密码存在哪。
   *
   * 服务端给的是一句人话（storageLabel）：系统密码箱按平台各不相同
   * （Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）。
   * 文件后端下要保留验收单锁定的那句原文——那时密码确实在本机文件里。
   * 降级时如实说"密码箱这一刻用不了，已临时改用本机文件保存"。
   */
  const storageNote = (): string => {
    if (security === undefined) return PLAIN_STORAGE_NOTE;
    if (security.degraded === true) return STORAGE_DEGRADED_NOTE;
    if (security.storage === "keychain") return security.storageLabel ?? STORAGE_KEYCHAIN_NOTE;
    return PLAIN_STORAGE_NOTE;
  };

  // 旧版凭据文件已停用：只给一条清理入口，不提任何已取消的能力。
  const legacyBanner = security?.legacy === true ? (
    <div
      className="uniterminal-col uniterminal-banner"
      // 外壳（padding / 描边 / 圆角）由 .uniterminal-banner 统一声明；这里只留这条提示独有的间距与底色
      style={{ gap: 6, background: "rgba(214, 158, 46, 0.14)" }}
    >
      <span className="uniterminal-body uniterminal-strong">{LEGACY_BANNER_TITLE}</span>
      <p className="uniterminal-hint">{CLEAR_LEGACY_NOTE}</p>
      <div className="uniterminal-row">
        <button
          type="button"
          disabled={resetBusy}
          className="uniterminal-self-center"
          onClick={() => setResetPending(true)}
        >
          {CLEAR_LEGACY_LABEL}
        </button>
        {resetPending && (
          <>
            <span className="uniterminal-small">{CLEAR_LEGACY_CONFIRM}</span>
            <button
              type="button"
              className="uniterminal-self-center"
              disabled={resetBusy}
              onClick={() => void clearLegacy()}
            >
              清理旧版凭据
            </button>
            <button type="button" className="uniterminal-self-center" onClick={() => setResetPending(false)}>
              取消
            </button>
          </>
        )}
      </div>
      {/* 横幅自己的错误：它确实是错误，红色对，而且必须常驻到用户改完为止——
          所以不走共享 notice 通道（那条是一次性反馈，6 秒过期，还会被下一次反馈顶掉）。 */}
      {/* B5 无障碍：外层容器常驻（role="alert" 挂在条件渲染的节点上，插入那一刻会被漏播） */}
      <div {...noticeLiveProps("error")} className="uniterminal-live">
        {resetError !== undefined && <div className="uniterminal-notice">{resetError}</div>}
      </div>
    </div>
  ) : undefined;

  /**
   * M4-1 孤儿会话区：宿主上活着但本页没跟踪的会话。一行一个，接管直接进终端，关闭释放连接。
   * 只在确实有孤儿时出现——没有孤儿就一个像素都不占。
   */
  const orphanBanner = orphans.length > 0 ? (
    <div
      className="uniterminal-col uniterminal-banner"
      // 外壳（padding / 描边 / 圆角）由 .uniterminal-banner 统一声明；这里只留这条提示独有的间距与底色
      style={{ gap: 6, background: "rgba(214, 158, 46, 0.14)" }}
    >
      <span className="uniterminal-body uniterminal-strong">{orphanSummary(orphans.length)}</span>
      <p className="uniterminal-hint">
        这些会话仍在宿主上运行（多半是刷新页面留下的）：接管可直接回到终端，关闭会释放主机连接。
      </p>
      {orphans.map((session) => (
        <div
          key={session.id ?? sessionEndpointText(session)}
          className="uniterminal-row uniterminal-wrap"
        >
          <span className="uniterminal-body">{sessionEndpointText(session)}</span>
          <span className="uniterminal-hint">{sessionCreatedText(session.createdAt)}</span>
          <button type="button" className="uniterminal-self-center" onClick={() => adoptSession(session)}>
            接管
          </button>
          <button
            type="button"
            className="uniterminal-self-center"
            disabled={orphanBusy}
            onClick={() => void closeOrphanSession(session)}
          >
            关闭
          </button>
        </div>
      ))}
    </div>
  ) : undefined;

  /** 会话栏：一条会话一个按钮（当前会话高亮）+ × 关闭 + 末尾的 ＋ 新建。 */
  const sessionBar =
    sessions.entries.length === 0 ? undefined : (
      <div
        role="tablist"
        aria-label="会话"
        className="uniterminal-row-tight uniterminal-wrap uniterminal-fixed"
        style={{ gap: 6 }}
      >
        {sessions.entries.map((entry) => (
          <span key={entry.id} className="uniterminal-row-tight" style={{ gap: 2 }}>
            <button
              type="button"
              className="uniterminal-viewtab"
              aria-pressed={entry.id === activeId}
              title={entry.title}
              onClick={() => showSession(entry.id)}
            >
              {/* 已结束的会话留在会话栏上：用户要看得见它，也得关得掉 */}
              {entry.ended === true ? "⚠ " : ""}
              {entry.title}
            </button>
            <button
              type="button"
              className="uniterminal-viewtab uniterminal-compact"
              aria-label="断开连接"
              title="断开连接"
              onClick={() => {
                reportClient("client.close-requested", { from: "tab", id: entry.id });
                setPendingClose({ id: entry.id, title: entry.title });
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="uniterminal-viewtab"
          aria-label="新建会话"
          title="新建会话"
          onClick={openLauncher}
        >
          ＋
        </button>
      </div>
    );

  /** 当前会话的工具栏：没有会话、或启动器占着主区域时不出现。 */
  const sessionToolbar =
    activeEntry === undefined || launcherVisible ? undefined : (
      <div className="uniterminal-row uniterminal-wrap uniterminal-fixed">
        <span className="uniterminal-hint">{activeEntry.title}</span>
        <button
          type="button"
          className="uniterminal-viewtab"
          aria-pressed={paneView === "terminal"}
          onClick={() => setPaneView("terminal")}
        >
          终端
        </button>
        <button
          type="button"
          className="uniterminal-viewtab"
          aria-pressed={paneView === "files"}
          onClick={() => setPaneView("files")}
        >
          文件
        </button>
        <button
          type="button"
          className="uniterminal-viewtab"
          aria-pressed={paneView === "tunnels"}
          onClick={() => setPaneView("tunnels")}
        >
          隧道
        </button>
        <button
          type="button"
          className="uniterminal-viewtab"
          aria-pressed={appearanceOpen}
          onClick={() => {
              if (!appearanceOpen) setAppearanceSnapshot(appearance);
              setAppearanceOpen((open) => !open);
            }}
        >
          外观
        </button>
        <button
          type="button"
          disabled={duplicating || activeEntry.profile === undefined}
          title={activeEntry.profile === undefined ? "缺少连接快照，无法复制" : undefined}
          onClick={() => void duplicateSession()}
        >
          复制会话
        </button>
        <button
          type="button"
          className="uniterminal-viewtab"
          style={{ color: COLOR_DANGER }}
          onClick={() => {
                reportClient("client.close-requested", { from: "toolbar", id: activeEntry.id });
                setPendingClose({ id: activeEntry.id, title: activeEntry.title });
              }}
        >
          断开连接
        </button>
      </div>
    );

  const connectForm = (
    <div className="uniterminal-overlay">
      <div className="uniterminal-overlay-panel">
      <div className="uniterminal-pane" ref={formRef}>
      {legacyBanner}
      <p className="uniterminal-hint">{selected === undefined ? "手动连接" : "连接 " + selected.name}</p>
      <label>主机<input value={host} onChange={(event) => setHost(event.target.value)} /></label>
      <label>用户<input value={user} onChange={(event) => setUser(event.target.value)} /></label>
      <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} /></label>
      {/* 认证方式（M2d-2）：两个区同时可见，勾选只决定这次用不用它；切换立刻影响下一次连接 */}
      <div className="uniterminal-row-tight uniterminal-wrap" style={{ gap: 16 }}>
        <label className="uniterminal-check">
          <input type="checkbox" checked={usePassword} onChange={(event) => setUsePassword(event.target.checked)} />
          使用密码
        </label>
        <label className="uniterminal-check">
          <input type="checkbox" checked={useKey} onChange={(event) => setUseKey(event.target.checked)} />
          使用私钥
        </label>
        {usePassword && useKey && <span className="uniterminal-hint">两种都试，由 SSH 自己按顺序尝试</span>}
        {!usePassword && !useKey && <span className="uniterminal-hint">请至少选择一种认证方式</span>}
      </div>
      <div className="uniterminal-col-gap" style={{ opacity: usePassword ? 1 : 0.55 }}>
        <span className="uniterminal-small uniterminal-strong">密码</span>
        <label>
          <span
            className="uniterminal-strong"
            style={
              selected !== undefined && selectedRemembered ? { color: COLOR_SUCCESS } : undefined
            }
          >
            {selected !== undefined && selectedRemembered ? "密码（已记住）" : "密码"}
          </span>
          <div className="uniterminal-row">
            <input
              type={passwordVisible ? "text" : "password"}
              autoComplete="off"
              disabled={!usePassword}
              className={
                selected !== undefined && selectedRemembered && password === ""
                  ? "uniterminal-masked uniterminal-flex-auto"
                  : "uniterminal-flex-auto"
              }
              placeholder={
                selected !== undefined && selectedRemembered ? "已保存密码无需输入直接连接" : "输入密码"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              disabled={!usePassword}
              className="uniterminal-self-center uniterminal-compact-wide"
              aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
              title={passwordVisible ? "隐藏密码" : "显示密码"}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? "隐藏" : "显示"}
            </button>
          </div>
        </label>
        {selected !== undefined && selectedRemembered && (
          <p className="uniterminal-hint">
            已记住这台主机的密码：密码框留空直接点「连接」即可。若输入新密码，连接成功后会用新密码覆盖旧密码。
          </p>
        )}
        <label className="uniterminal-check">
          <input type="checkbox" checked={remember} disabled={!usePassword} onChange={(event) => setRemember(event.target.checked)} />
          记住密码
        </label>
        <p className="uniterminal-hint">{storageNote()}</p>
      </div>
      <div className="uniterminal-col-gap" style={{ opacity: useKey ? 1 : 0.55 }}>
        <span className="uniterminal-small uniterminal-strong">私钥</span>
        <label>
          私钥文件路径
          <input
            value={identityPath}
            disabled={!useKey}
            placeholder={"C:\\Users\\you\\.ssh\\id_ed25519"}
            onChange={(event) => setIdentityPath(event.target.value)}
          />
        </label>
        <label className="uniterminal-check">
          <input type="checkbox" checked={rememberKeyPath} disabled={!useKey} onChange={(event) => setRememberKeyPath(event.target.checked)} />
          保存私钥路径
        </label>
        <p className="uniterminal-hint">
          勾选后路径写进本机配置；取消勾选并保存会清掉已存路径（私钥文件本身不会被删除）；留空则用下面粘贴的私钥。
        </p>
        <div className="uniterminal-row">
          <button
            type="button"
            disabled={!useKey}
            className="uniterminal-self-center"
            onClick={() => setKeyPasteOpen((open) => !open)}
          >
            粘贴私钥内容
          </button>
          {privateKeyText !== "" && (
            <span className="uniterminal-hint">已粘贴 {String(privateKeyText.length)} 字符：提交成功后立即清空</span>
          )}
        </div>
        {keyPasteOpen && (
          <>
            <label>
              私钥内容
              {/* 刻意不做掩码：粘贴完要能核对；内容在提交成功后立刻清空，不留在组件状态里 */}
              <textarea
                rows={6}
                value={privateKeyText}
                autoComplete="off"
                spellCheck={false}
                disabled={!useKey}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={(event) => setPrivateKeyText(event.target.value)}
                className="uniterminal-body"
                style={{
                  padding: "4px 6px",
                  fontFamily: "monospace",
                  color: "inherit",
                  background: "transparent",
                  border: "1px solid var(--ut-border)",
                  borderRadius: 4,
                  resize: "vertical",
                }}
              />
            </label>
            <label>
              私钥口令（可选）
              <div className="uniterminal-row">
                <input
                  type={passphraseVisible ? "text" : "password"}
                  autoComplete="off"
                  disabled={!useKey}
                  placeholder="私钥没有口令就留空"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className="uniterminal-flex-auto"
                />
                <button
                  type="button"
                  disabled={!useKey}
                  className="uniterminal-self-center uniterminal-compact-wide"
                  aria-label={passphraseVisible ? "隐藏私钥口令" : "显示私钥口令"}
                  title={passphraseVisible ? "隐藏私钥口令" : "显示私钥口令"}
                  aria-pressed={passphraseVisible}
                  onClick={() => setPassphraseVisible((visible) => !visible)}
                >
                  {passphraseVisible ? "隐藏" : "显示"}
                </button>
              </div>
            </label>
            <p className="uniterminal-hint">
              私钥内容只随本次提交发给本机凭据文件，不写进主机配置；提交成功后这里会立即清空。
            </p>
          </>
        )}
        {usePassword && useKey && (
          <p className="uniterminal-hint">私钥坏了也能用密码：两个都勾时两条路一起交给 SSH，私钥读不到会自动用密码。</p>
        )}
        {useKey && !usePassword && (
          <p className="uniterminal-hint">只使用私钥。私钥读不到会报错；如需密码登录请勾选「使用密码」。</p>
        )}
      </div>
      <div className="uniterminal-row">
        <button type="button" className="uniterminal-self-center" disabled={connecting} onClick={() => void connect()}>
          {connecting ? "连接中…" : "连接"}
        </button>
        <button type="button" className="uniterminal-self-center" disabled={saving} onClick={() => void saveProfile()}>
          保存配置
        </button>
        {/* 连接期间不禁用：等不及的用户必须能放弃这次连接 */}
        <button type="button" className="uniterminal-self-center" onClick={backToList}>返回主机列表</button>
      </div>
      {pendingTrust !== undefined && (
        <button type="button" onClick={() => void trustAndRetry()}>
          信任该主机并重试（{pendingTrust.host}:{pendingTrust.port} {pendingTrust.fingerprint}）
        </button>
      )}
      {/* 「正在连接…」是**状态说明**（进行中），不是操作反馈：
          因此不走共享 notice 通道（那条是一次性反馈，6 秒就过期——状态说明不该消失），
          也不用 `.uniterminal-notice`（那永远是错误红，用户只会读成"出错了"）。 */}
      {connecting && (
        <div className="uniterminal-hint">
          {"正在连接 " + connectTargetText(user, host, port) + "…"}
          {/* 超过 5 秒才追加倒计时：前 5 秒只是"在连"，还没到需要催的时候 */}
          {connectCountdown.counting ? " 连接超时倒计时 " + connectCountdown.remainingSec + "s" : ""}
        </div>
      )}
      {/* 连接相关的反馈就地显示：连接状态在下面，错误也应该在下面。
          之前只放在面板顶部，用户点了「连接」却要在最上方找结果。 */}
      {/* B5 无障碍：两个常驻容器，按 kind 只往其中一个写文字（role 本身不切换）。
          "连接中就藏起来"这条改成作用在**文字**上，容器本身不卸载。 */}
      <div {...noticeLiveProps("ok")} className="uniterminal-live">
        {!connecting && notice !== undefined && notice.kind === "ok" && (
          <div className={noticeClassName(notice.kind) + " uniterminal-left"}>{notice.text}</div>
        )}
      </div>
      <div {...noticeLiveProps("error")} className="uniterminal-live">
        {!connecting && notice !== undefined && notice.kind === "error" && (
          <div className={noticeClassName(notice.kind) + " uniterminal-left"}>{notice.text}</div>
        )}
      </div>
      {/* 取消勾选并保存 = 丢弃已存的口令/路径，用与删除主机相同的弹框确认 */}
      {saveConfirm !== undefined && (
        <ConfirmDialog
          title="确认保存？"
          message={droppedSecretsMessage(saveConfirm)}
          confirmLabel="确定保存"
          danger
          onCancel={() => setSaveConfirm(undefined)}
          onConfirm={() => {
            setSaveConfirm(undefined);
            void saveProfile();
          }}
        />
      )}
    </div>
      </div>
    </div>
  );

  return (
    <div className="uniterminal-pane" ref={mainPaneRef}>
      {sessionBar}
      {/* 连接表单开着时，连接相关的反馈由表单自己就地显示（按钮下方）；
          否则同一条错误会在顶部和底部各出现一次。 */}
      {/* 断开连接前确认：会话一断，里面正在跑的命令就没了 */}
      {pendingClose !== undefined && (
        <ConfirmDialog
          title="断开连接"
          message={"关闭「" + pendingClose.title + "」？会话会断开，里面正在运行的任务会停止。"}
          confirmLabel="断开连接"
          danger
          onCancel={() => setPendingClose(undefined)}
          onConfirm={() => {
            const target = pendingClose;
            reportClient("client.close-confirmed", { id: target.id });
            setPendingClose(undefined);
            void closeSessionEntry(target.id);
          }}
        />
      )}
      {/* 顶部一处：同样两个常驻容器；"表单打开时不在顶部重复显示"这条作用在文字上 */}
      <div {...noticeLiveProps("ok")} className="uniterminal-live">
        {!(launcherVisible && view === "form") && notice !== undefined && notice.kind === "ok" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
      <div {...noticeLiveProps("error")} className="uniterminal-live">
        {!(launcherVisible && view === "form") && notice !== undefined && notice.kind === "error" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
      {/* 启动器（主机列表 / 连接表单）：开着时只把会话区藏起来，一条终端都不卸载 */}
      {launcherVisible && (
        <div className="uniterminal-col-gap uniterminal-grow uniterminal-fill">
          {/* 列表常驻：连接表单改成浮层，背后仍能看到主机，切走也不必重建列表 */}
          <>
            {legacyBanner}
            {orphanBanner}
            <div className="uniterminal-grow uniterminal-fill">
              <HostListView onSelect={selectHost} onManualConnect={manualConnect} refreshKey={refreshKey} />
            </div>
          </>
          {view === "form" && connectForm}
        </div>
      )}
      {/* 会话区：每条会话一个容器，只隐藏不卸载（display:none）——切回来不必重放缓冲 */}
      <div
        className="uniterminal-col-gap uniterminal-grow uniterminal-fill"
        style={{ display: launcherVisible ? "none" : "flex" }}
      >
        {sessionToolbar}
        {/* 外观面板（M6-2）：本地 state 即时喂给终端预览，保存由面板自己 POST */}
        {appearanceOpen && (
        <div className="uniterminal-overlay">
          <div className="uniterminal-overlay-panel">
            <div className="uniterminal-row-tight uniterminal-between">
              <span>外观</span>
              <button type="button" title="关闭" aria-label="关闭外观面板" onClick={() => {
                // 没点「保存」就关闭：把预览回滚到打开前的样子，避免"看着没保存其实已经生效"
                if (appearanceSnapshot !== undefined) setAppearance(appearanceSnapshot);
                setAppearanceSnapshot(undefined);
                setAppearanceOpen(false);
              }}>
                ×
              </button>
            </div>
            <AppearancePanel value={appearance} onChange={setAppearance} onSaved={(next) => setAppearanceSnapshot(next)} />
          </div>
        </div>
      )}
        {sessions.entries.map((entry) => (
          <div
            key={entry.id}
            className="uniterminal-col uniterminal-grow uniterminal-fill"
            style={{
              display: entry.id === activeId && paneView === "terminal" ? "flex" : "none",
            }}
          >
            {entry.ended === true ? (
              <div className="uniterminal-col-gap">
                <span className="uniterminal-hint">
                  会话已结束：宿主上已经没有这条会话（多半是宿主重启或被别处关闭）
                </span>
                <button type="button" className="uniterminal-self-center" onClick={() => void closeSessionEntry(entry.id)}>
                  关闭
                </button>
              </div>
            ) : entry.wsUrl === undefined ? (
              <div className="uniterminal-col-gap">
                <span className="uniterminal-hint">正在接回会话 {entry.title}…</span>
                <button type="button" className="uniterminal-self-center" onClick={() => setReattachKey((key) => key + 1)}>
                  重试
                </button>
              </div>
            ) : (
              <>
                <TerminalView sessionId={entry.id} wsUrl={entry.wsUrl} onNotice={setNotice} appearance={appearance} />
                {/* M8-20 状态栏：终端高度跟着缩，尺寸交给 TerminalView 自己的 ResizeObserver + fit，这里不做任何计算 */}
                {/* 非活动标签、非当前会话都不算活动：轮询闸门在这里与 visible、activeId 取与（M9-4） */}
                <StatusBar
                  sessionId={entry.id}
                  active={paneView === "terminal" && tabVisible && entry.id === activeId}
                />
              </>
            )}
          </div>
        ))}
        {activeEntry !== undefined && visitedViews.has("files") && (
          <div
            className="uniterminal-col uniterminal-grow uniterminal-fill"
            style={{
              display: paneView === "files" ? "flex" : "none",
            }}
          >
            <SftpPanel sessionId={activeEntry.id} />
          </div>
        )}
        {activeEntry !== undefined && visitedViews.has("tunnels") && (
          <div
            className="uniterminal-col uniterminal-grow uniterminal-fill"
            style={{
              display: paneView === "tunnels" ? "flex" : "none",
            }}
          >
            <div className="uniterminal-overlay">
              <div className="uniterminal-overlay-panel">
                <div className="uniterminal-row-tight uniterminal-between">
                  <span>隧道</span>
                  <button type="button" title="关闭" aria-label="关闭隧道面板" onClick={() => setPaneView("terminal")}>
                    ×
                  </button>
                </div>
                <TunnelPanel sessionId={activeEntry.id} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
