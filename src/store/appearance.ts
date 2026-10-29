import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { diag } from "../host-diag.js";

/** 主题模式：follow 跟随 DSH 明暗；custom 时才用四个自定义颜色（契约见 M6 计划）。 */
export type AppearanceThemeMode = "follow" | "dark" | "light" | "custom";

/** 终端外观（M6-1）：宿主侧唯一的一份形状，路由与客户端都按它对齐。 */
export interface Appearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  themeMode: AppearanceThemeMode;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  /**
   * M6-5 分组名称颜色：键是分组显示名（HostListView 用 " / " 连接 groupPath），值是 #rgb/#rrggbb。
   * 可选：缺字段等于空表（老存档、内置默认值都不带它，DEFAULT_APPEARANCE 的形状因此不变）。
   */
  groupColors?: Record<string, string>;
}

/** save 的入参：只给想改的字段，其余保持当前值。 */
export type AppearancePatch = Partial<Appearance>;

/** 内置默认值（契约里的示例值）；插件 config 的 appearance 只覆盖其中给出来的字段。 */
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

/** 越界/格式错一律用它：路由据此映射 400，其余异常仍是 500。 */
export class AppearanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppearanceError";
  }
}

const FILE_NAME = "appearance.json";
const VERSION = 1;
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;
const LETTER_SPACING_MIN = 0;
const LETTER_SPACING_MAX = 5;
const FONT_FAMILY_MAX = 200;
const GROUP_KEY_MAX = 200;
const GROUP_COLORS_MAX = 200;
/** 只认 #rgb 与 #rrggbb：别的写法（rgb()/颜色名）在 xterm theme 里同样是合法值，但契约只承诺这两形。 */
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const THEME_MODES: readonly string[] = ["follow", "dark", "light", "custom"];
const APPEARANCE_KEYS: readonly string[] = [
  "fontFamily",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "themeMode",
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "groupColors",
];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 文案统一带上字段名：界面要能直接告诉用户改哪一个字段。 */
const invalid = (field: string, expected: string): AppearanceError =>
  new AppearanceError("字段 " + field + " " + expected);

const validFontFamily = (value: unknown): string => {
  if (typeof value !== "string") throw invalid("fontFamily", "必须是非空字符串");
  const family = value.trim();
  if (family === "" || family.length > FONT_FAMILY_MAX) {
    throw invalid("fontFamily", "必须是非空字符串（最多 " + FONT_FAMILY_MAX + " 个字符）");
  }
  return family;
};

const validFontSize = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < FONT_SIZE_MIN || value > FONT_SIZE_MAX) {
    throw invalid("fontSize", "必须是 " + FONT_SIZE_MIN + ".." + FONT_SIZE_MAX + " 之间的整数");
  }
  return value;
};

const validLineHeight = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < LINE_HEIGHT_MIN || value > LINE_HEIGHT_MAX) {
    throw invalid("lineHeight", "必须是 " + LINE_HEIGHT_MIN + ".." + LINE_HEIGHT_MAX + " 之间的数");
  }
  return value;
};

const validLetterSpacing = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < LETTER_SPACING_MIN ||
    value > LETTER_SPACING_MAX
  ) {
    throw invalid("letterSpacing", "必须是 " + LETTER_SPACING_MIN + ".." + LETTER_SPACING_MAX + " 之间的数");
  }
  return value;
};

const validThemeMode = (value: unknown): AppearanceThemeMode => {
  if (typeof value !== "string" || !THEME_MODES.includes(value)) {
    throw invalid("themeMode", "必须是 " + THEME_MODES.join(" / ") + " 之一");
  }
  return value as AppearanceThemeMode;
};

const colorOf =
  (field: string) =>
  (value: unknown): string => {
    if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
      throw invalid(field, "必须是 #rgb 或 #rrggbb 形式的颜色");
    }
    return value;
  };

/**
 * M6-5 分组颜色表：整张表一起校验，任何一条不合法就整次拒绝——
 * 半张表落盘会让用户既不知道哪条错了，也删不掉那条错色。
 */
const validGroupColors = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) throw invalid("groupColors", "必须是对象（分组名 → #rgb 或 #rrggbb）");
  const entries = Object.entries(value);
  if (entries.length > GROUP_COLORS_MAX) {
    throw new AppearanceError(
      "字段 groupColors 最多 " + GROUP_COLORS_MAX + " 条（当前 " + entries.length + " 条）",
    );
  }
  const colors: Record<string, string> = {};
  for (const [key, color] of entries) {
    if (key.trim() === "" || key.length > GROUP_KEY_MAX || /[\n\r\t]/.test(key)) {
      throw new AppearanceError(
        "字段 groupColors 的 key 不合法：" +
          JSON.stringify(key) +
          "；必须是非空字符串、不含换行或制表符、最多 " + GROUP_KEY_MAX + " 个字符",
      );
    }
    if (typeof color !== "string" || !COLOR_PATTERN.test(color)) {
      throw new AppearanceError(
        "字段 groupColors 中分组 " + JSON.stringify(key) + " 的颜色不合法：" +
          JSON.stringify(color) + "；必须是 #rgb 或 #rrggbb 形式",
      );
    }
    colors[key] = color;
  }
  return colors;
};

/**
 * 把 patch 叠在 base 上：strict 供 save（越界即抛），lenient 供插件 config 的 seed
 * （一条写错的配置不该让外观整体失效，逐字段回落内置默认并留痕）。
 */
