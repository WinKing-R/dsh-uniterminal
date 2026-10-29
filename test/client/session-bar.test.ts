import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 结构回归锁（M9-4）：一个侧边栏标签里装多条会话。
 *
 * 没有 react-dom / 测试库，组件层只能读源码断言。锁的是四件在真机上前会悄悄坏掉的事：
 *  1. 每条会话的终端**只隐藏、不卸载**——卸载会丢终端缓冲与 socket，切回来要重放（M8-17 的教训）；
 *  2. 断开连接必须真的去关宿主会话（POST /sessions/close），不能只从界面上抹掉；
 *  3. 连接流程不再开/关侧边栏标签——原生右栏只给一个不透明标签，那条路已证明不可行；
 *  4. 复制会话只带白名单快照，口令永不进请求。
 */
const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

/** 从一个标记往后切一段：断言只落在那个函数里，不被文件别处的同名文案蒙混过关。 */
function sliceAfter(source: string, marker: string, length: number): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + length);
}

describe("session bar keeps every terminal mounted (M9-4)", () => {
  it("renders one terminal per session inside the entry loop", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("sessions.entries.map(");
    // key 必须是会话 id：换 key 等于换组件实例，切会话就会把终端重挂一遍
    expect(source).toContain("key={entry.id}");
    // 终端在 map 里面（每条会话一个），而不是 map 外面按当前会话渲染一个
    expect(source.indexOf("<TerminalView")).toBeGreaterThan(source.indexOf("sessions.entries.map("));
    expect(source).toContain("wsUrl={entry.wsUrl}");
  });

  it("hides the inactive sessions with display:none instead of unmounting them", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('display: entry.id === activeId && paneView === "terminal" ? "flex" : "none"');
    // 条件渲染 = 卸载：按 activeId 决定要不要渲染终端，一次都不许出现
    expect(source).not.toMatch(/&&\s*\(?\s*<TerminalView/);
    expect(source).not.toMatch(/activeId[^\n]*&&[^\n]*<TerminalView/);
    expect(source).not.toMatch(/activeId[^\n]*\?[^\n]*<TerminalView/);
  });

  it("keeps the launcher and the ended placeholder out of the session containers", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    // 已结束的会话：给提示 + 关闭出口，不给终端。
    // 按**分支边界**切（下一个分支的判据），不按固定字符数切：
    // 分支里的内联样式搬进 CSS 类后文字会变短，固定窗口一飘就会把下一条分支的终端算进来。
    const endedStart = source.indexOf("会话已结束：宿主上已经没有这条会话");
    expect(endedStart).toBeGreaterThan(-1);
    const endedEnd = source.indexOf(": entry.wsUrl === undefined ?", endedStart);
    expect(endedEnd).toBeGreaterThan(endedStart);
    const ended = source.slice(endedStart, endedEnd);
    expect(ended).toContain("关闭");
    expect(ended).not.toContain("<TerminalView");
    // 还没拿到地址的会话：给「正在接回」+ 重试，同样不挂终端
    const pending = sliceAfter(source, "正在接回会话", 250);
    expect(pending).toContain("重试");
    expect(pending).not.toContain("<TerminalView");
  });
});

describe("closing a session inside the tab (M9-4)", () => {
  it("closes the host session as well as the bar entry", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const close = sliceAfter(source, "const closeSessionEntry = useCallback", 1200);

    // 同一个动作只留一个说法：会话栏的 × 与工具栏的按钮都叫「断开连接」（术语表）
    expect(source).toContain('aria-label="断开连接"');
    expect(source).toContain('title="断开连接"');
    // 旧说法不许再冒出来（同一个动作两个名字，用户会对不上）
    expect(source).not.toContain("关闭会话");
    expect(close).toContain("/api/uniterminal/sessions/close");
    expect(close).toContain("removeSession(");
    // 失败也要从界面上消失：提示之后不再把条目塞回去
    expect(close).toContain("setNotice(");
  });

  it("marks a session the host dropped as ended instead of deleting it", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const archive = await read("../../src/client/tab-state.ts");

    // 组件只负责把宿主回报的存活列表喂进去；标记策略住在纯函数里（可单测）
    expect(source).toContain("adoptHostSessions");
    expect(archive).toContain("export function markSessionEnded");
    expect(archive).toMatch(/adoptHostSessions[\s\S]{0,300}markSessionEnded/);
  });
});

describe("no more sidebar tab juggling (M9-4)", () => {
  it("never opens or closes a sidebar tab while connecting", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).not.toContain("resolveOpenTab");
    expect(source).not.toContain("resolveCloseTab");
    expect(source).not.toContain("openClaimedSessionTab");
    expect(source).not.toContain("openTab(");
    expect(source).not.toMatch(/\bcloseTab\(/);
    // 连接成功后是把会话加进会话栏，而不是开标签
    expect(source).toMatch(/setSessions\(\(prev\) =>\s*addSession\(prev,/);
  });

  it("drops the obsolete runtime probe of the host tab props", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).not.toContain("client.tab-props");
  });
});

describe("session bar affordances (M9-4)", () => {
  it("draws a bar with a highlighted active session, a close button and a new-session entry", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("aria-pressed={entry.id === activeId}");
    // 会话栏复用视图切换按钮的样式，不新增 CSS 文件里的类
    expect(source).toContain('className="uniterminal-viewtab"');
    expect(source).toContain("＋");
    expect(source).toContain("新建会话");
  });

  it("duplicates the active session through the whitelist snapshot only", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const duplicate = sliceAfter(source, "const duplicateSession = useCallback", 2200);

    expect(source).toContain("复制会话");
    expect(duplicate).toContain("/api/uniterminal/sessions");
    // 请求里只允许出现连接所需的非敏感字段
    expect(duplicate).not.toContain("password");
    expect(duplicate).not.toContain("privateKey");
    expect(duplicate).not.toContain("passphrase");
  });

  it("persists and restores the session set per tab", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("readPersistedSessionSet(tabId)");
    expect(source).toContain("writePersistedSessionSet(tabId, sessions)");
  });
});

describe("session set archive stays credential free (M9-4)", () => {
  it("routes the archive through the profile whitelist", async () => {
    const source = await read("../../src/client/tab-state.ts");
    const serialized = sliceAfter(source, "export function serializeSessionSet", 1400);

    expect(serialized).toContain("sanitizeProfileSnapshot(");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("passphrase");
  });
});
