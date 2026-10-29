import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { Appearance } from "./AppearancePanel.js";
import { ensureUniterminalCss } from "./inject-css.js";
import { reportClient } from "./report.js";

/** 侧边栏拖宽会连续触发尺寸变化：80ms 合并一次，既跟手又不至于每像素都 fit。 */
const FIT_DEBOUNCE_MS = 80;

/** 深色：宿主主题变量读不到时的回落色，也是 themeMode: "dark" 的配色。 */
const DARK_PALETTE = {
  background: "#101418",
  foreground: "#d6dde4",
  cursor: "#7aa2f7",
  selectionBackground: "#2a3441",
};

/** 浅色：与 DSH 亮色主题同观感的黑白配。 */
const LIGHT_PALETTE = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#cfe0f5",
};

/** follow 模式按顺序读这些宿主变量，取到第一个非空值就用它（变量名来自宿主 Web GUI 主题）。 */
const FOLLOW_VARS = {
  background: ["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1"],
  foreground: ["--dsw-alias-label-primary"],
  cursor: ["--dsw-alias-brand-primary", "--dsw-alias-label-secondary"],
  selectionBackground: ["--dsw-alias-interactive-bg-hover", "--dsw-alias-bg-layer-2"],
};

type Palette = typeof DARK_PALETTE;

/** 依次尝试候选变量；一个都读不到就用 fallback。 */
function firstVariable(style: CSSStyleDeclaration, names: string[], fallback: string): string {
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") return value;
  }
  return fallback;
}

/** follow：主题变量挂在 document.documentElement 上；读不到就回落深色，终端永远有可见配色。 */
function followPalette(): Palette {
  if (typeof document === "undefined") return DARK_PALETTE;
  const style = getComputedStyle(document.documentElement);
  return {
    background: firstVariable(style, FOLLOW_VARS.background, DARK_PALETTE.background),
    foreground: firstVariable(style, FOLLOW_VARS.foreground, DARK_PALETTE.foreground),
    cursor: firstVariable(style, FOLLOW_VARS.cursor, DARK_PALETTE.cursor),
    selectionBackground: firstVariable(style, FOLLOW_VARS.selectionBackground, DARK_PALETTE.selectionBackground),
  };
}

/** themeMode → xterm 主题：custom 用给定四色，dark / light 用内置，follow 读宿主变量。 */
function resolveTheme(appearance: Appearance): ITheme {
  switch (appearance.themeMode) {
    case "dark":
      return DARK_PALETTE;
    case "light":
      return LIGHT_PALETTE;
    case "custom":
      return {
        background: appearance.background,
        foreground: appearance.foreground,
        cursor: appearance.cursor,
        selectionBackground: appearance.selectionBackground,
      };
    case "follow":
      return followPalette();
  }
}

/** 把外观写进活着的 terminal：5 个 options 与契约字段一一对应。 */
function applyAppearance(terminal: Terminal, appearance: Appearance): void {
  terminal.options.fontFamily = appearance.fontFamily;
  terminal.options.fontSize = appearance.fontSize;
  terminal.options.lineHeight = appearance.lineHeight;
  terminal.options.letterSpacing = appearance.letterSpacing;
  terminal.options.theme = resolveTheme(appearance);
}

export interface TerminalViewProps {
  sessionId: string;
  /** 宿主给出的确切 WS 地址；页面 origin 可能是 app://，不能用 location.host 推导。 */
  wsUrl: string;
  onNotice: (message: string) => void;
  /** 外观（M6-2）：不传就保持 xterm 自己的默认观感。 */
  appearance?: Appearance;
}

interface ServerMessage {
  type: string;
  data?: string;
}

