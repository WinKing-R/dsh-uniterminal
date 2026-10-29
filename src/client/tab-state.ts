import {
  buildSessionTabMeta,
  sanitizeProfileSnapshot,
  sessionIdTabId,
  TAB_TYPE,
  type OpenTabSeed,
  type ProfileSnapshot,
} from "./right-pane.js";

/**
 * 本文件叠着三段历史，读之前先看这张地图（每段都写明了「为什么还留着」）：
 *
 *  - M4-1 单会话存档（本文件顶部）：**遗留**。生产代码已无调用方，被 M9-4 的
 *    「会话集存档」取代。留着是因为台账点名 + 有回归用例，见下方该段的说明。
 *  - M9-2 泄漏保险机器（本文件中段）：**故意保留的安全网**，当前方案下未接线。
 *    它是 M9-1 泄漏事故之后的安全网，见该段的说明。
 *  - M9-4 会话集（本文件下段）：**正在跑的那一套**，生产代码全在用。
 *
 * 判断「死代码」的规矩：查三处——生产调用方（src/client/**）、测试覆盖（test/**）、
 * 台账点名（docs/superpowers/plans/ledger-m0.md）。三处都没有才算真死代码；
 * 只要有一处就留着，并把理由写在原地（本文件里每个「生产没有调用方」的导出都带着这样的说明）。
 */

/**
 * 终端会话的模块级存档 + 跨刷新存档。
 *
 * 面板容器（dsh-better-sidebar）在 tab 不可见时会卸载 pane 内容，组件 state 随之丢失，
 * 重挂载后就掉回主机列表。把会话放在模块作用域，卸载只是断开 socket，重挂载时用同一份存档重连，
 * 宿主 bridge 会回放 ring buffer。
 *
 * 取舍：本插件的 tab 只当一个终端用，所以这是单实例存档；同一会话多客户端由宿主 bridge 支持，
 * 前端无需区分，也就不做 map 式的多会话存档。
 *
 * M4-1：模块内存在**刷新页面**时会连同 JS 上下文一起消失，而宿主侧会话还活着——那份会话就变成
 * 界面看不到、也接不回的孤儿。因此写入同时落一份到可注入的存储后端（默认 sessionStorage），
 * 刷新后挂载先读模块存档、读不到再读持久化存档。
 *
 * 【状态：遗留，但保留】M9-4 的「会话集存档」已经取代了这套单会话存档，
 * 生产代码（src/client/**）不再调用 read/write/clearTerminalTabState。保留的两条理由：
 *  1. 台账点名：ledger-m0.md:596（M1-15b 验收）逐个记着这三个函数，ledger-m0.md:894 记着
 *     固定键「uniterminal.terminal-tab-state」。删掉等于改台账的历史记录。
 *  2. 回归锁：test/client/tab-state.test.ts 的 11 条用例锁着它们的语义——写入即复制
 *     （调用方改自己的对象不影响存档）、清理即清内存 + 清键、存储后端抛错也绝不丢内存态。
 * 所以这段是「有据的遗留」，不是没人管的死代码；要动它，先改台账。
 */
export interface TerminalTabState {
  sessionId: string;
  wsUrl: string;
}

/** 存储后端只要这三个方法：sessionStorage / localStorage 天然满足，测试注入内存实现。 */
export interface TabStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 键名固定：换一个名字等于丢掉所有已存档的会话。【遗留】属 M4-1 单会话存档，见文件头说明。 */
export const TERMINAL_TAB_STATE_KEY = "uniterminal.terminal-tab-state";

let current: TerminalTabState | undefined;

/** 注入的后端；settled 为真表示调用方已明确表态（含「不要持久化」），不再回落到 sessionStorage。 */
let injected: TabStateStorage | undefined;
let settled = false;

/** 默认后端：拿不到（Node 测试环境、被策略禁用）就是「没有持久化」，不影响模块存档。 */
function defaultStorage(): TabStateStorage | undefined {
  try {
    const candidate = (globalThis as { sessionStorage?: TabStateStorage }).sessionStorage;
    if (candidate === undefined) return undefined;
    // 取一次属性再比对：形状不对就当没有，绝不半用
    return typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function" &&
      typeof candidate.removeItem === "function"
      ? candidate
      : undefined;
  } catch {
    // 某些环境访问 sessionStorage 本身就会抛（沙箱 iframe、隐私模式）
    return undefined;
  }
}

