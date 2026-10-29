import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 源码级回归锁：B5 无障碍第三段（菜单的键盘入口 / 焦点归还 / 剩下的静音错误）。
 *
 * 为什么这几条只能用源码断言锁：它们要防的回归都是**"调用方"层面的遗漏**——
 * 组件本身早就写好了 returnFocusTo，但没有任何地方传它，真机上就是没生效；
 * live region 的容器是不是常驻，也只有在渲染点才看得出来。
 * 真 DOM 能跑的那几条（Shift+F10 / ⋯ 按钮 / 焦点归还）在
 * test/client/host-menu-keyboard.dom.test.tsx 里。
 */
const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

/** 去掉注释后按规则切分 CSS：选择器里混进注释会干扰"类名数量"的统计。 */
function parseRules(css: string): { selector: string; body: string }[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { selector: string; body: string }[] = [];
  for (const match of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = match[1];
    const body = match[2];
    if (selector === undefined || body === undefined) continue;
    rules.push({ selector: selector.trim(), body });
  }
  return rules;
}

/**
 * 「更多操作」按钮静止时不可见。
 *
 * 两条必须同时成立：
 * ① 隐藏只能用 opacity —— display: none / visibility: hidden 会把元素移出 Tab 序列
 *    与无障碍树，键盘用户就永远聚焦不到它，整轮改动白做；
 * ② 选择器不能是单类 (0,1,0) —— .uniterminal-pane button 是 (0,1,1)，
 *    单类会被它压死，opacity 写成一条**静默失效**的死声明（B4-4 刚清理过的坑）。
 */
describe("「更多操作」按钮的显形规则（CSS）", () => {
  it("基础规则用 opacity: 0 隐藏，绝不是 display / visibility", async () => {
    const rules = parseRules(await read("../../src/client/tab.module.css"));
    const rowMore = rules.filter((rule) => rule.selector.includes("uniterminal-row-more"));
    expect(rowMore.length).toBeGreaterThan(0);

    for (const rule of rowMore) {
      expect(rule.body).not.toContain("display");
      expect(rule.body).not.toContain("visibility");
      // 把自己从无障碍树摘掉的自相矛盾写法同样不许出现
      expect(rule.selector).not.toContain("aria-hidden");
    }

    const base = rowMore.find((rule) => rule.body.includes("opacity: 0"));
    expect(base).toBeDefined();
    expect(base?.body).toContain("opacity: 0");
    // 选择器抬到 (0,2,0)：类名至少两个，并且带 .uniterminal-pane 前缀
    const classCount = (base?.selector.match(/\.[A-Za-z][\w-]*/g) ?? []).length;
    expect(classCount).toBeGreaterThanOrEqual(2);
    expect(base?.selector).toContain(".uniterminal-pane");
  });

  it("悬停与行内焦点都能把它显形（主机行与分组行各一套）", async () => {
    const rules = parseRules(await read("../../src/client/tab.module.css"));
    const reveal = rules.find(
      (rule) => rule.selector.includes("uniterminal-row-more") && rule.body.includes("opacity: 1"),
    );
    expect(reveal).toBeDefined();
    const selector = reveal?.selector ?? "";

    for (const needed of [
      ".uniterminal-pane .uniterminal-hostrow:hover .uniterminal-row-more",
      ".uniterminal-pane .uniterminal-hostrow:focus-within .uniterminal-row-more",
      ".uniterminal-pane .uniterminal-grouprow:hover .uniterminal-row-more",
      ".uniterminal-pane .uniterminal-grouprow:focus-within .uniterminal-row-more",
    ]) {
      expect(selector).toContain(needed);
    }
  });
});

/**
 * 三处**以前完全静音**的错误：SFTP 目录加载失败 / 隧道列表失败 / 主机行内「测试连接」结果。
 *
 * 容器必须常驻（第一处起就没有条件渲染容器）：`{err && <div role="alert">…}` 是无效的——
 * 读屏软件只在"已有节点的内容变化"时播报，节点刚插入的那一帧往往整条被漏掉。
 */
