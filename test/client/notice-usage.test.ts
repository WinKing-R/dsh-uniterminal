import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 三个面板接入共享的一次性提示模型（notice.ts）。
 *
 * 早先每个面板各有一套 notice state，成功与失败共用同一个字符串 state，
 * 于是「已保存配置」「已交给浏览器下载」「已保存到本机」这些**成功反馈也是红的**，
 * 用户只会读成"出错了"。共享模型把 kind（ok / error）显式带进渲染层：
 * setOk = 成功（绿）、setNotice = 失败（红）。
 *
 * 过期规则（6 秒）也只剩一个来源：面板不再各自声明 notice state，不再各自调 useAutoDismiss。
 */
const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

const PANELS = ["UniterminalTab.tsx", "SftpPanel.tsx", "AppearancePanel.tsx"] as const;

describe("三个面板都从共享模型取提示（P0-2）", () => {
  it("每一个面板都从 ./notice.js 引 useNotice 与 noticeClassName", async () => {
    for (const file of PANELS) {
      const source = await read("../../src/client/" + file);
      expect(source).toContain('from "./notice.js"');
      expect(source).toContain("useNotice");
      expect(source).toContain("noticeClassName");
    }
  });

  it("过期规则只有一个来源：面板不再自己声明 notice state，也不再自己调 useAutoDismiss", async () => {
    for (const file of PANELS) {
      const source = await read("../../src/client/" + file);
      // 计时器归 notice.ts（它内部用 useAutoDismiss）：面板不许再各自挂一个
      expect(source).not.toContain("useAutoDismiss");
      expect(source).not.toContain('from "./use-auto-dismiss.js"');
    }
  });

  it("提示按 kind 上色：成功走成功色，失败仍是错误色", async () => {
    for (const file of PANELS) {
      const source = await read("../../src/client/" + file);
      // 渲染层不再硬写 .uniterminal-notice（那永远是红），改由 kind 决定
      expect(source).toContain("noticeClassName(notice.kind)");
      expect(source).toContain("notice.text");
    }
  });
});

describe("UniterminalTab：成功是绿，失败是红", () => {
  it("成功文案走 setOk", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('setOk("已保存配置")');
    expect(source).toContain('setOk("旧版凭据已清理")');
  });

  it("失败文案走 setNotice", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    // 内部细节不进界面（docs/copy-guide.md §2.1）：给用户的是一句能照做的话
    expect(source).toContain('setNotice("连接失败：服务返回异常，请重试")');
    expect(source).toContain('setNotice("断开连接失败："');
    expect(source).toContain('setNotice("保存配置失败："');
  });

  it("两处渲染都按 kind 上色，但同一条提示仍然只显示一次", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    // 表单内一处 + 顶部一处；B5 起每一处都是**两个常驻容器**（ok / error 各一个，
    // role 不切换），所以按 kind 上色的写法是 2 处 × 2 = 4 处
    expect(source.match(/noticeClassName\(notice\.kind\)/g)?.length).toBe(4);
    // 每个容器只写自己那一半：同一条提示物理上不可能同时落进两个容器
    expect(source.match(/notice\.kind === "ok" &&/g)?.length).toBe(2);
    expect(source.match(/notice\.kind === "error" &&/g)?.length).toBe(2);
    // 顶部那处在表单打开时被关掉：同一条错误不会在顶部和底部各出现一次
    expect(source).toContain('!(launcherVisible && view === "form") && notice !== undefined');
    expect(source).not.toContain("(connecting || notice !== undefined)");
  });

  it("面板自己的 notice state 已经删干净", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain("const { notice, setNotice, setOk, clear } = useNotice();");
    expect(source).not.toMatch(/useState<string \| undefined>\(\(undefined\)\);/);
  });
});

/**
 * 内部错误信息移进 diag（docs/copy-guide.md §2.1）。
 *
 * 用户看到的是「服务返回异常，请重试」——他不需要知道少了哪个字段，
 * 更不该被内部实现牵着走；原始细节（缺会话 id / 缺回环地址）写进 diag，
 * 挂在**已有**的诊断事件上，一个新事件名都不造、一次失败也只发一条。
 */
