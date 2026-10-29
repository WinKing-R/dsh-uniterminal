import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProfileAuth, ProfileAuthKind, ProtocolKind } from "../engine/types.js";
import { AUTH_KINDS, authKindsText, isAuthKind } from "../auth-kinds.js";
import { diag } from "../host-diag.js";

/** 分组表的一行（M10-A）：分组身份的唯一事实来源，路径是派生的，不落盘。 */
export interface StoredGroup {
  id: string;
  name: string;
  /** 上级分组 id；null = 顶层。 */
  parentId: string | null;
  /** #rgb / #rrggbb；没设过颜色就没有这个字段。 */
  color?: string;
}

export interface StoredProfile {
  id: string;
  name: string;
  kind: ProtocolKind;
  /** 指向 groups 表；null = 根层。绝不存路径——改个组名不该搬动任何主机。 */
  groupId: string | null;
  host?: string;
  port?: number;
  user?: string;
  keepaliveMs?: number;
  connectTimeoutMs?: number;
  tags?: string[];
  /** D10 记住密码：profiles.json 里唯一与凭据有关的字段，口令本身只进保险库。 */
  remember?: boolean;
  /** M2b 私钥认证：只有方式与路径；私钥内容只进 credentials.json（ref = key:<profileId>）。 */
  auth?: ProfileAuth;
  /**
   * M3-3 跳板链：按顺序经这些跳板机连到本主机，每项形如 user@host:port（user 与 port 可省略）。
   * 空数组等价于没配；任何一项都必须是非空字符串。
   */
  proxyJump?: string[];
  createdAt: number;
  updatedAt: number;
}

/** profiles.json 的完整形状（version 2：groups 表 + 只按 id 引用分组的 profiles）。 */
export interface ProfilesFile {
  version: 2;
  groups: StoredGroup[];
  profiles: StoredProfile[];
}

/** 解析结果：migrated 为真时调用方负责备份与写回。 */
export interface ParsedProfilesFile {
  data: ProfilesFile;
  migrated: boolean;
  /** 找不到对应分组而被丢弃的颜色条数：旧颜色表只作为迁移来源读一次。 */
  droppedColors: number;
}

const VERSION = 2;
const LEGACY_VERSION = 1;
const FILE_NAME = "profiles.json";
/** 迁移前的原文件副本：只写一次为 v1 的那一份，重名覆盖。 */
const BACKUP_SUFFIX = ".bak-v1";
/** 与 profiles.json 同目录的外观测文件：里头的 groupColors 是颜色的唯一迁移来源。 */
const APPEARANCE_FILE = "appearance.json";
const PROTOCOLS: readonly string[] = ["ssh", "local", "telnet", "serial"];
const GROUP_SEPARATOR = "\u0000";
/** 旧颜色表的键是显示名：与客户端 groupLabel 同一条拼接规则。 */
const GROUP_LABEL_SEPARATOR = " / ";
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isMissingFile = (error: unknown): boolean => asRecord(error)?.code === "ENOENT";

const compareGroupPaths = (left: string[], right: string[]): number => {
  const a = left.join(GROUP_SEPARATOR);
  const b = right.join(GROUP_SEPARATOR);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * 分组路径校验：非空数组、每段非空且不含 "/"。
 * 多级由数组本身表达，绝不靠分隔符——这正是宿主路由踩过尾斜杠事故的同类问题。
 */
export const normalizeFolderPath = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("folder path must be a non-empty array of non-empty strings");
  }
  const segments: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new TypeError("folder path must be a non-empty array of non-empty strings");
    }
    const segment = item.trim();
    if (segment === "") throw new TypeError("folder path must be a non-empty array of non-empty strings");
    if (segment.includes("/")) throw new TypeError("folder path segments must not contain '/'");
    segments.push(segment);
  }
  return segments;
};

/**
 * 迁移用的宽松版本：坏数据一律降级（丢弃该段），绝不抛。
 * 旧存档是手改过的可能性最高的一份数据，宁可少一个分组也不要让插件起不来。
 */
const sanitizeGroupPath = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const segments: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const segment = item.trim();
    if (segment === "" || segment.includes("/")) continue;
    segments.push(segment);
  }
  return segments;
};

const isProtocolKind = (value: unknown): value is ProtocolKind =>
  typeof value === "string" && PROTOCOLS.includes(value);

// 认证方式的白名单只在 src/auth-kinds.ts 维护；这里不再复制一份

const isStringArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && (value as unknown[]).every((item) => typeof item === "string");

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("field '" + key + "' must be a string");
  return value;
};

const optionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("field '" + key + "' must be a finite number");
  }
  return value;
};

const optionalStringArray = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isStringArray(value)) throw new Error("field '" + key + "' must be a string array");
  return value.map((item) => String(item));
};

/**
 * 跳板链：每一项都是非空字符串（user@host:port）。非法一律报错并保留原文件，
 * 绝不悄悄丢掉整条链——那样用户会以为自己在直连。
 */
const optionalProxyJump = (record: Record<string, unknown>): string[] | undefined => {
  const value = record.proxyJump;
  if (value === undefined) return undefined;
  const invalid = (): Error => new Error("field 'proxyJump' must be a non-empty string array");
  if (!Array.isArray(value)) throw invalid();
  const hops: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw invalid();
    const hop = item.trim();
    if (hop === "") throw invalid();
    hops.push(hop);
  }
  return hops;
};

const optionalBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("field '" + key + "' must be a boolean");
  return value;
};

/**
 * auth 块只认方式与路径：私钥内容（privateKey / passphrase）不在白名单里，
 * 就算有人手改了文件也解析不出来，下一次落盘即被丢弃。
 */
const optionalAuth = (record: Record<string, unknown>): ProfileAuth | undefined => {
  const value = record.auth;
  if (value === undefined) return undefined;
  const auth = asRecord(value);
  if (auth === undefined) throw new Error("field 'auth' must be an object");
  const kind = auth.kind;
  if (!isAuthKind(kind)) throw new Error("field 'auth.kind' must be one of " + AUTH_KINDS.join(", "));
  const identityPath = auth.identityPath;
  if (identityPath === undefined) return { kind };
  if (typeof identityPath !== "string" || identityPath.trim() === "") {
    throw new Error("field 'auth.identityPath' must be a non-empty string");
  }
  return { kind, identityPath };
};

/**
 * 分组引用只认非空字符串 id，其余（缺省、null、数字、空串）一律当根层：
 * 指向不存在的分组也由 parseV2 统一回收到根层，绝不让主机凭空消失。
 */
const groupIdOf = (record: Record<string, unknown>): string | null => {
  const value = record.groupId;
  return typeof value === "string" && value !== "" ? value : null;
};

const parseStoredProfile = (value: unknown): StoredProfile => {
  const record = asRecord(value);
  if (record === undefined) throw new Error("entry must be an object");

  const id = record.id;
  if (typeof id !== "string" || id === "") throw new Error("field 'id' must be a non-empty string");

  const name = record.name;
  if (typeof name !== "string") throw new Error("field 'name' must be a string");

  const kind = record.kind;
  if (!isProtocolKind(kind)) {
    throw new Error("field 'kind' must be one of " + PROTOCOLS.join(", "));
  }
  const createdAt = record.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    throw new Error("field 'createdAt' must be a finite number");
  }

  const updatedAt = record.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    throw new Error("field 'updatedAt' must be a finite number");
  }

  return {
    id,
    name,
    kind,
    groupId: groupIdOf(record),
    host: optionalString(record, "host"),
    port: optionalNumber(record, "port"),
    user: optionalString(record, "user"),
    keepaliveMs: optionalNumber(record, "keepaliveMs"),
    connectTimeoutMs: optionalNumber(record, "connectTimeoutMs"),
    tags: optionalStringArray(record, "tags"),
    remember: optionalBoolean(record, "remember"),
    auth: optionalAuth(record),
    proxyJump: optionalProxyJump(record),
    createdAt,
    updatedAt,
  };
};

/** 单条分组：坏到无法解释的行返回 undefined（由 repairGroups 之外的上层计数丢弃）。 */
const parseGroup = (value: unknown): StoredGroup | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = record.id;
  if (typeof id !== "string" || id === "") return undefined;
  const rawName = record.name;
  if (typeof rawName !== "string") return undefined;
  const name = rawName.trim();
  if (name === "" || name.includes("/")) return undefined;
  const rawParent = record.parentId;
  const parentId = typeof rawParent === "string" && rawParent !== "" ? rawParent : null;
  const group: StoredGroup = { id, name, parentId };
  const color = record.color;
  if (typeof color === "string" && COLOR_PATTERN.test(color)) group.color = color;
  return group;
};

/**
 * 坏数据修复：重复 id 只留第一条；父级不存在、自指、成环、或自己就在环上——一律挂到根层。
 * 判定用修复前的快照，结果因此与遍历顺序无关：同一份坏文件读两次得到同一棵树。
 */