describe("三处静音错误接上 live region", () => {
  const CASES = [
    ["SftpPanel.tsx", "{!loading && error !== undefined &&", '{...noticeLiveProps("error")}'],
    ["TunnelPanel.tsx", "{listError !== undefined &&", '{...noticeLiveProps("error")}'],
    ["HostListView.tsx", "{testResults[profile.id] !== undefined &&", '{...noticeLiveProps("ok")}'],
  ] as const;

  it("条件写在常驻容器里面，容器自己不挂条件", async () => {
    for (const [file, condition, wrapper] of CASES) {
      const source = await read("../../src/client/" + file);
      const at = source.indexOf(condition);
      expect(at, file + " 里找不到 " + condition).toBeGreaterThan(-1);

      const wrapperAt = source.lastIndexOf(wrapper, at);
      expect(wrapperAt, file + "：" + condition + " 没有住在常驻 live 容器里").toBeGreaterThan(-1);
      const between = source.slice(wrapperAt, at);
      expect(between).toContain('className="uniterminal-live"');
      // 一旦出现 && / ?，说明容器本身又变回条件渲染了
      expect(between).not.toContain("&&");
      expect(between).not.toContain("?");
    }
  });

  it("「测试连接」的结果只有一个容器：成功与失败不拆双通道", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    // 这是次要信息：成功与失败都只该 polite 播报，不该打断用户
    expect(source).toContain('{...noticeLiveProps("ok")} className="uniterminal-live"');
    expect(source).toContain('{testResults[profile.id] !== undefined &&');
  });
});

/**
 * 状态栏：常驻状态文本，但**不许播报**。
 *
 * 这一行每秒都在重渲染（运行时长、CPU 占用都在变），挂一个礼貌播报的 live region
 * 会让读屏每一秒打断用户一次。role="status" 只留下语义（可被按需读取）。
 */
describe("StatusBar 是状态而不是播报", () => {
  it("两行都带 role=\"status\"，且都没有挂 polite / assertive", async () => {
    const source = await read("../../src/client/StatusBar.tsx");

    expect(source.match(/role="status"/g)?.length).toBe(2);
    expect(source).toContain('aria-live="off"');
    expect(source).not.toContain('aria-live="polite"');
    expect(source).not.toContain('aria-live="assertive"');
  });
});

/** 菜单的可访问名：同一屏上主机菜单与分组菜单结构一样，没名字读屏分不出是谁的操作。 */
describe("菜单的可访问名", () => {
  it("ContextMenu 有可选 label，并落在根节点的 aria-label 上", async () => {
    const menu = await read("../../src/client/context-menu.tsx");

    expect(menu).toContain("label?: string;");
    expect(menu).toContain("aria-label={props.label}");
  });

  it("HostListView 给两个菜单都传了人话名字（主机 / 分组 / 操作）", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    expect(source).toContain('label={"主机 " + target.name + " 的操作"}');
    expect(source).toContain('label={"分组 " + node.path.join(" / ") + " 的操作"}');
  });
});

/** 焦点归还：第一批把 returnFocusTo 做进了组件，但**没有调用方**，真机上等于没做。 */
describe("returnFocusTo 有了真实调用方", () => {
  it("两处 <ContextMenu> 都传了触发元素", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    expect(source.match(/<ContextMenu/g)?.length).toBe(2);
    expect(source.match(/returnFocusTo=\{/g)?.length).toBe(2);
    expect(source).toContain("returnFocusTo={menu.trigger}");
    expect(source).toContain("returnFocusTo={groupMenu.trigger}");
  });

  it("菜单状态里带着 trigger：三种打开方式各自传自己的触发元素", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    // 鼠标右键 → 行元素；键盘（Shift+F10 / 菜单键）→ 行元素；「⋯」按钮 → 按钮本身
    expect(source.match(/trigger: HTMLElement;/g)?.length).toBe(2);
    expect(source).toContain("trigger: event.currentTarget");
    expect(source).toContain("setMenu({ ...anchorOf(trigger), profileId, trigger });");
    expect(source).toContain("setGroupMenu({ ...anchorOf(trigger), groupId, trigger });");
  });
});

