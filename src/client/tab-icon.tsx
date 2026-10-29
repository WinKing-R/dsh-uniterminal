import type { ReactElement } from "react";

/**
 * 标签图标：圆角方框 + ">_"。
 *
 * 宿主的 `TabDescriptor.icon` 接受 `ReactNode | ((size: number) => ReactNode)`；
 * 我们此前没传，宿主就画了自己的默认方块——所以这个图标"能不能改"的答案是能。
 * 用内联 SVG + `currentColor`：深/浅/彩色主题下都自动跟随，不用 emoji（字形跨机器不一致）。
 */
export function terminalTabIcon(size: number): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7.5 9.5l3 2.5-3 2.5" />
      <path d="M13 15h4" />
    </svg>
  );
}
