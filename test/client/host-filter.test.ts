import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { filterHosts } from "../../src/client/host-filter.js";

/**
 * 回归锁（M40）：主机/分组搜索。
 *
 * 用户诉求：「增加一个放大镜搜索分组名或者主机名或者主机IP，以应对大量主机的使用场景」。
 * 三个关键语义：命中分组 → 该组主机全显示；命中主机 → 保留它所在分组与祖先；空查询 → 全部。
 */
const groups = [
  { id: "g1", name: "生产", parentId: null },
  { id: "g2", name: "华东", parentId: "g1" },
  { id: "g3", name: "测试", parentId: null },
];
const hosts = [
  { id: "h1", name: "web-01", host: "192.0.2.10", groupId: "g2" },
  { id: "h2", name: "db-01", host: "10.0.0.5", groupId: "g3" },
  { id: "h3", name: "root-box", host: "127.0.0.1", groupId: null },
];

describe("filterHosts (M40)", () => {
  it("returns everything for an empty query", () => {
    const result = filterHosts("   ", hosts, groups);
    expect([...result.hostIds].sort()).toEqual(["h1", "h2", "h3"]);
    expect(result.groupIds.size).toBe(3);
  });

  it("matches by host name", () => {
    const result = filterHosts("web", hosts, groups);
    expect([...result.hostIds]).toEqual(["h1"]);
    // 命中主机要保留它所在分组与祖先，否则树会散架
    expect([...result.groupIds].sort()).toEqual(["g1", "g2"]);
  });

  it("matches by address", () => {
    const result = filterHosts("10.0.0", hosts, groups);
    expect([...result.hostIds]).toEqual(["h2"]);
    expect([...result.groupIds]).toEqual(["g3"]);
  });

  it("shows a whole group when its name matches", () => {
    const result = filterHosts("华东", hosts, groups);
    // 命中分组 → 组内主机一起显示（搜"华东"是想看那一组，而不是只看空组名）
    expect([...result.hostIds]).toEqual(["h1"]);
    expect([...result.groupIds].sort()).toEqual(["g1", "g2"]);
  });

  it("ignores case", () => {
    expect([...filterHosts("WEB", hosts, groups).hostIds]).toEqual(["h1"]);
  });

  it("returns nothing when nothing matches", () => {
    const result = filterHosts("zzz", hosts, groups);
    expect(result.hostIds.size).toBe(0);
    expect(result.groupIds.size).toBe(0);
  });

  it("caps the search query at the shared name limit (M44)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");
    const { NAME_MAX } = await import("../../src/name-limits.js");

    // 能被搜到的名字最长就是 NAME_MAX；IPv4 最多 15 —— 更长的输入不可能命中
    expect(NAME_MAX).toBe(16);
    expect(list).toContain("maxLength={NAME_MAX}");
  });
});
