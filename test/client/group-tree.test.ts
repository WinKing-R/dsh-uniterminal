import { describe, expect, it } from "vitest";
import {
  buildGroupTree,
  findGroupByPath,
  flattenGroupTree,
  groupPathOf,
  type ClientGroup,
} from "../../src/client/group-tree.js";

/** 分组表的三种坏形状（悬空父级、自指、成环）都真实出现过：这里直接给形状，不去构造宿主。 */
const group = (id: string, name: string, parentId: string | null, color?: string): ClientGroup =>
  color === undefined ? { id, name, parentId } : { id, name, parentId, color };

/** 一行一个分组的扁平描述：名字/深度/完整路径，断言层级最省事。 */
const shape = (tree: ReturnType<typeof buildGroupTree>): [string, number, string][] =>
  flattenGroupTree(tree).map((node) => [node.name, node.depth, node.path.join("/")]);

describe("buildGroupTree", () => {
  it("builds a three-level tree with depth and full path", () => {
    const tree = buildGroupTree([group("g1", "生产", null), group("g2", "华东", "g1"), group("g3", "机房A", "g2")]);
    expect(tree).toHaveLength(1);
    expect(shape(tree)).toEqual([
      ["生产", 0, "生产"],
      ["华东", 1, "生产/华东"],
      ["机房A", 2, "生产/华东/机房A"],
    ]);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("g3");
  });

  it("keeps the host order among siblings", () => {
    // 宿主按完整路径排序：生产, 生产/华东, 华南 —— 兄弟顺序必须原样保留
    const tree = buildGroupTree([group("a", "生产", null), group("b", "华东", "a"), group("c", "华南", null)]);
    expect(shape(tree)).toEqual([
      ["生产", 0, "生产"],
      ["华东", 1, "生产/华东"],
      ["华南", 0, "华南"],
    ]);
  });

  it("mounts a group whose parentId is unknown at the root", () => {
    // 悬空 parentId（父组已被删除）：挂根层，绝不能整组消失
    const tree = buildGroupTree([group("g1", "孤儿", "deleted-parent")]);
    expect(shape(tree)).toEqual([["孤儿", 0, "孤儿"]]);
  });

  it("cuts a self-referencing group to the root", () => {
    const tree = buildGroupTree([group("g1", "自指", "g1")]);
    expect(shape(tree)).toEqual([["自指", 0, "自指"]]);
  });

  it("cuts an A->B->A cycle instead of looping forever", () => {
    const tree = buildGroupTree([group("a", "A", "b"), group("b", "B", "a")]);
    // 环上每一环都挂到根层：两个分组都还在，但互不为父子
    expect(shape(tree)).toEqual([
      ["A", 0, "A"],
      ["B", 0, "B"],
    ]);
  });

  it("cuts a three-node cycle without dropping anyone", () => {
    const tree = buildGroupTree([
      group("a", "A", "b"),
      group("b", "B", "c"),
      group("c", "C", "a"),
      group("d", "D", "a"),
    ]);
    const rows = shape(tree);
    // 不挂死也不丢人：环上的三个分组挂根层，挂在环成员下面的 D 也一样（它的祖先链同样终结不了）
    expect(rows).toEqual([
      ["A", 0, "A"],
      ["B", 0, "B"],
      ["C", 0, "C"],
      ["D", 0, "D"],
    ]);
  });

  it("returns an empty tree for no groups", () => {
    expect(buildGroupTree([])).toEqual([]);
  });

  it("carries the colour through to the node", () => {
    const tree = buildGroupTree([group("g1", "生产", null, "#3fb950")]);
    expect(tree[0]?.color).toBe("#3fb950");
    expect(tree[0]?.children).toEqual([]);
  });
});

describe("groupPathOf", () => {
  const tree = buildGroupTree([group("g1", "生产", null), group("g2", "华东", "g1"), group("g3", "机房A", "g2")]);

  it("returns [] for the root level", () => {
    expect(groupPathOf(tree, null)).toEqual([]);
  });

  it("returns [] for an unknown id", () => {
    expect(groupPathOf(tree, "gone")).toEqual([]);
  });

  it("returns the full path of a deep group", () => {
    expect(groupPathOf(tree, "g3")).toEqual(["生产", "华东", "机房A"]);
    expect(groupPathOf(tree, "g1")).toEqual(["生产"]);
  });

  it("returns the repaired path for a group pulled out of a cycle", () => {
    const cyclic = buildGroupTree([group("a", "A", "b"), group("b", "B", "a")]);
    expect(groupPathOf(cyclic, "a")).toEqual(["A"]);
    expect(groupPathOf(cyclic, "b")).toEqual(["B"]);
  });
});

describe("flattenGroupTree", () => {
  it("walks parents before children", () => {
    const tree = buildGroupTree([group("a", "生产", null), group("b", "华东", "a"), group("c", "华南", null)]);
    expect(flattenGroupTree(tree).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });

  it("terminates on cyclic input", () => {
    const tree = buildGroupTree([group("a", "A", "b"), group("b", "B", "a"), group("c", "C", "b")]);
    expect(flattenGroupTree(tree).map((node) => node.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("findGroupByPath", () => {
  const tree = buildGroupTree([group("g1", "生产", null), group("g2", "华东", "g1"), group("g3", "华南", "g1")]);

  it("resolves a written path to its group", () => {
    expect(findGroupByPath(tree, ["生产", "华东"])?.id).toBe("g2");
    expect(findGroupByPath(tree, ["生产"])?.id).toBe("g1");
  });

  it("returns undefined for an unknown or empty path", () => {
    expect(findGroupByPath(tree, ["生产", "华北"])).toBeUndefined();
    expect(findGroupByPath(tree, [])).toBeUndefined();
  });
});
