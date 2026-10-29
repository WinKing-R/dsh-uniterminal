import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../src/store/profile-store.js";
import { parseSshConfig } from "../src/store/ssh-config-import.js";

/**
 * 回归锁（M45）：导入必须支持"先预览、后确认"。
 *
 * 用户要求：点导入先告诉他扫到几台，确认后才真正导入。
 * 这里锁住最关键的一点——**预览阶段绝不能写 profiles.json**。
 */
describe("import preview (M45)", () => {
  it("parses the config without touching the profile store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ut-import-"));
    const file = join(dir, "profiles.json");
    await writeFile(file, JSON.stringify({ version: 2, groups: [], profiles: [] }), "utf8");
    const before = await readFile(file, "utf8");

    const config = [
      "Host web-01",
      "  HostName 192.0.2.10",
      "  User root",
      "Host db-01",
      "  HostName 10.0.0.5",
    ].join("\n");
    const parsed = parseSshConfig(config);

    // 预览只用到解析结果
    expect(parsed.hosts).toHaveLength(2);
    // 存档一个字节都没变（预览不写盘）
    const store = new ProfileStore(file);
    await store.load();
    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
    expect(store.list()).toHaveLength(0);
  });
});