describe("UniterminalTab：内部细节只进 diag，不进界面（copy-guide §2.1）", () => {
  it("失败文案里不出现内部字段名", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).not.toContain('setNotice("连接失败：响应缺少');
    expect(source).not.toContain('setNotice("复制会话失败：响应缺少');
    expect(source).not.toContain('setNotice("接管失败：该会话缺少');
  });

  it("三个失败点给用户同一句能照做的话", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('setNotice("连接失败：服务返回异常，请重试")');
    expect(source).toContain('setNotice("复制会话失败：服务返回异常，请重试")');
    expect(source).toContain('setNotice("接管失败：服务返回异常，请重试")');
  });

  it("原始细节挂在已有诊断事件上（不新造事件名）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('reportClient("client.create-failed", { reason: "session id missing" })');
    expect(source).toContain('reportClient("client.create-failed", { reason: "missing-ws" })');
    expect(source).toContain('reportClient("client.duplicate-failed", { reason: "session id missing" })');
    expect(source).toContain('reportClient("client.duplicate-failed", { reason: "missing-ws" })');
    // 接管失败沿用已有事件：reason 区分"缺会话 id"与"缺回环地址"
    expect(source).toContain('reportClient("client.adopt-failed", {');
    expect(source).toContain('reason: id === undefined ? "session id missing" : "missing-ws",');
  });
});

/**
 * 术语统一（docs/copy-guide.md §一 / §四）：
 * 密码一律叫「密码」；「口令保护」「凭据库」这类已取消的加密能力不许出现在界面上；
 * 远端那台机器叫「主机」，不叫「服务器」。
 */
