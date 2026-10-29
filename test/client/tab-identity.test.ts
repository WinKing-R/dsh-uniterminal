import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 遗留会话标签的身份（M9-2 → M9-4 收尾）。
 *
 * M9-2 把会话身份放在标签 id 里（`uniterminal:<sessionId>`），线上证明走不通：
 * 本机原生右栏只给插件一个不透明标签（id:"tab63"），第二列根本不会创建。
 * M9-4 改成一个标签里自绘会话栏后，这套解析只剩一个用处——**接回旧标签**：
 * 一个带 `uniterminal:<id>` 的标签把自己那条会话当成会话栏的第一条。
 * 这里锁的就是「只用于接回、不用于连接流程」。
 */
const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

describe("legacy session tab identity (M9-2)", () => {
  it("derives the session id from props.tab.id, never from tab.path", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("parseSessionIdFromTabId(props.tab?.id)");
    // 解析入口的参数里不能出现 path：那正是 M9-1 的错误通道
    expect(source).not.toMatch(/parseSessionIdFromTabId\([^)]*path/);
    // 遗留标签的那条会话就是会话栏的第一条，而不是「当前会话」这类单实例状态
    expect(source).toMatch(/initialSessionSet\(tabId, legacySessionId, legacyProfile\)/);
  });

  it("claims the legacy session when such a tab mounts", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("claimSessionTab(legacySessionId)");
  });

  it("keeps the M9-2 tab machinery only in tab-state (no longer wired to the component)", async () => {
    const guard = await read("../../src/client/tab-state.ts");

    expect(guard).toMatch(/id:\s*sessionIdTabId\(sessionId\)/);
    expect(guard).toContain("type: TAB_TYPE");
    expect(guard).toMatch(/meta:\s*buildSessionTabMeta\(/);
    // 连接流程不再开标签：组件里连这些名字都不该出现（见 session-bar.test.ts）
    const source = await read("../../src/client/UniterminalTab.tsx");
    expect(source).not.toContain("openClaimedSessionTab");
  });
});

describe("session toolbar (M9-4)", () => {
  it("offers 复制会话 backed by a real connection request", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("复制会话");
    expect(source).toContain("duplicateSession");
    expect(source).toContain("/api/uniterminal/sessions");
    // 复制会话要快照：没有快照就明确说清楚，而不是发一条缺字段的请求
    expect(source).toContain("缺少连接快照，无法复制会话");
  });

  it("shows 会话已结束 with a 关闭 exit instead of a dead terminal", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("会话已结束");
    expect(source).toContain("正在接回会话");
  });
});