const repairGroups = (groups: StoredGroup[]): StoredGroup[] => {
  const unique = new Map<string, StoredGroup>();
  for (const group of groups) if (!unique.has(group.id)) unique.set(group.id, group);

  const flatten = new Set<string>();
  for (const group of unique.values()) {
    const seen = new Set<string>();
    let current: StoredGroup | undefined = group;
    while (current !== undefined) {
      if (seen.has(current.id)) {
        flatten.add(group.id);
        break;
      }
      seen.add(current.id);
      current = current.parentId === null ? undefined : unique.get(current.parentId);
    }
  }

  const repaired: StoredGroup[] = [];
  for (const group of unique.values()) {
    const parentId = group.parentId;
    const broken =
      parentId === null ||
      parentId === group.id ||
      !unique.has(parentId) ||
      flatten.has(group.id);
    repaired.push(broken && parentId !== null ? { ...group, parentId: null } : group);
  }
  return repaired;
};

/** 路径按首次出现顺序建分组：a/b 一定同时有 a，parentId 逐级串联。 */
const buildGroups = (paths: readonly string[][]): { groups: StoredGroup[]; idOfPath: Map<string, string> } => {
  const groups: StoredGroup[] = [];
  const byPath = new Map<string, StoredGroup>();
  const idOfPath = new Map<string, string>();
  for (const path of paths) {
    let parentId: string | null = null;
    for (let depth = 1; depth <= path.length; depth += 1) {
      const prefix = path.slice(0, depth);
      const key = prefix.join(GROUP_SEPARATOR);
      let group = byPath.get(key);
      if (group === undefined) {
        group = { id: "g" + String(groups.length + 1), name: path[depth - 1] ?? "", parentId };
        groups.push(group);
        byPath.set(key, group);
      }
      idOfPath.set(key, group.id);
      parentId = group.id;
    }
  }
  return { groups, idOfPath };
};

/**
 * version 1 → 2：folders 的路径与每个 profile 的 groupPath 一起变成 groups 表；
 * profile 只留最深那一级的 id；颜色表（键是显示名）落成 group.color，对不上的键丢弃。
 * 顺序：先 folders 再 profiles 的路径，按首次出现去重——同一份旧文件迁移多少次都得到同一张表。
 */
const migrateV1 = (record: Record<string, unknown>, legacyGroupColors: Record<string, string>): ParsedProfilesFile => {
  const entries = record.profiles;
  if (!Array.isArray(entries)) throw new Error("'profiles' must be an array");

  const legacy: { profile: StoredProfile; path: string[] }[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const draft = asRecord(entries[index]);
    try {
      // 分组引用在旧文件里叫 groupPath：解析完统一丢掉，只保留 path 供建表用
      const parsed = parseStoredProfile(draft === undefined ? entries[index] : { ...draft, groupId: null });
      legacy.push({ profile: parsed, path: sanitizeGroupPath(draft?.groupPath) });
    } catch (error) {
      throw new Error("profiles[" + index + "]: " + messageOf(error));
    }
  }

  const folderPaths: string[][] = [];
  const rawFolders = record.folders;
  if (Array.isArray(rawFolders)) {
    for (const entry of rawFolders) {
      const path = sanitizeGroupPath(entry);
      if (path.length > 0) folderPaths.push(path);
    }
  }

  const { groups, idOfPath } = buildGroups([...folderPaths, ...legacy.map((entry) => entry.path)]);
  const profiles = legacy.map((entry) => {
    const id = entry.path.length === 0 ? undefined : idOfPath.get(entry.path.join(GROUP_SEPARATOR));
    return { ...entry.profile, groupId: id ?? null };
  });

  const byId = new Map(groups.map((group) => [group.id, group]));
  let droppedColors = 0;
  for (const [label, color] of Object.entries(legacyGroupColors)) {
    const path = sanitizeGroupPath(label.split(GROUP_LABEL_SEPARATOR));
    const id = path.length === 0 ? undefined : idOfPath.get(path.join(GROUP_SEPARATOR));
    const group = id === undefined ? undefined : byId.get(id);
    if (group === undefined) {
      droppedColors += 1;
      continue;
    }
    group.color = color;
  }

  return {
    data: { version: VERSION, groups, profiles },
    migrated: true,
    droppedColors,
  };
};

