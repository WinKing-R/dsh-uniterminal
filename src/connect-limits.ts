/**
 * 连接超时的单一事实来源：引擎用它断开 ssh2 的 readyTimeout，
 * 前端用同一个值算倒计时——两处各写一个数字迟早不一致。
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

/** 超过这个时长才开始显示倒计时：前 5 秒只是"在连"，没到需要催的时候。 */
export const CONNECT_COUNTDOWN_AFTER_MS = 5000;

export interface ConnectProgress {
  /** 是否已该显示倒计时 */
  counting: boolean;
  /** 剩余秒数（向上取整，最小 0） */
  remainingSec: number;
}

/**
 * 把"已经连了多久"换算成界面该显示什么。
 * 纯函数，好测：边界（4.999s / 5s / 19.9s / 20s 之后）都能直接断言。
 */
export function connectProgress(elapsedMs: number, timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): ConnectProgress {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const total = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
  const remainingSec = Math.max(0, Math.ceil((total - elapsed) / 1000));
  return { counting: elapsed >= CONNECT_COUNTDOWN_AFTER_MS, remainingSec };
}
