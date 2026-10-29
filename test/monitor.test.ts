import { describe, expect, it } from "vitest";
import { formatMonitorLine, levelOfPct, monitorSegments, parseMonitor } from "../src/monitor.js";

/**
 * M8-20 状态栏解析层：fixture 以真实样本的形状为准（地址用文档保留段 192.0.2.0/24）。
 * 六段之间是命令里的 `echo ---`，一次 exec 把全部指标拼回来（见 routes.ts 的 MONITOR_COMMAND）。
 */
const CPU_LINE = "cpu  28018 1386 67680 48805903 526421 14069 32965 0 0 0";
const MEM_LINES = ["MemTotal:        3708744 kB", "MemAvailable:    2607676 kB"].join("\n");
const UPTIME_LINE = "123886.29 488059.04";
const NET_LINES = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 37126423   75758    0    0    0     0          0         0 37126423   75758    0    0    0     0       0          0",
  "ens160: 24697243356 26539191    0    0    0     0          0       586 22571156081 17492024    0    3    0     0       0          0",
].join("\n");
const DF_LINES = [
  "Filesystem          1024-blocks    Used Available Capacity Mounted on",
  "/dev/mapper/rl-root    62849024 9256484  53592540      15% /",
  "/dev/nvme0n1p2           983040  363332    619708      37% /boot",
].join("\n");

/** 段拼装：顺序与命令里的 echo 顺序严格一致。 */
const segment = (...parts: string[]): string => parts.join("\n---\n");
const REAL_RAW = segment(CPU_LINE, MEM_LINES, UPTIME_LINE, "3", NET_LINES, DF_LINES);

const MEM_TOTAL_KB = 3708744;
const MEM_AVAIL_KB = 2607676;
/** /proc/stat 首行 10 个字段之和与 idle+iowait：两次采样的差值就是 CPU 使用率的分母与分子。 */
const JIFFIES_TOTAL = 49476442;
const JIFFIES_IDLE = 49332324;
/** lo 的 37126423 字节必须被排除：只统计 ens160。 */
const RX_BYTES = 24697243356;
const TX_BYTES = 22571156081;

/** 第二份样本：Δtotal=1000、Δidle=250 → 75%；两个方向各 +1000000 字节、Δt=2s → 500000 B/s。 */
const SECOND_RAW = REAL_RAW.replace(
  "cpu  28018 1386 67680 48805903 526421 14069 32965 0 0 0",
  "cpu  28768 1386 67680 48806153 526421 14069 32965 0 0 0",
)
  .replace("123886.29 488059.04", "123888.29 488059.04")
  .replace(
    "ens160: 24697243356 26539191    0    0    0     0          0       586 22571156081 17492024    0    3    0     0       0          0",
    "ens160: 24698243356 26539191    0    0    0     0          0       586 22572156081 17492024    0    3    0     0       0          0",
  );

const nextOf = (raw: string) => {
  const parsed = parseMonitor(raw);
  if (parsed.next === undefined) throw new Error("first parse must yield a previous-sample state");
  return parsed.next;
};