/** 键盘入口：菜单以前只有右键能开，纯键盘用户进不去（WCAG 2.1.1 硬失败）。 */
describe("菜单的键盘入口", () => {
  it("Windows 惯例的两条快捷键都认", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    expect(source).toContain("function isMenuKey(");
    expect(source).toContain('event.shiftKey && event.key === "F10"');
    expect(source).toContain('event.key === "ContextMenu"');
  });

  it("主机行与分组行都挂了 onKeyDown，并且用**该行元素**当锚点", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    // 两处行容器各一条：判据同一个纯函数，两行不会各算一套
    expect(source.match(/if \(!isMenuKey\(event\)\) return;/g)?.length).toBe(2);
    expect(source).toContain("openRowMenu(event.currentTarget, profile.id)");
    expect(source).toContain("openGroupMenu(event.currentTarget, node.id)");
    // 行元素要能被程序聚焦，否则"关闭菜单后焦点回到这一行"是空操作
    // 只数"独占一行的属性"：注释里也会提到 tabIndex={-1}，那不算调用点
    expect(source.match(/^\s*tabIndex=\{-1\}$/gm)?.length).toBe(2);
  });

  it("两行各有「⋯」按钮：aria-haspopup、aria-expanded、读得出名字的 aria-label", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    expect(source.match(/aria-haspopup="menu"/g)?.length).toBe(2);
    expect(source.match(/className="uniterminal-row-more uniterminal-compact"/g)?.length).toBe(2);
    expect(source).toContain("aria-expanded={menu?.profileId === profile.id}");
    expect(source).toContain("aria-expanded={groupMenu?.groupId === node.id}");
    expect(source).toContain('aria-label={"更多操作：" + profile.name}');
    expect(source).toContain('aria-label={"更多操作：分组 " + label}');
    // 同一个类名不许在别处复用成"常驻可见"的按钮
    expect(source).toContain('title="更多操作"');
  });

  it("锚点只有一套基准：视口里量、再减去面板的视口坐标", async () => {
    const source = await read("../../src/client/HostListView.tsx");
    const at = source.indexOf("function anchorOf(");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 400);

    expect(body).toContain("getBoundingClientRect()");
    expect(body).toContain("rect.left - (pane?.left ?? 0)");
    expect(body).toContain("rect.bottom - (pane?.top ?? 0)");
  });
});

/** 确认弹框：正文必须被念出来（只有标题时用户不知道这次要删的是哪一台）。 */
describe("确认弹框的正文绑定", () => {
  it("message 的 div 有稳定 id，role=\"dialog\" 用 aria-describedby 指过去", async () => {
    const source = await read("../../src/client/confirm-dialog.tsx");

    expect(source).toContain("useId()");
    expect(source).toContain("aria-describedby={messageId}");
    expect(source).toContain("id={messageId}");
    // 同一个屏上可能同时存在多个弹框：id 必须每个实例不同，不能写死
    expect(source).not.toMatch(/id="uniterminal-modal-text"/);
  });
});


/**
 * B5 无障碍第四段（用户报回来的三个真问题）。
 *
 * 这三条只有在**渲染点**与**选择器特异度**上才看得出来，所以照旧用源码级回归锁：
 * ① 「⋯」按钮的过渡被它自己的显形规则盖掉——它是那一行里唯一没有底色过渡的按钮；
 * ② 主机行的「连接」「测试」没有可访问名，读屏按按钮浏览就是「连接 连接 连接」；
 * ③ SFTP 的「选中」只能靠点行，而删除依赖选中项——纯键盘用户等于删不掉任何文件。
 *
 * 第四项（分组折叠按钮的 aria-controls）**刻意不锁**：折叠时内容容器根本不渲染，
 * 给它挂 aria-controls 只会指向一个不存在的 id，把"假修复"锁进测试比不写更糟。
 */