const parseVersion2 = (record: Record<string, unknown>): ParsedProfilesFile => {
  const rawGroups = record.groups;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) throw new Error("'groups' must be an array");
  const parsedGroups: StoredGroup[] = [];
  for (const entry of rawGroups ?? []) {
    const group = parseGroup(entry);
    if (group !== undefined) parsedGroups.push(group);
  }
  const groups = repairGroups(parsedGroups);

  const entries = record.profiles;
  if (!Array.isArray(entries)) throw new Error("'profiles' must be an array");
  const profiles: StoredProfile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    try {
      profiles.push(parseStoredProfile(entries[index]));
    } catch (error) {
      throw new Error("profiles[" + index + "]: " + messageOf(error));
    }
  }

  const known = new Set(groups.map((group) => group.id));
  const repaired = profiles.map((profile) =>
    profile.groupId !== null && !known.has(profile.groupId) ? { ...profile, groupId: null } : profile,
  );
  return { data: { version: VERSION, groups, profiles: repaired }, migrated: false, droppedColors: 0 };
};

/**
 * 解析存档：version 2 直接读；version 1 当场迁移（加载时自动执行）；别的版本沿用旧口径报错。
 * 纯函数——颜色以参数传入，读文件与落盘都由 ProfileStore 负责。
 */
export function parseProfilesFile(
  text: string,
  legacyGroupColors: Record<string, string> = {},
): ParsedProfilesFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("content is not valid JSON");
  }
  const record = asRecord(raw);
  if (record === undefined) throw new Error("root must be an object");
  if (record.version === VERSION) return parseVersion2(record);
  if (record.version === LEGACY_VERSION) return migrateV1(record, legacyGroupColors);
  throw new Error("version must be " + LEGACY_VERSION + " or " + VERSION);
}

/** 规范形：字段顺序固定，同一份数据永远序列化成同一串字节（幂等的地基）。 */
export function serializeProfilesFile(data: ProfilesFile): string {
  return JSON.stringify({ version: VERSION, groups: data.groups, profiles: data.profiles }, null, 2) + "\n";
}

