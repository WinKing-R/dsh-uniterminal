import type { CSSProperties } from "react";

/**
 * 共享的控件样式。
 *
 * ## 为什么样式常量要共用一份
 *
 * TunnelPanel 与 AppearancePanel 各写了一份几乎一样的 SELECT_STYLE：
 * 两处都在手写"和面板按钮同一个观感"的下拉框（padding / font / color /
 * background / border / borderRadius），改一处就得记得改另一处——
 * 而 select 不在 tab.module.css 的覆盖范围内，改 CSS 根本救不了它。
 *
 * 这里导出**一份**，取值与现状逐字一致（见 test/client/api.test.ts 的锁定断言），
 * 下一轮把两个面板改成导入即可，界面观感不会变。
 */

/** select 不在 tab.module.css 的样式覆盖范围内，这里按同样的观感内联。 */
export const SELECT_STYLE: CSSProperties = {
  padding: "4px 6px",
  font: "inherit",
  color: "inherit",
  background: "transparent",
  border: "1px solid var(--ut-border)",
  borderRadius: 4,
};