function activeStorage(): TabStateStorage | undefined {
  return settled ? injected : defaultStorage();
}

/**
 * 注入存储后端（测试注入内存实现；传 undefined 表示这次运行不要持久化）。
 * 持久化只是附加能力：后端坏了由各调用点吞掉异常，绝不打断挂载。
 *
 * 【状态】生产没有调用方——注入点只服务测试（test/client/tab-state.test.ts、
 * test/client/session-set.test.ts）。两套存档（单会话 + 会话集）共用它，
 * 删掉测试就没有办法注入内存后端，因此保留。
 */
export function setTabStateStorage(storage: TabStateStorage | undefined): void {
  injected = storage;
  settled = true;
}

/* --- M4-1 单会话存档的读写口（遗留）：这一组导出在生产代码（src/client/**）里都没有调用方了。 ---
 * M9-4 之后会话由「会话集」管。保留理由见上方 TerminalTabState 的说明：
 * 台账 ledger-m0.md:596 / :894 点名 + test/client/tab-state.test.ts 的 11 条回归用例。
 * 要动请先改台账。 */
export function readTerminalTabState(): TerminalTabState | undefined {
  return current;
}

/** 字段类型不符、缺字段、不是对象——一律视为无存档。 */
function parseState(raw: string | null | undefined): TerminalTabState | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const { sessionId, wsUrl } = record;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (typeof wsUrl !== "string" || wsUrl === "") return undefined;
  return { sessionId, wsUrl };
}

/** 刷新后的恢复入口：读不到、解析失败、字段类型不符都返回 undefined，绝不抛错。 */
export function readPersistedTerminalTabState(): TerminalTabState | undefined {
  const storage = activeStorage();
  if (storage === undefined) return undefined;
  try {
    return parseState(storage.getItem(TERMINAL_TAB_STATE_KEY));
  } catch {
    return undefined;
  }
}

export function writeTerminalTabState(state: TerminalTabState): void {
  // 复制一份：调用方后续改动自己那个对象不应影响存档
  const copy = { sessionId: state.sessionId, wsUrl: state.wsUrl };
  current = copy;
  const storage = activeStorage();
  if (storage === undefined) return;
  try {
    storage.setItem(TERMINAL_TAB_STATE_KEY, JSON.stringify(copy));
  } catch {
    // 配额满 / 被禁用：模块存档已经写好了，刷新恢复降级为不可用
  }
}

export function clearTerminalTabState(): void {
  current = undefined;
  const storage = activeStorage();
  if (storage === undefined) return;
  try {
    storage.removeItem(TERMINAL_TAB_STATE_KEY);
  } catch {
    // 后端拒绝删除：内存已经清空，界面不会停在旧会话上
  }
}

/* ------------------------------------------------------------------------------------------------
 * M9-2：一条会话一个标签，标签 id 就是会话身份。下面三样东西必须活过组件的挂载与卸载
 * （面板容器会随时把 pane 卸掉再挂回来），所以和上面的存档一样住在模块作用域里。
 *
 * ⚠ 这一整段是**故意保留的安全网**，不要当死代码删掉。
 *
 * 来历（台账 ledger-m0.md:1612「M9-1 事故与回滚」）：上一版「每会话一个侧栏标签」上线后，
 * 宿主没把载荷送进新标签，用户以为没连上就反复点——created=171 / closed=67
 * （ledger-m0.md:1620），泄漏了 171 条真实的远端 shell（ledger-m0.md:1623）。方案整体回滚，
 * 于是留下这台保险：连接成功后 5 秒内没人认领这条会话，就主动关掉它并提示，
 * 让「标签没打开」的最坏结果变成「少一条连接」，而不是「一堆谁也算不清的残留」
 * （ledger-m0.md:1639、:1665）。
 *
 * 现在为什么没人调用：M9-4 改成「一个标签里自绘会话栏」，连接流程不再开侧边栏标签
 * （ledger-m0.md:1699 验收：openSessionTab|openClaimedSessionTab( 在组件里 0 次），
 * 所以「开标签」这一侧整段未接线。
 *
 * 为什么仍然保留：
 *  - 认领这一侧还在用：claimSessionTab / forgetSessionTab / readProfileSnapshot 仍被组件调用
 *    （UniterminalTab.tsx 的 claimSessionTab(legacySessionId) / forgetSessionTab(id) /
 *    readProfileSnapshot(legacySessionId)）——遗留标签要接回，会话也要从本页的持有表里摘掉。
 *  - 开标签这一侧是**现成的保险**：将来若恢复「每会话一个标签」方案，宽限期、待认领表、
 *    档案快照白名单都是直接可用的，不必重写。
 *  - test/client/session-claim.test.ts（16 条用例）与 test/client/tab-identity.test.ts:32-41
 *    明确锁着「这套机器只住在 tab-state、组件不再接线」这个约定。
 * → 除非能证明它有害，否则不许删。
 * ---------------------------------------------------------------------------------------------- */