export class ProfileStore {
  readonly #file: string;
  readonly #groups = new Map<string, StoredGroup>();
  readonly #profiles = new Map<string, StoredProfile>();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const legacyColors = await this.#legacyGroupColorsIfNeeded(text);
    let parsed: ParsedProfilesFile;
    try {
      parsed = parseProfilesFile(text, legacyColors);
    } catch (error) {
      throw this.#invalid(messageOf(error));
    }
    this.#groups.clear();
    this.#profiles.clear();
    for (const group of parsed.data.groups) this.#groups.set(group.id, group);
    for (const profile of parsed.data.profiles) this.#profiles.set(profile.id, profile);
    if (!parsed.migrated) return;
    if (parsed.droppedColors > 0) diag("profile.migrate-colors-dropped", { count: parsed.droppedColors });
    await this.#writeBackup(text);
    await this.#persist();
  }

  list(): StoredProfile[] {
    return [...this.#profiles.values()];
  }

  get(id: string): StoredProfile | undefined {
    return this.#profiles.get(id);
  }

  /** 全部分组，按完整路径排序：树的形状对调用方是确定的。 */
  listGroups(): StoredGroup[] {
    return [...this.#groups.values()].sort((left, right) =>
      compareGroupPaths(this.groupPath(left.id), this.groupPath(right.id)),
    );
  }

  groupById(id: string): StoredGroup | undefined {
    return this.#groups.get(id);
  }

  /** 分组到根层的路径（显示名按 " / " 拼接由调用方做）；断链或成环都停在那里，绝不抛。 */
  groupPath(groupId: string | null): string[] {
    const segments: string[] = [];
    const seen = new Set<string>();
    let currentId = groupId;
    while (currentId !== null && !seen.has(currentId)) {
      const group = this.#groups.get(currentId);
      if (group === undefined) break;
      seen.add(currentId);
      segments.unshift(group.name);
      currentId = group.parentId;
    }
    return segments;
  }

  /** 逐段按名字下行；客户端仍用路径寻址，这是那条旧契约的唯一入口。 */
  groupByPath(path: readonly string[]): StoredGroup | undefined {
    let parentId: string | null = null;
    let found: StoredGroup | undefined;
    for (const name of path) {
      found = this.#childByName(parentId, name);
      if (found === undefined) return undefined;
      parentId = found.id;
    }
    return found;
  }

  /** 让这条路径上每一级分组都存在（同级同名唯一）；已存在则复用，没有任何新建就不落盘。 */
  async ensureGroup(path: readonly string[]): Promise<StoredGroup> {
    const segments = normalizeFolderPath(path);
    let parentId: string | null = null;
    let current: StoredGroup | undefined;
    let created = false;
    for (const name of segments) {
      current = this.#childByName(parentId, name);
      if (current === undefined) {
        current = { id: randomUUID(), name, parentId };
        this.#groups.set(current.id, current);
        created = true;
      }
      parentId = current.id;
    }
    if (created) await this.#persist();
    if (current === undefined) throw new TypeError("folder path must be a non-empty array of non-empty strings");
    return current;
  }

  /**
   * 分组改名：**只改一个字段**。主机靠 groupId 引用分组，
   * 因此没有一台主机会被重写，updatedAt 也不会被刷新。
   */
  async renameGroup(id: string, name: string): Promise<boolean> {
    const group = this.#groups.get(id);
    if (group === undefined) return false;
    const next = name.trim();
    if (next === "" || next.includes("/") || next === group.name) return false;
    this.#groups.set(id, { ...group, name: next });
    await this.#persist();
    return true;
  }

  /** 颜色随分组走：写进 group.color，不再碰 appearance.groupColors。 */
  async setGroupColor(id: string, color: string | null): Promise<StoredGroup | undefined> {
    const group = this.#groups.get(id);
    if (group === undefined) return undefined;
    if (color !== null && !COLOR_PATTERN.test(color)) {
      throw new TypeError("color must be #rgb or #rrggbb");
    }
    const next: StoredGroup = { id: group.id, name: group.name, parentId: group.parentId };
    if (color !== null) next.color = color;
    this.#groups.set(id, next);
    await this.#persist();
    return next;
  }

  /** 删除分组子树；其中的主机一律保留，回到根层。返回是否真的动过东西。 */
  async removeFolder(path: readonly string[]): Promise<boolean> {
    const group = this.groupByPath(path);
    if (group === undefined) return false;
    const doomed = new Set<string>([group.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of this.#groups.values()) {
        if (candidate.parentId === null || doomed.has(candidate.id)) continue;
        if (!doomed.has(candidate.parentId)) continue;
        doomed.add(candidate.id);
        grew = true;
      }
    }
    const now = Date.now();
    let changed = false;
    for (const id of doomed) if (this.#groups.delete(id)) changed = true;
    for (const profile of this.list()) {
      if (profile.groupId === null || !doomed.has(profile.groupId)) continue;
      this.#profiles.set(profile.id, { ...profile, groupId: null, updatedAt: now });
      changed = true;
    }
    if (changed) await this.#persist();
    return changed;
  }

  async upsert(profile: StoredProfile): Promise<void> {
    const existing = this.#profiles.get(profile.id);
    const now = Date.now();
    // 分组被删掉的同时有人回写档案：宁可把主机放回根层，也不要留一个指向空气的引用
    const groupId = profile.groupId !== null && this.#groups.has(profile.groupId) ? profile.groupId : null;
    this.#profiles.set(profile.id, {
      ...profile,
      groupId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await this.#persist();
  }

  async remove(id: string): Promise<void> {
    if (!this.#profiles.delete(id)) return;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const payload = serializeProfilesFile({ version: VERSION, groups: this.listGroups(), profiles: this.list() });
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

  /** 备份失败只留痕：迁移本身是硬要求，备份只是后悔药。 */
  async #writeBackup(text: string): Promise<void> {
    const backup = this.#file + BACKUP_SUFFIX;
    try {
      await writeFile(backup, text, "utf8");
    } catch (error) {
      diag("profile.backup-failed", { path: backup, error: messageOf(error).slice(0, 160) });
    }
  }

  /** 只有真要读旧颜色时才碰 appearance.json；读不到/坏掉都等于「没有颜色表」。 */
  async #legacyGroupColorsIfNeeded(text: string): Promise<Record<string, string>> {
    try {
      const probe: unknown = JSON.parse(text);
      if (asRecord(probe)?.version !== LEGACY_VERSION) return {};
    } catch {
      return {};
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dirname(this.#file), APPEARANCE_FILE), "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) diag("profile.legacy-colors-failed", { error: messageOf(error).slice(0, 160) });
      return {};
    }
    const colors = asRecord(asRecord(raw)?.appearance)?.groupColors;
    if (colors === undefined) return {};
    const legacy: Record<string, string> = {};
    const record = asRecord(colors);
    if (record === undefined) return {};
    for (const [label, color] of Object.entries(record)) {
      if (typeof color === "string" && COLOR_PATTERN.test(color)) legacy[label] = color;
    }
    return legacy;
  }

  #childByName(parentId: string | null, name: string): StoredGroup | undefined {
    for (const group of this.#groups.values()) {
      if (group.parentId === parentId && group.name === name) return group;
    }
    return undefined;
  }

  #invalid(reason: string): Error {
    return new Error("uniterminal: " + FILE_NAME + " is invalid (" + this.#file + "): " + reason);
  }
}
