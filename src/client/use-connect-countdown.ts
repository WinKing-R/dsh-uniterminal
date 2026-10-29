import { useEffect, useState } from "react";
import { connectProgress, type ConnectProgress } from "../connect-limits.js";

/**
 * 连接期间计时，用来显示"超时倒计时"。
 *
 * 只在 connecting 为真时跑计时器：连接一结束立刻归零并清掉 interval，
 * 否则下次连接会带着上一次的 elapsed 起跑（倒计时从 3 秒开始）。
 * 500ms 一跳：1s 一跳的话，数字会在两跳之间"卡"一小会儿。
 */
export function useConnectCountdown(connecting: boolean): ConnectProgress {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!connecting) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(timer);
  }, [connecting]);

  return connectProgress(elapsedMs);
}
