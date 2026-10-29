import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 结构回归锁（M8-17）：文件/隧道面板在切换视图时**只隐藏、不卸载**。
 * 卸载会丢掉正在进行的上传/下载进度行（XHR 还在跑，界面却没了）、
 * 当前目录、选中项与隧道列表——用户实报过这个现象。
 * 这条断言不改行为，只防止有人把「懒挂载 + 隐藏」改回条件渲染。
 */
describe("session panel persistence (M8-17)", () => {
  it("never unmounts the sftp and tunnel panels on a view switch", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 条件渲染等于卸载：这两种写法一个都不能再出现
    expect(source).not.toContain('paneView === "files" &&');
    expect(source).not.toContain('paneView === "tunnels" &&');
    // 必须是"访问过就一直挂着"
    expect(source).toContain("visitedViews.has(\"files\")");
    expect(source).toContain("visitedViews.has(\"tunnels\")");
  });

  it("keeps every session's terminal mounted as well", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 终端一进来就是挂载的（切走切会话都用 display:none），这条自 M3 起就成立；
    // M9-4 之后按会话各挂一份，可见性由「当前会话 + 当前视图」决定，而不是决定要不要渲染
    expect(source).toContain('display: entry.id === activeId && paneView === "terminal" ? "flex" : "none"');
  });
});

/**
 * 回归锁（M8-19）：连上终端后必须主动同步一次真实尺寸。
 * 远端 PTY 是以 80x24 打开的，而 onResize 只在尺寸**变化**时触发；
 * 面板一进去就 fit 好了，事件永远不来，远端便按 80 列换行、
 * 本地按面板宽度渲染 —— 长命令行会把提示符覆盖掉（用户实报）。
 */
describe("terminal size handshake (M8-19)", () => {
  it("pushes the real cols and rows when the websocket opens", async () => {
    const source = await readFile(new URL("../../src/client/TerminalView.tsx", import.meta.url), "utf8");

    expect(source).toContain("socket.onopen");
    // 一定要在 onopen 里发 resize，且用的是终端自己的真实尺寸
    expect(source).toMatch(/onopen[\s\S]{0,400}type: "resize", cols: terminal\.cols, rows: terminal\.rows/);
  });
});

/**
 * 回归锁（M8-21）：状态栏只在终端视图可见且窗口在前台时轮询。
 * 面板按 M8-17 只隐藏不卸载，若不闸住，用户切到文件视图后
 * 仍会每 4 秒在远端跑一次 exec —— 那是给服务器增加的无谓负载。
 */
describe("status bar polling gate (M8-21)", () => {
  it("stops polling when the terminal view is inactive or the page is hidden", async () => {
    const source = await readFile(new URL("../../src/client/StatusBar.tsx", import.meta.url), "utf8");

    expect(source).toContain("active");
    expect(source).toMatch(/if \(!active \|\| !pageVisible\) return;/);
    expect(source).toContain('addEventListener("visibilitychange"');
  });

  it("passes the terminal view state down from the tab", async () => {
    const tab = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // M9-2：宿主会同时保留多个标签，非活动标签必须连终端视图都不算活动
    // M9-4：一个标签里挂着多条会话，只有「当前会话 + 终端视图 + 标签可见」才轮询
    expect(tab).toContain("active={paneView === \"terminal\" && tabVisible && entry.id === activeId}");
  });
});

/**
 * 回归锁（M9-6）：会话标签的 notice 必须自动消失。
 * 用户实报「终端连接已断开」一直挂在标题下不消失——这类一次性提示没有生命周期就会变成噪音。
 */
describe("one-shot notices auto dismiss (M9-23)", () => {
  it("ships a single shared dismiss hook that owns the timer", async () => {
    const hook = await readFile(new URL("../../src/client/use-auto-dismiss.ts", import.meta.url), "utf8");

    // 定时器由本 hook 独占：清理必须落在本 hook 里，别处不许再各写一个 setTimeout
    expect(hook).toMatch(/clearTimeout\(timer\)/);
    // **clear 的身份变化不得影响倒计时**：
    // 调用点每次渲染都传一个新的箭头函数（`() => setNotice(undefined)`），
    // 它一旦进了依赖数组，父组件每重渲染一次就重建 6 秒计时器，
    // 一次性提示在不停重渲染的面板里就可能永不过期。
    // 于是 clear 只能经 ref 传递，计时器的依赖只剩 [active, ms]。
    expect(hook).toMatch(/useRef\(/);
    expect(hook).toMatch(/\}, \[active, ms\]\);/);
  });

  it("every panel with a one-shot notice uses the shared model", async () => {
    // 同一类缺陷曾出现三次（SFTP 面板 / 会话标签 / 主机列表各写各的）。
    // 现在四个面板都从 notice.ts 取提示：状态、成功/失败语义与 6 秒过期规则只剩一个来源，
    // 面板不许再各自 useAutoDismiss（否则又会漏一处）。
    for (const file of ["UniterminalTab.tsx", "SftpPanel.tsx", "HostListView.tsx", "AppearancePanel.tsx"]) {
      const source = await readFile(new URL("../../src/client/" + file, import.meta.url), "utf8");
      expect(source).toContain('from "./notice.js"');
      expect(source).toMatch(/useNotice\(/);
      expect(source).not.toContain("useAutoDismiss");
    }
  });
});

