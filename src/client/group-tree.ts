/**
 * M10-B：分组表的客户端纯函数。
 *
 * 宿主 M10-A 起按 {id,name,parentId,color} 存分组，主机只带 groupId；
 * 树因此必须由 parentId 拼，而不是由每台主机的路径字符串拼。
 * 这里刻意不依赖 react：存档坏掉（悬空父级、自指、成环）时的行为要能被单测钉死。
 */

/** 与 GET /profiles 响应里的 groups 同形（也是 GET /groups 的元素）。 */
export interface ClientGroup {
  id: string;
  name: string;
  parentId: string | null;
  color?: string;
}

/** 渲染用的一层：深度与完整路径随树算好，组件不必再回溯。 */
export interface GroupNode extends ClientGroup {
  depth: number;
  path: string[];
  children: GroupNode[];
}

/** id 相同的重复条目只认第一条：坏存档不至于让同一个分组渲染两遍。 */
function indexById(groups: readonly ClientGroup[]): Map<string, ClientGroup> {
  const byId = new Map<string, ClientGroup>();
  for (const group of groups) if (!byId.has(group.id)) byId.set(group.id, group);
  return byId;
}

/**
 * 一个分组的**有效父级**：悬空、自指、以及任何能回到自己的祖先链，一律挂根层。
 * 返回值只会是「父链能正常终结」的 id，因此建成的一定是森林，绝不成环。
 */
function effectiveParentOf(node: ClientGroup, byId: Map<string, ClientGroup>): string | null {
  const parentId = node.parentId;
  if (parentId === null || parentId === node.id || !byId.has(parentId)) return null;
  const seen = new Set<string>([node.id]);
  let current: string = parentId;
  for (;;) {
    // 回到走过的节点 = 成环：断开这一条，挂根层
    if (seen.has(current)) return null;
    seen.add(current);
    const next = byId.get(current)?.parentId ?? null;
    // 父链正常终结（根层 / 自指 / 悬空）：这个父级可以放心用
    if (next === null || next === current || !byId.has(next)) return parentId;
    current = next;
  }
}

/**
 * parentId 列表 → 森林。兄弟顺序沿用宿主的顺序（宿主已按完整路径排过）。
 * 每个分组最多出现一次，坏数据再离谱也不会死循环。
 */
export function buildGroupTree(groups: readonly ClientGroup[]): GroupNode[] {
  const byId = indexById(groups);
  const nodeById = new Map<string, GroupNode>();
  for (const group of byId.values()) {
    nodeById.set(group.id, {
      id: group.id,
      name: group.name,
      parentId: effectiveParentOf(group, byId),
      color: group.color,
      depth: 0,
      path: [],
      children: [],
    });
  }
  const roots: GroupNode[] = [];
  for (const node of nodeById.values()) {
    const parent = node.parentId === null ? undefined : nodeById.get(node.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  // 深度与路径在这一趟里算：只在森林里走，visited 只是防御
  const visited = new Set<string>();
  const walk = (node: GroupNode, depth: number, prefix: string[]): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    node.depth = depth;
    node.path = [...prefix, node.name];
    for (const child of node.children) walk(child, depth + 1, node.path);
  };
  for (const root of roots) walk(root, 0, []);
  return roots;
}

/** 深度优先展开成一行一个分组：渲染侧只按下标画缩进与成员。 */
export function flattenGroupTree(tree: readonly GroupNode[]): GroupNode[] {
  const rows: GroupNode[] = [];
  const visited = new Set<string>();
  const walk = (nodes: readonly GroupNode[]): void => {
    for (const node of nodes) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      rows.push(node);
      walk(node.children);
    }
  };
  walk(tree);
  return rows;
}

/** 分组 id → 完整路径（名字链）。根层与未知 id 都是空数组：调用方按"没有父级"处理。 */
export function groupPathOf(tree: readonly GroupNode[], id: string | null): string[] {
  if (id === null) return [];
  return flattenGroupTree(tree).find((node) => node.id === id)?.path ?? [];
}

/** 用户手写的路径 → 分组。空路径是根层、查不到的路径都不算命中，由调用方分别处理。 */
export function findGroupByPath(tree: readonly GroupNode[], path: readonly string[]): GroupNode | undefined {
  if (path.length === 0) return undefined;
  return flattenGroupTree(tree).find(
    (node) => node.path.length === path.length && node.path.every((name, index) => name === path[index]),
  );
}
