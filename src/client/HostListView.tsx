import { useEffect, useRef, useState } from "react";
import { hasKeyAuth } from "./auth-selection.js";
import { NAME_MAX } from "../name-limits.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { ContextMenu } from "./context-menu.js";
import { menuAnchor, type MenuAnchor } from "./menu-anchor.js";
import { filterHosts } from "./host-filter.js";
import { SelectField } from "./select-field.js";
import { KeyIcon, SearchIcon, ShieldCheckIcon } from "./host-icons.js";
import { useNotice, noticeClassName, noticeLiveProps } from "./notice.js";
import {
  buildGroupTree,
  findGroupByPath,
  flattenGroupTree,
  groupPathOf,
  type ClientGroup,
  type GroupNode,
} from "./group-tree.js";
import { api, errorText, type ApiError } from "./api.js";
import { reportClient } from "./report.js";
import { ensureUniterminalCss } from "./inject-css.js";
import {
  COLOR_DANGER,
  COLOR_SUCCESS,
  GROUP_COLOR_FALLBACK,
  KEY_ICON_COLOR,
} from "./tokens.js";

/** profiles.json 的 auth 块：只有方式与路径，永远不含私钥内容。 */
export interface HostProfileAuth {
  kind?: string;
  identityPath?: string;
}

/** 与 ProfileStore.list() 的 JSON 形态一致（只读，不含任何凭据字段）。 */
export interface HostProfile {
  id: string;
  name: string;
  kind: string;
  /** M10-A：主机只带分组 id，路径由分组表自己拼。 */
  groupId: string | null;
  host?: string;
  port?: number;
  user?: string;
  /** M2b：kind === 'key' 表示这台主机用私钥登录。 */
  auth?: HostProfileAuth;
  /** D10 记住密码标记：编辑保存时要随存档一起回写，否则会被整条替换悄悄清掉。 */
  remember?: boolean;
  /** M3-10 跳板链：按顺序经过这些跳板机，每项 user@host:port；不出现即直连。 */
  proxyJump?: string[];
}

export interface HostListViewProps {
  onSelect: (profile: HostProfile, remembered: boolean) => void;
  onManualConnect: () => void;
  /** 父组件在回到列表时自增，触发重新拉取。 */
  refreshKey?: number;
}

interface ProfilesResponse {
  profiles?: HostProfile[];
  groups?: ClientGroup[];
  error?: string;
}

/** POST /profiles/import 的预览响应（dryRun: true）：只报数量，不写盘。 */
interface ImportPreviewResponse {
  preview?: boolean;
  found?: number;
  skipped?: { alias?: string; reason?: string }[];
  path?: string;
  missing?: boolean;
  error?: string;
}

interface ImportResponse {
  imported?: number;
  skipped?: { alias?: string; reason?: string }[];
  directives?: string[];
  error?: string;
}

/** 与 POST /folders、POST /folders/delete、POST /folders/rename 的响应同形。 */
interface FolderResponse {
  path?: string[];
  removed?: boolean;
  /** rename 的改动条数：M10-A 起是分组的 0|1，不再是主机台数。 */
  renamed?: number;
  /** POST /folders 的 201 带回新建（或已存在）的那一组。 */
  group?: { id?: string };
  error?: string;
}

/**
 * ensureGroupId 抛的错带这个标记：调用点据此决定用哪个动作词拼前缀，
 * 免得同一个动作出现两次（"移动分组失败"里又套一个"新建分组失败"）。
 */
class GroupCreateError extends Error {}

/** POST /profiles/test 的响应：成功 { ok:true, ms }，失败 { ok:false, error, ms }。 */
interface TestConnectionResponse {
  ok?: boolean;
  ms?: number;
  error?: string;
}

/**
 * 测试连接的失败文案。
 *
 * 宿主对「连不通」有两种回法：非 2xx（HTTP 错误）与 200 + { ok:false }（业务失败，例如认证没过）。
 * api.ts 把后者也算作失败，所以这里按状态码把两种情况分开，文案与旧写法逐字一致：
 * - 非 2xx：后端原文；后端没给原文时是「HTTP <status>」。
 * - 200 + { ok:false }：后端原文；后端没给原文时是「未知错误」（不是「HTTP 200」——那对用户没有意义）。
 */
function testFailureText(error: ApiError): string {
  if (error.status !== 200) return error.message;
  const body = error.payload;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "未知错误";
  const detail = (body as { error?: unknown }).error;
  if (detail === undefined || detail === null) return "未知错误";
  return String(detail);
}

/** GET /security/refs 的响应形态：只有 ref 名字（profile:<id>），永远不含密钥。 */
interface RefsResponse {
  refs?: string[];
  error?: string;
}

/** 与 routes.ts 的 CREDENTIAL_PREFIX 一致：ref 名字的前缀剥掉就是主机 id。 */
const CREDENTIAL_REF_PREFIX = "profile:";
/** 跳板标记：来源是 profiles.json 的 proxyJump。 */
const PROXY_JUMP_LABEL = "跳板";

/**
 * M6-5 折叠状态：**按分组 id** 存（M10-B 之前存的是路径），读不出就退回「全部展开」。
 * 键名不动：旧存档里的折叠状态必须继续读得到。
 */
const COLLAPSED_GROUPS_KEY = "uniterminal.collapsed-groups";
/** 与宿主 AppearanceStore 同一条规则：只认 #rgb 与 #rrggbb。 */
const GROUP_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 折叠记忆的读取：坏 JSON、形状不对、存储本身不可用（沙箱 iframe、隐私模式）都返回空表，
 * 也就是「全部展开」，并且绝不抛错——丢一次折叠记忆只是难看，不该让列表打不开。
 * M10-B 之前存的是分组路径字符串：旧内容一个 id 都匹配不上，于是自然退化成「全部展开」。
 */
function readCollapsedGroups(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(COLLAPSED_GROUPS_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsedGroups(keys: string[]): void {
  try {
    globalThis.sessionStorage?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(keys));
  } catch {
    // 存不下只是丢一次折叠记忆：列表照常工作
  }
}

/** 本地即时生效用：清除颜色（null）就是把 color 去掉，界面随即回到默认前景色。 */
const withGroupColor = (group: ClientGroup, color: string | null): ClientGroup =>
  color === null ? { id: group.id, name: group.name, parentId: group.parentId } : { ...group, color };

/** <input type="color"> 的 value 必须是六位：把 #rgb 展开，未设色时用兜底色。 */
function pickerHex(color: string | undefined): string {
  if (color === undefined) return GROUP_COLOR_FALLBACK;
  if (color.length !== 4) return color;
  const red = color.charAt(1);
  const green = color.charAt(2);
  const blue = color.charAt(3);
  return "#" + red + red + green + green + blue + blue;
}

/** 主机上的分组引用：老存档可能没有这个字段，一律当根层。 */
const groupIdOf = (profile: HostProfile): string | null =>
  typeof profile.groupId === "string" ? profile.groupId : null;

/** GET /profiles 的 groups 是**对象数组**：形状不对的条目直接丢弃，列表照旧能渲染。 */
function normalizeGroups(value: unknown): ClientGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ClientGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { id, name, parentId, color } = item;
    if (typeof id !== "string" || typeof name !== "string") continue;
    groups.push({
      id,
      name,
      parentId: typeof parentId === "string" ? parentId : null,
      color: typeof color === "string" ? color : undefined,
    });
  }
  return groups;
}

