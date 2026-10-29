export interface FilterableHost {
  id: string;
  name: string;
  host?: string;
  groupId: string | null;
}

export interface FilterableGroup {
  id: string;
  name: string;
  parentId: string | null;
}

export interface HostFilterResult {
  /** 命中的主机 id */
  hostIds: Set<string>;
  /** 需要显示的分组 id（命中的分组 + 含命中主机的分组 + 它们的祖先） */
  groupIds: Set<string>;
}

/**
 * 主机/分组搜索。
 *
 * 三种命中方式：主机名、主机地址（IP/域名）、分组名。
 * **分组名命中时，它下面的主机全部显示**——搜"生产"就是想看那一组，而不是看空组名。
 * 同时把命中项的**祖先分组一并保留**，否则树会散架（子组出现但父组不在）。
 * 空查询返回 "全部显示" 的语义由调用方处理（这里返回全部）。
 */
export function filterHosts(
  query: string,
  hosts: readonly FilterableHost[],
  groups: readonly FilterableGroup[],
): HostFilterResult {
  const keyword = query.trim().toLowerCase();
  const byId = new Map(groups.map((group) => [group.id, group]));

  if (keyword === "") {
    return { hostIds: new Set(hosts.map((host) => host.id)), groupIds: new Set(groups.map((group) => group.id)) };
  }

  const matchedGroups = new Set(
    groups.filter((group) => group.name.toLowerCase().includes(keyword)).map((group) => group.id),
  );

  const hostIds = new Set<string>();
  for (const host of hosts) {
    const inMatchedGroup = host.groupId !== null && matchedGroups.has(host.groupId);
    const hit =
      host.name.toLowerCase().includes(keyword) ||
      (host.host ?? "").toLowerCase().includes(keyword) ||
      inMatchedGroup;
    if (hit) hostIds.add(host.id);
  }

  // 保留祖先：命中的分组 + 命中主机的分组，逐级向上
  const groupIds = new Set<string>(matchedGroups);
  const keepWithAncestors = (startId: string | null): void => {
    let current = startId;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const group = byId.get(current);
      if (group === undefined) return;
      groupIds.add(group.id);
      current = group.parentId;
    }
  };
  for (const group of groups) {
    if (matchedGroups.has(group.id)) keepWithAncestors(group.id);
  }
  for (const host of hosts) {
    if (hostIds.has(host.id)) keepWithAncestors(host.groupId);
  }

  return { hostIds, groupIds };
}