/** 泄漏保险的宽限期：新标签在这段时间内没认领会话，就当它根本没打开。 */
export const SESSION_CLAIM_GRACE_MS = 5000;

interface PendingClaim {
  claimed: boolean;
  cancel?: () => void;
}

/** 已开标签、尚未被认领的会话。 */
const pendingClaims = new Map<string, PendingClaim>();
/** 本页标签真正持有的会话（含刚开出来、还在待认领窗口里的）。 */
const ownedSessions = new Set<string>();
/** 会话 → 不含凭据的档案快照：meta 丢了时的后备（刷新后失效，可接受）。 */
const profileSnapshots = new Map<string, ProfileSnapshot>();

function defaultSchedule(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
}

/** 开一条会话标签要带的东西：会话 id、标题、以及不含凭据的档案快照。 */
export interface SessionTabRequest {
  sessionId: string;
  title: string;
  profile: ProfileSnapshot;
}

/** 开标签所需的外部能力：全部可注入，测试因此不必真等 5 秒、也不必真发请求。 */
export interface ClaimGuardDeps {
  openTab: (seed: OpenTabSeed) => void;
  closeSession: (sessionId: string) => void | Promise<void>;
  /** 返回 true = 这条会话已被调用方接回（例如本标签自己带终端），此时**不要**关闭它。 */
  onLeak?: (sessionId: string) => boolean | void;
  schedule?: (run: () => void, ms: number) => () => void;
  graceMs?: number;
}

