import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatMonitorLine, monitorSegments, type MonitorSample } from "../monitor.js";
import { parseJsonSafe } from "./http-json.js";
import { LEVEL_COLOR } from "./tokens.js";

/**
 * 刷新间隔与 MobaXterm 一致：1 秒。
 * 但**没有**照抄它的远端常驻 `while true` 循环——实测单次取数只花 34ms、跑完即退、零残留，
 * 每秒轮询已经能做到同样的观感，而常驻循环会永久占着一个远端 bash 进程。
 */
const POLL_INTERVAL_MS = 1000;

const MONITOR_ENDPOINT = "/api/uniterminal/monitor";

/**
 * 状态栏这一行的容器样式：正常行与「指标暂不可用」行共用同一份，
 * 保证替代行的高度与上边框不变（终端高度不跳动）。
 * 横排与收缩（display:flex / minWidth:0）由布局原语承担，这里只留这一行独有的外壳。
 */
const ROW_STYLE: CSSProperties = {
  flex: "0 0 auto",
  overflow: "hidden",
  padding: "4px 10px",
  borderTop: "1px solid var(--ut-border)",
};

/**
 * 行内文字样式：正常行与替代行同一套字号与省略号行为。
 * flex + min-width:0 / 13px / 单行省略由布局原语承担，这里只剩行高。
 */
const TEXT_STYLE: CSSProperties = {
  lineHeight: 1.5,
};

/** 指标不可用时的替代行内容。 */
export interface StatusBarFallback {
  /** 行内文案：弱对比，不用错误色。 */
  text: string;
  /** 悬浮说明：为什么不可用（服务端说不支持 / 请求失败）。 */
  title: string;
}

/**
 * 「指标暂不可用」这一行该不该渲染。
 *
 * M8-20 的原裁定是"拿不到指标就整条不渲染：不占位，也不报错"——
 * **从未成功取到过样本**时继续遵守它（返回 undefined = 什么都不渲染）。
 * 但"曾经取到过、后来取不到了"也整条消失的话，用户看到的就是状态栏凭空不见了，
 * 分不清是主机不支持、会话断了还是宿主没接线。
 * 因此这一档补一行弱对比的替代文案：高度与上边框不变（终端不跳动），
 * 具体原因只放在 title 里，不进正文、也不用错误色。
 */
export function statusBarFallback(
  everAvailable: boolean,
  reason: string | undefined,
): StatusBarFallback | undefined {
  if (!everAvailable) return undefined;
  return {
    text: "指标暂不可用",
    title: reason ?? "指标暂不可用：宿主未说明原因",
  };
}

/**
 * 判定不可用原因时真正用到的三个字段：服务端是否说"不支持"、它给的理由、宿主的错误信息。
 * 只取这三个，函数就能被单测直接钉住，不必先造一份完整的样本。
 */
export interface MonitorAvailability {
  supported?: boolean;
  reason?: string;
  error?: string;
}

/**
 * 不可用的原因文案：服务端说"不支持"与"请求失败"是两回事，
 * 但对用户都表现为指标消失——原因写进 title，不写进正文。
 */
export function unavailableReasonText(
  payload: MonitorAvailability,
  status: number,
  ok: boolean,
): string {
  if (payload.supported === false) {
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return reason === ""
      ? "服务端报告当前环境不支持指标采集"
      : "服务端报告当前环境不支持指标采集：" + reason;
  }
  const detail = typeof payload.error === "string" ? payload.error : "";
  if (detail.startsWith("HTTP ")) return "取数失败：" + detail;
  if (detail !== "") return "取数失败（HTTP " + String(status) + "）：" + detail;
  return ok ? "取数失败：宿主返回的指标数据不完整" : "取数失败（HTTP " + String(status) + "）";
}

/**
 * M8-20 终端视图最下方的 MobaXterm 风格状态栏：
 * 一行显示 CPU、内存 已用/总量、网络 ↓/↑ 速率、运行时长、登录用户数、磁盘占用。
 *
 * 指标由宿主用**独立 exec 通道**取回（见 routes.ts 的 serveMonitor），
 * 这里只负责轮询与渲染——绝不往用户正在用的交互式 shell 里写命令。
 * 拿不到指标（非 Linux、会话已断、宿主没接线）默认整条不渲染：不占位，也不报错（M8-20 原裁定）。
 * 只有一档例外：**这个会话曾经取到过、后来取不到了**——那时状态栏凭空消失会让人以为界面坏了，
 * 于是补一行弱对比的「指标暂不可用」，高度与上边框不变，原因放进 title。
 */
