import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProfilesFile, ProfileStore, serializeProfilesFile } from "../../src/store/profile-store.js";

/** 迁移要落盘（备份 + 原子写）：本文件的每条断言都必须看得见真实的写次数。 */
const renameSpy = vi.hoisted(() => vi.fn());
const diagCalls = vi.hoisted(() => [] as { event: string; data?: Record<string, unknown> }[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  renameSpy.mockImplementation((from: string, to: string) => actual.rename(from, to));
  return { ...actual, rename: renameSpy };
});

vi.mock("../../src/host-diag.js", () => ({
  diag: (event: string, data?: Record<string, unknown>) => {
    diagCalls.push({ event, data });
  },
}));

/** 旧文件里的颜色表：键是显示名（" / " 连接），值是 #rgb 或 #rrggbb。 */
const COLORS: Record<string, string> = {
  "生产 / 华东": "#ff0000",
  "空分组": "#00ff00",
  "没有这个分组": "#0000ff",
};

const host = (id: string, groupPath: unknown): Record<string, unknown> => ({
  id,
  name: id,
  kind: "ssh",
  groupPath,
  host: "192.0.2.10",
  port: 22,
  user: "root",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
});

/** version 1 存档：folders（显式空分组）+ 每个 profile 自己的 groupPath。 */
const v1Text = (profiles: unknown[], folders?: unknown): string =>
  JSON.stringify(folders === undefined ? { version: 1, profiles } : { version: 1, folders, profiles }, null, 2) + "\n";

const fullProfiles = (): unknown[] => [
  host("h1", ["生产", "华东"]),
  host("h2", ["生产", "华东", "机房A"]),
  host("h3", []),
  host("h4", ["测试"]),
];

const fullText = (): string => v1Text(fullProfiles(), [["生产"], ["空分组"]]);

const writeAppearance = async (colors: Record<string, string>): Promise<void> => {
  const file = join(dir, "appearance.json");
  await writeFile(file, JSON.stringify({ version: 1, appearance: { groupColors: colors } }, null, 2) + "\n", "utf8");
};

