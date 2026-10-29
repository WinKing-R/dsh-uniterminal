import type { ReactElement } from "react";

/**
 * 主机行的小图标（内联 SVG）。
 *
 * 为什么用图标而不是文字徽标：把「已记住」「私钥」做成带描边的小方框，
 * 一行里就会多出两个框，和行内动作按钮的框叠在一起，浅色主题下尤其碎。
 * 图标只占 14px、跟随 currentColor，既能说明状态，又不制造新的框。
 *
 * 不用 emoji：字形在不同机器上胖瘦不一，也无法保证「盾牌里镂空一个对勾」这种精确形状。
 */

const BASE = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  // 默认 SVG 是 inline 元素、按文字基线对齐，图标会明显偏下；
  // 改成块级后由外层 inline-flex 的 align-items: center 精确居中。
  style: { display: "block" },
};

/** 盾牌 + 镂空对勾：凭据文件里已经存有这台主机的口令。 */
export function ShieldCheckIcon(): ReactElement {
  return (
    <svg {...BASE}>
      <path d="M12 3l7 3v6c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6l7-3z" />
      <path d="M9 12.2l2.1 2.1L15.2 10" />
    </svg>
  );
}

/** 钥匙：这台主机用私钥登录。 */
export function KeyIcon(): ReactElement {
  return (
    <svg {...BASE}>
      <circle cx="8" cy="16" r="3.2" />
      <path d="M10.4 13.6L20 4" />
      <path d="M17.2 3.6l3.2 3.2" />
      <path d="M14.6 9.4l2.2 2.2" />
    </svg>
  );
}

/** 放大镜：搜索框左侧。用内联 SVG 而不是 emoji——字形跨机器不一致，且无法跟 currentColor。 */
export function SearchIcon(): ReactElement {
  return (
    <svg {...BASE} width={13} height={13}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5.5 5.5" />
    </svg>
  );
}