describe("第四段：「⋯」的过渡与其它按钮一致（CSS）", () => {
  it("transition 是基础规则那两条，不是只剩 opacity 一条", async () => {
    const rules = parseRules(await read("../../src/client/tab.module.css"));

    const base = rules.find((rule) => rule.selector === ".uniterminal-pane button");
    expect(base).toBeDefined();
    const baseTransition = base?.body.match(/transition:\s*([^;]+);/)?.[1]?.trim();
    expect(baseTransition).toBe("background 120ms ease, opacity 120ms ease");

    const rowMore = rules.find((rule) => rule.selector === ".uniterminal-pane .uniterminal-row-more");
    expect(rowMore).toBeDefined();
    // 只写 opacity 会把基础规则的 background 过渡整条盖掉：悬停底色变成瞬间跳变
    expect(rowMore?.body).toContain("transition: " + String(baseTransition) + ";");
  });
});

describe("第四段：主机行的「连接」「测试」读得出是哪台主机", () => {
  it("两个按钮都带主机名，可见文字一个字都没动", async () => {
    const source = await read("../../src/client/HostListView.tsx");

    expect(source).toContain('aria-label={"测试连接：" + profile.name}');
    expect(source).toContain('aria-label={"连接：" + profile.name}');
    // 术语表（docs/copy-guide.md）：叫「测试连接」，不是「连接测试」
    expect(source).not.toContain("连接测试");
    // 可见文字不变：仍然是「测试」（进行中「测试中…」）与「连接」
    expect(source).toContain('{testingId === profile.id ? "测试中…" : "测试"}');
    expect(source).toMatch(/>\s*连接\s*<\/button>/);
  });
});

describe("第四段：SFTP 的「选中」接进键盘（WCAG 2.1.1）", () => {
  it("文件名是带 aria-pressed 的 button，且单击只做选中", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    expect(source).toContain('className="uniterminal-file-name uniterminal-self-center"');
    expect(source).toContain("aria-pressed={selected?.path === entry.path}");
    // 回归锁：名字不许退回普通 span —— 那条路径键盘用户永远够不到
    expect(source).not.toContain('<span className="uniterminal-ellipsis">{entry.name}</span>');

    const at = source.indexOf('className="uniterminal-file-name');
    const open = source.lastIndexOf("<button", at);
    const close = source.indexOf("</button>", at);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const body = source.slice(open, close);
    expect(body).toContain("setSelected(entry)");
    // 「进入目录」不许混进来：单击语义只留"选中"，否则键盘上单击就跳目录
    expect(body).not.toContain("navigate(");
  });

  it("行容器的 onClick 不再重复处理按钮冒泡上来的那一次点击", async () => {
    const source = await read("../../src/client/SftpPanel.tsx");

    expect(source).toContain(
      'if (event.target instanceof Element && event.target.closest("button") !== null) return;',
    );
  });

  it("外观用两级选择器压过 .uniterminal-pane button，且声明里没有加强标记", async () => {
    const css = await read("../../src/client/tab.module.css");
    const rules = parseRules(css);

    const name = rules.find((rule) => rule.selector === ".uniterminal-pane .uniterminal-file-name");
    expect(name).toBeDefined();
    const classCount = (name?.selector.match(/\.[A-Za-z][\w-]*/g) ?? []).length;
    expect(classCount).toBeGreaterThanOrEqual(2);

    for (const declaration of [
      "border: none",
      "background: transparent",
      "padding: 0",
      "color: inherit",
      "font: inherit",
      "text-align: left",
      "border-radius: var(--ut-radius-sm)",
      "overflow: hidden",
      "text-overflow: ellipsis",
      "white-space: nowrap",
    ]) {
      expect(name?.body).toContain(declaration);
    }

    // 声明层面零强制覆盖：被压过的规则靠选择器，不靠加强标记（注释里提到不算）
    for (const rule of rules) expect(rule.body).not.toContain("!important");
  });
});