describe("monitor parsing (M8-20)", () => {
  it("parses the real fixture into a full sample on the first call", () => {
    const { sample, next } = parseMonitor(REAL_RAW);

    expect(sample).toEqual({
      supported: true,
      // 第一次没有上一份样本：CPU 与两个方向都必须留空，绝不编一个 0% 出来
      cpuPct: null,
      memUsedBytes: (MEM_TOTAL_KB - MEM_AVAIL_KB) * 1024,
      memTotalBytes: MEM_TOTAL_KB * 1024,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      uptimeSec: 123886.29,
      users: 3,
    });
    // 宿主必须存下这些原始计数，下一次才算得出差值
    expect(next?.jiffies).toEqual({ total: JIFFIES_TOTAL, idle: JIFFIES_IDLE });
    expect(next?.at).toBeCloseTo(123886.29, 2);
    expect(next?.rx).toBe(RX_BYTES);
    expect(next?.tx).toBe(TX_BYTES);
  });

  it("computes cpu percent and both network rates from the previous sample", () => {
    const second = parseMonitor(SECOND_RAW, nextOf(REAL_RAW));

    expect(second.sample.cpuPct).toBe(75);
    expect(second.sample.rxBytesPerSec).toBe(500000);
    expect(second.sample.txBytesPerSec).toBe(500000);
  });

  it("keeps the loopback interface out of the byte totals", () => {
    // prev 的 rx/tx 记 0，lo 上挂 900000000 字节：速率若把它算进去就会是 4.5e8
    const raw = segment(
      CPU_LINE,
      MEM_LINES,
      // prev.at 记 100 秒：Δt=2 秒，eth0 的 1000/2000 字节才变成 500/1000 B/s
      "102.00 100.00",
      "1",
      [
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
        "    lo: 900000000   75758    0    0    0     0          0         0 900000000   75758    0    0    0     0       0          0",
        "eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
      ].join("\n"),
      DF_LINES,
    );

    const sample = parseMonitor(raw, {
      jiffies: { total: JIFFIES_TOTAL, idle: JIFFIES_IDLE },
      at: 100,
      rx: 0,
      tx: 0,
    }).sample;

    expect(sample.rxBytesPerSec).toBe(500);
    expect(sample.txBytesPerSec).toBe(1000);
  });

  it("answers supported:false instead of throwing when a required section is missing", () => {
    // 只有前三段（CPU / 内存 / uptime）：网络、用户都没回来
    const truncated = segment(CPU_LINE, MEM_LINES, UPTIME_LINE);

    const { sample } = parseMonitor(truncated);

    expect(sample.supported).toBe(false);
    expect(sample.reason).toBeTruthy();
    expect(sample.cpuPct).toBeNull();
    expect(sample.memTotalBytes).toBe(0);
  });

  it("answers supported:false for a non-Linux host", () => {
    const windows = [
      "Microsoft Windows [Version 10.0.19045.3803]",
      "(c) Microsoft Corporation. 保留所有权利。",
      "",
      "C:\\Users\\<you>>",
    ].join("\n");

    const { sample } = parseMonitor(windows);

    expect(sample.supported).toBe(false);
    expect(sample.reason).toBeTruthy();
  });

  it("never divides by zero when the counters did not move", () => {
    const stale = parseMonitor(REAL_RAW, { ...nextOf(REAL_RAW), rx: 0, tx: 0 }).sample;

    expect(stale.supported).toBe(true);
    expect(stale.cpuPct).toBeNull();
    expect(stale.rxBytesPerSec).toBe(0);
    expect(stale.txBytesPerSec).toBe(0);
  });

  it("renders the single MobaXterm-style line", () => {
    const { sample } = parseMonitor(REAL_RAW);

    expect(formatMonitorLine(sample)).toBe(
      "⚙ CPU —   │   ▤ 内存 1.1 GB / 3.5 GB   │   ↓ 0.00 MB/s  ↑ 0.00 MB/s   │   ⏱ 运行 1天10小时   │   👤 用户 3",
    );
    expect(formatMonitorLine({ ...sample, cpuPct: 12 })).toContain("CPU 12.0%");
  });
});

/**
 * M8-28：阈值配色。用户口径是「0~60 绿、61~90 黄、90~100 红」，
 * 边界必须钉死：60 仍是绿（<=60），90 仍是黄（<=90），超过才红。
 * 这属于"看起来对、算错一格就永远错"的逻辑，逐点断言。
 */
describe("threshold levels (M8-28)", () => {
  it("maps percentages onto the three bands at the exact boundaries", () => {
    expect(levelOfPct(0)).toBe("ok");
    expect(levelOfPct(60)).toBe("ok");
    expect(levelOfPct(60.1)).toBe("warn");
    expect(levelOfPct(90)).toBe("warn");
    expect(levelOfPct(90.1)).toBe("danger");
    expect(levelOfPct(100)).toBe("danger");
    // 非法值不能变成红色警报
    expect(levelOfPct(Number.NaN)).toBe("ok");
  });

  it("colors the cpu segment by its own percentage", () => {
    const base = { supported: true, cpuPct: 0, memUsedBytes: 1, memTotalBytes: 100, rxBytesPerSec: 0, txBytesPerSec: 0, uptimeSec: 0, users: 0 };
    expect(monitorSegments({ ...base, cpuPct: 12 })[0]?.level).toBe("ok");
    expect(monitorSegments({ ...base, cpuPct: 75 })[0]?.level).toBe("warn");
    expect(monitorSegments({ ...base, cpuPct: 96 })[0]?.level).toBe("danger");
    // 首次采样没有百分比：不着色，也不假装是 0%
    expect(monitorSegments({ ...base, cpuPct: null })[0]?.level).toBeUndefined();
  });

  it("colors the memory segment by used over total", () => {
    const base = { supported: true, cpuPct: 0, rxBytesPerSec: 0, txBytesPerSec: 0, uptimeSec: 0, users: 0 };
    // 50% → 绿
    expect(monitorSegments({ ...base, memUsedBytes: 50, memTotalBytes: 100 })[1]?.level).toBe("ok");
    // 80% → 黄
    expect(monitorSegments({ ...base, memUsedBytes: 80, memTotalBytes: 100 })[1]?.level).toBe("warn");
    // 95% → 红
    expect(monitorSegments({ ...base, memUsedBytes: 95, memTotalBytes: 100 })[1]?.level).toBe("danger");
  });

  it("leaves the other segments uncolored", () => {
    const base = { supported: true, cpuPct: 99, memUsedBytes: 99, memTotalBytes: 100, rxBytesPerSec: 0, txBytesPerSec: 0, uptimeSec: 0, users: 0 };
    const segments = monitorSegments(base);
    expect(segments.slice(2).every((segment) => segment.level === undefined)).toBe(true);
  });
});