function runClose(closeSession: (sessionId: string) => void | Promise<void>, sessionId: string): void {
  try {
    const result: unknown = closeSession(sessionId);
    if (typeof (result as Promise<void> | undefined)?.catch === "function") {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // 关闭失败也不该把异常抛回界面：宿主自己会记账
  }
}

/**
 * 开一条会话标签，并挂上 5 秒泄漏保险（M9-2）。
 * 顺序是刻意的：先登记待认领（宿主若在同一次渲染里就挂起组件，认领也能找到记录），
 * 再 openTab，最后起定时器。宽限期内没有标签认领这条会话 → 主动关掉它并提示，
 * 于是「标签没打开」最坏的结果是少一条连接，而不是一条谁也算不清的残留。
 * 返回 false = 标签没开出来（宿主没有 openTab 或它抛错），调用方退回单标签并自己接住会话。
 */
export function openClaimedSessionTab(request: SessionTabRequest, deps: ClaimGuardDeps): boolean {
  const sessionId = request.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  // 同一条会话已经有待认领记录：先撤掉旧记录，免得两个定时器抢着关同一条会话
  const previous = pendingClaims.get(sessionId);
  if (previous !== undefined) {
    previous.cancel?.();
    pendingClaims.delete(sessionId);
  }
  const record: PendingClaim = { claimed: false };
  pendingClaims.set(sessionId, record);
  try {
    deps.openTab({
      // 显式 id：宿主合成标签时 seed.id 优先，会话身份就靠它往返（M9-1 的教训）
      id: sessionIdTabId(sessionId),
      type: TAB_TYPE,
      title: request.title,
      meta: buildSessionTabMeta(request.profile),
    });
  } catch {
    pendingClaims.delete(sessionId);
    return false;
  }
  // 新标签可能已经同步挂载并认领：这条会话已经有人接，不需要保险
  if (record.claimed || pendingClaims.get(sessionId) !== record) return true;
  const schedule = deps.schedule ?? defaultSchedule;
  const graceMs = deps.graceMs ?? SESSION_CLAIM_GRACE_MS;
  record.cancel = schedule(() => {
    // 记录已被撤掉或替换：这条定时器过期了，不许它去关别人的会话
    if (pendingClaims.get(sessionId) !== record) return;
    pendingClaims.delete(sessionId);
    // 宿主没开新标签（实测本机原生右栏忽略 seed.id，只给一个 tabNN）：
    // 先让调用方把会话接回本标签，接不回来才关闭——既保住可用性，又不留残留。
    const adopted = deps.onLeak?.(sessionId) === true;
    if (!adopted) runClose(deps.closeSession, sessionId);
  }, graceMs);
  return true;
}

/**
 * 会话标签挂载时认领自己的会话；返回 true = 认领到了启动器开出的那条待认领记录。
 * 认领不到的旧会话标签（刷新后重新挂载）同样算「本页有人在用」。
 */
export function claimSessionTab(sessionId: string): boolean {
  if (typeof sessionId !== "string" || sessionId === "") return false;
  ownedSessions.add(sessionId);
  const record = pendingClaims.get(sessionId);
  if (record === undefined) return false;
  pendingClaims.delete(sessionId);
  record.claimed = true;
  record.cancel?.();
  return true;
}

/** 会话标签断开：这条会话不再由本页任何标签持有，快照也一并丢掉。 */
export function forgetSessionTab(sessionId: string): void {
  ownedSessions.delete(sessionId);
  profileSnapshots.delete(sessionId);
  const record = pendingClaims.get(sessionId);
  if (record !== undefined) {
    record.cancel?.();
    pendingClaims.delete(sessionId);
  }
}

/**
 * 本页标签正在用的会话 id（含刚开出、还在待认领窗口里的）：
 * 启动器的孤儿列表据此剔除它们——否则一条活会话会被摆成一行「可以关掉」的孤儿，
 * 用户一点就会把别的标签正在用的终端关掉。
 *
 * 【状态】生产没有调用方：M9-4 之后启动器的孤儿列表改用会话集自己的 entries
 * （UniterminalTab.tsx 里那行 new Set(sessions.entries.map((entry) => entry.id))）。
 * 它与 openClaimedSessionTab 同属 M9-2 那台保险，
 * 要删就得一起删——单独删掉只会让保险剩下半边。
 */
export function ownedSessionIds(): ReadonlySet<string> {
  const ids = new Set(ownedSessions);
  for (const sessionId of pendingClaims.keys()) ids.add(sessionId);
  return ids;
}

/**
 * 记下会话的档案快照（写入侧同样过白名单：调用方塞凭据也进不来）。
 *
 * 【状态】写侧生产没有调用方；读侧 readProfileSnapshot 仍在用（UniterminalTab.tsx 的
 * readProfileSnapshot(legacySessionId)，遗留标签接回时取快照）。读写成对留着，也属 M9-2 那台保险。
 */
export function rememberProfileSnapshot(sessionId: string, profile: unknown): void {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const snapshot = sanitizeProfileSnapshot(profile);
  if (snapshot === undefined) return;
  profileSnapshots.set(sessionId, snapshot);
}

/**
 * 取会话的档案快照。
 *
 * 【状态】生产有调用方：UniterminalTab.tsx 的 readProfileSnapshot(legacySessionId)
 * —— 遗留标签接回时用它补档案。
 */
export function readProfileSnapshot(sessionId: string): ProfileSnapshot | undefined {
  return profileSnapshots.get(sessionId);
}

/**
 * 测试用：清空全部模块级状态（生产路径不需要，标签自己会 forget）。
 *
 * 【状态】生产没有调用方；session-claim.test.ts 用它做每个用例之间的隔离。
 * 属 M9-2 那台保险的一部分，保留。
 */
export function resetSessionTabs(): void {
  for (const record of pendingClaims.values()) record.cancel?.();
  pendingClaims.clear();
  ownedSessions.clear();
  profileSnapshots.clear();
}

/* ------------------------------------------------------------------------------------------------
 * M9-4：一个标签里装多条会话。
 *
 * 本机原生右栏只给插件一个不透明标签（探针实测 id:"tab63"，path/meta 全丢，第二个实例根本不创建），
 * 所以「一个会话一个侧边栏标签」不可实现。改成 MobaXterm 的做法：标签内部自己画一条会话栏，
 * 一个标签里同时开多条会话。这里只放**纯数据**：会话集是一个不可变的 { entries, activeId }，
 * 组件负责把它画出来；存档与恢复也走这里，绝不碰 React。
 * ---------------------------------------------------------------------------------------------- */

/** 会话栏里的一条会话。wsUrl 缺省 = 还没拿到回环地址（刷新后等宿主回报）；ended = 宿主上已经没有了。 */
export interface SessionEntry {
  id: string;
  wsUrl?: string;
  title: string;
  /** 不含凭据的档案快照：「复制会话」靠它重连，口令永远由宿主凭据库提供。 */
  profile?: ProfileSnapshot;
  /** 宿主上已经没有这条会话：条目保留在会话栏上（用户要能手动关掉），但不再挂终端。 */
  ended?: boolean;
}

/** 一个标签里的全部会话。activeId 缺省 = 没有会话（只剩启动器）。 */
export interface SessionSet {
  entries: SessionEntry[];
  activeId?: string;
}

/**
 * 会话标题去重：同一台主机开两次会得到两个同名标签（用户与模型都无法区分"哪个窗口"）。
 * 第二个起追加 " #2"、" #3"，与宿主侧 uniterminal_list_sessions 的编号规则一致（按打开顺序）。
 *
 * 【与 UniterminalTab.tsx 的 snapshotTitle 是两条并行的标题生成路径——本轮不合并，合并留给下一轮】
 *  - snapshotTitle(snapshot, fallback)：输入「档案快照 + 兜底文案」，
 *    输出「主机配置名 → user@host:port → 兜底文案」，只管**叫什么**，不去重；
 *    兜底文案由调用方给（"SSH 会话" / connectTargetText(...)）。
 *  - uniqueSessionTitle(existing, desired)：输入「已有标题列表 + 想要的标题」，
 *    输出「去重后的标题」，负责加 " #2" 编号，兜底文案写死在函数里（"SSH 会话"），
 *    它不看档案快照。
 *  - 差异，以及合并前要先定的两件事：前者懂档案（能取 name）、后者懂重名（能编号）；
 *    组件当前是两步串起来用（UniterminalTab.tsx 的两处 addSession：复制会话 / 新建连接）。
 *    合并时要定：
 *    ① 兜底文案归谁；② 加编号时**同一条会话**的旧标题算不算占用（现在算——
 *    同 id 的条目改名后可能变成 "x #2"）。
 */
export function uniqueSessionTitle(existing: readonly string[], desired: string): string {
  const base = desired.trim() === "" ? "SSH 会话" : desired.trim();
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(base + " #" + String(index))) index += 1;
  return base + " #" + String(index);
}