describe("UniterminalTab：术语按 copy-guide 走（§一 / §四）", () => {

  /**
   * 剥掉注释，字符串字面量原样保留。
   *
   * 为什么不能直接用正则按行删注释：`//` 也可能出现在字符串里（"http://x"），
   * 按行切会把后面整行连同那个字符串一起吃掉。这里按**字符顺序**扫一遍：
   * - 处在字符串里（单引号 / 双引号 / 模板串）就整段跳过——里面的 `//` 不是注释；
   * - 只有处在"代码"状态下遇到的 `//` 与 `/*` 才是注释。
   *
   * 模板串的 `${…}` 里可能又出现字符串，所以用栈记录"该回到哪种状态"；
   * 插值里的 `{` / `}` 用计数器配平，免得提前退出插值。
   *
   * 注释里的字符换成空格、换行原样保留：返回的串与原文等长，行号列号都不变。
   */
  function stripComments(source: string): string {
    const out = source.split("");
    const n = source.length;
    type Frame = { kind: "code"; braces: number } | { kind: "string"; quote: string };
    const stack: Frame[] = [{ kind: "code", braces: 0 }];
    const blank = (from: number, to: number): void => {
      for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
    };
    let i = 0;
    while (i < n) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (top.kind === "string") {
        const ch = source[i];
        // 转义：下一个字符一定是字面量的一部分（\\" 不算引号）
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === top.quote) {
          stack.pop();
          i += 1;
          continue;
        }
        // 模板串的插值：回到"代码"状态，插值结束再回到模板串
        if (top.quote === "`" && ch === "$" && source[i + 1] === "{") {
          stack.push({ kind: "code", braces: 0 });
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      const ch = source[i];
      if (ch === "/" && source[i + 1] === "/") {
        const end = source.indexOf("\n", i);
        const stop = end === -1 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        stack.push({ kind: "string", quote: ch });
        i += 1;
        continue;
      }
      if (ch === "{") {
        top.braces += 1;
        i += 1;
        continue;
      }
      if (ch === "}") {
        if (top.braces > 0) {
          top.braces -= 1;
          i += 1;
          continue;
        }
        // 插值结束：回到外层的模板串
        if (stack.length > 1) {
          stack.pop();
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      i += 1;
    }
    return out.join("");
  }

  /**
   * 含中文的字符串字面量：只有字面量是真正显示给用户的文本。
   *
   * **先剥注释**：注释里带引号的中文（例：不再因为"本机还记得口令"…）不是界面文案，
   * 却被字面量提取正则当成文案——那是误报，迁就扫描器去改注释是把方向搞反了。
   * （与 test/client/copy-conventions.test.ts 里那份实现一致；
   *   这一轮的文件边界里没有地方放共享助手，所以各自带一份。）
   */
  function userFacingLiterals(source: string): string[] {
    const found: string[] = [];
    const pattern = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    for (const match of stripComments(source).matchAll(pattern)) {
      const value = match[2];
      if (value === undefined) continue;
      if (!/[\u4e00-\u9fff]/.test(value)) continue;
      found.push(value);
    }
    return found;
  }

  it("「口令」只允许出现在私钥口令这个词组里", async () => {
    const literals = userFacingLiterals(await read("../../src/client/UniterminalTab.tsx"));
    const offenders = literals.filter((text) => text.includes("口令") && !text.includes("私钥"));

    expect(offenders).toEqual([]);
  });

  it("界面文案里不出现「凭据库」「其它」", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    // 剥掉注释再查：注释里提到「其它」是给开发者看的，不是界面文案
    // （界面文案本身——字面量与 JSX 静态文本——剥完还在，照样查得到）
    const shown = stripComments(source);

    expect(shown).not.toContain("本机凭据库");
    expect(shown).not.toContain("其它");
  });

  it("旧档的退出路径说「密码」，不说「口令」", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('"清理旧版凭据（不影响已保存的密码）"');
    expect(source).toContain(
      '"将删除旧版凭据文件。旧档里读不出来的那份密码需要重新输入一次，明文库里已记住的密码不受影响。确定清理吗？"',
    );
    expect(source).toContain('setNotice("本机凭据当前不可读：请先清理旧版凭据后重试")');
  });

  /**
   * 反向锁：界面文案里不许出现「加密」「主密码」「解锁」「锁定」。
   *
   * 这四个词描述的是**已取消**的能力（D-2a 取消主密码与锁定/解锁；M65 整套删掉了自研密码学）。
   * 留着它们就是在骗用户——界面上写着的东西必须真的存在。
   *
   * 扫描口径：**先剥注释**再查（字符顺序状态机，本文件已有实现），否则注释里讨论历史
   * （比如"旧版加密档位"）会被误判成界面文案。扫的是剥完注释的**整段源码**，不只是字符串字面量——
   * JSX 里的静态文本（横幅标题就是）也要被扫到。
   */
  it("界面文案里不出现「加密」「主密码」「解锁」「锁定」", async () => {
    const clientDir = new URL("../../src/client/", import.meta.url);
    const entries = await readdir(clientDir);
    const forbidden = ["加密", "主密码", "解锁", "锁定"];
    const offenders: string[] = [];

    for (const name of entries) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const source = await readFile(new URL(name, clientDir), "utf8");
      const shown = stripComments(source);
      for (const word of forbidden) {
        if (shown.includes(word)) offenders.push(name + "：" + word);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("验收单锁住的那两句一个字没动", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('"密码以明文保存在本机凭据文件，受 Windows 账户权限保护"');
    expect(source).toContain('setNotice("该主机尚未保存密码，请输入一次并连接，之后会自动记住")');
  });
});

/**
 * 断开连接的三条路（P1-9）：会话栏的 ×、工具栏的「断开连接」、孤儿那一行，
 * 外加复制会话失败时的泄漏保险——原来各写一份几乎同构的请求。
 *
 * 现在只有一份实现，三条路的差别由参数显式表达：
 * - 会话栏那条路：请求发出前就把条目从会话栏拿掉（失败也不塞回去），失败给用户一条提示；
 * - 孤儿那条路：不碰会话栏（孤儿本来就不在里面），成功后才去掉那一行，失败保留该行；
 * - 泄漏保险那条路：只记诊断，不打扰用户。
 */
describe("断开连接三条路共用一份实现（P1-9）", () => {
  /** 从一个标记往后切一段：断言只落在那个函数里。 */
  function sliceAfter(source: string, marker: string, length: number): string {
    const at = source.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, at + length);
  }

  it("关闭请求只发一次：三处调用点都走它", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    // 关闭请求只有这一处实现
    expect(source.match(/api\.post<\{ closed\?: boolean; error\?: string \}>/g)).toHaveLength(1);
    expect(source).toContain('"/api/uniterminal/sessions/close"');
  });

  it("会话栏那条路：先从会话栏拿掉，失败给用户一条提示", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const bar = sliceAfter(source, "const closeSessionEntry = useCallback", 600);

    expect(bar).toContain("removeFromBar: true");
    expect(bar).toContain("removeOrphanRow: false");
    expect(bar).toContain("notifyFailure: true");
  });

  it("孤儿那条路：不碰会话栏，成功后才去掉那一行，失败保留该行", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const orphan = sliceAfter(source, "const closeOrphanSession = useCallback", 600);

    expect(orphan).toContain("removeFromBar: false");
    expect(orphan).toContain("removeOrphanRow: true");
    expect(orphan).toContain('failedEvent: "client.orphan-close-failed"');
    expect(orphan).toContain('closedEvent: "client.orphan-closed"');
  });

  it("泄漏保险那条路：只记诊断，不打扰用户", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");
    const quiet = sliceAfter(source, "async function closeSessionById", 600);

    expect(quiet).toContain("notifyFailure: false");
    expect(quiet).toContain("removeFromBar: false");
    expect(quiet).toContain("removeOrphanRow: false");
  });

  it("失败提示的文案：统一叫「断开连接失败：」", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('setNotice("断开连接失败：" + res.error.message)');
  });
});

/**
 * 面板的共享请求层与语义色（P1-9 同一轮）。
 *
 * JSON 请求一律走 api.ts（失败是结构化的，永不抛错）；
 * 语义色一律从 tokens.ts 取（同一个值只有一个定义处）。
 * 诊断上报也统一走 report.ts 的 reportClient（凭据类字段在发送前被丢掉）。
 */