let dir = "";
let file = "";
let store: ProfileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-migrate-"));
  file = join(dir, "profiles.json");
  store = new ProfileStore(file);
  renameSpy.mockClear();
  diagCalls.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (target: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;

describe("v1 to v2 migration", () => {
  it("builds one group per unique path, keeps the tree and attaches every host to its deepest group", async () => {
    const { data, migrated } = parseProfilesFile(fullText(), COLORS);

    expect(migrated).toBe(true);
    expect(data.version).toBe(2);
    // folders 先出场（生产、空分组），再由 profile 的 groupPath 补齐更深的两级与独立的一级
    expect(data.groups.map((group) => [group.id, group.name, group.parentId])).toEqual([
      ["g1", "生产", null],
      ["g2", "空分组", null],
      ["g3", "华东", "g1"],
      ["g4", "机房A", "g3"],
      ["g5", "测试", null],
    ]);
    expect(data.profiles.map((entry) => [entry.id, entry.groupId])).toEqual([
      ["h1", "g3"],
      ["h2", "g4"],
      ["h3", null],
      ["h4", "g5"],
    ]);
    // 单一事实来源：旧字段一个都不留
    expect(data.profiles[0]).not.toHaveProperty("groupPath");
    expect(serializeProfilesFile(data)).not.toContain("groupPath");
  });

  it("moves the colour of every known label onto its group and drops the unknown ones", async () => {
    const { data } = parseProfilesFile(fullText(), COLORS);

    expect(data.groups.find((group) => group.name === "华东")?.color).toBe("#ff0000");
    expect(data.groups.find((group) => group.name === "空分组")?.color).toBe("#00ff00");
    // 找不到对应分组的键直接丢弃：绝不为了颜色凭空造一个分组
    expect(data.groups.some((group) => group.name === "没有这个分组")).toBe(false);
    expect(data.groups.find((group) => group.name === "生产")?.color).toBeUndefined();
  });

  it("writes version 2 back and keeps the old file as profiles.json.bak-v1", async () => {
    const original = fullText();
    await writeFile(file, original, "utf8");
    await writeAppearance(COLORS);

    await store.load();

    const persisted = await readJson(file);
    expect(persisted.version).toBe(2);
    expect(persisted.folders).toBeUndefined();
    expect(Array.isArray(persisted.groups)).toBe(true);
    expect(persisted.profiles).toHaveLength(4);
    expect(store.groupPath("g3")).toEqual(["生产", "华东"]);
    expect(store.get("h2")?.groupId).toBe("g4");
    expect(await readFile(file + ".bak-v1", "utf8")).toBe(original);
  });

  it("overwrites a stale backup instead of keeping it", async () => {
    const original = fullText();
    await writeFile(file, original, "utf8");
    await writeFile(file + ".bak-v1", "STALE BACKUP\n", "utf8");

    await store.load();

    expect(await readFile(file + ".bak-v1", "utf8")).toBe(original);
  });

  it("still migrates when the backup cannot be written, and records a diagnostic", async () => {
    const original = fullText();
    await writeFile(file, original, "utf8");
    // 备份路径被一个目录占住：写备份必然失败
    await mkdir(file + ".bak-v1", { recursive: true });

    await expect(store.load()).resolves.toBeUndefined();

    expect((await readJson(file)).version).toBe(2);
    expect(diagCalls.map((call) => call.event)).toContain("profile.backup-failed");
  });

  it("is byte-for-byte stable when the migrated file is fed through again", async () => {
    const first = serializeProfilesFile(parseProfilesFile(fullText(), COLORS).data);
    const second = serializeProfilesFile(parseProfilesFile(first, COLORS).data);
    expect(second).toBe(first);

    // 落盘的那一份同样稳定：再读一次不会再写文件
    await writeFile(file, fullText(), "utf8");
    await store.load();
    const onDisk = await readFile(file, "utf8");
    // 落盘的那一份已经是规范形：再解析、再序列化一个字节都不差
    expect(serializeProfilesFile(parseProfilesFile(onDisk, COLORS).data)).toBe(onDisk);
    const writesAfterMigration = renameSpy.mock.calls.length;

    const reloaded = new ProfileStore(file);
    await reloaded.load();
    expect(renameSpy.mock.calls.length).toBe(writesAfterMigration);
    expect(await readFile(file, "utf8")).toBe(onDisk);
    expect(reloaded.get("h1")?.groupId).toBe("g3");
  });
});

describe("migration against bad data", () => {
  it("degrades duplicate, blank, slashed and non-string paths instead of throwing", async () => {
    const text = v1Text(
      [
        host("p1", ["生产", "", " 华东 "]),
        host("p2", "nope"),
        host("p3", ["生产", "华东", ""]),
        { id: "p4", name: "p4", kind: "ssh", createdAt: 1, updatedAt: 1 },
      ],
      [["生产"], ["生产"], [""], ["a/b"], ["不合法", 42], "nope", []],
    );

    const { data } = parseProfilesFile(text, {});

    // 空名段与含 "/" 的段一律丢弃；" 华东 " 去空白后与 p3 的段合并成同一个分组
    expect(data.groups.map((group) => group.name)).toEqual(["生产", "不合法", "华东"]);
    const east = data.groups.find((group) => group.name === "华东");
    const production = data.groups.find((group) => group.name === "生产");
    expect(east?.parentId).toBe(production?.id);
    expect(data.profiles.map((entry) => [entry.id, entry.groupId])).toEqual([
      ["p1", east?.id],
      ["p2", null],
      ["p3", east?.id],
      ["p4", null],
    ]);
  });

  it("puts a host back on the root layer when its parent path is unknown and never loops", async () => {
    const { data } = parseProfilesFile(v1Text([host("p1", ["没有父级", "子级"])]), {});
    const child = data.groups.find((group) => group.name === "子级");
    const parent = data.groups.find((group) => group.name === "没有父级");
    expect(parent?.parentId).toBeNull();
    expect(child?.parentId).toBe(parent?.id);
    expect(data.profiles[0]?.groupId).toBe(child?.id);
  });
});

describe("version 2 files", () => {
  it("repairs a cyclic parentId and a dangling groupId to the root layer", async () => {
    const text =
      JSON.stringify(
        {
          version: 2,
          groups: [
            { id: "g1", name: "A", parentId: "g2" },
            { id: "g2", name: "B", parentId: "g1" },
            { id: "g3", name: "C", parentId: "gone" },
          ],
          profiles: [
            { id: "p1", name: "p1", kind: "ssh", groupId: "missing", createdAt: 1, updatedAt: 1 },
            { id: "p2", name: "p2", kind: "ssh", groupId: "g3", createdAt: 1, updatedAt: 1 },
          ],
        },
        null,
        2,
      ) + "\n";
    await writeFile(file, text, "utf8");

    await store.load();

    expect(store.groupById("g1")?.parentId).toBeNull();
    expect(store.groupById("g2")?.parentId).toBeNull();
    expect(store.groupById("g3")?.parentId).toBeNull();
    expect(store.groupPath("g1")).toEqual(["A"]);
    expect(store.get("p1")?.groupId).toBeNull();
    expect(store.get("p2")?.groupId).toBe("g3");
  });

  it("rejects an unknown version without touching the file", async () => {
    const text = JSON.stringify({ version: 3, profiles: [] }, null, 2) + "\n";
    await writeFile(file, text, "utf8");

    await expect(store.load()).rejects.toThrow(/profiles\.json/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});
