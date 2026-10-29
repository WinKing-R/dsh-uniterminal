/**
 * M8-20 终端状态栏的解析层：远端 /proc 与 df 的原始文本 → MonitorSample。
 *
 * 这里全部是纯函数：路由只负责"一次 exec + 按 sessionId 存上一份样本"，
 * 差值计算与格式化的每一条口径都能被单测直接钉住。
 */

/** 状态栏需要的全部指标。supported=false 时其余字段一律为 0 / 空，绝不编数字。 */
export interface MonitorSample {
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

/**
 * 上一份样本：CPU 与网络都是**累计计数器**，速率只能靠两次采样的差值算。
 * at 记的是那一份样本的 /proc/uptime 秒数（单调、不受墙钟调整影响）：
 * 于是 Δ 秒完全由远端数据决定，parseMonitor 才保持纯函数、可确定单测。
 */
export interface MonitorPrev {
  jiffies: { total: number; idle: number };
  at: number;
  rx: number;
  tx: number;
}

export interface MonitorParseResult {
  sample: MonitorSample;
  /** 下一次解析要用的上一份样本；解析失败时原样带回旧的，不把差值窗口打断。 */
  next?: MonitorPrev;
}

/** 命令里用 echo 拼出的段落分隔线。 */
const SEPARATOR = "---";
/** CPU / 内存 / uptime / 用户数 / 网卡 / df 六段，缺一段就没有可用的状态栏。 */
const REQUIRED_SECTIONS = 5;
/** MobaXterm 也只列两个挂载点：状态栏是一行，不是文件浏览器。 */
const MAX_DISKS = 2;
/** 伪文件系统：它们的容量对"磁盘占用"没有意义。 */
const PSEUDO_FILESYSTEMS: ReadonlySet<string> = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs"]);

const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0);

interface CpuCounters {
  total: number;
  idle: number;
}

/** 解析不出来时的空样本：supported:false + 原因，其余字段全 0（路由在 exec 失败时也用它）。 */
export const unsupportedSample = (reason: string): MonitorSample => ({
  supported: false,
  cpuPct: null,
  memUsedBytes: 0,
  memTotalBytes: 0,
  rxBytesPerSec: 0,
  txBytesPerSec: 0,
  uptimeSec: 0,
  users: 0,
  reason,
});

const unsupported = (reason: string, prev?: MonitorPrev): MonitorParseResult => ({
  sample: unsupportedSample(reason),
  next: prev,
});

/** 按 echo --- 切成段；段内保留原始行（空行也算，df 与网卡都要靠"有没有内容"判缺失）。 */
function splitSections(raw: string): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === SEPARATOR) {
      sections.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  sections.push(current);
  return sections;
}

const hasContent = (section: string[] | undefined): boolean =>
  section !== undefined && section.some((line) => line.trim() !== "");

/**
 * /proc/stat 首行：total = 所有字段之和，idle = idle + iowait。
 * 后面那个 0 0 0 是 guest/guest_nice 一类字段：一并计入 total，与内核自己的口径一致。
 */
function parseCpu(section: string[] | undefined): CpuCounters | undefined {
  const line = section?.find((item) => item.trimStart().startsWith("cpu "));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/).slice(1);
  // user nice system idle 是最少的四个字段，再少就是脏数据
  if (fields.length < 4) return undefined;
  let total = 0;
  for (const field of fields) {
    const value = Number(field);
    if (!Number.isFinite(value) || value < 0) return undefined;
    total += value;
  }
  const idle = Number(fields[3] ?? "0") + Number(fields[4] ?? "0");
  if (!Number.isFinite(idle)) return undefined;
  return { total, idle };
}