/** 老存档没有这个字段（或不是数组）：一律当直连。 */
const proxyJumpOf = (profile: HostProfile): string[] =>
  Array.isArray(profile.proxyJump) ? profile.proxyJump : [];

const detailOf = (profile: HostProfile): string => {
  // 只展示连接目标 host:port——用户名（root 之类）每行都一样，是噪声，
  // 而横向空间恰恰最紧（名称列 + 明细 + 四个动作按钮）。
  const target = profile.host ?? "";
  const port = profile.port === undefined ? "" : ":" + String(profile.port);
  return target + port;
};

/** 「添加主机」内联表单的草稿；不含任何密码字段（后端收到即 400）。 */
interface DraftHost {
  name: string;
  host: string;
  port: string;
  user: string;
  group: string;
  /** 逗号分隔的跳板机原文：留空即直连。 */
  proxyJump: string;
}

/** 名称列是定宽的（20ch），超过这个长度会被截断——所以在输入口就限制，而不是让界面去猜。 */

/** 下拉里"新建分组…"这一项的哨兵值：真实分组路径不可能长这样。 */
const NEW_GROUP_OPTION = "__new_group__";

const EMPTY_DRAFT: DraftHost = { name: "", host: "", port: "22", user: "root", group: "", proxyJump: "" };

/** 提交前的最小校验；返回 undefined 表示通过。 */
function validateDraft(draft: DraftHost): string | undefined {
  if (draft.name.trim() === "") return "名称不能为空";
  if (draft.name.trim().length > NAME_MAX) return "名称不能超过 " + NAME_MAX + " 个字符";
  if (draft.host.trim() === "") return "主机不能为空";
  const port = Number(draft.port.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口必须是 1..65535 的整数";
  return undefined;
}

/** 分组用 "/" 分隔多级路径，空段丢弃；留空即根层。 */
const splitGroupPath = (value: string): string[] =>
  value.split("/").map((part) => part.trim()).filter((part) => part !== "");

/** 跳板机用逗号分隔多跳：trim 后丢弃空项（" , " 这类输入等于没填）。 */
const splitProxyJump = (value: string): string[] =>
  value.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "");

/**
 * Windows 惯例的两条键盘入口：Shift+F10 与菜单键（"ContextMenu"）。
 *
 * B5 之前菜单**只有右键能开**：纯键盘用户根本进不去那一排动作（编辑 / 移入分组 / 删除），
 * 这是 WCAG 2.1.1（键盘）的硬失败——不是"体验差一点"，是功能不可达。
 * 判据抽成纯函数：行容器与测试用的是同一份定义，不会一边算 F10 一边算 Shift+F10。
 */
function isMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return (event.shiftKey && event.key === "F10") || event.key === "ContextMenu";
}

/** 主机列表：分组缩进 + 从 ~/.ssh/config 导入 + 添加主机 + 删除；点条目交给父组件进入终端。 */
export function HostListView({ onSelect, onManualConnect, refreshKey }: HostListViewProps) {
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  /** 宿主的**分组表**原样存着：树、路径、颜色全部由它派生。 */
  const [groups, setGroups] = useState<ClientGroup[]>([]);
  /** 已经记住密码的主机 id（来自 /security/refs，只有 ref 名字）。 */
  const [rememberedIds, setRememberedIds] = useState<string[]>([]);
  // 一次性提示走共享模型：成功（绿）/ 失败（红）两种 kind，过期规则由 notice.ts 统一负责
  const { notice, setNotice, setOk, clear } = useNotice();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DraftHost>(EMPTY_DRAFT);
  /** 是否切到"新建分组"分支（下拉里选「＋ 新建分组…」时为真）。 */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  /** undefined = 新建分组的内联输入未展开。 */
  const [folderDraft, setFolderDraft] = useState<string | undefined>(undefined);
  const [folderError, setFolderError] = useState<string | undefined>(undefined);
  /** 正在输入「移入分组」的主机 id（每次只展开一行）。 */
  const [movingId, setMovingId] = useState<string | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);
  // 只存 id，对象每次渲染时现取：否则会拿到删改前的副本（例如改名后弹框里还是旧名字）
  const pendingHost = profiles.find((item) => item.id === pendingDeleteId);
  /** 弹框居中在哪块：右侧栏自己，而不是整个视口。 */
  const paneRef = useRef<HTMLDivElement>(null);
  /** 待确认删除的分组 id：和主机删除同理，按身份绑定才不会串组 */
  const [pendingFolderId, setPendingFolderId] = useState<string | undefined>(undefined);
  /** 正在就地改名的分组 id：undefined = 这一屏没有展开改名输入框。 */
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");
  const [movePath, setMovePath] = useState("");
  /** undefined = 表单在「添加」；有值 = 正在编辑这台主机（同一个内联表单，改成预填 + 标题）。 */
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  /** 正在测试连接的主机 id：请求中该行按钮禁用。 */
  const [testingId, setTestingId] = useState<string | undefined>(undefined);
  /** 测试结论在行内保留 10 秒后自动消失：它是快照，不是状态。 */
const TEST_RESULT_TTL_MS = 10000;

