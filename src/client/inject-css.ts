import xtermCss from "@xterm/xterm/css/xterm.css";
import tabCss from "./tab.module.css";

const PLUGIN_ID = "@winking-r/dsh-uniterminal";

let injected = false;

/** 与真实插件同一套注入方式：style[data-plugin-css] 去重，挂到 document.head。 */
function inject(tagId: string, css: string): void {
  const selector = "style[data-plugin-css=" + JSON.stringify(tagId) + "]";
  if (document.querySelector(selector) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = PLUGIN_ID;
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** 每个文档只注入一次；SSR / 无 document 时静默跳过。 */
export function ensureUniterminalCss(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  inject(PLUGIN_ID + "/xterm.css", xtermCss);
  inject(PLUGIN_ID + "/tab.module.css", tabCss);
}
