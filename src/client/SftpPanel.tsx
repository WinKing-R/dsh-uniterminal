import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNotice, noticeClassName, noticeLiveProps } from "./notice.js";
import { api } from "./api.js";
import { COLOR_DANGER, COLOR_INFO } from "./tokens.js";
import { parseJsonSafe } from "./http-json.js";

/** 七个文件操作共用一条路由；下载与上传是两条流式端点。 */
const OP_ENDPOINT = "/api/uniterminal/sftp/op";
const DOWNLOAD_ENDPOINT = "/api/uniterminal/sftp/download";
const UPLOAD_ENDPOINT = "/api/uniterminal/sftp/upload";
/** M8-14：宿主真实收到的字节数（浏览器可能根本不发 upload.onprogress）。 */
const UPLOAD_PROGRESS_ENDPOINT = "/api/uniterminal/sftp/upload-progress";
/** 与 engine/sftp.ts 的 SftpEntryType 一致：目录、文件之外还有链接与其他。 */
type EntryType = "file" | "dir" | "symlink" | "other";

interface SftpEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  mtime: number;
  mode: number;
}

interface LsResponse {
  entries?: SftpEntry[];
  error?: string;
}

interface OpResponse {
  op?: string;
  ok?: boolean;
  error?: string;
}

type UploadStatus = "pending" | "uploading" | "done" | "failed" | "cancelled";

/** 每个文件一行上传状态：进度与结果都留在界面上，失败带后端 error 原文。 */
interface UploadOutcome {
  name: string;
  status: UploadStatus;
  loaded: number;
  total: number;
  error?: string;
}

interface Crumb {
  label: string;
  path: string;
}

const TYPE_LABEL: Record<EntryType, string> = { dir: "目录", file: "文件", symlink: "链接", other: "其他" };

