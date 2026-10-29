import { useEffect, useState, useMemo } from "react";
import { api } from "./api.js";
import { useNotice, noticeClassName, noticeLiveProps } from "./notice.js";
import { SelectField } from "./select-field.js";

export const APPEARANCE_ENDPOINT = "/api/uniterminal/appearance";

/** 主题模式：follow 读宿主 CSS 变量，dark / light 用内置配色，custom 用下面四个自定义色。 */
export type ThemeMode = "follow" | "dark" | "light" | "custom";

/** 与计划里的接口契约同形：GET/POST /api/uniterminal/appearance 的 appearance 字段。 */
export interface Appearance {
  fontFamily: string;
  /** 8..32 的整数：xterm 只接受整数像素字号。 */
  fontSize: number;
  /** 1.0..2.0 */
  lineHeight: number;
  /** 0..5 */
  letterSpacing: number;
  themeMode: ThemeMode;
  /** 以下四色只在 themeMode === "custom" 时生效（follow 读宿主变量，dark/light 用内置配色）。 */
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

/** 宿主文件不存在时的默认值；「恢复默认」也回到这里。 */
export const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: "Cascadia Mono, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  themeMode: "follow",
  background: "#101418",
  foreground: "#d6dde4",
  cursor: "#7aa2f7",
  selectionBackground: "#2a3441",
};

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;
const LETTER_SPACING_MIN = 0;
const LETTER_SPACING_MAX = 5;

/** 下拉候选：常见的等宽字体（含 CJK 友好的）。真正显示哪些由可用性探测决定。 */
const FONT_CANDIDATES = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Victor Mono",
  "Sarasa Mono SC",
  "Noto Sans Mono CJK SC",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Menlo",
  "SF Mono",
  "Monaco",
  "Courier New",
  "monospace",
];

/** 下拉里代表「自己输入字体栈」的哨兵值。 */
const CUSTOM_FONT = "__custom__";

/**
 * 字体是否真的装在本机。
 * 不用 document.fonts.check：它对完全不存在的字体族也会返回 true（浏览器允许回落）。
 * 这里用 canvas 量字宽做差：与两个回退族（monospace / serif）都比不出差异，才认为没装。
 */
function fontAvailable(family: string): boolean {
  if (family === "monospace") return true;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) return true;
    const probe = "mmmmmmmmmmlli1|WW@#";
    const widthOf = (font: string): number => {
      context.font = font;
      return context.measureText(probe).width;
    };
    const quoted = '"' + family + '"';
    const monoBase = widthOf("72px monospace");
    const serifBase = widthOf("72px serif");
    const withMono = widthOf("72px " + quoted + ", monospace");
    const withSerif = widthOf("72px " + quoted + ", serif");
    return Math.abs(withMono - monoBase) > 0.01 || Math.abs(withSerif - serifBase) > 0.01;
  } catch {
    // 探测本身失败时不要据此隐藏字体：宁可多给几个选项
    return true;
  }
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "follow", label: "跟随系统" },
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "custom", label: "自定义" },
];

type ColorKey = "background" | "foreground" | "cursor" | "selectionBackground";

const COLOR_FIELDS: { key: ColorKey; label: string }[] = [
  { key: "background", label: "背景" },
  { key: "foreground", label: "前景" },
  { key: "cursor", label: "光标" },
  { key: "selectionBackground", label: "选中背景" },
];

/** POST 响应里本面板只关心这两项。 */
interface AppearanceResponse {
  appearance?: unknown;
  error?: string;
}

function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "follow" || value === "dark" || value === "light" || value === "custom";
}

/**
 * 宿主返回的字段可能是任意 JSON：逐字段校验，坏字段各自回落到默认值，
 * 不让一个坏字段毁掉整份外观（尤其是不能把 NaN 写进 xterm 的 fontSize）。
 */
export function normalizeAppearance(raw: unknown): Appearance {
  if (typeof raw !== "object" || raw === null) return DEFAULT_APPEARANCE;
  const source = raw as Record<string, unknown>;
  const text = (key: string, fallback: string): string => {
    const value = source[key];
    return typeof value === "string" && value.trim() !== "" ? value : fallback;
  };
  const number = (key: string, fallback: number, min: number, max: number, integer: boolean): number => {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return clampNumber(integer ? Math.round(value) : value, min, max);
  };
  const mode = source.themeMode;
  return {
    fontFamily: text("fontFamily", DEFAULT_APPEARANCE.fontFamily),
    fontSize: number("fontSize", DEFAULT_APPEARANCE.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, true),
    lineHeight: number("lineHeight", DEFAULT_APPEARANCE.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, false),
    letterSpacing: number(
      "letterSpacing",
      DEFAULT_APPEARANCE.letterSpacing,
      LETTER_SPACING_MIN,
      LETTER_SPACING_MAX,
      false,
    ),
    themeMode: isThemeMode(mode) ? mode : DEFAULT_APPEARANCE.themeMode,
    background: text("background", DEFAULT_APPEARANCE.background),
    foreground: text("foreground", DEFAULT_APPEARANCE.foreground),
    cursor: text("cursor", DEFAULT_APPEARANCE.cursor),
    selectionBackground: text("selectionBackground", DEFAULT_APPEARANCE.selectionBackground),
  };
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  hint: string;
  onApply: (next: number) => void;
}

