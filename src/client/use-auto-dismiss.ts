import { useEffect, useRef } from "react";

/** 一次性提示的存活时间：与各面板保持一致，改这一处即可。 */
export const AUTO_DISMISS_MS = 6000;

/**
 * 让"一次性提示"自己消失。
 *
 * 为什么做成共享 hook：同一类缺陷在本项目出现过三次
 * （SFTP 面板、会话标签、主机列表各有一套自己的 notice），每加一个组件就漏一次。
 * **判断标准**：这是"操作反馈"还是"状态说明"？
 * - 操作反馈（已保存 / 已重命名 / 已取消下载）→ 用它，必须过期；
 * - 状态说明（列表加载失败、会话已结束）→ 不要用，它会解释为什么界面是空的。
 *
 * 为什么 clear 不能进依赖数组：调用点几乎都写成
 * `useAutoDismiss(notice !== undefined, () => setNotice(undefined))`，
 * 那个箭头函数**每次渲染都是新身份**。它一旦进了依赖，父组件每重渲染一次
 * 就重建 6 秒计时器——在会不停重渲染的面板里，一次性提示可能**永不过期**。
 * 现在依赖只有 [active, ms]：倒计时只在"提示出现/消失"与"时长变化"时重启；
 * 到点时调用 ref 里**当下**的 clear，语义与从前完全一致。
 */
export function useAutoDismiss(
  active: boolean,
  clear: () => void,
  ms: number = AUTO_DISMISS_MS,
): void {
  /** 最新 clear 的引用：计时器到点时用它，保证调用的是当下的清空函数。 */
  const clearRef = useRef(clear);
  useEffect(() => {
    clearRef.current = clear;
  }, [clear]);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => clearRef.current(), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
}
