/**
 * 语义色的单一来源。
 *
 * ## 为什么语义色只能有一处
 *
 * 同一个语义色曾经散在 6 个文件里各写一遍：
 * HostListView 的成功 / 警告 / 危险三色、SftpPanel 的危险色、
 * StatusBar 的三档监控色、TerminalView 的内联色、
 * 私钥图标的古铜色、分组没设颜色时的兜底前景色。
 *
 * 抄开的代价不是"多写了几行"，而是**改一处漏一处**：
 * 危险色改了，SftpPanel 还停在旧值，于是"删除失败"在两个面板里颜色不一样；
 * 监控三档与列表三色一旦漂移，用户就分不清"警告"到底是哪一种。
 *
 * 现在这 6 个值各有一个名字、一处定义。
 * 取值与旧值**逐字一致**（同一个宿主变量名、同一个 fallback 十六进制），
 * 所以这次搬家不改变任何一处的观感——它是"单一事实来源"，不是"重新配色"。
 *
 * 取值用 `var(--dsw-alias-*, #rrggbb)`：
 * 宿主定义了就跟主题走，宿主没定义就回落到那个后备色，明暗两套主题都不用在这里分支。
 */

/** 成功 / 正常。 */
export const COLOR_SUCCESS = "var(--dsw-alias-label-success, #3fb950)";
/** 警告 / 需要注意。 */
export const COLOR_WARNING = "var(--dsw-alias-label-warning, #d9a536)";
/** 危险 / 失败 / 破坏性操作。 */
export const COLOR_DANGER = "var(--dsw-alias-label-error, #e5534b)";
/** 信息 / 中性强调。 */
export const COLOR_INFO = "var(--dsw-alias-label-info, #5a8dee)";

/** 私钥图标的古铜色：它不是状态色，是"这把钥匙"的标识色，故单列。 */
export const KEY_ICON_COLOR = "#b87333";

/** 分组没有自定义颜色时的兜底前景色。 */
export const GROUP_COLOR_FALLBACK = "#d6dde4";

/** 监控指标的分档配色（ok / warn / danger），与上面三色同源。 */
export const LEVEL_COLOR: Record<"ok" | "warn" | "danger", string> = {
  ok: COLOR_SUCCESS,
  warn: COLOR_WARNING,
  danger: COLOR_DANGER,
};