/**
 * 数字输入：录入过程中只应用范围内的值（否则输「1」会被夹成 8，再接「2」就变成了 82），
 * 失焦时才把越界/空值夹回边界并回显，保证预览里永远是合法值。
 */
function NumberField({ label, value, min, max, step, integer, hint, onApply }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  // 外部改了值（保存回填 / 恢复默认 / 宿主 GET 回来）→ 草稿跟着对齐
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const normalize = (text: string): number | undefined => {
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return clampNumber(integer ? Math.round(parsed) : parsed, min, max);
  };

  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const trimmed = text.trim();
          if (trimmed === "") return;
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) return;
          if (parsed < min || parsed > max) return;
          const next = integer ? Math.round(parsed) : parsed;
          if (next !== value) onApply(next);
        }}
        onBlur={() => {
          const next = normalize(draft) ?? value;
          setDraft(String(next));
          if (next !== value) onApply(next);
        }}
      />
      <span className="uniterminal-hint">{hint}</span>
    </label>
  );
}

export interface AppearancePanelProps {
  /** 当前生效的外观（本地 state）：面板每次改动都立刻回传，预览立即跟着变。 */
  value: Appearance;
  onChange: (next: Appearance) => void;
  /** 保存成功后回调：让外部把"已保存快照"更新到这个值，否则关闭时会回滚掉刚保存的改动。 */
  onSaved?: (next: Appearance) => void;
}

/**
 * 外观面板（M6-2）：字体与配色。改动即时应用到预览，「保存」才 POST 到宿主。
 * 所有 JSON 都先取 text 再走 parseJsonSafe；保存失败原样显示后端 error。
 */