/**
 * 新增一条会话并置为 active；同 id 已存在则**就地替换**（保持会话栏顺序）并置为 active。
 * 没有 id 的条目直接忽略：会话身份就是会话栏的 key，凭空造一个只会产生认不回来的条目。
 */
export function addSession(set: SessionSet, entry: SessionEntry): SessionSet {
  if (typeof entry.id !== "string" || entry.id === "") return set;
  const index = set.entries.findIndex((item) => item.id === entry.id);
  if (index === -1) return { entries: [...set.entries, entry], activeId: entry.id };
  const entries = [...set.entries];
  entries[index] = entry;
  return { entries, activeId: entry.id };
}

/**
 * 移除一条会话。移除的正是 active 时，active 落到**相邻项**：优先前一个（用户视线留在原地），
 * 没有前一个就接上后一个；一条都不剩则 activeId 为 undefined。未知 id 原样返回。
 */
export function removeSession(set: SessionSet, id: string): SessionSet {
  const index = set.entries.findIndex((item) => item.id === id);
  if (index === -1) return set;
  const entries = set.entries.filter((item) => item.id !== id);
  if (set.activeId !== id) return { entries, activeId: set.activeId };
  if (entries.length === 0) return { entries };
  const neighbour = entries[index - 1] ?? entries[index];
  return neighbour === undefined ? { entries } : { entries, activeId: neighbour.id };
}