/** /proc/meminfo 的一行：`MemTotal:        3708744 kB` → 3708744（kB）。 */
function parseMemKb(section: string[], key: string): number | undefined {
  for (const line of section) {
    if (!line.startsWith(key + ":")) continue;
    const value = Number(line.slice(key.length + 1).replace(/kB/i, "").trim());
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

/** 段首那个数字：用于 /proc/uptime（带小数）与 who | wc -l（整数）。 */
function parseLeadingNumber(section: string[] | undefined): number | undefined {
  const first = section?.find((line) => line.trim() !== "");
  if (first === undefined) return undefined;
  const value = Number((first.trim().split(/\s+/)[0] ?? "").trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * /proc/net/dev：每行 `name: rx ... tx ...`，接收第 1 列、发送第 9 列。
 * lo 必须排除——回环流量会随本地服务放大，算进"网络速率"完全是噪音。
 * 只要认出至少一个接口（含被排除的 lo）就算这一段可读，避免把"只有 lo 的容器"当成非 Linux。
 */
function parseNet(section: string[] | undefined): { rx: number; tx: number } | undefined {
  if (section === undefined) return undefined;
  let rx = 0;
  let tx = 0;
  let interfaces = 0;
  for (const line of section) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "") continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    const received = Number(fields[0] ?? "");
    const transmitted = Number(fields[8] ?? "");
    if (!Number.isFinite(received) || !Number.isFinite(transmitted)) continue;
    interfaces += 1;
    if (name === "lo") continue;
    rx += received;
    tx += transmitted;
  }
  return interfaces === 0 ? undefined : { rx, tx };
}

/** df -Pk：Capacity 列（`15%`）与挂载点；伪文件系统整行丢掉。 */
function parseDisks(section: string[] | undefined): { mount: string; usedPct: number }[] {
  const disks: { mount: string; usedPct: number }[] = [];
  for (const line of section ?? []) {
    const fields = line.trim().split(/\s+/);
    // 源 + 容量 + 挂载点至少要 6 列；表头行的第 5 列是 "Capacity"，会被百分号判断挡掉
    if (fields.length < 6) continue;
    const source = fields[0] ?? "";
    const capacity = fields[4] ?? "";
    // 挂载点理论上可以带空格：从第 6 列起整段接回来
    const mount = fields.slice(5).join(" ");
    if (mount === "" || !capacity.endsWith("%")) continue;
    if (PSEUDO_FILESYSTEMS.has(source.toLowerCase())) continue;
    const usedPct = Number(capacity.slice(0, -1));
    if (!Number.isFinite(usedPct)) continue;
    disks.push({ mount, usedPct });
    if (disks.length === MAX_DISKS) break;
  }
  return disks;
}

/**
 * 解析一次 exec 的输出。prev 是同一会话上一份样本（首次没有）：
 * CPU 用两次 jiffies 的差值，网络用两次累计字节数除 Δ 秒；首次一律给 null / 0。
 * 任何一段缺失或格式不对都返回 supported:false + reason，绝不抛。
 */
export function parseMonitor(raw: string, prev?: MonitorPrev): MonitorParseResult {
  const sections = splitSections(raw);
  if (sections.length < REQUIRED_SECTIONS) return unsupported("missing sections", prev);

  const cpu = parseCpu(sections[0]);
  if (cpu === undefined) return unsupported("unreadable /proc/stat", prev);
  const memSection = sections[1] ?? [];
  const totalKb = parseMemKb(memSection, "MemTotal");
  const availableKb = parseMemKb(memSection, "MemAvailable");
  if (totalKb === undefined || availableKb === undefined) return unsupported("unreadable /proc/meminfo", prev);
  const uptime = parseLeadingNumber(sections[2]);
  if (uptime === undefined) return unsupported("unreadable /proc/uptime", prev);
  const users = parseLeadingNumber(sections[3]);
  if (users === undefined || !Number.isInteger(users)) return unsupported("unreadable user count", prev);
  const net = parseNet(sections[4]);
  if (net === undefined) return unsupported("unreadable /proc/net/dev", prev);

  // CPU：首次没有上一份样本 → null（不是 0%）；两次之间计数没动也没有可报的占比
  let cpuPct: number | null = null;
  if (prev !== undefined) {
    const totalDelta = cpu.total - prev.jiffies.total;
    if (totalDelta > 0) {
      const idleDelta = cpu.idle - prev.jiffies.idle;
      cpuPct = Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
    }
  }

  // 网络：Δ 秒用 uptime 的差（单调）；首次或时间没走 → 0。计数器重置时按 0 处理，绝不出现负数。
  const elapsedSec = prev === undefined ? 0 : uptime - prev.at;
  const rate = (current: number, previous: number): number =>
    elapsedSec > 0 ? Math.max(0, current - previous) / elapsedSec : 0;

  return {
    sample: {
      supported: true,
      cpuPct,
      memUsedBytes: (totalKb - availableKb) * 1024,
      memTotalBytes: totalKb * 1024,
      rxBytesPerSec: rate(net.rx, prev?.rx ?? net.rx),
      txBytesPerSec: rate(net.tx, prev?.tx ?? net.tx),
      uptimeSec: uptime,
      users,
    },
    next: { jiffies: cpu, at: uptime, rx: net.rx, tx: net.tx },
  };
}

const formatBytes = (bytes: number): string => {
  const value = finiteOrZero(bytes);
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1) + " GB";
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + " MB";
  return String(Math.round(value / 1024)) + " KB";
};

/** 速率统一用 MB/s 两位小数：0 就是 "0.00 MB/s"，不显示 "0 B/s" 这类跳字。 */
const formatRate = (bytesPerSec: number): string => (finiteOrZero(bytesPerSec) / 1024 ** 2).toFixed(2) + " MB/s";

/** 运行时长按 MobaXterm 的两级口径：有天数就报"天 + 小时"，否则"小时 + 分钟"。 */
const formatUptime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(finiteOrZero(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return String(days) + "天" + String(hours) + "小时";
  if (hours > 0) return String(hours) + "小时" + String(minutes) + "分钟";
  return String(minutes) + "分钟";
};

/**
 * 状态栏那一行文本（M8-20）：CPU 12% · 内存 1.1 GB / 3.5 GB · ↓ 0.00 MB/s ↑ 0.00 MB/s ·
 * 运行 1天10小时 · 用户 3 · / 15% · /boot 37%。
 * 纯格式化，单独导出是为了让"到底显示成什么"能被单测钉住（组件本身只负责轮询与渲染）。
 */
/** 分级：0~60 正常，60~90 警告，>90 危险。 */
export type MonitorLevel = "ok" | "warn" | "danger";

/** 状态栏的一段文本；level 只有 CPU 与内存会带（其余项没有阈值语义）。 */
export interface MonitorSegment {
  text: string;
  level?: MonitorLevel;
}

/** 按百分比分级：<=60 绿、<=90 黄、其余红。 */
export function levelOfPct(pct: number): MonitorLevel {
  const value = Number.isFinite(pct) ? pct : 0;
  if (value <= 60) return "ok";
  if (value <= 90) return "warn";
  return "danger";
}

/**
 * 状态栏一行文本。用图标+竖线分隔：纯数字串在 11px 下分不清哪段是哪项
 * （用户实报「没有图标区分不开是什么东西」「间隔太小」）。
 * 图标只做前缀，**标签文字保留**——万一字体缺字形，仍能读懂。
 */
export function formatMonitorLine(sample: MonitorSample): string {
  // 单一事实来源：文本永远由 monitorSegments 产出，避免"显示"与"着色"各写一套
  return monitorSegments(sample)
    .map((segment) => segment.text)
    .join("   │   ");
}

/**
 * 结构化版本：CPU 与内存带上等级，供状态栏着色。
 * 文本内容与 formatMonitorLine 完全一致（后者就是它的拼接结果），
 * 因此"显示什么"与"什么颜色"不会各说一套。
 */
export function monitorSegments(sample: MonitorSample): MonitorSegment[] {
  const cpuText =
    sample.cpuPct === null || !Number.isFinite(sample.cpuPct)
      ? "⚙ CPU —"
      : "⚙ CPU " + sample.cpuPct.toFixed(1) + "%";
  const memPct =
    sample.memTotalBytes > 0 ? (sample.memUsedBytes / sample.memTotalBytes) * 100 : 0;
  return [
    { text: cpuText, level: sample.cpuPct === null ? undefined : levelOfPct(sample.cpuPct) },
    {
      text: "▤ 内存 " + formatBytes(sample.memUsedBytes) + " / " + formatBytes(sample.memTotalBytes),
      level: levelOfPct(memPct),
    },
    { text: "↓ " + formatRate(sample.rxBytesPerSec) + "  ↑ " + formatRate(sample.txBytesPerSec) },
    { text: "⏱ 运行 " + formatUptime(sample.uptimeSec) },
    { text: "👤 用户 " + String(Math.round(finiteOrZero(sample.users))) },
  ];
}
