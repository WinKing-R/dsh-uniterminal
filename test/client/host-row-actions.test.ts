import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁（M57）：主机行的动作布局。
 *
 * 用户要求：行内只保留「测试」，另加「连接」按钮；单击主机仍进连接弹窗；
 * 编辑 / 移入分组 / 删除 收进**右键菜单**。
 */
describe("host row actions (M57)", () => {
  it("keeps only connect and test inline", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 行内按钮里必须有「连接」与「测试」（换行符不作要求，只要求是按钮标签）
    expect(list).toMatch(/>\s*连接\s*<\/button>/);
    expect(list).toContain("{testingId === profile.id ? \"测试中…\" : \"测试\"}");
    // 便捷入口：连接按钮与单击主机走同一条路径
    expect(list).toContain("onClick={() => onSelect(profile, rememberedIds.includes(profile.id))}");
  });

  it("moves the rare actions into a right-click menu", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");
    const menu = await readFile(new URL("../../src/client/context-menu.tsx", import.meta.url), "utf8");

    expect(list).toContain("onContextMenu");
    expect(list).toContain("<ContextMenu");
    for (const label of ["编辑", "移入分组…", "测试连接", "删除"]) {
      expect(list).toContain(label);
    }
    // 菜单本身要能被关掉：点外部 / Esc
    expect(menu).toContain('event.key !== "Escape"');
    expect(menu).toContain('window.addEventListener("mousedown"');
  });

  it("no longer renders the old four inline buttons", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 「移入分组」不再是**按钮**（弹窗标题仍是这几个字，所以只排除 </button> 收尾的那种）
    expect(list).not.toMatch(/>\s*移入分组\s*<\/button>/);
    // 行内也不再有「编辑」「删除」按钮（它们只存在于右键菜单的 items 里）
    expect(list).not.toMatch(/>\s*编辑\s*<\/button>/);
  });
  it("moves group rename and delete into a right-click menu (M58)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // 「清除颜色」改名「重置颜色」，仍是行内按钮
    expect(list).toMatch(/>\s*重置颜色\s*<\/button>/);
    expect(list).not.toMatch(/>\s*清除颜色\s*<\/button>/);

    // 重命名 / 删除分组 不再是行内按钮
    expect(list).not.toMatch(/>\s*重命名\s*<\/button>/);
    expect(list).not.toMatch(/>\s*删除分组\s*<\/button>/);

    // 但必须在分组右键菜单里
    expect(list).toContain("setGroupMenu");
    expect(list).toContain('{ label: "重命名", onSelect: () => startFolderRename(node) }');
    expect(list).toContain('{ label: "删除分组", danger: true, onSelect: () => setPendingFolderId(node.id) }');
  });
  it("opens the group right-click menu from the group row (M58 entry point)", async () => {
    const list = await readFile(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

    // M58 只把菜单项写好了，入口只有一个：分组行容器。
    // 取分组行的**开标签**（以 ">" 独占一行收尾的那一段），它必须自带 onContextMenu。
    // 分组行还带布局原语（uniterminal-row-tight），类名表可以变长，开标签本身仍要自成一段
    const groupRowTag = /className="uniterminal-grouprow[^"]*"[\s\S]*?\n\s*>/.exec(list);
    expect(groupRowTag).not.toBeNull();
    const tag = groupRowTag?.[0] ?? "";
    expect(tag).toContain("onContextMenu");
    expect(tag).toContain("setGroupMenu(");
    // 坐标相对面板算：面板是定位上下文，祖先被主题加 transform 也不会把菜单带偏
    expect(tag).toContain("event.preventDefault()");
    expect(tag).toContain("paneRef.current?.getBoundingClientRect()");
    expect(tag).toContain("event.clientX - (rect?.left ?? 0)");
    expect(tag).toContain("event.clientY - (rect?.top ?? 0)");
    expect(tag).toContain("groupId: node.id");
    // 绝不能退回"视口坐标 + fixed"（那个坑记在 tab.module.css 里）
    expect(tag).not.toContain("position: fixed");

    // 调色板上的右键只是空白：不冒泡，免得调色时弹出分组菜单
    expect(list).toContain("onContextMenu={(event) => event.stopPropagation()}");

    // 链路终点：菜单项 → renamingId / pendingFolderId → 对应的界面
    expect(list).toContain("renamingId === node.id ? (");
    expect(list).toContain("groupRows.find((item) => item.id === pendingFolderId)");
    expect(list).toContain("{pendingGroup !== undefined && (");
  });
});