/** 终端视图：xterm 只认 /api/uniterminal/ws/:id 的 JSON 消息协议（input / resize / data）。 */
export function TerminalView({ sessionId, wsUrl, onNotice, appearance }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 终端与 fit 单独存 ref：外观走另一条 effect，改外观绝不能重建终端（会断 WS、丢回滚）。 */
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** 已经应用到终端上的外观：建终端时读它，变化时用来判断要不要重新 fit。 */
  const appearanceRef = useRef<Appearance | undefined>(appearance);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    ensureUniterminalCss();

    const terminal = new Terminal({ convertEol: true, scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // 创建时就应用外观：字号/字体必须先定下来，下面的 fit 才会按正确字宽算行列
    const initialAppearance = appearanceRef.current;
    if (initialAppearance !== undefined) applyAppearance(terminal, initialAppearance);
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.open(host);

    // 容器尺寸为 0（侧边栏收起）时 xterm 算不出行列会抛错：静默跳过，等下一次尺寸变化。
    // refresh 用于清掉全屏程序按旧尺寸绘制后残留的字符。
    const fitNow = (): void => {
      try {
        fit.fit();
        terminal.refresh(0, terminal.rows - 1);
      } catch {
        // 尺寸不可用，静默跳过
      }
    };
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFit = (): void => {
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        fitNow();
      }, FIT_DEBOUNCE_MS);
    };

    fitNow();
    terminal.focus();

    const socket = new WebSocket(wsUrl);

    reportClient("client.ws-open", { sessionId, url: socket.url });
    socket.onopen = () => {
      reportClient("client.ws-opened", { sessionId });
      // 远端 PTY 是以 80x24 打开的，而 onResize 只在尺寸**变化**时触发——
      // 面板一进来就 fit 好了，事件永远不会来，远端于是按 80 列换行、
      // 本地按面板宽度渲染，长命令行会互相覆盖（用户实报）。
      // 所以连上必须主动同步一次真实尺寸。
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };
    // 二进制帧 = 终端输出（零拷贝交给 xterm）；文本帧 = 控制消息
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
        return;
      }
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "data" && message.data !== undefined) {
        // 兼容旧宿主：仍可能发 base64 文本帧
        terminal.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
      }
    };
    socket.onerror = () => {
      reportClient("client.ws-error", { sessionId, readyState: socket.readyState });
      onNotice("终端连接失败");
    };
    socket.onclose = (event) => {
      reportClient("client.ws-closed", { sessionId, code: event.code, reason: event.reason, wasClean: event.wasClean });
      onNotice("终端连接已断开");
    };

    const dataSubscription = terminal.onData((chunk) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: chunk }));
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // 拖动侧边栏宽度、展开/收起侧边栏都不触发 window.resize，必须观察容器本身。
    // window.resize 仅作兜底，与 ResizeObserver 共用 scheduleFit，避免重复 fit。
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);
    const onWindowResize = () => scheduleFit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      observer.disconnect();
      if (fitTimer !== undefined) {
        clearTimeout(fitTimer);
        fitTimer = undefined;
      }
      window.removeEventListener("resize", onWindowResize);
      dataSubscription.dispose();
      resizeSubscription.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socket.close();
      terminal.dispose();
    };
  }, [sessionId, wsUrl, onNotice]);

  // 外观变化只改 options；字号/字体类改动会改变单元格尺寸，必须重新 fit
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === null || appearance === undefined) return;
    const previous = appearanceRef.current;
    appearanceRef.current = appearance;
    applyAppearance(terminal, appearance);
    const metricsChanged =
      previous === undefined ||
      previous.fontFamily !== appearance.fontFamily ||
      previous.fontSize !== appearance.fontSize ||
      previous.lineHeight !== appearance.lineHeight ||
      previous.letterSpacing !== appearance.letterSpacing;
    const fit = fitRef.current;
    if (!metricsChanged || fit === null) return;
    try {
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);
    } catch {
      // 容器尺寸为 0（侧边栏收起）时 fit 会抛：等下一次 ResizeObserver
    }
  }, [appearance]);

  return <div ref={hostRef} className="uniterminal-terminal" />;
}