export function StatusBar({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [sample, setSample] = useState<MonitorSample | undefined>(undefined);
  /**
   * 曾经成功取到过样本的会话 id（只记 id：换会话就是换一份"曾经"）。
   * 只有"这个会话曾经有过、后来没了"才补一行提示，从未有过就整条不渲染。
   */
  const everAvailable = useRef<string | undefined>(undefined);
  /** 取不到指标的原因（服务端说不支持 / 请求失败）：只进 title，不占正文。 */
  const [unavailableReason, setUnavailableReason] = useState<string | undefined>(undefined);
  /** 窗口可见性：切回前台要立刻恢复轮询，否则要等下一次 4 秒整点 */
  const [pageVisible, setPageVisible] = useState(() => document.hidden !== true);

  useEffect(() => {
    const onChange = (): void => setPageVisible(document.hidden !== true);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    // 只有"终端视图可见且窗口在前台"才轮询：
    // 面板按 M8-17 只隐藏不卸载，若不停，用户切到文件视图后仍会每 4 秒在服务器上跑一次 exec。
    if (!active || !pageVisible) return;
    // 卸载或换会话后到达的响应一律丢弃：否则旧会话的指标会盖到新会话的状态栏上
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(MONITOR_ENDPOINT + "?sessionId=" + encodeURIComponent(sessionId));
        // 宿主对未知路径的兜底是纯文本 "not found"：先取 text 再交给 parseJsonSafe，绝不裸解析
        const payload = parseJsonSafe<MonitorSample>(await response.text(), response.status);
        if (cancelled) return;
        if (response.ok && payload.supported === true) {
          // 这个会话曾经有过指标：记住它，之后取不到了才补那一行提示
          everAvailable.current = sessionId;
          setUnavailableReason(undefined);
          setSample(payload);
          return;
        }
        // 取不到：区分"服务端说不支持"与"请求失败"，两者都算不可用，原因只进 title
        setSample(undefined);
        setUnavailableReason(unavailableReasonText(payload, response.status, response.ok));
      } catch {
        if (!cancelled) {
          setSample(undefined);
          setUnavailableReason("取数失败：连不上宿主");
        }
      }
    };
    // 串行自调度而不是 setInterval：请求偶尔超过 1 秒时不会叠成一堆并发请求
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      await poll();
      if (cancelled) return;
      timer = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sessionId, active, pageVisible]);

  if (sample === undefined) {
    // 从未取到过 → 整条不渲染（M8-20 原裁定：不占位，也不报错）
    // 取到过又断了 → 一行弱对比的替代文案，终端高度不跳动
    const fallback = statusBarFallback(everAvailable.current === sessionId, unavailableReason);
    if (fallback === undefined) return null;
    return (
      <div
        className="uniterminal-row uniterminal-shrink"
        style={{ ...ROW_STYLE, opacity: 0.55 }}
        role="status"
        // status 这个 role 在 ARIA 里**隐含**一个礼貌播报的 live region：这一行每秒都在重渲染，
        // 不显式关掉的话读屏会被指标淹掉。role 留着——它的语义（"这是一段状态"）
        // 对按需查询（读屏的"读当前行"、无障碍树检查）仍然有效。
        aria-live="off"
      >
        <span
          title={fallback.title}
          className="uniterminal-grow uniterminal-small uniterminal-ellipsis"
          style={TEXT_STYLE}
        >
          {fallback.text}
        </span>
      </div>
    );
  }

  const line = formatMonitorLine(sample);
  const segments = monitorSegments(sample);
  return (
    <div
      className="uniterminal-row uniterminal-shrink"
      style={{ ...ROW_STYLE, opacity: 0.85 }}
      // 常驻状态文本，但**不播报**：指标里有运行时长、CPU 占用，每个 tick 都在变，
      // 挂一个礼貌播报的 live region 会让读屏每一秒打断用户一次。
      // status 这个 role 只提供语义（可被按需读取），aria-live="off" 显式压掉它隐含的播报。
      role="status"
      aria-live="off"
    >
      <span title={line} className="uniterminal-grow uniterminal-small uniterminal-ellipsis" style={TEXT_STYLE}>
        {segments.map((segment, index) => (
          <span key={segment.text}>
            {index > 0 ? "   │   " : ""}
            <span style={segment.level === undefined ? undefined : { color: LEVEL_COLOR[segment.level] }}>
              {segment.text}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}
