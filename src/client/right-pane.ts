export type RightPaneTarget = "betterSidebar" | "sidebarRightTabs" | "none";

/** 本插件注册的标签类型；会话标签的 id 以它为前缀。 */
export const TAB_TYPE = "uniterminal";

/** 会话标签 id 的前缀：标签 id 是会话身份的唯一事实来源（M9-2）。 */
export const SESSION_TAB_PREFIX = TAB_TYPE + ":";

/**
 * 会话 id → 标签 id。空会话 id 没有身份可言，返回空串：
 * 解析侧一定还原成 undefined，于是一律当作启动器标签，而不是伪造一条会话标签。
 */
export function sessionIdTabId(sessionId: string): string {
  return typeof sessionId === "string" && sessionId !== "" ? SESSION_TAB_PREFIX + sessionId : "";
}

/**
 * 标签 id → 会话 id。只有以 SESSION_TAB_PREFIX 开头、且前缀之后还有内容才算会话标签；
 * 其余（启动器、别家前缀、大小写不符、非字符串、任何异常）一律返回 undefined。
 */
export function parseSessionIdFromTabId(tabId: unknown): string | undefined {
  try {
    if (typeof tabId !== "string" || !tabId.startsWith(SESSION_TAB_PREFIX)) return undefined;
    const sessionId = tabId.slice(SESSION_TAB_PREFIX.length);
    return sessionId === "" ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

/** 会话标签 meta 里的认证快照：方式与路径，密钥内容永远走宿主凭据库。 */
export interface ProfileAuthSnapshot {
  kind?: string;
  identityPath?: string;
}

/** 会话标签 meta 里的档案快照：**白名单字段，永不含凭据**（复制会话只靠它重连）。 */
export interface ProfileSnapshot {
  host?: string;
  port?: number;
  user?: string;
  name?: string;
  id?: string;
  kind?: string;
  remember?: boolean;
  auth?: ProfileAuthSnapshot;
  /**
   * 跳板链（"user@host:port" 列表）：**不是凭据**，是连接路径。
   * 存档 profiles.json 里本来就明文存着它（store/profile-store.ts 的 proxyJump），
   * 所以放行它不违反「凭据永不进快照」这条防线；
   * password / privateKey / passphrase 仍然一律丢弃。
   */
  proxyJump?: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 跳板链的严格校验：必须是数组，每项都是字符串，去空白后非空。
 *
 * 与存档层同一套规矩（store/profile-store.ts 的 optionalProxyJump）：
 * 一项不合法就**整条丢弃**——半条链比没有链更难排查（用户以为自己在走跳板，
 * 实际那条链并不是他配的那条）。空数组等于没有跳板链，不进快照。
 */
function proxyJumpOf(record: Record<string, unknown>): string[] | undefined {
  const raw = record["proxyJump"];
  if (!Array.isArray(raw)) return undefined;
  const hops: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    const hop = item.trim();
    if (hop === "") return undefined;
    hops.push(hop);
  }
  return hops.length === 0 ? undefined : hops;
}

/**
 * 档案 → 可进标签 meta / 模块级 Map 的快照：逐字段白名单拷贝。
 * 这是「快照里没有凭据」的**唯一保证点**——password / privateKey / passphrase
 * 无论调用方塞什么都进不来，嵌套的 auth 也一样。
 *
 * proxyJump（跳板链）在白名单里，但它**不是凭据**：它是连接路径，
 * 存档 profiles.json 里本来就明文存着它（store/profile-store.ts 的 optionalProxyJump），
 * 放行它不破坏上面那道防线；缺省或非法一律当「没有跳板链」，绝不报错。
 */
export function sanitizeProfileSnapshot(raw: unknown): ProfileSnapshot | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const snapshot: ProfileSnapshot = {};
  const host = asString(record["host"]);
  if (host !== undefined) snapshot.host = host;
  const port = record["port"];
  if (typeof port === "number" && Number.isFinite(port)) snapshot.port = port;
  const user = asString(record["user"]);
  if (user !== undefined) snapshot.user = user;
  const name = asString(record["name"]);
  if (name !== undefined) snapshot.name = name;
  const id = asString(record["id"]);
  if (id !== undefined) snapshot.id = id;
  const kind = asString(record["kind"]);
  if (kind !== undefined) snapshot.kind = kind;
  const remember = record["remember"];
  if (typeof remember === "boolean") snapshot.remember = remember;
  const auth = record["auth"];
  if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
    const authRecord = auth as Record<string, unknown>;
    const authSnapshot: ProfileAuthSnapshot = {};
    const authKind = asString(authRecord["kind"]);
    if (authKind !== undefined) authSnapshot.kind = authKind;
    const identityPath = asString(authRecord["identityPath"]);
    if (identityPath !== undefined) authSnapshot.identityPath = identityPath;
    snapshot.auth = authSnapshot;
  }
  const proxyJump = proxyJumpOf(record);
  if (proxyJump !== undefined) snapshot.proxyJump = proxyJump;
  return snapshot;
}

/** 开标签时带上的 meta：只有白名单快照，没有凭据。 */
export function buildSessionTabMeta(profile: unknown): { profile: ProfileSnapshot } {
  return { profile: sanitizeProfileSnapshot(profile) ?? {} };
}

/**
 * meta → 快照。宿主往返过的 meta、手写的旧 meta 都不可信，
 * 因此解析侧再走一遍白名单；结构不对就返回 undefined，调用方退回模块级 Map。
 */
