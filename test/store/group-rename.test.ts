import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../../src/engine/registry.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import type { TransportAdapter } from "../../src/engine/types.js";
import { createRoutes, matchRoute, UNITERMINAL_ROUTES } from "../../src/routes.js";
import type { WebRouteLike } from "../../src/routes.js";
import { AppearanceStore } from "../../src/store/appearance.js";
import { ProfileStore } from "../../src/store/profile-store.js";
import type { StoredProfile } from "../../src/store/profile-store.js";

/**
 * M10-A 的核心断言：分组身份只存一份（groups 表）。
 * 改名因此只动一个字段，**一个 profile 都不该被重写**——快照 + spy 两条证据都要在。
 */

const adapter: TransportAdapter = {
  kind: "ssh",
  capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
  open: async (profile) => ({
    id: profile.id,
    kind: "ssh",
    capabilities: { exec: true, sftp: true, tunnel: true, resize: true },
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onClose: () => () => {},
    close: async () => {},
  }),
};

function makeManager(): SessionManager {
  const registry = new TransportRegistry();
  registry.register(adapter);
  return new SessionManager(registry, { bufferBytes: 16 });
}

function fakeRequest(address: string, method = "GET", body?: unknown, url?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = {
    method,
    url,
    socket: { remoteAddress: address, localPort: 7001 },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return request as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  body: unknown;
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(payload: string) {
      captured.body = JSON.parse(payload);
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

async function call(
  routes: WebRouteLike[],
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Captured> {
  const route = matchRoute(routes, pathname);
  if (route === undefined) throw new Error("no route matches: " + pathname);
  const response = fakeResponse();
  await route.handler(fakeRequest("127.0.0.1", options.method ?? "GET", options.body, pathname), response.res);
  return response.captured;
}

let dir = "";
let profilesFile = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "uniterminal-rename-"));
  profilesFile = join(dir, "profiles.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readPersisted = async (): Promise<{ groups?: unknown[]; profiles: StoredProfile[] }> =>
  JSON.parse(await readFile(profilesFile, "utf8")) as { groups?: unknown[]; profiles: StoredProfile[] };

const profileBytes = async (): Promise<string> => JSON.stringify((await readPersisted()).profiles);

const host = (id: string, groupId: string | null): StoredProfile => ({
  id,
  name: id,
  kind: "ssh",
  groupId,
  host: "192.0.2.10",
  port: 22,
  user: "root",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
});

describe("ProfileStore.renameGroup", () => {
  it("changes one name and leaves the whole profile block byte-identical", async () => {
    const store = new ProfileStore(profilesFile);
    const east = await store.ensureGroup(["生产", "华东"]);
    await store.upsert(host("p1", east.id));
    await store.upsert(host("p2", east.id));
    const beforeBytes = await profileBytes();
    const beforeProfiles = store.list().map((entry) => ({ ...entry }));
    const beforeUpdatedAt = store.get("p1")?.updatedAt;

    expect(await store.renameGroup(east.id, "华南")).toBe(true);

    expect(store.groupById(east.id)?.name).toBe("华南");
    expect(store.groupPath(east.id)).toEqual(["生产", "华南"]);
    expect(await profileBytes()).toBe(beforeBytes);
    expect(store.list()).toEqual(beforeProfiles);
    expect(store.get("p1")?.updatedAt).toBe(beforeUpdatedAt);
  });

  it("keeps the child groups attached and the colour untouched", async () => {
    const store = new ProfileStore(profilesFile);
    const east = await store.ensureGroup(["生产", "华东"]);
    const deep = await store.ensureGroup(["生产", "华东", "机房A"]);
    await store.setGroupColor(east.id, "#ff0000");

    await store.renameGroup(east.id, "华南");

    expect(store.groupById(deep.id)?.parentId).toBe(east.id);
    expect(store.groupPath(deep.id)).toEqual(["生产", "华南", "机房A"]);
    expect(store.groupById(east.id)?.color).toBe("#ff0000");
  });

  it("reports false for an unknown group, an empty name and an unchanged name", async () => {
    const store = new ProfileStore(profilesFile);
    const east = await store.ensureGroup(["生产"]);

    expect(await store.renameGroup("no-such-group", "华南")).toBe(false);
    expect(await store.renameGroup(east.id, "   ")).toBe(false);
    expect(await store.renameGroup(east.id, "甲/乙")).toBe(false);
    expect(await store.renameGroup(east.id, "生产")).toBe(false);
    expect(store.groupById(east.id)?.name).toBe("生产");
  });
});

describe("POST /folders/rename rewrites no profile", () => {
  async function setupRename(): Promise<{
    routes: WebRouteLike[];
    profiles: ProfileStore;
    appearance: AppearanceStore;
  }> {
    const profiles = new ProfileStore(profilesFile);
    const appearance = new AppearanceStore(join(dir, "appearance"));
    const ready = Promise.all([profiles.load(), appearance.load()]).then(() => undefined);
    const routes = createRoutes(makeManager(), { profiles, appearance, ready });
    await ready;
    return { routes, profiles, appearance };
  }

  const addHost = async (routes: WebRouteLike[], id: string, groupPath: string[]): Promise<void> => {
    const created = await call(routes, UNITERMINAL_ROUTES.profiles, {
      method: "POST",
      body: { profile: { id, name: id, kind: "ssh", groupPath, host: "192.0.2.10", port: 22, user: "root" } },
    });
    expect(created.status).toBe(201);
  };

  it("renames the deep group while every host stays on the same group id", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产", "华东"]);
    await addHost(routes, "p2", ["生产", "华东", "机房A"]);
    await addHost(routes, "p3", ["生产", "华东2"]);
    const groupIds = new Map(profiles.list().map((entry) => [entry.id, entry.groupId]));
    const beforeBytes = await profileBytes();
    const upsertSpy = vi.spyOn(profiles, "upsert");
    const removeSpy = vi.spyOn(profiles, "remove");

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产", "华东"], name: "华南" },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ renamed: 1 });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    // 一个字节都没动：连 updatedAt 都没有被刷新
    expect(await profileBytes()).toBe(beforeBytes);
    expect(new Map(profiles.list().map((entry) => [entry.id, entry.groupId]))).toEqual(groupIds);
    // 挂在最深组上的主机跟着组走，路径是派生的，不需要搬
    const renamedGroup = profiles.groupByPath(["生产", "华南"]);
    expect(renamedGroup).toBeDefined();
    expect(profiles.groupPath(profiles.get("p1")?.groupId ?? null)).toEqual(["生产", "华南"]);
    expect(profiles.groupPath(profiles.get("p2")?.groupId ?? null)).toEqual(["生产", "华南", "机房A"]);
    expect(profiles.groupPath(profiles.get("p3")?.groupId ?? null)).toEqual(["生产", "华东2"]);
  });

  it("writes no colour table when the renamed group carries a colour", async () => {
    const { routes, profiles, appearance } = await setupRename();
    await addHost(routes, "p1", ["生产", "华东"]);
    const group = profiles.groupByPath(["生产", "华东"]);
    expect(group).toBeDefined();
    await profiles.setGroupColor(group?.id ?? "", "#ff0000");

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["生产", "华东"], name: "华南" },
    });

    expect(renamed.status).toBe(200);
    expect(appearance.current().groupColors).toBeUndefined();
    expect(profiles.groupById(group?.id ?? "")?.color).toBe("#ff0000");
  });

  it("answers renamed:0 and writes nothing for an unknown path", async () => {
    const { routes, profiles } = await setupRename();
    await addHost(routes, "p1", ["生产"]);
    const renameSpy = vi.spyOn(profiles, "renameGroup");

    const renamed = await call(routes, UNITERMINAL_ROUTES.foldersRename, {
      method: "POST",
      body: { path: ["没有这个分组", "子级"], name: "新名" },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ renamed: 0 });
    expect(renameSpy).not.toHaveBeenCalled();
  });
});
