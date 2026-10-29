import { useCallback, useState } from "react";
import { useAutoDismiss } from "./use-auto-dismiss.js";

/**
 * 一次性提示（notice）的共享模型。
 *
 * 为什么成功与失败必须是两种 kind：
 * 提示的**颜色绑定语义**——`.uniterminal-notice` 是错误红（tab.module.css），
 * 而早先四个面板各有一套 notice state，"成功"与"失败"共用同一个字符串 state，
 * 于是「已删除 X」「已导入 N 台主机」「已保存配置」这些**成功反馈也是红的**，
 * 用户只会读成"出错了"。kind 把"这次是成功还是失败"显式带进渲染层，
 * 颜色才能跟着语义走（成功绿 / 失败红），文案不必自己编码颜色。
 *
 * 为什么过期规则只有一个来源：6 秒的存活时间写在 use-auto-dismiss.ts 的
 * AUTO_DISMISS_MS 里，本文件不再另写一个时长常量——改一处即可，四个面板一起变。
 */
export type NoticeKind = "ok" | "error";

export interface Notice {
  text: string;
  kind: NoticeKind;
}

export interface NoticeApi {
  /** 当前提示；undefined = 没有提示。 */
  notice: Notice | undefined;
  /** 失败 / 错误提示（默认语义，与旧的 setNotice(text) 完全一致：调用点无需改动）。 */
  setNotice: (text: string) => void;
  /** 成功提示。 */
  setOk: (text: string) => void;
  /** 手动清掉。 */
  clear: () => void;
}

/**
 * kind → 类名：成功提示在 `.uniterminal-notice` 之上追加 `.uniterminal-notice-ok`，
 * 把默认的错误红覆盖成成功绿；错误提示沿用 `.uniterminal-notice`（仍是红）。
 */
export function noticeClassName(kind: NoticeKind): string {
  return kind === "ok" ? "uniterminal-notice uniterminal-notice-ok" : "uniterminal-notice";
}

/**
 * kind → 常驻 live region 的语义（B5 无障碍）。
 *
 * 为什么成功与失败必须是两种打断强度：
 * - **成功**（status / polite）：等用户把当前这句朗读完再说。「已保存配置」打断一次
 *   屏幕朗读没有任何价值，只会让人丢掉刚才在听的上下文。
 * - **失败**（alert / assertive）：立刻打断。密码错了、列表加载不出来，
 *   用户晚一秒知道就是在错误的方向上多走一步。
 *
 * 为什么是纯函数：和 noticeClassName 一样，「一个 kind 只有一种正确映射」这件事
 * 属于提示模型本身，不该由四个面板各写一遍。纯函数才好单测。
 *
 * 为什么调用点要用**两个**容器而不是一个容器切 role：改 role 等于换语义，
 * 读屏软件未必重新识别同一个节点（常见结果是切换后的一两次播报丢掉）。
 * 所以每个面板挂两个常驻容器，各自固定一种 role，只把文字写进对应的那个。
 */
export function noticeLiveProps(kind: NoticeKind): {
  role: "status" | "alert";
  "aria-live": "polite" | "assertive";
} {
  return kind === "ok"
    ? { role: "status", "aria-live": "polite" }
    : { role: "alert", "aria-live": "assertive" };
}

/**
 * 共享的一次性提示：状态、语义（成功/失败）与自动过期都在这里。
 *
 * setNotice / setOk / clear 都是**稳定引用**（useCallback 空依赖）：
 * 不稳定的话，useAutoDismiss 的计时器会跟着每次渲染重建，
 * 提示在不停重渲染的面板里就可能永不过期。
 */
export function useNotice(): NoticeApi {
  const [notice, setState] = useState<Notice | undefined>(undefined);
  /** 失败提示：与旧的 setNotice(text) 语义完全一致，调用点无需改动。 */
  const setNotice = useCallback((text: string) => setState({ text, kind: "error" }), []);
  /** 成功提示：同一段文案，但语义是"成功了"。 */
  const setOk = useCallback((text: string) => setState({ text, kind: "ok" }), []);
  /** 手动清掉。 */
  const clear = useCallback(() => setState(undefined), []);
  // 过期规则只有一个来源：6 秒后自动消失（AUTO_DISMISS_MS）
  useAutoDismiss(notice !== undefined, clear);
  return { notice, setNotice, setOk, clear };
}
