import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceError, AppearanceStore, DEFAULT_APPEARANCE } from "../../src/store/appearance.js";

/** diag 在测试里默认静默：这里接管调用记录，损坏回落的诊断必须看得见。 */
const diagCalls = vi.hoisted(() => [] as { event: string; data?: Record<string, unknown> }[]);

vi.mock("../../src/host-diag.js", () => ({
  diag: (event: string, data?: Record<string, unknown>) => {
    diagCalls.push({ event, data });
  },
}));

const FILE = "appearance.json";
const EVENT_CORRUPT = "appearance.corrupt";
const EVENT_SEED_INVALID = "appearance.seed-invalid";

let dir = "";
let file = "";
let store: AppearanceStore;

const readPersisted = async (): Promise<{ version: number; appearance: Record<string, unknown> }> =>
  JSON.parse(await readFile(file, "utf8")) as { version: number; appearance: Record<string, unknown> };

const events = (): string[] => diagCalls.map((call) => call.event);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-appearance-"));
  file = join(dir, FILE);
  store = new AppearanceStore(dir);
  diagCalls.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AppearanceStore", () => {
  it("serves the built-in defaults before anything was saved", async () => {
    await store.load();

    expect(store.current()).toEqual(DEFAULT_APPEARANCE);
    // 文件不存在不是损坏：绝不能记 appearance.corrupt 去干扰真故障排查
    expect(events()).not.toContain(EVENT_CORRUPT);
  });

  it("roundtrips a save through a fresh store on the same directory", async () => {
    await store.load();
    const saved = await store.save({
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 18,
      lineHeight: 1.5,
      letterSpacing: 0.5,
      themeMode: "custom",
      background: "#123456",
    });

    expect(saved.fontSize).toBe(18);
    // 只给了部分字段：其余保持默认，绝不被清空
    expect(saved.cursor).toBe(DEFAULT_APPEARANCE.cursor);

    const persisted = await readPersisted();
    expect(persisted.version).toBe(1);
    expect(persisted.appearance.fontSize).toBe(18);

    const reloaded = new AppearanceStore(dir);
    await reloaded.load();
    expect(reloaded.current()).toEqual(store.current());
    expect(reloaded.current()).toEqual(saved);
  });

  it("falls back to the defaults on corrupt JSON without throwing, and records diag", async () => {
    await store.save({ fontSize: 20 });
    await writeFile(file, "{ this is not json", "utf8");

    const broken = new AppearanceStore(dir);
    await expect(broken.load()).resolves.toBeUndefined();
    expect(broken.current()).toEqual(DEFAULT_APPEARANCE);
    expect(events()).toContain(EVENT_CORRUPT);
  });

  it("falls back to the defaults when a persisted field is out of range", async () => {
    const corrupted = { ...DEFAULT_APPEARANCE, fontSize: 99, background: "red" };
    await writeFile(file, JSON.stringify({ version: 1, appearance: corrupted }), "utf8");

    const broken = new AppearanceStore(dir);
    await expect(broken.load()).resolves.toBeUndefined();
    expect(broken.current()).toEqual(DEFAULT_APPEARANCE);
    expect(events()).toContain(EVENT_CORRUPT);
  });

  it("rejects out-of-range values, naming the field, without touching the disk", async () => {
    await store.load();

    const invalid: Record<string, unknown>[] = [
      { fontSize: 40 },
      { fontSize: 9.5 },
      { lineHeight: 0.5 },
      { letterSpacing: -1 },
      { themeMode: "neon" },
      { background: "red" },
      { foreground: "#12345" },
      { fontFamily: "   " },
    ];
    for (const patch of invalid) await expect(store.save(patch)).rejects.toBeInstanceOf(AppearanceError);

    await expect(store.save({ fontSize: 40 })).rejects.toThrow(/fontSize/);
    await expect(store.save({ lineHeight: 0.5 })).rejects.toThrow(/lineHeight/);
    await expect(store.save({ themeMode: "neon" })).rejects.toThrow(/themeMode/);
    await expect(store.save({ background: "red" })).rejects.toThrow(/background/);

    expect(store.current()).toEqual(DEFAULT_APPEARANCE);
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves no temp file behind after an atomic write", async () => {
    await store.load();
    await store.save({ fontSize: 16 });

    expect(await readdir(dir)).toEqual([FILE]);
  });

  it("seeds the defaults from the plugin config and ignores invalid seed fields", async () => {
    const seeded = new AppearanceStore(dir, {
      fontSize: 20,
      lineHeight: 1.5,
      themeMode: "dark",
      background: "not-a-color",
    });

    expect(seeded.current().fontSize).toBe(20);
    expect(seeded.current().lineHeight).toBe(1.5);
    expect(seeded.current().themeMode).toBe("dark");
    // 非法 seed 字段回落内置默认并记 diag：一条错的插件配置不该让外观整体失效
    expect(seeded.current().background).toBe(DEFAULT_APPEARANCE.background);
    expect(events()).toContain(EVENT_SEED_INVALID);

    await seeded.load();
    expect(seeded.current().fontSize).toBe(20);
  });

  it("hands out a copy so callers cannot mutate store state", async () => {
    await store.load();
    const snapshot = store.current();
    snapshot.fontSize = 30;

    expect(store.current().fontSize).toBe(DEFAULT_APPEARANCE.fontSize);
  });
});