describe("UniterminalTab：JSON 请求走 api.ts，语义色走 tokens.ts", () => {
  it("JSON 请求一律走 api.ts：面板里没有裸 fetch", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('from "./api.js"');
    // 诊断上报也统一走 report.ts：面板自己不再 fetch，凭据类字段由那一路丢掉
    expect(source.match(/fetch\(/g) ?? []).toHaveLength(0);
    expect(source).toContain('from "./report.js"');
    expect(source).toContain("reportClient(");
  });

  it("语义色从 tokens.ts 取，内联色值不许再出现", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('from "./tokens.js"');
    expect(source).toContain("color: COLOR_DANGER");
    expect(source).toContain("color: COLOR_SUCCESS");
    expect(source).not.toContain("--dsw-alias-label-error, #e5534b");
    expect(source).not.toContain("--dsw-alias-label-success, #3fb950");
  });
});

describe("SftpPanel：成功是绿，失败是红", () => {
  it("成功文案走 setOk", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    expect(source).toContain('setOk("已交给浏览器下载：" + entry.name)');
    expect(source).toContain('setOk("已保存 " + entry.name)');
    expect(source).toContain('setOk("已取消下载")');
  });

  it("失败文案走 setNotice", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    expect(source).toContain('setNotice("下载失败：" + String(error))');
    expect(source).toContain('setNotice("请输入目录名")');
    expect(source).toContain('setNotice("目录名不能包含 /")');
    expect(source).toContain("setNotice(failure)");
  });

  it("上传结果行的自动消失与 notice 无关，不许被合并掉", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    // 结果行（不是 notice）的定时器常量原样保留
    expect(source).toContain("export const UPLOAD_RESULT_DISMISS_MS = 6000;");
    expect(source).toContain("scheduleUploadResultDismiss(uploads");
  });

  it("面板自己的 actionError state 已经删干净", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    expect(source).toContain("const { notice, setNotice, setOk, clear } = useNotice();");
    expect(source).not.toContain("actionError");
  });
});

/**
 * 状态说明 ≠ 操作反馈（M59 残留）。
 *
 * 「正在连接 user@host:port…」是**进行中**的状态说明，却用了 .uniterminal-notice
 * （那是错误红，用户只会读成"出错了"）。它也不该走共享 notice 通道——
 * 那条是一次性反馈，6 秒就过期；状态说明必须常驻到连接结束。
 */
describe("UniterminalTab：状态说明不是错误", () => {
  /** 「正在连接…」那一块：从 {connecting && ( 到它的收尾。 */
  function connectingBlock(source: string): string {
    const at = source.indexOf('"正在连接 " + connectTargetText');
    expect(at).toBeGreaterThan(-1);
    const open = source.lastIndexOf("{connecting && (", at);
    const close = source.indexOf(")}", at);
    return source.slice(open, close);
  }

  it("「正在连接…」不落错误色（改用中性色 .uniterminal-hint）", async () => {
    const block = connectingBlock(await read("../../src/client/UniterminalTab.tsx"));

    expect(block).toContain("uniterminal-hint");
    expect(block).not.toContain("uniterminal-notice");
  });

  it("「正在连接…」不走共享 notice 通道（状态说明不该 6 秒后消失）", async () => {
    const block = connectingBlock(await read("../../src/client/UniterminalTab.tsx"));

    expect(block).not.toContain("noticeClassName");
    expect(block).not.toContain("notice.text");
  });

  it("横幅里的 resetError 仍是错误红、且常驻（它确实是错误，不走共享 notice 通道）", async () => {
    const source = await read("../../src/client/UniterminalTab.tsx");

    expect(source).toContain('<div className="uniterminal-notice">{resetError}</div>');
  });
});

describe("AppearancePanel：成功是绿，失败是红", () => {
  it("成功文案走 setOk，失败文案走 setNotice", async () => {
    const source = await read("../../src/client/AppearancePanel.tsx");

    expect(source).toContain('setOk("已保存到本机")');
    // 保存失败走共享 notice 通道：前缀是「保存失败：」，内容是请求层取好的失败文案
    expect(source).toContain('setNotice("保存失败：" + res.error.message);');
    expect(source).toContain('setNotice("保存失败：" + String(error));');
  });

  it("原来的 saveError / savedHint 两套 state 已经合成一条 notice", async () => {
    const source = await read("../../src/client/AppearancePanel.tsx");

    expect(source).toContain("const { notice, setNotice, setOk, clear } = useNotice();");
    // 注释里提到旧名字不算：真正要没有的是那两个 state 及其 setter
    expect(source).not.toContain("setSaveError");
    expect(source).not.toContain("setSavedHint");
    expect(source).not.toMatch(/useState<string \| undefined>\(\(undefined\)\)/);
  });
});
