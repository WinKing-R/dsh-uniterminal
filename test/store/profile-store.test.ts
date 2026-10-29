import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredGroup, StoredProfile } from "../../src/store/profile-store.js";
import { ProfileStore } from "../../src/store/profile-store.js";

const renameSpy = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  renameSpy.mockImplementation((from: string, to: string) => actual.rename(from, to));
  return { ...actual, rename: renameSpy };
});

type PersistedFile = { version: number; profiles: StoredProfile[]; groups?: StoredGroup[] };

const profile = (overrides: Partial<StoredProfile> = {}): StoredProfile => ({
  id: "p1",
  name: "Prod",
  kind: "ssh",
  groupId: null,
  host: "10.0.0.1",
  port: 22,
  user: "ops",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

let dir = "";
let file = "";
let store: ProfileStore;

const readPersisted = async (): Promise<PersistedFile> =>
  JSON.parse(await readFile(file, "utf8")) as PersistedFile;

const renameCall = (index: number): { from: string; to: string } | undefined => {
  const call = (renameSpy.mock.calls as unknown[][])[index];
  if (call === undefined) return undefined;
  return { from: String(call[0]), to: String(call[1]) };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-profiles-"));
  file = join(dir, "profiles.json");
  store = new ProfileStore(file);
  renameSpy.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("lists nothing when profiles.json does not exist", async () => {
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("upserts and reads back a profile, stamping createdAt once and updatedAt on every write", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await store.upsert(profile({ createdAt: 0, updatedAt: 0 }));

      const first = store.get("p1");
      expect(first?.name).toBe("Prod");
      expect(first?.host).toBe("10.0.0.1");
      expect(first?.createdAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
      expect(first?.updatedAt).toBe(first?.createdAt);

      vi.setSystemTime(new Date("2026-01-01T00:00:07.000Z"));
      await store.upsert(profile({ name: "Prod renamed", createdAt: 0, updatedAt: 0 }));

      const second = store.get("p1");
      expect(second?.name).toBe("Prod renamed");
      expect(second?.createdAt).toBe(first?.createdAt);
      expect(second?.updatedAt).toBe(Date.parse("2026-01-01T00:00:07.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a single entry when the same id is upserted twice", async () => {
    await store.upsert(profile({ name: "Prod" }));
    await store.upsert(profile({ name: "Prod renamed" }));

    expect(store.list()).toHaveLength(1);
    const persisted = await readPersisted();
    expect(persisted.profiles).toHaveLength(1);
    expect(persisted.profiles[0]?.name).toBe("Prod renamed");
  });

  it("replaces profiles.json atomically through a temp file and rename", async () => {
    await store.upsert(profile());

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const call = renameCall(0);
    expect(call?.to).toBe(file);
    expect(call?.from).not.toBe(file);
    expect(dirname(call?.from ?? "")).toBe(dir);

    const persisted = await readPersisted();
    expect(persisted.version).toBe(2);
    expect(persisted.profiles.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("throws on malformed profiles.json instead of clearing it", async () => {
    const badVersion = JSON.stringify({ version: 3, profiles: [] });
    await writeFile(file, badVersion, "utf8");
    await expect(store.load()).rejects.toThrow(/profiles\.json/);
    expect(await readFile(file, "utf8")).toBe(badVersion);

    const badProfiles = JSON.stringify({ version: 2, profiles: "nope" });
    await writeFile(file, badProfiles, "utf8");
    await expect(store.load()).rejects.toThrow(/profiles\.json/);
    expect(await readFile(file, "utf8")).toBe(badProfiles);

    expect(store.list()).toEqual([]);
  });
});

describe("ProfileStore.groups", () => {
  it("keeps one group per level and reuses it for every later path", async () => {
    const east = await store.ensureGroup(["生产", "华东"]);
    const north = await store.ensureGroup(["生产", "华北"]);

    expect(store.listGroups().map((group) => group.name)).toEqual(["生产", "华东", "华北"]);
    expect(north.parentId).toBe(east.parentId);
    expect(store.groupPath(east.id)).toEqual(["生产", "华东"]);
    expect(store.groupByPath(["生产", "华东"])?.id).toBe(east.id);
    expect(store.groupByPath(["生产"])?.id).toBe(east.parentId);
    expect(store.groupByPath(["生产", "华南"])).toBeUndefined();
  });

  it("adds the same group twice without duplicating it or persisting twice", async () => {
    const first = await store.ensureGroup(["运维", "北京"]);
    const second = await store.ensureGroup(["运维", "北京"]);

    expect(second.id).toBe(first.id);
    expect(store.listGroups().map((group) => group.name)).toEqual(["运维", "北京"]);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect((await readPersisted()).groups?.map((group) => group.name)).toEqual(["运维", "北京"]);
  });

  it("shows a group that carries no host at all", async () => {
    await store.ensureGroup(["空分组"]);
    expect(store.list()).toEqual([]);
    expect(store.listGroups().map((group) => group.name)).toEqual(["空分组"]);
  });

  it("reloads the group tree from disk", async () => {
    const created = await store.ensureGroup(["生产"]);
    const reloaded = new ProfileStore(file);
    await reloaded.load();
    expect(reloaded.listGroups().map((group) => [group.id, group.name, group.parentId])).toEqual([
      [created.id, "生产", null],
    ]);
  });

  it("rejects a folder path that is empty, blank or contains a slash", async () => {
    await expect(store.ensureGroup([])).rejects.toThrow(/folder path/);
    await expect(store.ensureGroup([""])).rejects.toThrow(/folder path/);
    await expect(store.ensureGroup(["  "])).rejects.toThrow(/folder path/);
    await expect(store.ensureGroup(["生产/华东"])).rejects.toThrow(/folder path/);
    await expect(store.ensureGroup(["ok", "  "])).rejects.toThrow(/folder path/);

    expect(store.listGroups()).toEqual([]);
    await expect(readPersisted()).rejects.toThrow();
  });

  it("carries the colour on the group itself and never in appearance", async () => {
    const group = await store.ensureGroup(["生产"]);
    const coloured = await store.setGroupColor(group.id, "#ff0000");

    expect(coloured?.color).toBe("#ff0000");
    expect(store.groupById(group.id)?.color).toBe("#ff0000");
    expect((await readPersisted()).groups).toEqual([
      { id: group.id, name: "生产", parentId: null, color: "#ff0000" },
    ]);

    await store.setGroupColor(group.id, null);
    expect(store.groupById(group.id)).toEqual({ id: group.id, name: "生产", parentId: null });
  });
});

describe("ProfileStore.removeFolder", () => {
  it("removes the folder but keeps its hosts, sending them back to the root", async () => {
    const east = await store.ensureGroup(["生产", "华东"]);
    await store.upsert(profile({ id: "east", groupId: east.id, host: "10.0.0.9" }));
    const web = await store.ensureGroup(["生产", "华东", "web"]);
    await store.upsert(profile({ id: "deep", groupId: web.id, host: "10.0.0.10" }));
    await store.ensureGroup(["生产"]);

    const removed = await store.removeFolder(["生产"]);

    expect(removed).toBe(true);
    expect(store.list().map((entry) => entry.id).sort()).toEqual(["deep", "east"]);
    expect(store.get("east")?.groupId).toBeNull();
    expect(store.get("east")?.host).toBe("10.0.0.9");
    expect(store.get("deep")?.groupId).toBeNull();
    expect(store.listGroups()).toEqual([]);

    const persisted = await readPersisted();
    expect(persisted.groups).toEqual([]);
    expect(persisted.profiles).toHaveLength(2);
    expect(persisted.profiles.every((entry) => entry.groupId === null)).toBe(true);
  });

  it("reports false for a folder that never existed and writes nothing", async () => {
    expect(await store.removeFolder(["没有这个分组"])).toBe(false);
    await expect(readPersisted()).rejects.toThrow();
  });
});

describe("ProfileStore.remember", () => {
  it("roundtrips the remember flag and keeps credentials out of profiles.json", async () => {
    await store.upsert(profile({ id: "remembered", remember: true }));
    await store.upsert(profile({ id: "forgotten", remember: false }));
    await store.upsert(profile({ id: "legacy" }));

    const text = await readFile(file, "utf8");
    expect(text).not.toMatch(/password|passphrase|secret|credential|token/i);

    const persisted = (await readPersisted()).profiles;
    expect(persisted.find((entry) => entry.id === "remembered")?.remember).toBe(true);
    expect(persisted.find((entry) => entry.id === "forgotten")?.remember).toBe(false);
    expect(persisted.find((entry) => entry.id === "legacy")).not.toHaveProperty("remember");

    const reloaded = new ProfileStore(file);
    await reloaded.load();
    expect(reloaded.get("remembered")?.remember).toBe(true);
    expect(reloaded.get("forgotten")?.remember).toBe(false);
    expect(reloaded.get("legacy")?.remember).toBeUndefined();
  });

  it("rejects a non-boolean remember instead of coercing it", async () => {
    const text = JSON.stringify({
      version: 2,
      profiles: [
        { id: "p1", name: "Prod", kind: "ssh", groupId: null, createdAt: 0, updatedAt: 0, remember: "yes" },
      ],
    });
    await writeFile(file, text, "utf8");

    await expect(store.load()).rejects.toThrow(/field 'remember' must be a boolean/);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(store.list()).toEqual([]);
  });
});

describe("ProfileStore.auth", () => {
  const IDENTITY_PATH = "/home/ops/.ssh/id_ed25519";
  /** 不含换行的哨兵：任何编码里都原样出现，私钥内容一旦落盘就一定被抓到。 */
  const KEY_MARKER = "FAKE-KEY-MATERIAL-FOR-TESTS";

  it("roundtrips the auth block and persists the identity path only", async () => {
    await store.upsert(profile({ id: "key-path", auth: { kind: "key", identityPath: IDENTITY_PATH } }));
    await store.upsert(profile({ id: "key-pasted", auth: { kind: "key" } }));
    await store.upsert(profile({ id: "password-auth", auth: { kind: "password" } }));

    const text = await readFile(file, "utf8");
    expect(text).toContain(IDENTITY_PATH);
    expect(text).not.toContain(KEY_MARKER);
    expect(text).not.toMatch(/privateKey|BEGIN OPENSSH/);

    const reloaded = new ProfileStore(file);
    await reloaded.load();
    expect(reloaded.get("key-path")?.auth).toEqual({ kind: "key", identityPath: IDENTITY_PATH });
    expect(reloaded.get("key-pasted")?.auth).toEqual({ kind: "key" });
    expect(reloaded.get("password-auth")?.auth).toEqual({ kind: "password" });
  });

  it("rejects an unknown auth kind instead of coercing it", async () => {
    const text = JSON.stringify({
      version: 2,
      profiles: [
        { id: "p1", name: "Prod", kind: "ssh", groupId: null, createdAt: 0, updatedAt: 0, auth: { kind: "agent" } },
      ],
    });
    await writeFile(file, text, "utf8");

    await expect(store.load()).rejects.toThrow(/field 'auth.kind'/);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(store.list()).toEqual([]);
  });

  it("rejects an empty or non-string identityPath without clearing the file", async () => {
    for (const identityPath of ["", "   ", 42]) {
      const text = JSON.stringify({
        version: 2,
        profiles: [
          {
            id: "p1",
            name: "Prod",
            kind: "ssh",
            groupId: null,
            createdAt: 0,
            updatedAt: 0,
            auth: { kind: "key", identityPath },
          },
        ],
      });
      await writeFile(file, text, "utf8");

      await expect(store.load()).rejects.toThrow(/field 'auth.identityPath'/);
      expect(await readFile(file, "utf8")).toBe(text);
      expect(store.list()).toEqual([]);
    }
  });

  it("rejects an auth block that is not an object", async () => {
    const text = JSON.stringify({
      version: 2,
      profiles: [{ id: "p1", name: "Prod", kind: "ssh", groupId: null, createdAt: 0, updatedAt: 0, auth: "key" }],
    });
    await writeFile(file, text, "utf8");

    await expect(store.load()).rejects.toThrow(/field 'auth' must be an object/);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(store.list()).toEqual([]);
  });
});

describe("ProfileStore.proxyJump", () => {
  // M3-3 跳板链：链必须落盘并能原样读回；每条形如 user@host:port（user/port 可省略）
  it("roundtrips the proxy jump chain", async () => {
    await store.upsert(profile({ id: "jumped", proxyJump: ["ops@bastion.example.com:2222", "jump2.internal"] }));
    await store.upsert(profile({ id: "direct" }));

    const persisted = (await readPersisted()).profiles;
    expect(persisted.find((entry) => entry.id === "jumped")?.proxyJump).toEqual([
      "ops@bastion.example.com:2222",
      "jump2.internal",
    ]);
    expect(persisted.find((entry) => entry.id === "direct")).not.toHaveProperty("proxyJump");

    const reloaded = new ProfileStore(file);
    await reloaded.load();
    expect(reloaded.get("jumped")?.proxyJump).toEqual(["ops@bastion.example.com:2222", "jump2.internal"]);
    expect(reloaded.get("direct")?.proxyJump).toBeUndefined();
  });

  it("rejects a proxyJump that is not a non-empty string array without clearing the file", async () => {
    const invalid: unknown[] = ["bastion.example.com", [42], [""], ["   "], [null], [{}]];
    for (const proxyJump of invalid) {
      const text = JSON.stringify({
        version: 2,
        profiles: [
          { id: "p1", name: "Prod", kind: "ssh", groupId: null, createdAt: 0, updatedAt: 0, proxyJump },
        ],
      });
      await writeFile(file, text, "utf8");

      await expect(store.load()).rejects.toThrow(/field 'proxyJump'/);
      expect(await readFile(file, "utf8")).toBe(text);
      expect(store.list()).toEqual([]);
    }
  });
});