/** 切到某条会话。未知 id 与「已经在这条上」都原样返回，React 因此可以直接跳过重渲染。 */
export function activateSession(set: SessionSet, id: string): SessionSet {
  if (set.activeId === id) return set;
  if (!set.entries.some((item) => item.id === id)) return set;
  return { entries: set.entries, activeId: id };
}

/** 保留条目、只标记 ended（宿主重启或被别处关掉）。active 不动：用户要看见这条会话已结束。 */
export function markSessionEnded(set: SessionSet, id: string): SessionSet {
  const index = set.entries.findIndex((item) => item.id === id);
  if (index === -1) return set;
  const found = set.entries[index];
  if (found === undefined || found.ended === true) return set;
  const entries = [...set.entries];
  entries[index] = { ...found, ended: true };
  return { entries, activeId: set.activeId };
}

/**
 * 把宿主报告的存活会话接回会话集（刷新 / 面板重挂载后的恢复路径）。
 * - 已经拿到地址的条目一个字都不改（它连着就是连着）；
 * - 缺地址的：宿主还列着就补上回环地址，宿主里没有就标记 ended；
 * - 已 ended 的不复活——复活与否是用户的决定（关掉重连），不是宿主的。
 * 什么也没变就返回同一个对象，界面因此不会白重渲染一次。
 */
export function adoptHostSessions(set: SessionSet, alive: ReadonlyMap<string, string>): SessionSet {
  let next = set;
  for (const entry of set.entries) {
    if (entry.ended === true || entry.wsUrl !== undefined) continue;
    const wsUrl = alive.get(entry.id);
    next = wsUrl === undefined ? markSessionEnded(next, entry.id) : attachSessionUrl(next, entry.id, wsUrl);
  }
  return next;
}

/** 给一条会话补上回环地址，并撤掉 ended（宿主确实还活着）。未知 id 或地址没变都原样返回。 */
export function attachSessionUrl(set: SessionSet, id: string, wsUrl: string): SessionSet {
  const index = set.entries.findIndex((item) => item.id === id);
  if (index === -1) return set;
  const found = set.entries[index];
  if (found === undefined) return set;
  if (found.wsUrl === wsUrl && found.ended !== true) return set;
  const next: SessionEntry = { ...found, wsUrl };
  delete next.ended;
  const entries = [...set.entries];
  entries[index] = next;
  return { entries, activeId: set.activeId };
}

/**
 * 会话集 → 存档字符串。档案逐条过白名单（sanitizeProfileSnapshot）：
 * password / privateKey / passphrase 无论在状态里被塞了什么，都进不了存档。
 */
export function serializeSessionSet(set: SessionSet): string {
  const entries: Record<string, unknown>[] = [];
  for (const entry of set.entries) {
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const record: Record<string, unknown> = {
      id: entry.id,
      title: typeof entry.title === "string" && entry.title !== "" ? entry.title : entry.id,
    };
    if (typeof entry.wsUrl === "string" && entry.wsUrl !== "") record["wsUrl"] = entry.wsUrl;
    if (entry.ended === true) record["ended"] = true;
    const profile = sanitizeProfileSnapshot(entry.profile);
    if (profile !== undefined) record["profile"] = profile;
    entries.push(record);
  }
  const activeId = set.activeId;
  const settled = typeof activeId === "string" && entries.some((item) => item["id"] === activeId) ? activeId : undefined;
  return JSON.stringify(settled === undefined ? { entries } : { entries, activeId: settled });
}

/**
 * 存档字符串 → 会话集。宿主往返过、旧版本遗留、被手改过的档案都不可信，
 * 因此解析侧再走一遍白名单；结构不对返回 undefined（调用方当没有存档），绝不抛错。
 * activeId 缺失或指向不存在的条目时落到第一条：恢复后总得有会话在看。
 */