export function AppearancePanel({ value, onChange, onSaved }: AppearancePanelProps) {
  // 字体是文本输入，单独留草稿：清空重输时不能被 value 立刻顶回去
  const [fontFamilyDraft, setFontFamilyDraft] = useState(value.fontFamily);
  const fontOptions = useMemo(() => {
    const detected = FONT_CANDIDATES.filter((family) => fontAvailable(family));
    // 当前值不在候选里也放进去，否则下拉会显示成自定义而丢掉在用字体
    return detected.includes(value.fontFamily) ? detected : [value.fontFamily, ...detected];
  }, [value.fontFamily]);
  const fontInList = fontOptions.includes(value.fontFamily);
  /** 用户在下拉里选了「自定义…」：露出文本框，但不立刻改字体。 */
  const [customFont, setCustomFont] = useState(false);
  const showCustomFont = customFont || !fontInList;

  const [saving, setSaving] = useState(false);
  /**
   * 一次性提示走共享模型（notice.ts）：成功是绿、失败是红，过期规则由那一个来源统一负责。
   * 原来的 saveError / savedHint 两套 state 合成一条 notice：成功与失败本来就该分色。
   */
  const { notice, setNotice, setOk, clear } = useNotice();

  useEffect(() => {
    setFontFamilyDraft(value.fontFamily);
  }, [value.fontFamily]);

  /** 任何改动都立即生效（只改本地 state）；旧的成功/失败提示随之作废。 */
  const apply = (patch: Partial<Appearance>): void => {
    onChange({ ...value, ...patch });
    clear();
  };

  const applyColor = (key: ColorKey, color: string): void => {
    const patch: Partial<Appearance> = {};
    patch[key] = color;
    apply(patch);
  };

  /** 「保存」是唯一的写宿主路径：POST 成功才把后端规整过的值回填给预览。 */
  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    clear();
    try {
      const res = await api.post<AppearanceResponse>(APPEARANCE_ENDPOINT, { appearance: value });
      if (!res.ok) {
        // 后端原文（越界字段、403、503……）原样显示，不翻译、不吞掉
        // api.ts 已经把文案取好：后端给了 error 就是它，没给就是 "HTTP <status>"。
        // 直接用请求层的结果，用户看到的字与旧版逐字一致。
        setNotice("保存失败：" + res.error.message);
        return;
      }
      const saved = normalizeAppearance(res.data.appearance);
        onChange(saved);
        onSaved?.(saved);
      setOk("已保存到本机");
    } catch (error) {
      setNotice("保存失败：" + String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="uniterminal-col-gap uniterminal-fixed uniterminal-banner">
      <div className="uniterminal-row uniterminal-wrap">
        <span className="uniterminal-body uniterminal-strong">字体与配色</span>
        <span className="uniterminal-hint">改动立即预览；点「保存」才写进本机；再次点击「外观」收回配置栏</span>
      </div>

      <label>
        字体
        {/* 原生 select 的弹出层由浏览器绘制、不继承主题变量（台账 M36）：
            深色主题下是"白底浅字"，选项几乎看不见。改用自绘下拉，
            颜色、边框、选中态全部走主题变量。 */}
        <SelectField
          label="字体"
          value={fontInList ? value.fontFamily : CUSTOM_FONT}
          onChange={(chosen) => {
            // 原生 select 选回同一个值不会触发 change：这里保持一致，不白刷一次 apply
            if (chosen === (fontInList ? value.fontFamily : CUSTOM_FONT)) return;
            if (chosen === CUSTOM_FONT) {
              // 自定义只是"露出输入框"，不立刻改字体
              setFontFamilyDraft(value.fontFamily);
              setCustomFont(true);
              return;
            }
            setCustomFont(false);
            setFontFamilyDraft(chosen);
            apply({ fontFamily: chosen });
          }}
          options={[
            ...fontOptions.map((family) => ({ value: family, label: family })),
            { value: CUSTOM_FONT, label: "自定义…" },
          ]}
        />
      </label>
      {showCustomFont && (
        <label>
          自定义字体栈
          <input
            value={fontFamilyDraft}
            placeholder={DEFAULT_APPEARANCE.fontFamily}
            onChange={(event) => {
              const text = event.target.value;
              setFontFamilyDraft(text);
              // 空串不应用：让用户能把整行清掉重打，预览保留上一个有效字体
              if (text.trim() !== "") apply({ fontFamily: text });
            }}
            onBlur={() => setFontFamilyDraft(value.fontFamily)}
          />
        </label>
      )}

      <div className="uniterminal-wrap" style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <NumberField
          label="字号"
          value={value.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          integer
          hint={String(FONT_SIZE_MIN) + ".." + String(FONT_SIZE_MAX)}
          onApply={(next) => apply({ fontSize: next })}
        />
        <NumberField
          label="行高"
          value={value.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.1}
          integer={false}
          hint="1.0..2.0"
          onApply={(next) => apply({ lineHeight: next })}
        />
        <NumberField
          label="字距"
          value={value.letterSpacing}
          min={LETTER_SPACING_MIN}
          max={LETTER_SPACING_MAX}
          step={0.5}
          integer={false}
          hint="0..5"
          onApply={(next) => apply({ letterSpacing: next })}
        />
      </div>

      <div className="uniterminal-col" style={{ gap: 4 }}>
        <span className="uniterminal-body">主题模式</span>
        <div className="uniterminal-row uniterminal-wrap">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={value.themeMode === option.value}
              className="uniterminal-compact-wide"
              style={{ fontWeight: value.themeMode === option.value ? 600 : 400 }}
              onClick={() => apply({ themeMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {value.themeMode === "follow" && (
          <span className="uniterminal-hint">跟随 DSH 的明暗主题；读不到主题变量时回落深色</span>
        )}
        {value.themeMode === "custom" && (
          <span className="uniterminal-hint">自定义模式下四个颜色都生效</span>
        )}
      </div>

      {value.themeMode === "custom" && (
        <div className="uniterminal-row-tight uniterminal-wrap" style={{ gap: 12 }}>
          {COLOR_FIELDS.map((field) => (
            <label key={field.key} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {field.label}
              <input
                type="color"
                value={value[field.key]}
                style={{ width: 40, height: 24, padding: 0 }}
                onChange={(event) => applyColor(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>
      )}

      <div className="uniterminal-row uniterminal-wrap">
        <button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" disabled={saving} onClick={() => apply(DEFAULT_APPEARANCE)}>
          恢复默认
        </button>
      </div>
      {/* B5 无障碍：两个常驻容器，按 kind 只往其中一个写文字（role 不切换） */}
      <div {...noticeLiveProps("ok")} className="uniterminal-live">
        {notice !== undefined && notice.kind === "ok" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
      <div {...noticeLiveProps("error")} className="uniterminal-live">
        {notice !== undefined && notice.kind === "error" && (
          <div className={noticeClassName(notice.kind)}>{notice.text}</div>
        )}
      </div>
    </div>
  );
}