export function parseSessionTabMeta(meta: unknown): ProfileSnapshot | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return sanitizeProfileSnapshot((meta as Record<string, unknown>)["profile"]);
}

/** 侧边栏里的一个标签（只声明本插件用到的字段）。 */
export interface SidebarTabLike {
  id: string;
  type: string;
  title?: string;
  path?: string;
  meta?: unknown;
}

/** 宿主传给标签组件的 props（只声明本插件用到的字段；都缺省时就当启动器降级）。 */
export interface TabComponentProps {
  ctx?: Record<string, unknown> | undefined;
  tab?: SidebarTabLike | undefined;
  visible?: boolean | undefined;
}

/**
 * 开一个标签用的种子。**id 是核心字段**：宿主合成标签时 seed.id 优先于自己 mint 的 id，
 * 所以会话身份靠它往返，而不是靠 path 载荷（M9-1 的教训）。
 */
export interface OpenTabSeed {
  id?: string;
  type: string;
  title?: string;
  path?: string;
  url?: string;
  meta?: unknown;
}

export interface TabDescriptor {
  id: string;
  title: () => string;
  component: unknown;
  /**
   * 标签图标。宿主契约为 ReactNode | ((size: number) => ReactNode)；
   * 不传时宿主画自己的默认方块 —— "能不能改"的答案是能，只是我们一直没传。
   */
  icon?: (size: number) => unknown;
  /** 新标签列表里标题下方的一行说明。 */
  description?: string;
}

export interface RegistrationResult {
  ok: boolean;
  target: RightPaneTarget;
  error?: string;
}

/**
 * cordis 对**未在 inject 中声明**的服务，读取属性会直接抛错
 * （cannot get property "x" without inject）。因此探测必须容错：读不到即视为不存在，
 * 真正的"等待服务出现"交给 ctx.inject 完成。
 */
function safeGet(ctx: Record<string, unknown>, key: string): unknown {
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

/** 宿主右栏服务（betterSidebar）：openTab / closeTab 挂在它上面。读不到就是 undefined。 */
function betterSidebarService(ctx: unknown): Record<string, unknown> | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const service = safeGet(ctx as Record<string, unknown>, "betterSidebar");
  return typeof service === "object" && service !== null ? (service as Record<string, unknown>) : undefined;
}

/**
 * 宿主的 openTab：会话标签靠它开新标签。拿不到（官方注册表 / 旧宿主）返回 undefined，
 * 组件据此退回「在本标签里显示终端」的单标签降级——绝不假装开出过标签。
 */
export function resolveOpenTab(ctx: unknown): ((seed: OpenTabSeed) => void) | undefined {
  const service = betterSidebarService(ctx);
  const openTab = service === undefined ? undefined : service["openTab"];
  if (typeof openTab !== "function") return undefined;
  return (seed) => {
    try {
      (openTab as (input: OpenTabSeed) => void).call(service, seed);
    } catch (error) {
      console.warn("uniterminal: openTab failed:", error);
    }
  };
}

/** 宿主的 closeTab：会话标签断开后关掉自己，别退化成一个新的启动器。 */
export function resolveCloseTab(ctx: unknown): ((tabId: string) => void) | undefined {
  const service = betterSidebarService(ctx);
  const closeTab = service === undefined ? undefined : service["closeTab"];
  if (typeof closeTab !== "function") return undefined;
  return (tabId) => {
    try {
      (closeTab as (id: string) => void).call(service, tabId);
    } catch (error) {
      console.warn("uniterminal: closeTab failed:", error);
    }
  };
}

/** 探测宿主暴露的右栏注册表，betterSidebar 优先于官方注册表。 */
export function detectRightPane(ctx: Record<string, unknown>): RightPaneTarget {
  const better = safeGet(ctx, "betterSidebar") as { registerTab?: unknown } | undefined;
  if (typeof better?.registerTab === "function") return "betterSidebar";
  const official = (safeGet(ctx, "sidebarRightTabs") ?? safeGet(ctx, "sidebarRight")) as
    | { register?: unknown }
    | undefined;
  if (typeof official?.register === "function") return "sidebarRightTabs";
  return "none";
}

/** 向探测到的注册表登记一个 tab 类型；任何失败都降级为返回值，绝不抛错。 */
export function registerTab(ctx: Record<string, unknown>, tab: TabDescriptor): RegistrationResult {
  const target = detectRightPane(ctx);
  try {
    if (target === "betterSidebar") {
      const better = ctx["betterSidebar"] as { registerTab(input: unknown): void };
      better.registerTab({
      id: tab.id,
      title: tab.title,
      component: tab.component,
      // 图标与说明是可选项：传了就覆盖宿主的默认方块
      ...(tab.icon === undefined ? {} : { icon: tab.icon }),
      ...(tab.description === undefined ? {} : { description: tab.description }),
    });
      return { ok: true, target };
    }
    if (target === "sidebarRightTabs") {
      const official = (safeGet(ctx, "sidebarRightTabs") ?? safeGet(ctx, "sidebarRight")) as {
        register(input: unknown): void;
      };
      official.register({ id: tab.id, kind: "terminal", multiple: true, title: tab.title });
      return { ok: true, target };
    }
    return { ok: false, target, error: "no right-pane registry available" };
  } catch (error) {
    return { ok: false, target, error: String(error) };
  }
}