export function parseSessionSet(raw: string | null | undefined): SessionSet | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const list = record["entries"];
  if (!Array.isArray(list)) return undefined;
  const entries: SessionEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const shape = item as Record<string, unknown>;
    const id = shape["id"];
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    const rawTitle = shape["title"];
    const entry: SessionEntry = {
      id,
      title: typeof rawTitle === "string" && rawTitle !== "" ? rawTitle : id,
    };
    const wsUrl = shape["wsUrl"];
    if (typeof wsUrl === "string" && wsUrl !== "") entry.wsUrl = wsUrl;
    if (shape["ended"] === true) entry.ended = true;
    const profile = sanitizeProfileSnapshot(shape["profile"]);
    if (profile !== undefined) entry.profile = profile;
    seen.add(id);
    entries.push(entry);
  }
  const first = entries[0];
  if (first === undefined) return { entries };
  const rawActive = record["activeId"];
  const activeId = typeof rawActive === "string" && seen.has(rawActive) ? rawActive : first.id;
  return { entries, activeId };
}

/** 存档键前缀；键名里带标签 id，会话栏是每个标签自己的。拿不到 id 时落到共用桶。 */
export const SESSION_SET_KEY_PREFIX = "uniterminal.session-set";

/** 「最后一次」全局存档键：tab.id 不稳定时的兜底（不参与按标签隔离）。 */
const LAST_SESSION_SET_KEY = "uniterminal.session-set:last";

/** 存档键：拿不到标签 id（props.tab 缺失）时落到一个共用桶里，至少本页刷新还接得回来。 */
export function sessionSetStorageKey(tabId: string): string {
  const scope = typeof tabId === "string" && tabId !== "" ? tabId : "unscoped";
  return SESSION_SET_KEY_PREFIX + ":" + scope;
}

/**
 * 读会话集存档：没有后端、解析失败、字段不符都返回 undefined，绝不抛错。
 * 除了按 tabId 的键，还会回退到「最后一次」全局键：宿主给我们的 tab.id 是不透明的（实测 tab63），
 * 若它在刷新后重新生成，按 tabId 的键就对不上了——全局键让「刷新即丢失所有会话」不至于发生。
 */
export function readPersistedSessionSet(tabId: string): SessionSet | undefined {
  const storage = activeStorage();
  if (storage === undefined) return undefined;
  try {
    const scoped = parseSessionSet(storage.getItem(sessionSetStorageKey(tabId)));
    if (scoped !== undefined) return scoped;
    return parseSessionSet(storage.getItem(LAST_SESSION_SET_KEY));
  } catch {
    return undefined;
  }
}

/**
 * 写会话集存档：按 tabId 的键 + 一个全局「最后一次」键（见 readPersistedSessionSet 的说明）。
 * 会话栏空了就把键删掉，别在存储里留一个空壳。
 */
export function writePersistedSessionSet(tabId: string, set: SessionSet): void {
  const storage = activeStorage();
  if (storage === undefined) return;
  const key = sessionSetStorageKey(tabId);
  try {
    if (set.entries.length === 0) {
      storage.removeItem(key);
      storage.removeItem(LAST_SESSION_SET_KEY);
      return;
    }
    const payload = serializeSessionSet(set);
    storage.setItem(key, payload);
    storage.setItem(LAST_SESSION_SET_KEY, payload);
  } catch {
    // 配额满 / 被禁用：刷新恢复降级为不可用，界面照常
  }
}

/**
 * 显式清掉会话集存档（用户清空会话栏时不必等写入路径判断）。
 *
 * 【状态】生产没有调用方：清空会话栏走的是 writePersistedSessionSet 的空集合分支
 * （它同样会删掉全局兜底键）。保留是因为有回归用例锁着「显式清理」这个出口的语义
 * （test/client/session-set.test.ts），删掉就没有显式清理了。
 */
export function clearPersistedSessionSet(tabId: string): void {
  const storage = activeStorage();
  if (storage === undefined) return;
  try {
    storage.removeItem(sessionSetStorageKey(tabId));
    // 全局兜底键也要清，否则「清空会话栏」之后刷新又会被它接回来
    storage.removeItem(LAST_SESSION_SET_KEY);
  } catch {
    // 后端拒绝删除：界面已经清了，存档留着也不影响本页
  }
}