function applyPatch(
  base: Appearance,
  patch: unknown,
  mode: "strict" | "lenient",
): { appearance: Appearance; ignored: string[] } {
  if (!isRecord(patch)) throw invalid("appearance", "必须是对象");
  const ignored: string[] = [];
  for (const key of Object.keys(patch)) {
    if (APPEARANCE_KEYS.includes(key)) continue;
    if (mode === "strict") throw new AppearanceError("未知的外观字段 " + key);
    ignored.push(key);
  }

  const pick = <T>(field: string, validate: (value: unknown) => T, fallback: T): T => {
    const raw = patch[field];
    if (raw === undefined) return fallback;
    try {
      return validate(raw);
    } catch (error) {
      if (mode === "strict") throw error;
      ignored.push(field);
      return fallback;
    }
  };

  const appearance: Appearance = {
    fontFamily: pick("fontFamily", validFontFamily, base.fontFamily),
    fontSize: pick("fontSize", validFontSize, base.fontSize),
    lineHeight: pick("lineHeight", validLineHeight, base.lineHeight),
    letterSpacing: pick("letterSpacing", validLetterSpacing, base.letterSpacing),
    themeMode: pick("themeMode", validThemeMode, base.themeMode),
    background: pick("background", colorOf("background"), base.background),
    foreground: pick("foreground", colorOf("foreground"), base.foreground),
    cursor: pick("cursor", colorOf("cursor"), base.cursor),
    selectionBackground: pick("selectionBackground", colorOf("selectionBackground"), base.selectionBackground),
  };
  // 没设过就整条不出现：读的一方按空表处理，老存档与默认值的形状一个字节都不变
  const groupColors = pick<Record<string, string> | undefined>(
    "groupColors",
    validGroupColors,
    base.groupColors,
  );
  if (groupColors !== undefined) appearance.groupColors = groupColors;

  return { appearance, ignored };
}

/** 插件 config 的 appearance 作为 seed：非法字段回落内置默认并记一条诊断。 */
function seedDefaults(seed: unknown): Appearance {
  if (!isRecord(seed)) return { ...DEFAULT_APPEARANCE };
  const { appearance, ignored } = applyPatch(DEFAULT_APPEARANCE, seed, "lenient");
  if (ignored.length > 0) diag("appearance.seed-invalid", { fields: ignored.join(",") });
  return appearance;
}

function parsePersisted(text: string, defaults: Appearance): Appearance {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppearanceError("content is not valid JSON");
  }
  if (!isRecord(raw)) throw new AppearanceError("root must be an object");
  if (raw.version !== VERSION) throw new AppearanceError("version must be " + VERSION);
  // 文件里缺字段是合法的（手改过的文件）：缺的取默认，给的必须是合法值
  return applyPatch(defaults, raw.appearance, "strict").appearance;
}

/**
 * `~/.dsh/uniterminal/appearance.json` 的唯一读写者（M6-1）。
 * 原子写（tmp → rename），与项目既有 store 同款；文件损坏/字段非法绝不抛错——
 * 外观是装饰，一条坏文件不该让插件起不来，只回落默认值并记 diag。
 */
export class AppearanceStore {
  readonly #file: string;
  readonly #defaults: Appearance;
  #appearance: Appearance;
  /**
   * 保存串行化：随机临时文件名只解决了「两个 save 共用一个 tmp」，
   * 但 **Windows 上两个 rename 同时落到同一目标会 EPERM**。
   * 这里把整段 read-modify-write 排队，彻底避免并发改名。
   */
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(dir: string, seed?: AppearancePatch) {
    this.#file = join(dir, FILE_NAME);
    this.#defaults = seedDefaults(seed);
    this.#appearance = { ...this.#defaults };
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      // 文件不存在是常态（第一次用），不算故障；其余读失败也只记诊断，绝不拖垮插件
      if (!isMissingFile(error)) {
        diag("appearance.load-failed", { path: this.#file, error: messageOf(error).slice(0, 160) });
      }
      this.#appearance = { ...this.#defaults };
      return;
    }
    try {
      this.#appearance = parsePersisted(text, this.#defaults);
    } catch (error) {
      this.#appearance = { ...this.#defaults };
      diag("appearance.corrupt", { path: this.#file, error: messageOf(error).slice(0, 160) });
    }
  }

  /** 返回副本：调用方手里的对象改不动 store 的状态。 */
  current(): Appearance {
    return { ...this.#appearance };
  }

  /** 只接受合法值：越界抛 AppearanceError（文案带字段名），落盘成功后才改内存状态。 */
  async save(patch: unknown): Promise<Appearance> {
    const run = async (): Promise<Appearance> => {
      const next = applyPatch(this.#appearance, patch, "strict").appearance;
      await this.#persist(next);
      this.#appearance = next;
      return { ...next };
    };
    // 排队执行；失败也要把队列推进下去，否则一次失败会永久堵住后续保存
    const task = this.#writeQueue.then(run, run);
    this.#writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #persist(appearance: Appearance): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const payload = JSON.stringify({ version: VERSION, appearance }, null, 2) + "\n";
    // 随机后缀：两个并发 save 各写各的临时文件，否则后一个 rename 会 ENOENT
    const temp = this.#file + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await writeFile(temp, payload, "utf8");
      await rename(temp, this.#file);
    } catch (error) {
      // 写失败也把临时文件收掉：否则半截文件会一直躺在数据目录里
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