/** 每台主机最近一次测试结果，行内显示「连通 ✓ 123 ms」或错误原文。 */
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  /** 已折叠的分组 **id**：存在 sessionStorage 里，刷新页面仍然是折叠的。 */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);
  /** 颜色 POST 排成一条队：拖色板会连发多次 onChange，串行写才不会彼此踩掉宿主的原子写。 */
  const colorSaveQueue = useRef<Promise<void>>(Promise.resolve());
  /** 分组树由 parentId 现算：表很小，坏数据由 buildGroupTree 兜住（不死循环）。 */
  const groupTree = buildGroupTree(groups);
  const groupRows = flattenGroupTree(groupTree);
  /** 搜索关键字：匹配主机名 / 地址 / 分组名，空串表示不过滤。 */
  const [query, setQuery] = useState("");
  /**
   * 分组菜单（B5）：坐标相对面板；groupId 指向被操作的那一组，
   * trigger 是"菜单关闭后焦点该回到哪儿"的元素——鼠标右键是分组行本身，
   * 「更多操作」按钮是那个按钮。没有它，关掉菜单等于把键盘用户的焦点扔回 body。
   */
  const [groupMenu, setGroupMenu] = useState<{
    left?: number;
    right?: number;
    top: number;
    groupId: string;
    trigger: HTMLElement;
  }>();
  /** 主机菜单：坐标相对面板；profileId 指向被操作的那台主机，trigger 同上。 */
  const [menu, setMenu] = useState<{
    left?: number;
    right?: number;
    top: number;
    profileId: string;
    trigger: HTMLElement;
  }>();
  /** 导入预览：非空即弹框，确认后才真正写盘。 */
  const [importPreview, setImportPreview] = useState<{ found: number; skipped: number; path: string }>();
  const filter = filterHosts(
    query,
    profiles.map((profile) => ({ id: profile.id, name: profile.name, host: profile.host, groupId: profile.groupId })),
    groupRows.map((row) => ({ id: row.id, name: row.name, parentId: row.parentId })),
  );
  const filtering = query.trim() !== "";
  // 分组同理：改名后弹框里显示的是新名字
  const pendingGroup = groupRows.find((item) => item.id === pendingFolderId);
  /**
   * 「连通 ✓ 123 ms」是**一次性测量**，不是状态：留着会误导（一分钟前的延迟不代表现在可达），
   * 也白占一行高度。每台主机各一个定时器，重测会重置，卸载统一清。
   */
  const testTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      for (const timer of Object.values(testTimerRef.current)) clearTimeout(timer);
      testTimerRef.current = {};
    },
    [],
  );

  useEffect(() => {
    ensureUniterminalCss();
    let cancelled = false;

    void (async () => {
      try {
        // 列表与「已记住」标记一次取完：refs 只回名字，取不到就当没有标记，不打断列表
        const [profilesResult, refsResult] = await Promise.all([
          api.get<ProfilesResponse>("/api/uniterminal/profiles"),
          api.get<RefsResponse>("/api/uniterminal/security/refs"),
        ]);
        if (cancelled) return;
        if (refsResult.ok) {
          const refs = Array.isArray(refsResult.data.refs) ? refsResult.data.refs : [];
          setRememberedIds(
            refs
              .filter((ref) => ref.startsWith(CREDENTIAL_REF_PREFIX))
              .map((ref) => ref.slice(CREDENTIAL_REF_PREFIX.length)),
          );
        }
        if (!profilesResult.ok) {
          setNotice("主机列表不可用：" + profilesResult.error.message);
          setLoaded(true);
          return;
        }
        const payload = profilesResult.data;
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setGroups(normalizeGroups(payload.groups));
        setLoaded(true);
      } catch (error) {
        if (!cancelled) {
          setNotice("主机列表不可用：" + String(error));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey, reloadToken]);

/**
 * 导入前先预览：只扫描 ~/.ssh/config 拿到条数，弹框确认后才真正写盘。
 * 直接导入的问题是用户不知道会加进来几台（可能 1 台，也可能 30 台）。
 */
async function previewImport(): Promise<void> {
  setBusy(true);
  clear();
  try {
    const result = await api.post<ImportPreviewResponse>("/api/uniterminal/profiles/import", {
      dryRun: true,
    });
    if (!result.ok) {
      setNotice("扫描 ~/.ssh/config 失败：" + result.error.message);
      return;
    }
    const payload = result.data;
    const found = payload.found ?? 0;
    if (found === 0) {
      setNotice(payload.missing === true ? "没有找到 ~/.ssh/config" : "~/.ssh/config 里没有可导入的主机");
      return;
    }
    setImportPreview({ found, skipped: payload.skipped?.length ?? 0, path: payload.path ?? "~/.ssh/config" });
  } catch (error) {
    setNotice("扫描 ~/.ssh/config 失败：" + String(error));
  } finally {
    setBusy(false);
  }
}

  async function importFromSshConfig(): Promise<void> {
    setBusy(true);
    clear();
    try {
      const result = await api.post<ImportResponse>("/api/uniterminal/profiles/import", {});
      if (!result.ok) {
        setNotice("导入失败：" + result.error.message);
        return;
      }
      const payload = result.data;
      const imported = payload.imported ?? 0;
      const skipped = payload.skipped?.length ?? 0;
      const directives = payload.directives?.length ?? 0;
      setOk(
        "已导入 " + String(imported) + " 台主机" +
          (skipped > 0 ? "，跳过 " + String(skipped) + " 项" : "") +
          (directives > 0 ? "，未识别指令 " + String(directives) + " 条" : ""),
      );
      setReloadToken((token) => token + 1);
    } catch (error) {
      setNotice("导入失败：" + String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(profile: HostProfile): Promise<void> {
    setBusy(true);
    clear();
    try {
      const result = await api.del<{ error?: string }>(
        "/api/uniterminal/profiles/" + encodeURIComponent(profile.id),
      );
      if (!result.ok) {
        setNotice("删除失败：" + result.error.message);
        return;
      }
      setOk("已删除 " + profile.name);
      setReloadToken((token) => token + 1);
    } catch (error) {
      setNotice("删除失败：" + String(error));
    } finally {
      setPendingDeleteId(undefined);
      setBusy(false);
    }
  }

  async function createFolder(): Promise<void> {
    const path = splitGroupPath(folderDraft ?? "");
    if (path.length === 0) {
      setFolderError("分组不能为空：多级用 / 分隔，例如 生产/华东");
      return;
    }
    setBusy(true);
    setFolderError(undefined);
    clear();
    try {
      const result = await api.post<FolderResponse>("/api/uniterminal/folders", { path });
      if (!result.ok) {
        setFolderError("新建分组失败：" + result.error.message);
        return;
      }
      setOk("已新建分组 " + path.join(" / "));
      setFolderDraft(undefined);
      setReloadToken((token) => token + 1);
    } catch (error) {
      setFolderError("新建分组失败：" + errorText(error));
    } finally {
      setBusy(false);
    }
  }

  /** 空的也删得掉；其中的主机不会被删，只会回到根层。宿主只按路径认分组，所以先算路径。 */
  async function removeFolder(node: GroupNode): Promise<void> {
    const path = groupPathOf(groupTree, node.id);
    if (path.length === 0) {
      setNotice("这个分组已经不存在，请重新加载列表");
      return;
    }
    setBusy(true);
    clear();
    try {
      const result = await api.post<FolderResponse>("/api/uniterminal/folders/delete", { path });
      if (!result.ok) {
        setNotice("删除分组失败：" + result.error.message);
        return;
      }
      setPendingFolderId(undefined);
      setOk("已删除分组 " + path.join(" / ") + "：其中的主机已回到根层");
      setReloadToken((token) => token + 1);
    } catch (error) {
      setNotice("删除分组失败：" + String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 就地改名：按 id 记住"哪一组在改"，默认值就是这一组自己的名字。 */
  function startFolderRename(node: GroupNode): void {
    setPendingFolderId(undefined);
    setRenamingId(node.id);
    setRenameDraft(node.name);
    clear();
  }

  function cancelFolderRename(): void {
    setRenamingId(undefined);
    setRenameDraft("");
  }

  /**
   * 改名：宿主只按路径认分组（POST /folders/rename 的入参是 {path,name}），所以先用
   * 分组表算出路径再提交。M10-A 之后它只改 group.name 一个字段——子分组与其中的主机
   * 跟着组走，颜色也不必再搬家（颜色就存在这一组自己身上）。
   */
  async function renameFolder(node: GroupNode, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") {
      setNotice("分组名不能为空");
      return;
    }
    const path = groupPathOf(groupTree, node.id);
    if (path.length === 0) {
      setNotice("这个分组已经不存在，请重新加载列表");
      return;
    }
    setBusy(true);
    clear();
    try {
      const result = await api.post<FolderResponse>("/api/uniterminal/folders/rename", {
        path,
        name: trimmed,
      });
      if (!result.ok) {
        setNotice("重命名分组失败：" + result.error.message);
        return;
      }
      const payload = result.data;
      cancelFolderRename();
      // renamed 是分组的 0|1：0 表示新旧同名（宿主不会为了凑数去动任何东西）
      setOk(
        (payload.renamed ?? 0) === 0
          ? "分组名没有变化"
          : "已重命名分组 " + [...path.slice(0, -1), trimmed].join(" / "),
      );
      setReloadToken((token) => token + 1);
    } catch (error) {
      setNotice("重命名分组失败：" + String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 折叠/展开一个分组：先落 state 再写 sessionStorage，存不下也不影响这次渲染。 */
  function toggleGroup(key: string): void {
    const next = collapsedGroups.includes(key)
      ? collapsedGroups.filter((item) => item !== key)
      : [...collapsedGroups, key];
    setCollapsedGroups(next);
    writeCollapsedGroups(next);
  }

  /**
   * 分组名称颜色：本地先改这一组（立即看到效果），再把这一组 POST 回宿主。
   * 失败只在 notice 里提示——颜色是装饰，绝不挡住主机列表和连接。
   */
  function saveGroupColor(id: string, color: string | null): void {
    setGroups((current) => current.map((group) => (group.id === id ? withGroupColor(group, color) : group)));
    clear();
    colorSaveQueue.current = colorSaveQueue.current.then(() => persistGroupColor(id, color));
  }

  async function persistGroupColor(id: string, color: string | null): Promise<void> {
    try {
      const result = await api.post<{ error?: string }>("/api/uniterminal/groups/color", {
        // 宿主契约：color 缺省或 null 才是"清除"；空字符串过不了颜色校验（会 400）
        groupId: id,
        color,
      });
      if (!result.ok) {
        setNotice("分组颜色保存失败：" + result.error.message);
      }
    } catch (error) {
      setNotice("分组颜色保存失败：" + String(error));
    }
  }

  /** 手写路径 → 分组 id：查不到就按 POST /folders 建出整条链（改造前"写路径即建组"的手感）。 */
  async function ensureGroupId(path: string[]): Promise<string | null> {
    if (path.length === 0) return null;
    const existing = findGroupByPath(groupTree, path);
    if (existing !== undefined) return existing.id;
    const result = await api.post<FolderResponse>("/api/uniterminal/folders", { path });
    if (!result.ok) throw new GroupCreateError(result.error.message);
    // 201 已经带回 group：直接用它的 id，省一次重拉
    const createdId = result.data.group?.id;
    if (typeof createdId !== "string") {
      // 内部字段名不进界面：原始细节写进 diag，界面上只说"服务返回异常，请重试"
      reportClient("client.group-create-failed", { reason: "missing-group-id", path: path.join(" / ") });
      throw new GroupCreateError("服务返回异常，请重试");
    }
    return createdId;
  }

  /** 走既有 POST /profiles 回写 groupId；留空即移出到根层。 */
  async function moveToGroup(profile: HostProfile, value: string): Promise<void> {
    const path = splitGroupPath(value);
    setBusy(true);
    clear();
    try {
      const groupId = await ensureGroupId(path);
      const result = await api.post<{ profile?: HostProfile; error?: string }>(
        "/api/uniterminal/profiles",
        // 只回写列表里已有的非敏感字段：后端白名单会拒绝任何密码字段
        { profile: { ...profile, groupId } },
      );
      if (!result.ok) {
        setNotice("移动分组失败：" + result.error.message);
        return;
      }
      setOk(
        groupId === null
          ? "已把 " + profile.name + " 移出分组（回到根层）"
          : "已把 " + profile.name + " 移入 " + path.join(" / "),
      );
      setMovingId(undefined);
      setMovePath("");
      setReloadToken((token) => token + 1);
    } catch (error) {
      setNotice("移动分组失败：" + errorText(error));
    } finally {
      setBusy(false);
    }
  }

  /** 编辑保存前重新拉一次存档：ProfileStore.upsert 是整条替换，漏字段会被静默清空。 */
  async function fetchStoredProfile(id: string): Promise<HostProfile | undefined> {
    const result = await api.get<ProfilesResponse>("/api/uniterminal/profiles");
    if (!result.ok) throw new Error(result.error.message);
    const list = Array.isArray(result.data.profiles) ? result.data.profiles : [];
    return list.find((profile) => profile.id === id);
  }

  /** 表单收起：添加与编辑共用同一份草稿状态。 */
  function closeForm(): void {
    setAdding(false);
    setEditingId(undefined);
    setDraft(EMPTY_DRAFT);
  }

  function cancelDraft(): void {
    closeForm();
    setFormError(undefined);
  }

  /** 点「编辑」：复用同一个内联表单，预填存档值。 */
  function openEdit(profile: HostProfile): void {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      host: profile.host ?? "",
      port: String(profile.port ?? 22),
      user: profile.user ?? "",
      group: groupPathOf(groupTree, profile.groupId).join("/"),
      proxyJump: proxyJumpOf(profile).join(", "),
    });
    // 下拉与手输框必须一开始就一致：编辑已有主机时按它的 groupId 选中
    setFormError(undefined);
    setAdding(true);
  }

  async function submitDraft(): Promise<void> {
    const invalid = validateDraft(draft);
    if (invalid !== undefined) {
      setFormError(invalid);
      return;
    }
    setBusy(true);
    setFormError(undefined);
    clear();
    const name = draft.name.trim();
    const hops = splitProxyJump(draft.proxyJump);
    const groupText = draft.group;
    try {
      // 分组按 id 引用：手写的路径先落到分组表上（不存在就按宿主既有规则建整条链）
      const groupId = await ensureGroupId(splitGroupPath(groupText));
      const edited = {
        name,
        host: draft.host.trim(),
        port: Number(draft.port.trim()),
        user: draft.user.trim() === "" ? undefined : draft.user.trim(),
        groupId,
      };
      let body: { profile: Record<string, unknown> };
      if (editingId === undefined) {
        // 只提交下面这些非敏感字段：任何密码字段都会被后端 400 拒绝
        body = { profile: { ...edited, kind: "ssh" } };
      } else {
        // 编辑：先取存档再整份回写。只回传改动字段会静默清掉 auth / remember / proxyJump / createdAt / groupId。
        const stored = await fetchStoredProfile(editingId);
        if (stored === undefined) {
          setFormError("这台主机已不存在，请重新加载列表");
          return;
        }
        body = { profile: { ...stored, ...edited, id: stored.id } };
      }
      // 跳板机：有有效项才带 proxyJump，否则删掉该字段（后端缺省即直连）。绝不发空数组。
      if (hops.length > 0) body.profile.proxyJump = hops;
      else delete body.profile.proxyJump;
      const result = await api.post<{ profile?: HostProfile; error?: string }>(
        "/api/uniterminal/profiles",
        body,
      );
      if (!result.ok) {
        // 后端原文照显，且保留用户已输入的内容
        setFormError(result.error.message);
        return;
      }
      const payload = result.data;
      setOk((editingId === undefined ? "已添加 " : "已保存 ") + String(payload.profile?.name ?? name));
      closeForm();
      setReloadToken((token) => token + 1);
    } catch (error) {
      // 分组是顺带建出来的：建分组这一类失败自带动作词，这里别再拼第二层前缀
      setFormError(error instanceof GroupCreateError ? "新建分组失败：" + error.message : errorText(error));
    } finally {
      setBusy(false);
    }
  }

  /** 测试连接：后端建一条临时连接再立刻关掉，这里只显示结论。 */
  async function testConnection(profile: HostProfile): Promise<void> {
    const record = (result: { ok: boolean; text: string }): void => {
      setTestResults((current) => ({ ...current, [profile.id]: result }));
      const previous = testTimerRef.current[profile.id];
      if (previous !== undefined) clearTimeout(previous);
      testTimerRef.current[profile.id] = setTimeout(() => {
        delete testTimerRef.current[profile.id];
        setTestResults((current) => {
          const next = { ...current };
          delete next[profile.id];
          return next;
        });
      }, TEST_RESULT_TTL_MS);
    };
    setTestingId(profile.id);
    setTestResults((current) => {
      const next = { ...current };
      delete next[profile.id];
      return next;
    });
    try {
      const result = await api.post<TestConnectionResponse>("/api/uniterminal/profiles/test", {
        id: profile.id,
      });
      if (!result.ok) {
        record({ ok: false, text: "连通 ✗ " + testFailureText(result.error) });
        return;
      }
      const payload = result.data;
      if (payload.ok === true) {
        record({ ok: true, text: "连通 ✓ " + String(payload.ms ?? 0) + " ms" });
        return;
      }
      record({ ok: false, text: "连通 ✗ " + String(payload.error ?? "未知错误") });
    } catch (error) {
      record({ ok: false, text: "连通 ✗ " + String(error) });
    } finally {
      setTestingId(undefined);
    }
  }

  function select(profile: HostProfile): void {
    if (profile.kind !== "ssh") {
      setNotice("目前只支持 SSH 连接");
      return;
    }
    onSelect(profile, rememberedIds.includes(profile.id));
  }

  /**
   * 菜单锚点只有**一套基准**：在视口里量、再减去面板的视口坐标，得到"相对面板"的坐标。
   *
   * 鼠标路径从事件坐标减（见两处 onContextMenu），键盘 / 按钮路径没有鼠标坐标，
   * 就从触发元素自己的 rect 减——两条路得到同一个坐标系，不要另造一套。
   * （面板是 position: relative，所以主题给祖先加 transform 也不会把菜单带偏。）
   */
  function anchorOf(element: HTMLElement): MenuAnchor {
    const rect = element.getBoundingClientRect();
    const pane = paneRef.current;
    const paneRect = pane?.getBoundingClientRect();
    // 横向基准取锚点的**右边缘**：靠右时 menuAnchor 会改成右对齐、向左展开，
    // 否则行尾那个「更多操作」按钮的菜单会伸出面板右边缘被宿主的 overflow 裁掉。
    return menuAnchor(
      rect.right - (paneRect?.left ?? 0),
      rect.bottom - (paneRect?.top ?? 0),
      pane?.clientWidth ?? 0,
    );
  }

  /** 打开主机菜单：trigger 既当锚点，也是关闭后焦点要回的元素。 */
  function openRowMenu(trigger: HTMLElement, profileId: string): void {
    setMenu({ ...anchorOf(trigger), profileId, trigger });
  }

  /** 打开分组菜单：与主机菜单同一套坐标基准与焦点归还规则。 */
  function openGroupMenu(trigger: HTMLElement, groupId: string): void {
    setGroupMenu({ ...anchorOf(trigger), groupId, trigger });
  }

  const groupIds = new Set(groupRows.map((node) => node.id));
  const rootProfiles = profiles.filter((profile) => groupIdOf(profile) === null);
  // 指向已不存在分组的主机：不隐藏也不猜它该去哪，直接摆回根层
  const strays = profiles.filter((profile) => {
    const id = groupIdOf(profile);
    return id !== null && !groupIds.has(id);
  });

  const row = (profile: HostProfile, depth: number) => (
    <div key={profile.id} className="uniterminal-col" style={{ gap: 4 }}>
      <div
        className="uniterminal-hostrow uniterminal-row-tight"
        style={{ gap: 6, paddingLeft: depth * 14 }}
        // tabIndex={-1}：菜单关闭时焦点要回到这一行。div 本来不可聚焦，
        // focus() 是空操作 → 焦点落到 body，键盘用户得从页面开头重新 Tab 回来。
        // -1 只让它**能被程序聚焦**，不增加 Tab 停靠点。
        tabIndex={-1}
        onKeyDown={(event) => {
          // 焦点可能落在行内任何一个按钮上，所以挂在行容器上（按键从按钮冒泡上来）
          if (!isMenuKey(event)) return;
          event.preventDefault();
          openRowMenu(event.currentTarget, profile.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // 坐标相对面板（面板是定位上下文）：主题加 transform 也不会把菜单带偏
          const pane = paneRef.current;
          const rect = pane?.getBoundingClientRect();
          setMenu({
            ...menuAnchor(
              event.clientX - (rect?.left ?? 0),
              event.clientY - (rect?.top ?? 0),
              pane?.clientWidth ?? 0,
            ),
            profileId: profile.id,
            trigger: event.currentTarget,
          });
        }}
      >
        <button
          type="button"
          className="uniterminal-hostname uniterminal-self-center"
          // 不撑满：名称·明细·图标紧贴在一起，剩下的空白由后面的占位符吸收。
          // alignSelf:center 交给两级选择器 .uniterminal-pane button.uniterminal-self-center：
          // 单类原语 (0,1,0) 压不过 .uniterminal-pane button 的 flex-start。
          // textAlign / overflow 没有对应的两级类，仍留内联（单类原语不许落在 button 上）。
          style={{ flex: "0 1 auto", textAlign: "left", overflow: "hidden" }}
          title={detailOf(profile)}
          onClick={() => select(profile)}
        >
          <span className="uniterminal-hostname-text" title={profile.name}>{profile.name}</span>
          <span className="uniterminal-hostdetail">{detailOf(profile)}</span>
          {/* 固定 6ch 的图标列：有没有图标都占同样宽度，按钮位置才稳定 */}
          <span className="uniterminal-hosticons">
          {rememberedIds.includes(profile.id) && (
            <span
              // 有密码 → 盾牌里镂空一个对勾；不再用「已记住」小方框（一行里多一个框很碎）
              title="本机凭据文件里已经存有这台主机的密码"
              aria-label="已记住密码"
              style={{
                display: "inline-flex",
                alignItems: "center",
                verticalAlign: "middle",
                // 字形中线与盒子中线有差：按用户观感下移 2px（position 不影响行高）
                position: "relative",
                top: 1,
                color: COLOR_SUCCESS,
              }}
            >
              <ShieldCheckIcon />
            </span>
          )}
          {profile.auth !== undefined && hasKeyAuth(profile.auth.kind) && (
            <span
              title={
                profile.auth.kind === "both"
                  ? "两种都试：私钥与已保存的密码一起交给 SSH"
                  : profile.auth.identityPath === undefined
                    ? "这台主机使用粘贴到本机凭据文件的私钥登录"
                    : "这台主机使用私钥文件登录：" + profile.auth.identityPath
              }
              aria-label="使用私钥"
              style={{
                display: "inline-flex",
                alignItems: "center",
                verticalAlign: "middle",
                position: "relative",
                top: 1,
                // 古铜色需要原色呈现；之前的 0.8 透明度会把铜色冲成土黄
                color: KEY_ICON_COLOR,
              }}
            >
              <KeyIcon />
            </span>
          )}
          </span>
          {proxyJumpOf(profile).length > 0 && (
            <span
              title={"经这些跳板机连接：" + proxyJumpOf(profile).join(" → ")}
              className="uniterminal-small"
              style={{ opacity: 0.75 }}
            >
              {PROXY_JUMP_LABEL}
            </span>
          )}
        </button>
        {/* 弹性占位符把动作按钮顶到最右：窗口拉宽时按钮始终贴右侧，不会飘到中间 */}
        <span aria-hidden="true" className="uniterminal-grow" />
        {/* 行内只留"连接"和"测试"：编辑/移入分组/删除收进右键菜单 */}
        <button
          type="button"
          disabled={busy || testingId === profile.id}
          // 读屏按「按钮列表」浏览时，一串「测试 测试 测试」分不清是哪台主机
          aria-label={"测试连接：" + profile.name}
          title="建一条临时连接后立刻断开：不进会话列表，也不占终端"
          onClick={() => void testConnection(profile)}
        >
          {testingId === profile.id ? "测试中…" : "测试"}
        </button>
        <button
          type="button"
          style={{ color: COLOR_SUCCESS }}
          disabled={busy}
          aria-label={"连接：" + profile.name}
          title="打开连接面板（与单击主机名相同）"
          onClick={() => onSelect(profile, rememberedIds.includes(profile.id))}
        >
          连接
        </button>
        {/* 键盘与触屏进入菜单的入口：不常驻可见（.uniterminal-row-more 静止时 opacity 0），
            行被悬停或行内有焦点才显形——面板外观因此没变。
            用 opacity 而不是 display / visibility：后两者会把它移出 Tab 序列，
            键盘用户就永远聚焦不到它（opacity: 0 仍然可聚焦、也仍被读屏读到）。 */}
        <button
          type="button"
          className="uniterminal-row-more uniterminal-compact"
          aria-haspopup="menu"
          aria-expanded={menu?.profileId === profile.id}
          aria-label={"更多操作：" + profile.name}
          title="更多操作"
          onClick={(event) => {
            // 开菜单就是开菜单：不让这次点击冒泡到行里别的处理器（免得顺带触发别的动作）
            event.stopPropagation();
            openRowMenu(event.currentTarget, profile.id);
          }}
        >
          ⋯
        </button>
      </div>
      {movingId === profile.id && (
        <div className="uniterminal-overlay">
          <div className="uniterminal-overlay-panel">
            {/* 字号与字重交给 .uniterminal-overlay-panel > div:first-child（16px / 650）：
                内联的 fontSize 永远压过 CSS，浮层标题会停在 14px，比确认弹框标题还小一档。 */}
            <div>移入分组</div>
            {/* 已有分组做下拉：手打路径容易打错一个字就凭空多出一个分组 */}
            <label>
              分组
              {/* 用下拉而不是"输入 + 建议"：datalist 会按当前输入过滤，预填了分组名就只看得到一项 */}
              <SelectField
                label="移入的分组"
                value={movePath}
                onChange={setMovePath}
                options={[
                  { value: "", label: "根层（不分组）" },
                  ...(movePath !== "" && !groupRows.some((row) => row.path.join("/") === movePath)
                    ? [{ value: movePath, label: movePath + "（当前）" }]
                    : []),
                  ...groupRows.map((row) => ({
                    value: row.path.join("/"),
                    label: "　".repeat(row.depth) + row.path.join(" / "),
                  })),
                ]}
              />
            </label>
            <div className="uniterminal-toolbar">
              <button type="button" disabled={busy} onClick={() => void moveToGroup(profile, movePath)}>
                确定
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMovingId(undefined);
                  setMovePath("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 「测试连接」的结果：B5 之前这处也完全静音——成功的延迟与失败的原文都只写进 DOM，
          读屏用户按「测试」之后什么也听不到。
          一个常驻容器就够：这是次要信息，成功与失败都不该打断用户（status / polite），
          不按成功失败拆双容器。容器常驻、条件只决定里面的文字。 */}
      <div {...noticeLiveProps("ok")} className="uniterminal-live">
        {testResults[profile.id] !== undefined && (
          <div
            className={testResults[profile.id]?.ok === true ? "uniterminal-hint" : "uniterminal-notice"}
            style={{
              paddingLeft: depth * 14 + 14,
              color: testResults[profile.id]?.ok === true ? COLOR_SUCCESS : COLOR_DANGER,
            }}
          >
            {testResults[profile.id]?.text}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="uniterminal-pane" ref={paneRef} style={{ position: "relative" }}>
      <div className="uniterminal-toolbar">
        <button type="button" disabled={busy} onClick={onManualConnect}>
          手动连接
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setAdding(true);
            setEditingId(undefined);
            setDraft(EMPTY_DRAFT);
            setFormError(undefined);
          }}
        >
          添加主机
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setFolderDraft(folderDraft === undefined ? "" : undefined);
            setFolderError(undefined);
          }}
        >
          新建分组
        </button>
        {/* 搜索：主机名 / 地址 / 分组名。主机多时靠它定位，而不是用眼睛扫 */}
        <span className="uniterminal-search">
          <span aria-hidden={true} className="uniterminal-search-icon"><SearchIcon /></span>
          <input
            value={query}
            maxLength={NAME_MAX}
            placeholder="搜索主机 / IP / 分组"
            aria-label="搜索主机、IP 或分组"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
            <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </span>
      </div>
      {folderDraft !== undefined && (
        <div className="uniterminal-overlay">
          <div className="uniterminal-overlay-panel">
            <div>新建分组</div>
            <label>
              分组
              <input
                value={folderDraft}
                placeholder="生产/华东（多级用 / 分隔，可以先建空分组）"
                onChange={(event) => setFolderDraft(event.target.value)}
              />
            </label>
            <div className="uniterminal-row">
              <button type="button" disabled={busy} onClick={() => void createFolder()}>
                新建
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setFolderDraft(undefined);
                  setFolderError(undefined);
                }}
              >
                取消
              </button>
            </div>
            {/* B5 无障碍：外层是**常驻**的 alert 区，只有里面的文字会变。
                直接把 role="alert" 挂在条件渲染的那个 div 上不行——节点刚插入时读屏往往漏播。 */}
            <div {...noticeLiveProps("error")} className="uniterminal-live">
              {folderError !== undefined && <div className="uniterminal-notice">{folderError}</div>}
            </div>
          </div>
        </div>
      )}
      {adding && (
        <div className="uniterminal-overlay">
          <div className="uniterminal-overlay-panel">
          <div style={{ opacity: 0.75 }}>
            {editingId === undefined
              ? "添加主机"
              : "编辑 " + (profiles.find((profile) => profile.id === editingId)?.name ?? draft.name)}
          </div>
          <label>
            名称
            <input
              value={draft.name}
              placeholder="生产 Web 01"
              maxLength={NAME_MAX}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            主机
            <input
              value={draft.host}
              placeholder="192.0.2.10"
              onChange={(event) => setDraft({ ...draft, host: event.target.value })}
            />
          </label>
          <label>
            端口
            <input
              value={draft.port}
              inputMode="numeric"
              onChange={(event) => setDraft({ ...draft, port: event.target.value })}
            />
          </label>
          <label>
            用户
            <input
              value={draft.user}
              onChange={(event) => setDraft({ ...draft, user: event.target.value })}
            />
          </label>
        <label>
          分组
          {/* 完整下拉 + 一个"新建"分支：datalist 会按当前输入过滤，预填后只看得到一项 */}
          <SelectField
            label="分组"
            value={creatingGroup ? NEW_GROUP_OPTION : draft.group}
            onChange={(value) => {
              if (value === NEW_GROUP_OPTION) {
                setCreatingGroup(true);
                setDraft({ ...draft, group: "" });
                return;
              }
              setCreatingGroup(false);
              setDraft({ ...draft, group: value });
            }}
            options={[
              { value: "", label: "根层（不分组）" },
              ...(!creatingGroup && draft.group !== "" && !groupRows.some((row) => row.path.join("/") === draft.group)
                ? [{ value: draft.group, label: draft.group + "（当前）" }]
                : []),
              ...groupRows.map((row) => ({
                value: row.path.join("/"),
                label: "　".repeat(row.depth) + row.path.join(" / "),
              })),
              { value: NEW_GROUP_OPTION, label: "＋ 新建分组…" },
            ]}
          />
        </label>
        {creatingGroup && (
          <label>
            新分组
            <input
              autoFocus
              value={draft.group}
              placeholder="生产/华东（多级用 / 分隔）"
              onChange={(event) => setDraft({ ...draft, group: event.target.value })}
            />
          </label>
        )}
          <label>
            跳板机（可选）
            <input
              value={draft.proxyJump}
              placeholder="bastion.example.com 或 user@host:2222"
              onChange={(event) => setDraft({ ...draft, proxyJump: event.target.value })}
            />
            <span className="uniterminal-hint" style={{ display: "block" }}>
              按顺序经过这些跳板机；留空表示直连。多跳用逗号分隔。
            </span>
          </label>
          <div className="uniterminal-row">
            {/* 从 ~/.ssh/config 导入原本在工具栏，和四个按钮挤在一起把搜索框挤跑了；挪到这里更合理 */}
            <button
              type="button"
              disabled={busy}
              title="读取 ~/.ssh/config，把其中的主机批量加进列表"
              onClick={() => void previewImport()}
            >
              从 ~/.ssh/config 导入
            </button>
            <button type="button" className="uniterminal-self-center" disabled={busy} onClick={() => void submitDraft()}>
              {editingId === undefined ? "保存主机" : "保存修改"}
            </button>
            <button type="button" className="uniterminal-self-center" disabled={busy} onClick={cancelDraft}>
              取消
            </button>
          </div>
          {/* 同上：容器常驻、只有文字变化，失败才播报得出去 */}
          <div {...noticeLiveProps("error")} className="uniterminal-live">
            {formError !== undefined && <div className="uniterminal-notice">{formError}</div>}
          </div>
          </div>
        </div>
      )}
      {!loaded && <p className="uniterminal-hint">加载主机列表…</p>}
      {loaded && profiles.length === 0 && groupRows.length === 0 && (
        <p className="uniterminal-hint">还没有主机：点上面的「从 ~/.ssh/config 导入」「添加主机」或「新建分组」。</p>
      )}
      <div className="uniterminal-col uniterminal-fill" style={{ gap: 2, overflowY: "auto" }}>
        {rootProfiles.filter((profile) => !filtering || filter.hostIds.has(profile.id)).map((profile) => row(profile, 0))}
        {groupRows.map((node) => {
          // 成员 = 直接挂着这一组 id 的主机（子分组是另一行，不在这里重复）
          // 过滤生效时只留命中的主机
          const members = profiles.filter((profile) => profile.groupId === node.id && (!filtering || filter.hostIds.has(profile.id)));
          const label = node.path.join(" / ");
          const collapsed = collapsedGroups.includes(node.id);
          const nodeColor = node.color;
          const color = nodeColor !== undefined && GROUP_COLOR_PATTERN.test(nodeColor) ? nodeColor : undefined;
          return (
            <div key={node.id} className="uniterminal-col" style={{ gap: 2 }}>
              <div
                className="uniterminal-grouprow uniterminal-row-tight"
                style={{
                  gap: 6,
                  paddingLeft: 4 + node.depth * 14,
                }}
                // tabIndex={-1}：与主机行同理——菜单关闭后焦点要回到这一行，
                // 而 div 不聚焦时 focus() 是空操作，焦点会掉到 body。
                tabIndex={-1}
                onKeyDown={(event) => {
                  // 焦点可能落在行内任何控件上（折叠按钮 / 调色板 / 重置颜色），
                  // 监听挂在行容器上，按键从它们冒泡上来
                  if (!isMenuKey(event)) return;
                  event.preventDefault();
                  openGroupMenu(event.currentTarget, node.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  // 坐标相对面板（面板是定位上下文）：主题给祖先加 transform 也不会把菜单带偏
                  const pane = paneRef.current;
                  const rect = pane?.getBoundingClientRect();
                  setGroupMenu({
                    ...menuAnchor(
                      event.clientX - (rect?.left ?? 0),
                      event.clientY - (rect?.top ?? 0),
                      pane?.clientWidth ?? 0,
                    ),
                    groupId: node.id,
                    trigger: event.currentTarget,
                  });
                }}
              >
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  title={
                    (collapsed ? "展开分组" : "折叠分组") +
                    "：只影响这一屏的显示，不会改动主机与分组"
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: 0,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: 650,
                    opacity: 1,
                    // 没设过色就继承默认前景色：这里不写死任何颜色
                    color: color ?? "inherit",
                  }}
                  onClick={() => toggleGroup(node.id)}
                >
                  <span aria-hidden={true} style={{ fontSize: 12 }}>
                    {collapsed ? "▸" : "▾"}
                  </span>
                  <span aria-hidden={true} style={{ fontSize: 12 }}>
                    📁
                  </span>
                  <span className="uniterminal-group-title">{label}</span>
                  <span className="uniterminal-body" style={{ fontWeight: 400, opacity: 0.7 }}>
                    · {members.length} 台
                  </span>
                </button>
                <input
                  type="color"
                  aria-label={"分组 " + label + " 的名称颜色"}
                  title="只改分组名称的颜色，不是终端配色"
                  style={{ width: 22, height: 16, padding: 0, border: "none", background: "none" }}
                  value={pickerHex(nodeColor)}
                  onChange={(event) => saveGroupColor(node.id, event.target.value)}
                  // 调色板上右键只是无意义的空白：不冒泡，免得右键调色时弹出分组菜单
                  onContextMenu={(event) => event.stopPropagation()}
                />
                <button
                  type="button"
                  disabled={busy || nodeColor === undefined}
                  title="重置这个分组的名称颜色：回到默认前景色"
                  onClick={() => saveGroupColor(node.id, null)}
                >
                  重置颜色
                </button>
                {renamingId === node.id ? (
                  <>
                    <input
                      type="text"
                      aria-label={"分组 " + label + " 的新名称"}
                      title="改这一组的名称：子分组与其中的主机跟着走，颜色留在这一组身上"
                      value={renameDraft}
                      autoFocus={true}
                      disabled={busy}
                      maxLength={NAME_MAX}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        // Enter 确定、Esc 取消：输入框里的键盘操作就这两件事
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void renameFolder(node, renameDraft);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelFolderRename();
                        }
                      }}
                      style={{ width: 160 }}
                    />
                    <button type="button" disabled={busy} onClick={() => void renameFolder(node, renameDraft)}>
                      确定
                    </button>
                    <button type="button" disabled={busy} onClick={cancelFolderRename}>
                      取消
                    </button>
                  </>
                ) : (
          null
                )}
                {/* 分组行的「更多操作」：与主机行同形（重命名 / 删除分组只在这里） */}
                <button
                  type="button"
                  className="uniterminal-row-more uniterminal-compact"
                  aria-haspopup="menu"
                  aria-expanded={groupMenu?.groupId === node.id}
                  aria-label={"更多操作：分组 " + label}
                  title="更多操作"
                  onClick={(event) => {
                    event.stopPropagation();
                    openGroupMenu(event.currentTarget, node.id);
                  }}
                >
                  ⋯
                </button>
              </div>
              {/* 折叠时不渲染成员行，也不渲染「（空分组）」：整段一起藏起来 */}
              {!collapsed && (
                <div
                  className="uniterminal-col"
                  style={{
                    gap: 2,
                    // 左侧竖线把「这一组的主机」框在一起：只靠缩进，用户看不出归属
                    marginLeft: 10 + node.depth * 14,
                    paddingLeft: 10,
                    // M9-19：竖线用分组色——成员因此"属于这一组"一目了然，而主机名保持中性
                    borderLeft:
                      // 2px：1px 在浅色主题下几乎看不出"这行属于哪一组"
                      "2px solid " + (color ?? "var(--ut-border)"),
                  }}
                >
                  {members.length === 0 && (
                    <div className="uniterminal-small" style={{ opacity: 0.45 }}>（空分组）</div>
                  )}
                  {members.map((profile) => row(profile, 0))}
                </div>
              )}
            </div>
          );
        })}
        {strays.map((profile) => row(profile, 0))}
      </div>
      {/* 右键菜单：编辑 / 移入分组 / 测试 / 删除（行内只留"连接""测试"） */}
      {menu !== undefined &&
        (() => {
          const target = profiles.find((item) => item.id === menu.profileId);
          if (target === undefined) return null;
          return (
            <ContextMenu
              // left 与 right 互斥：锚点靠右时 menuAnchor 只给 right，
              // 两个都必须接上——漏掉 right 会让 absolute 元素退回静态位置（菜单跑到面板左下）。
              left={menu.left}
              right={menu.right}
              top={menu.top}
              // 可访问名：同一屏上有主机菜单与分组菜单，没有名字时读屏读不出这是谁的操作
              label={"主机 " + target.name + " 的操作"}
              // B5：关掉菜单把焦点还给触发元素（右键的行走是那一行，「⋯」进来就是那个按钮）。
              // 没有它，关菜单等于把键盘用户的焦点扔回文档开头。
              returnFocusTo={menu.trigger}
              onClose={() => setMenu(undefined)}
              items={[
                { label: "编辑", onSelect: () => openEdit(target) },
                {
                  label: "移入分组…",
                  onSelect: () => {
                    setMovingId(target.id);
                    setMovePath(groupPathOf(groupTree, target.groupId).join("/"));
                  },
                },
                { label: "测试连接", onSelect: () => void testConnection(target) },
                { label: "删除", danger: true, onSelect: () => setPendingDeleteId(target.id) },
              ]}
            />
          );
        })()}

      {/* 分组右键菜单：重命名 / 删除分组（行内只保留颜色相关的"重置颜色"） */}
      {groupMenu !== undefined &&
        (() => {
          const node = groupRows.find((row) => row.id === groupMenu.groupId);
          if (node === undefined) return null;
          return (
            <ContextMenu
              left={groupMenu.left}
              right={groupMenu.right}
              top={groupMenu.top}
              label={"分组 " + node.path.join(" / ") + " 的操作"}
              returnFocusTo={groupMenu.trigger}
              onClose={() => setGroupMenu(undefined)}
              items={[
                { label: "重命名", onSelect: () => startFolderRename(node) },
                { label: "删除分组", danger: true, onSelect: () => setPendingFolderId(node.id) },
              ]}
            />
          );
        })()}

      {/* 导入预览：先告诉用户会加进来几台，确认后才写盘 */}
      {importPreview !== undefined && (
        <ConfirmDialog
          title="导入 ~/.ssh/config"
          message={
            "在 " + importPreview.path + " 中找到 " + String(importPreview.found) + " 台主机" +
            (importPreview.skipped > 0 ? "（另有 " + String(importPreview.skipped) + " 条跳过）" : "") +
            "。确认后它们会出现在「ssh 导入」分组里。"
          }
          confirmLabel="确认导入"
          onCancel={() => setImportPreview(undefined)}
          onConfirm={() => {
            setImportPreview(undefined);
            void importFromSshConfig();
          }}
        />
      )}
      {/* B5 无障碍：成功与失败各自一个**常驻**容器（role 不切换，只换写哪个），
          空着的那个靠 .uniterminal-live:empty 退出流内布局，不会多出空白。 */}
      <div {...noticeLiveProps("ok")} className="uniterminal-live">
        {notice !== undefined && notice.kind === "ok" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
      <div {...noticeLiveProps("error")} className="uniterminal-live">
        {notice !== undefined && notice.kind === "error" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
      {/* 破坏性操作统一走弹框：就地确认会让行宽跳动、并且屏幕上可能同时出现多处"确认" */}
      {pendingHost !== undefined && (
        <ConfirmDialog
          title="删除主机"
          message={"从本机列表删除「" + pendingHost.name + "」？只会删掉这台主机的配置与已保存的密码，不会影响远端主机。"}
          confirmLabel="删除"
          danger
          onCancel={() => setPendingDeleteId(undefined)}
          onConfirm={() => void remove(pendingHost)}
        />
      )}
      {pendingGroup !== undefined && (
        <ConfirmDialog
          title="删除分组"
          message={"删除分组「" + pendingGroup.name + "」？其中的主机会回到根层，不会被删除。"}
          confirmLabel="删除分组"
          danger
          onCancel={() => setPendingFolderId(undefined)}
          onConfirm={() => void removeFolder(pendingGroup)}
        />
      )}
    </div>
  );
}