const TYPE_ICON: Record<EntryType, string> = { dir: "📁", file: "📄", symlink: "🔗", other: "❔" };

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/** 远端路径一律用 "/" 拼接；根目录本身就以 "/" 结尾，不能拼出 "//"。 */
function childPath(directory: string, name: string): string {
  return directory.endsWith("/") ? directory + name : directory + "/" + name;
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** 面包屑每一段都带绝对路径：点回哪一层都不用再拼字符串。 */
function crumbsOf(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/")) {
    if (part === "") continue;
    current += "/" + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** 目录在前、文件在后，各自按名称排序（链接与其他归到文件一侧）。 */
function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  return [...entries].sort((left, right) => {
    const leftDir = left.type === "dir";
    const rightDir = right.type === "dir";
    if (leftDir !== rightDir) return leftDir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** 字节数按 1024 进制写成 1 位小数的可读文本。 */
function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return String(bytes) + " B";
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(1) + " " + (SIZE_UNITS[unit] ?? "KB");
}

function sizeText(entry: SftpEntry): string {
  if (entry.type === "dir") return "—";
  return bytesText(entry.size);
}

/** 进度百分比：total 未知时按 0 处理，宽度永远不会变成 NaN%。 */
function percentOf(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const value = Math.floor((loaded / total) * 100);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 100 ? 100 : value;
}

/**
 * 显示用百分比：大文件下 17 MB / 4 GB 只有 0.4%，整数百分比会抹成 0%，看着像没动。
 */
function percentText(loaded: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  const value = loaded <= 0 ? 0 : Math.min(100, (loaded / total) * 100);
  if (value >= 100) return "100";
  if (value >= 10) return String(Math.floor(value));
  return value.toFixed(1);
}

/** 进度条宽度：恰好在动的时候至少给 2px，否则「条在走」根本看不见。 */
function barWidth(loaded: number, total: number): string {
  const value = percentOf(loaded, total);
  if (value <= 0 && loaded > 0) return "2px";
  return "max(2px, " + String(value) + "%)";
}

/** 传输速率：字节数与秒数都已知时，给用户一个「它确实在跑」的量。 */
function speedText(loaded: number, elapsedSec: number): string {
  if (!Number.isFinite(loaded) || loaded <= 0 || elapsedSec <= 0) return "";
  return " · " + bytesText(loaded / elapsedSec) + "/s";
}

/** 一行上传文案：进度、完成、取消、失败；失败带后端原文。 */
function uploadText(row: UploadOutcome, elapsedSec: number): string {
  if (row.status === "pending") return "等待上传";
  if (row.status === "uploading") {
    // 字节数可能长时间不动（浏览器不发进度事件时）：秒数在走，至少证明它没死
    const elapsed = elapsedSec > 0 ? " · 已用 " + String(elapsedSec) + "s" : "";
    return (
      "已传 " +
      bytesText(row.loaded) +
      " / " +
      bytesText(row.total) +
      "（" +
      percentText(row.loaded, row.total) +
      "%）" +
      speedText(row.loaded, elapsedSec) +
      elapsed
    );
  }
  if (row.status === "done") return "上传完成";
  // M3-8：取消＝远端什么都没留下，这句话本身要这么写，别让用户以为只是没传完
  if (row.status === "cancelled") return "已取消（远端未生成文件）";
  return "上传失败：" + String(row.error ?? "");
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** ssh2 的 mtime 是秒；0 与非法值按「未知」显示。 */
function timeText(mtime: number): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return "—";
  const date = new Date(mtime * 1000);
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes())
  );
}

/** 结果行全部成功（或取消）后自动清除的等待；失败行永远不自动消失。 */
export const UPLOAD_RESULT_DISMISS_MS = 6000;

/** 「清除」按钮文案：只要结果行还在，这个按钮就在。 */
export const UPLOAD_CLEAR_LABEL = "清除";

/** 只有「一批非空、且没有失败、也没有还在传的行」才自动清除。 */
export function shouldAutoDismissUploads(rows: readonly Pick<UploadOutcome, "status">[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => row.status === "done" || row.status === "cancelled");
}

/**
 * 按上面的策略挂一个定时器，返回取消函数——组件卸载或结果行变化时都要把定时器清掉，
 * 否则一次 unmount 之后还会去 setState。
 */
export function scheduleUploadResultDismiss(
  rows: readonly Pick<UploadOutcome, "status">[],
  clear: () => void,
): () => void {
  if (!shouldAutoDismissUploads(rows)) return () => undefined;
  const timer = setTimeout(clear, UPLOAD_RESULT_DISMISS_MS);
  return () => clearTimeout(timer);
}

export interface UploadResultHandlers {
  /** 用户点「清除」：关掉结果行——失败行不会自动消失，只能这样关。 */
  clear(): void;
  /** 用户点「取消上传」：真的打断当前这次传输。 */
  cancel(): void;
}

/**
 * 上传结果行（M3-9）：进度条只在「传输中」出现，完成 / 失败 / 已取消只留一行文字；
 * 「清除」在结果行存在时始终可见，失败行因此永远能被用户读完再手动关掉。
 */
export function uploadResultsView(
  rows: readonly UploadOutcome[],
  handlers: UploadResultHandlers,
  elapsedSec: number,
): ReactElement {
  return (
    <div className="uniterminal-col uniterminal-small" style={{ gap: 4 }}>
      <div className="uniterminal-row">
        <span className="uniterminal-hint uniterminal-flex-auto">
          上传结果
        </span>
        <button type="button" style={{ padding: "1px 6px" }} onClick={handlers.clear}>
          {UPLOAD_CLEAR_LABEL}
        </button>
      </div>
      {rows.map((row, index) => (
        <div key={row.name + ":" + String(index)} className="uniterminal-col" style={{ gap: 2 }}>
          <div className="uniterminal-row uniterminal-wrap">
            <span className="uniterminal-break">{row.name}</span>
            {/* 失败行走自己的播报通道（B5 无障碍）：结果行在上传开始时就已挂载，
                失败只是往这个**已有**节点里写文字，读屏软件才收得到；
                直接把 role="alert" 挂在条件渲染的结果行上，插入那一刻会被漏播。
                它仍然不进 notice 通道：失败行永远不自动消失，那边 6 秒就没了。 */}
            <div {...noticeLiveProps("error")} className="uniterminal-live">
              {row.status === "failed" && (
                <span style={{ color: COLOR_DANGER }}>{uploadText(row, elapsedSec)}</span>
              )}
            </div>
            {row.status !== "failed" && (
              <span style={{ opacity: row.status === "done" ? 0.85 : 1 }}>{uploadText(row, elapsedSec)}</span>
            )}
            {row.status === "uploading" && (
              <button type="button" style={{ padding: "1px 6px" }} onClick={handlers.cancel}>
                取消上传
              </button>
            )}
          </div>
          {/* 进度条只属于「正在传」：其余状态只有文字结果，不会留一条走满的假进度条
              （class 是断言用的稳定钩子；轨道与填充的固定部分在 .uniterminal-progress-track / -fill） */}
          {row.status === "uploading" && row.total > 0 && (
            <div className="uniterminal-upload-bar uniterminal-progress-track">
              <div
                className="uniterminal-progress-fill"
                style={{ width: barWidth(row.loaded, row.total), background: COLOR_INFO }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export interface SftpPanelProps {
  sessionId: string;
}

/**
 * 远端文件面板（M3-4a）：列目录、上传、下载、新建目录、删除。
 * 所有 JSON 响应都先取 text 再走 parseJsonSafe；下载交给浏览器原生（a + download），
 * 上传请求体就是 File 本身，两处都不会把文件读进内存。
 * M3-6：上传改走 XHR（只有 xhr.upload.onprogress 有真实进度，也只有 abort() 能中断），
 * 并且上传期间面板照常可用——只禁用「上传」按钮本身，避免同一个文件被并发写。
 */
export function SftpPanel({ sessionId }: SftpPanelProps) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<SftpEntry | undefined>(undefined);
  const [deletePending, setDeletePending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<UploadOutcome[]>([]);
  /** 一次性提示走共享模型（notice.ts）：成功是绿、失败是红，过期规则由那一个来源统一负责。 */
  const { notice, setNotice, setOk, clear } = useNotice();
  /** 待确认的覆盖：远端已有同名文件时不静默覆盖，先问一次。 */
  const [conflicts, setConflicts] = useState<{ files: File[]; existing: string[] } | undefined>(undefined);
  /** 上传期间每秒 +1：进度数字不动时，这个秒数至少能证明它没死。 */
  const [elapsedSec, setElapsedSec] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 正在传输的那个 XHR：取消按钮要能真的打断它。 */
  const activeXhrRef = useRef<XMLHttpRequest | undefined>(undefined);
  /** 正在下载的那一个文件：有了 total 才是真进度条。 */
  const [download, setDownload] = useState<{ name: string; loaded: number; total: number } | undefined>(undefined);
  const abortDownloadRef = useRef<AbortController | undefined>(undefined);
  const cancelledRef = useRef(false);

  // M3-9：一批全成功（或取消）6 秒后自动清掉结果行；有任何失败就留着让用户读。
  // 卸载与结果行变化都会走 cleanup，因此不会留下「点了清除又被定时器叫醒」的尾巴。
  useEffect(() => scheduleUploadResultDismiss(uploads, () => setUploads([])), [uploads]);

  useEffect(() => {
    // 上传与下载都要走秒：4 GB 的文件只看字节数变化太慢，秒数与速率才有「在动」的感觉
    if (!uploading && download === undefined) {
      setElapsedSec(0);
      return;
    }
    const timer = setInterval(() => setElapsedSec((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [uploading, download]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    // 换目录/刷新后旧选中项可能已不在列表里：确认框与选中一起清掉
    setSelected(undefined);
    setDeletePending(false);
    void (async () => {
      try {
        const res = await api.post<LsResponse>(OP_ENDPOINT, { sessionId, op: "ls", path });
        if (cancelled) return;
        if (!res.ok) {
          setEntries(undefined);
          setError(res.error.message);
          return;
        }
        setEntries(sortEntries(res.data.entries ?? []));
      } catch (caught) {
        if (!cancelled) {
          setEntries(undefined);
          setError(String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, reloadKey]);

  const reload = (): void => setReloadKey((key) => key + 1);

  /** 上传期间允许切目录：本批文件的目标目录在发起时就已确定，换个目录看也不影响它们。 */
  const navigate = (next: string): void => {
    if (next === path) return;
    setPath(next);
    setError(undefined);
    clear();
    setMkdirOpen(false);
    setNewDirName("");
  };

  /** 单个非流式操作：成功返回 undefined，失败返回后端 error 原文。 */
  async function runOp(op: string, target: string): Promise<string | undefined> {
    try {
      const res = await api.post<OpResponse>(OP_ENDPOINT, { sessionId, op, path: target });
      if (!res.ok) return res.error.message;
      return undefined;
    } catch (caught) {
      return String(caught);
    }
  }

  async function createDirectory(): Promise<void> {
    const name = newDirName.trim();
    if (name === "") {
      setNotice("请输入目录名");
      return;
    }
    if (name.includes("/")) {
      setNotice("目录名不能包含 /");
      return;
    }
    if (creating) return;
    setCreating(true);
    clear();
    const failure = await runOp("mkdir", childPath(path, name));
    setCreating(false);
    if (failure !== undefined) {
      setNotice(failure);
      return;
    }
    setNewDirName("");
    setMkdirOpen(false);
    reload();
  }

  /** 删除的第二步（第一步是工具栏「删除」拉出的确认条）：目录走 rmdir，其余走 unlink。 */
  async function removeSelected(): Promise<void> {
    if (selected === undefined || deleting) return;
    const target = selected;
    setDeleting(true);
    clear();
    const failure = await runOp(target.type === "dir" ? "rmdir" : "unlink", target.path);
    setDeleting(false);
    setDeletePending(false);
    if (failure !== undefined) {
      setNotice(failure);
      return;
    }
    reload();
  }

  /**
   * 单个文件走 XHR：fetch 拿不到上传进度、也没法中断，这两条正是 M3-6 的缺陷。
   * 请求体直接是 File 对象——浏览器自己读盘，这里不把内容读进内存。
   */
  function sendFile(
    url: string,
    file: File,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      activeXhrRef.current = xhr;
      xhr.open("POST", url);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (event: ProgressEvent) => {
        onProgress(event.loaded, event.total > 0 ? event.total : file.size);
      };
      xhr.onload = () => {
        const payload = parseJsonSafe<OpResponse>(xhr.responseText, xhr.status);
        const failed = xhr.status < 200 || xhr.status >= 300;
        resolve(failed ? { ok: false, error: String(payload.error ?? xhr.status) } : { ok: true });
      };
      xhr.onerror = () => resolve({ ok: false, error: "网络错误：上传没有完成" });
      // 用户点「取消上传」：abort 不是失败，不能弹错
      xhr.onabort = () => resolve({ ok: false, cancelled: true });
      xhr.onloadend = () => {
        if (activeXhrRef.current === xhr) activeXhrRef.current = undefined;
      };
      // 浏览器可能不派发 upload.onprogress（实测宿主已收 1.4 GB 而界面仍是 0 B），
      // 因此同时轮询宿主真实收到的字节数，两者取大——进度以服务端为准。
      const poll = setInterval(() => {
        void (async () => {
          const res = await api.get<{ receivedBytes?: number }>(
            UPLOAD_PROGRESS_ENDPOINT + "?sessionId=" + encodeURIComponent(sessionId),
          );
          // 轮询失败不影响上传本身
          if (!res.ok) return;
          const received = res.data.receivedBytes;
          if (typeof received === "number") onProgress(received, file.size);
        })();
      }, 500);
      const stopPoll = (): void => clearInterval(poll);
      xhr.onloadend = () => {
        stopPoll();
        if (activeXhrRef.current === xhr) activeXhrRef.current = undefined;
      };
      xhr.send(file);
    });
  }

  /** 取消上传：断掉当前这次传输，本批没轮到的文件也一并标成「已取消」。 */
  const cancelUploads = (): void => {
    cancelledRef.current = true;
    activeXhrRef.current?.abort();
  };

  /**
   * 逐个上传：每个文件一行进度与结果，某文件失败不影响后续文件。
   * 目标目录在发起这一刻就定死——上传期间用户可以去别的目录，本批文件仍落到发起处。
   */
  async function uploadFiles(files: File[], overwrite = false): Promise<void> {
    if (files.length === 0 || uploading) return;
    const directory = path;
    if (!overwrite) {
      // 覆盖前先问：远端同名文件是用户的真实数据，不能"先覆盖再道歉"
      const existing: string[] = [];
      for (const file of files) {
        const failure = await runOp("stat", childPath(directory, file.name));
        if (failure === undefined) existing.push(file.name);
      }
      if (existing.length > 0) {
        setConflicts({ files, existing });
        return;
      }
    }
    cancelledRef.current = false;
    setUploading(true);
    clear();
    setUploads(files.map((file) => ({ name: file.name, status: "pending", loaded: 0, total: file.size })));
    const patch = (index: number, next: Partial<UploadOutcome>): void => {
      setUploads((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...next } : row)));
    };
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file === undefined) continue;
      if (cancelledRef.current) break;
      patch(index, { status: "uploading", loaded: 0, total: file.size });
      const url =
        UPLOAD_ENDPOINT +
        "?sessionId=" +
        encodeURIComponent(sessionId) +
        "&path=" +
        encodeURIComponent(childPath(directory, file.name)) +
        (overwrite ? "&overwrite=true" : "");
      const result = await sendFile(url, file, (loaded, total) => patch(index, { loaded, total }));
      if (result.cancelled === true) {
        patch(index, { status: "cancelled" });
        cancelledRef.current = true;
        break;
      }
      if (result.ok) patch(index, { status: "done", loaded: file.size, total: file.size });
      else patch(index, { status: "failed", error: result.error });
    }
    // 取消后没轮到的文件同样显示「已取消」，不会永远停在「等待上传」
    setUploads((current) => current.map((row) => (row.status === "pending" ? { ...row, status: "cancelled" } : row)));
    activeXhrRef.current = undefined;
    setUploading(false);
    reload();
  }

  /**
   * 下载：优先用 File System Access 流式写盘（有真实进度、不占内存）；
   * 环境不支持时回退浏览器原生下载，并明确告诉用户已开始——否则面板里点完毫无反馈。
   */
  async function downloadEntry(entry: SftpEntry): Promise<void> {
    const url = downloadUrl(entry);
    const picker = (globalThis as unknown as { showSaveFilePicker?: (options: unknown) => Promise<unknown> })
      .showSaveFilePicker;
    if (picker === undefined) {
      setOk("已交给浏览器下载：" + entry.name);
      const anchorElement = document.createElement("a");
      anchorElement.href = url;
      anchorElement.download = entry.name;
      anchorElement.click();
      return;
    }
    let writable: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } | undefined;
    try {
      const handle = (await picker({ suggestedName: entry.name })) as {
        createWritable: () => Promise<{ write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> }>;
      };
      writable = await handle.createWritable();
    } catch {
      // 用户取消选择，或该环境不允许（例如跨源 iframe）：退回原生下载，别让点击变哑巴
      return;
    }
    const controller = new AbortController();
    abortDownloadRef.current = controller;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || response.body === null) throw new Error("下载失败：" + String(response.status));
      // 头部缺失时退回列表里已知的大小，避免「已收 9.6 MB / 0 B（0%）」这种自相矛盾的显示
      const total = Number(response.headers.get("content-length") ?? 0) || entry.size;
      let loaded = 0;
      setDownload({ name: entry.name, loaded: 0, total });
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        setDownload({ name: entry.name, loaded, total });
      }
      await writable.close();
      setOk("已保存 " + entry.name);
    } catch (error) {
      // 用户自己取消 = 成功语义（绿）；真失败 = 失败语义（红）
      if ((error as { name?: string }).name === "AbortError") setOk("已取消下载");
      else setNotice("下载失败：" + String(error));
      try {
        await writable.close();
      } catch {
        // 关不掉就交给 GC
      }
    } finally {
      setDownload(undefined);
      abortDownloadRef.current = undefined;
    }
  }

  /** 覆盖：带着 overwrite=true 重跑这批文件。 */
  const confirmOverwrite = (): void => {
    const pending = conflicts;
    setConflicts(undefined);
    if (pending !== undefined) void uploadFiles(pending.files, true);
  };

  /** 跳过：只上传远端不存在的那些。 */
  const skipExisting = (): void => {
    const pending = conflicts;
    setConflicts(undefined);
    if (pending === undefined) return;
    const fresh = pending.files.filter((file) => !pending.existing.includes(file.name));
    if (fresh.length > 0) void uploadFiles(fresh, false);
  };

    const downloadUrl = (entry: SftpEntry): string =>
    DOWNLOAD_ENDPOINT +
    "?sessionId=" +
    encodeURIComponent(sessionId) +
    "&path=" +
    encodeURIComponent(entry.path);

  const crumbs = crumbsOf(path);

  return (
    <div className="uniterminal-col" style={{ gap: 8, flex: "1 1 auto", minHeight: 0 }}>
      <div className="uniterminal-row uniterminal-wrap uniterminal-shrink">
        <button type="button" disabled={path === "/"} onClick={() => navigate(parentPath(path))}>
          上级目录
        </button>
        <button type="button" onClick={reload}>
          刷新
        </button>
        <span className="uniterminal-row-tight uniterminal-wrap uniterminal-shrink uniterminal-body" style={{ gap: 2 }}>
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="uniterminal-shrink" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              {index > 0 && <span style={{ opacity: 0.5 }}>/</span>}
              <button
                type="button"
                style={{
                  padding: "1px 4px",
                  border: "none",
                  opacity: index === crumbs.length - 1 ? 1 : 0.75,
                  fontWeight: index === crumbs.length - 1 ? 600 : 400,
                }}
                onClick={() => navigate(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </span>
      </div>
      <div className="uniterminal-row uniterminal-wrap">
        <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "上传中…" : "上传"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            const picked = event.target.files === null ? [] : Array.from(event.target.files);
            // 清空 value：同一个文件连续选两次也要再触发一次 change
            event.target.value = "";
            void uploadFiles(picked);
          }}
        />
        <button
          type="button"
          disabled={creating}
          onClick={() => {
            setMkdirOpen((open) => !open);
            setNewDirName("");
            clear();
          }}
        >
          新建目录
        </button>
        <button
          type="button"
          disabled={deleting || selected === undefined}
          // 平时是普通按钮；鼠标一移上去立刻变"危险态"，按下前就能看见后果
          className="uniterminal-danger-on-hover"
          onClick={() => setDeletePending(true)}
        >
          删除
        </button>
        {selected !== undefined && <span className="uniterminal-hint">已选中 {selected.name}</span>}
      </div>
      {conflicts !== undefined && (
        <div className="uniterminal-notice uniterminal-row uniterminal-wrap uniterminal-body">
          <span>
            {"远端已存在 " +
              String(conflicts.existing.length) +
              " 个同名文件：" +
              conflicts.existing.join("、") +
              "。覆盖会替换原有内容。"}
          </span>
          <button type="button" style={{ padding: "1px 8px" }} onClick={confirmOverwrite}>
            覆盖
          </button>
          <button type="button" style={{ padding: "1px 8px" }} onClick={skipExisting}>
            跳过已存在
          </button>
          <button
            type="button"
            style={{ padding: "1px 8px" }}
            onClick={() => setConflicts(undefined)}
          >
            取消
          </button>
        </div>
      )}
      {mkdirOpen && (
        <div className="uniterminal-row uniterminal-wrap">
          <input
            value={newDirName}
            placeholder="新目录名称"
            disabled={creating}
            onChange={(event) => setNewDirName(event.target.value)}
            style={{ width: 220 }}
          />
          <button type="button" disabled={creating} onClick={() => void createDirectory()}>
            {creating ? "创建中…" : "创建"}
          </button>
          <button
            type="button"
            disabled={creating}
            onClick={() => {
              setMkdirOpen(false);
              setNewDirName("");
              clear();
            }}
          >
            取消
          </button>
        </div>
      )}
      {deletePending && selected !== undefined && (
        <div className="uniterminal-row uniterminal-wrap">
          <span
            // 不可恢复的操作要用危险色：红色是唯一不依赖阅读文字的警示
            className="uniterminal-body uniterminal-strong"
            style={{ color: COLOR_DANGER }}
          >
            确认删除{selected.type === "dir" ? "目录" : "文件"}「{selected.name}」？此操作不可恢复。
          </span>
          <button
            type="button"
            disabled={deleting}
            // 字号由 .uniterminal-pane button 统一锁定 13px（与提示文字同档）；这里只补语义色与加粗
            style={{ color: COLOR_DANGER, fontWeight: 600 }}
            onClick={() => void removeSelected()}
          >
            确认删除
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => setDeletePending(false)}
          >
            取消
          </button>
        </div>
      )}
      {download !== undefined && (
        <div className="uniterminal-col uniterminal-small" style={{ gap: 4 }}>
          <div className="uniterminal-row">
            <span className="uniterminal-ellipsis uniterminal-flex-auto">
              {"下载 " +
                download.name +
                " · 已收 " +
                bytesText(download.loaded) +
                " / " +
                bytesText(download.total) +
                "（" +
                percentText(download.loaded, download.total) +
                "%）" + speedText(download.loaded, elapsedSec) +
                (elapsedSec > 0 ? " · 已用 " + String(elapsedSec) + "s" : "")}
            </span>
            <button
              type="button"
              style={{ padding: "1px 6px" }}
              onClick={() => abortDownloadRef.current?.abort()}
            >
              取消下载
            </button>
          </div>
          <div className="uniterminal-progress-track">
            <div
              className="uniterminal-progress-fill"
              style={{ width: barWidth(download.loaded, download.total), background: COLOR_INFO }}
            />
          </div>
        </div>
      )}
      {uploads.length > 0 &&
        uploadResultsView(uploads, {
          clear: () => setUploads([]),
          cancel: cancelUploads,
        }, elapsedSec)}
      {/* B5 无障碍：两个常驻容器，按 kind 只往其中一个写文字（role 不切换） */}
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
      <div
        className="uniterminal-flex-auto uniterminal-fill"
        style={{
          overflow: "auto",
          border: "1px solid var(--ut-border)",
          borderRadius: 4,
        }}
      >
        <div
          className="uniterminal-small"
          style={{
            display: "flex",
            gap: 8,
            padding: "4px 8px",
            opacity: 0.7,
            borderBottom: "1px solid var(--ut-border)",
          }}
        >
          <span className="uniterminal-grow">名称</span>
          <span className="uniterminal-right uniterminal-col-size">大小</span>
          <span className="uniterminal-col-mtime">修改时间</span>
          <span className="uniterminal-right uniterminal-col-actions">操作</span>
        </div>
        {loading && (
          <p className="uniterminal-hint" style={{ padding: 8 }}>
            加载中…
          </p>
        )}
        {/* 目录加载失败：B5 之前这处是**完全静音**的（没有任何 live region），
            读屏用户点进一个打不开的目录，界面上什么都不发生。
            容器常驻、条件只决定里面的文字——条件渲染的容器读屏往往整条漏播。 */}
        <div {...noticeLiveProps("error")} className="uniterminal-live">
          {!loading && error !== undefined && (
            <p className="uniterminal-notice uniterminal-break" style={{ padding: 8 }}>
              {error}
            </p>
          )}
        </div>
        {!loading && error === undefined && entries !== undefined && entries.length === 0 && (
          <p className="uniterminal-hint" style={{ padding: 8 }}>
            此目录为空
          </p>
        )}
        {!loading &&
          entries !== undefined &&
          entries.map((entry) => (
            <div
              key={entry.path}
              onClick={(event) => {
                // 文件名那一格自己就是「选中」按钮：这次点击是它冒泡上来的，别再处理第二遍
                if (event.target instanceof Element && event.target.closest("button") !== null) return;
                setSelected(entry);
                setDeletePending(false);
              }}
              onDoubleClick={() => {
                if (entry.type === "dir") navigate(entry.path);
              }}
              className="uniterminal-row"
              style={{
                padding: "4px 8px",
                cursor: "pointer",
                background:
                  selected !== undefined && selected.path === entry.path ? "rgba(120, 160, 220, 0.18)" : "transparent",
                borderBottom: "1px solid rgba(128, 128, 128, 0.16)",
              }}
            >
              <span
                className="uniterminal-grow uniterminal-row-tight"
                style={{ gap: 6, overflow: "hidden", whiteSpace: "nowrap" }}
              >
                <span title={TYPE_LABEL[entry.type]} aria-hidden="true">
                  {TYPE_ICON[entry.type]}
                </span>
                {/* B5 无障碍：文件名自己就是「选中」的键盘入口（行容器的 onClick 只留鼠标便利）。
                    单击仍然只是选中——「进入目录」还在双击与动作列按钮上，语义不混。
                    aria-pressed 让读屏读得出选中态；外观由
                    .uniterminal-pane .uniterminal-file-name 压回原来的 <span> 样子。 */}
                <button
                  type="button"
                  className="uniterminal-file-name uniterminal-self-center"
                  aria-pressed={selected?.path === entry.path}
                  onClick={() => {
                    setSelected(entry);
                    setDeletePending(false);
                  }}
                >
                  {entry.name}
                </button>
              </span>
              <span className="uniterminal-right uniterminal-col-size" style={{ fontVariantNumeric: "tabular-nums" }}>{sizeText(entry)}</span>
              <span className="uniterminal-col-mtime" style={{ opacity: 0.8 }}>{timeText(entry.mtime)}</span>
              <span className="uniterminal-col-actions" style={{ display: "flex", justifyContent: "flex-end" }} onClick={(event) => event.stopPropagation()}>
                {entry.type === "dir" ? (
                  <button type="button" style={{ padding: "1px 6px" }} onClick={() => navigate(entry.path)}>
                    打开
                  </button>
                ) : (
                  // 下载走浏览器原生：a 标签 + download 属性指向流式端点，不 fetch、不进内存
                  <button
                      type="button"
                      style={{ padding: "1px 6px" }}
                      onClick={() => void downloadEntry(entry)}
                    >
                      下载
                    </button>
                )}
              </span>
            </div>
          ))}
      </div>
      <p className="uniterminal-hint">
        {path} · {entries === undefined ? 0 : entries.length} 项
      </p>
    </div>
  );
}