/** 断言这次 save 被拒并取回文案：分组颜色的错误必须能指明是哪一条出的错。 */
async function rejectionOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the save to be rejected");
}

/** 分组键就是 UI 里那一行显示的文字（HostListView 用 " / " 连接 groupPath）。 */
const GROUP_KEY = "生产 / 华东";

describe("AppearanceStore groupColors (M6-5)", () => {
  it("roundtrips a legal group colour map through a fresh store", async () => {
    await store.load();
    const colors = { [GROUP_KEY]: "#7aa2f7", "运维/北京": "#ABC", last: "#123456" };

    const saved = await store.save({ groupColors: colors });

    expect(saved.groupColors).toEqual(colors);
    expect((await readPersisted()).appearance.groupColors).toEqual(colors);

    const reloaded = new AppearanceStore(dir);
    await reloaded.load();
    expect(reloaded.current().groupColors).toEqual(colors);
    // 只给了 groupColors：其余字段保持当前值，绝不被清空
    expect(reloaded.current().fontFamily).toBe(DEFAULT_APPEARANCE.fontFamily);
  });

  it("treats a missing map as empty instead of inventing a default", async () => {
    await store.load();

    // 缺字段是合法的（老存档 / 内置默认值）：等于空表，且不改变 DEFAULT_APPEARANCE 的形状
    expect(store.current().groupColors ?? {}).toEqual({});
    expect(store.current()).toEqual(DEFAULT_APPEARANCE);

    await store.save({ groupColors: {} });
    expect((await readPersisted()).appearance.groupColors).toEqual({});
  });

  it("rejects a bad hex value naming the key, and leaves the file untouched", async () => {
    await store.load();
    await store.save({ groupColors: { [GROUP_KEY]: "#7aa2f7" } });
    const before = await readFile(file, "utf8");
    const beforeAppearance = store.current();

    await expect(store.save({ groupColors: { [GROUP_KEY]: "#12345" } })).rejects.toBeInstanceOf(AppearanceError);
    const message = await rejectionOf(store.save({ groupColors: { [GROUP_KEY]: "#12345" } }));
    // 文案要指明是哪个 key、哪个值
    expect(message).toContain(GROUP_KEY);
    expect(message).toContain("#12345");
    // 非法输入绝不落盘：文件一个字节都不能变，也不能留下临时文件
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual([FILE]);
    expect(store.current()).toEqual(beforeAppearance);
  });

  it("rejects an empty, over-long, or newline/tab key without touching the disk", async () => {
    await store.load();

    const badKeys = ["生产\n华东", "生产\t华东", "   ", "x".repeat(201)];
    for (const key of badKeys) {
      const message = await rejectionOf(store.save({ groupColors: { [key]: "#7aa2f7" } }));
      expect(message).toContain(JSON.stringify(key).slice(1, -1));
    }

    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects more than 200 entries and any non-object map", async () => {
    await store.load();

    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= 200; index += 1) tooMany["组" + String(index)] = "#7aa2f7";
    expect(await rejectionOf(store.save({ groupColors: tooMany }))).toContain("200");

    for (const bad of [[], "#7aa2f7", null, 42]) {
      await expect(store.save({ groupColors: bad })).rejects.toBeInstanceOf(AppearanceError);
    }

    expect(await readdir(dir)).toEqual([]);
  });

  it("replaces the whole map on every save so a dropped key disappears", async () => {
    await store.load();
    await store.save({ groupColors: { [GROUP_KEY]: "#7aa2f7", "运维/北京": "#3fb950" } });
    expect((await readPersisted()).appearance.groupColors).toEqual({
      [GROUP_KEY]: "#7aa2f7",
      "运维/北京": "#3fb950",
    });

    await store.save({ groupColors: { "运维/北京": "#3fb950" } });

    const persisted = await readPersisted();
    // 整表替换：漏掉的 key 是消失，而不是与旧表合并
    expect(persisted.appearance.groupColors).toEqual({ "运维/北京": "#3fb950" });
    expect(persisted.appearance.groupColors).not.toHaveProperty(GROUP_KEY);

    const reloaded = new AppearanceStore(dir);
    await reloaded.load();
    expect(reloaded.current().groupColors).toEqual({ "运维/北京": "#3fb950" });
  });

  it("lets two concurrent saves finish without fighting over one temp file", async () => {
    await store.load();

    // 固定 .tmp 名时，后一个 rename 会找不到自己的临时文件而 ENOENT，于是其中之一会 reject
    await expect(Promise.all([store.save({ fontSize: 16 }), store.save({ lineHeight: 1.5 })])).resolves.toBeDefined();

    // 关键不变量：目录里只留下数据文件本身，没有任何半截临时文件
    expect(await readdir(dir)).toEqual([FILE]);
    // 谁最后落盘不确定（也不该被断言），只要求文件始终可解析且字段仍是数字
    const persisted = JSON.parse(await readFile(file, "utf8")) as { appearance: Record<string, unknown> };
    expect(typeof persisted.appearance.fontSize).toBe("number");
    expect(typeof persisted.appearance.lineHeight).toBe("number");
  });

  it("keeps the stored map when a patch does not mention groupColors", async () => {
    await store.load();
    await store.save({ groupColors: { [GROUP_KEY]: "#7aa2f7" } });

    await store.save({ fontSize: 18 });

    expect(store.current().fontSize).toBe(18);
    expect(store.current().groupColors).toEqual({ [GROUP_KEY]: "#7aa2f7" });
  });
});