/**
 * 回归锁（M9-14）：断开最后一条会话后必须回到主机列表。
 * 用户实报：断开后被扔回「刚才那台主机的连接表单」——因为 view 还停在 form。
 */
describe("disconnect returns to the host list (M9-14)", () => {
  it("resets the launcher view when the session bar becomes empty", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/if \(sessions\.entries\.length === 0\) setView\("list"\)/);
    expect(source).toMatch(/\}, \[sessions\.entries\.length\]\);/);
  });

  it("renders the notice once instead of twice", async () => {
    const source = await readFile(new URL("../../src/client/UniterminalTab.tsx", import.meta.url), "utf8");

    // 表单里只留"正在连接…"，不再重复渲染全局 notice
    expect(source).not.toContain("(connecting || notice !== undefined)");
  });
});

/**
 * 回归锁（B3）：三个面板的文案按 docs/copy-guide.md 统一。
 *
 * 这一轮只改文案、不改行为，所以断言锁的是**用词**与**通道**：
 * 术语表说死的词不许漂，内部字段名不许进界面，
 * 而"不许误伤"的那些既有语义（上传结果行、隧道提示语、外观面板的前缀）一个字都不许动。
 */
describe("panel copy conventions (B3)", () => {
  const PANEL_FILES = ["SftpPanel.tsx", "TunnelPanel.tsx", "AppearancePanel.tsx"] as const;

  async function readPanel(file: string): Promise<string> {
    return readFile(new URL("../../src/client/" + file, import.meta.url), "utf8");
  }

  it("文件类型一律叫「其他」，不叫「其它」", async () => {
    const source = await readPanel("SftpPanel.tsx");

    expect(source).toContain('other: "其他"');
    expect(source).not.toContain("其它");
  });

  it("三个面板都不出现「其它」「口令」与内部字段名", async () => {
    for (const file of PANEL_FILES) {
      const source = await readPanel(file);
      // 术语表：文件类型统一叫「其他」
      expect(source).not.toContain("其它");
      // 「口令」只允许出现在「私钥口令」这个词组里，其余一律叫「密码」
      expect(source.replace(/私钥口令/g, "")).not.toContain("口令");
      // 内部字段名不进界面
      expect(source).not.toContain("session.id");
    }
  });

  it("隧道建立失败只说「重试」，内部字段名进 diag", async () => {
    const source = await readPanel("TunnelPanel.tsx");

    expect(source).toContain('setFormError("建立失败：服务返回异常，请重试")');
    expect(source).not.toContain("响应缺少 tunnel");
    // 原始细节不许丢：写进 diag，而不是显示在界面上
    expect(source).toContain('reportClient("client.tunnel-create-failed"');
  });

  it("这一轮不许误伤的既有文案原样保留", async () => {
    const sftp = await readPanel("SftpPanel.tsx");
    const tunnel = await readPanel("TunnelPanel.tsx");
    const appearance = await readPanel("AppearancePanel.tsx");

    // 隧道：只把「其它机器」换成「其他机器」，句子其余部分不许动
    expect(tunnel).toContain("只监听本机回环，局域网其他机器无法访问");
    expect(tunnel).toContain("远端端口在会话关闭时才会释放");
    // 上传结果行：成功/失败文案与「失败行不自动消失」的常量都不许动
    expect(sftp).toContain('"上传完成"');
    expect(sftp).toContain('"已取消（远端未生成文件）"');
    expect(sftp).toContain("export const UPLOAD_RESULT_DISMISS_MS = 6000;");
    // 外观面板：成功与失败前缀原样
    expect(appearance).toContain('setOk("已保存到本机")');
    expect(appearance).toContain('setNotice("保存失败："');
  });
});
