import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 回归锁：右键菜单（真机缺陷修复）。
 *
 * 【来历】用户在真机上发现两个缺陷，都是**真 bug**，不是"计划中的后续内容"：
 *
 * ① **菜单项点不动**（点「编辑」毫无反应）。
 *    根因是事件顺序，不是事件绑定：
 *    window 上的 mousedown 监听挂在**捕获阶段**且无条件 onClose()，
 *    而菜单根 div 上的 stopPropagation 挂在**冒泡阶段**。
 *    捕获阶段先于冒泡阶段执行，stopPropagation 拦不住已经跑过的捕获监听器：
 *    mousedown → 菜单被卸载 → mouseup / click 落不到按钮上 → item.onSelect() 永不执行。
 *    修复：菜单根 div 挂 ref，窗口 handler 先做 contains() 判断——
 *    **点在菜单内部就不关**，于是 mouseup / click 一定落在菜单项上，onSelect 必定执行。
 *
 *    ⚠ 别把这个包含判断"优化"掉（例如改成无条件 onClose，或"反正有 stopPropagation 了"）：
 *    它是"点菜单项能生效"的唯一保障，删掉就回到"菜单项全点不动"。
 *
 * ② **菜单项样式不对**（每一项都带描边 + 药丸圆角，像一摞按钮而不是菜单）。
 *    根因是 CSS 特异度：.uniterminal-pane button 是 (0,1,1)，
 *    而旧的 .uniterminal-context-item 只有 (0,1,0)，于是菜单项继承了面板按钮的
 *    描边（1px solid）与药丸圆角（999px）。
 *    修复：把菜单项选择器抬到 .uniterminal-context-menu .uniterminal-context-item (0,2,0)，
 *    并由菜单自己**完整地**声明外观（无描边、4px 圆角、13px 字号、6px 10px 内边距）。
 */
describe("context menu (真机缺陷回归锁)", () => {
  const readMenu = async (): Promise<string> =>
    readFile(new URL("../../src/client/context-menu.tsx", import.meta.url), "utf8");

  const readCss = async (): Promise<string> =>
    readFile(new URL("../../src/client/tab.module.css", import.meta.url), "utf8");

  /** 去掉注释后按规则切分：选择器里混进注释会干扰"类名数量"的统计。 */
  const parseRules = (css: string): { selector: string; body: string }[] => {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules: { selector: string; body: string }[] = [];
    for (const match of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      // noUncheckedIndexedAccess 下捕获组是 string | undefined：显式收窄，不用 as 硬压
      const selector = match[1];
      const body = match[2];
      if (selector === undefined || body === undefined) continue;
      rules.push({ selector: selector.trim(), body });
    }
    return rules;
  };

  it("keeps the menu open when the mousedown lands inside the menu", async () => {
    const menu = await readMenu();

    // 窗口 handler 必须拿到事件目标，并做出"是否在菜单内部"的判断
    expect(menu).toContain('window.addEventListener("mousedown"');
    expect(menu).toMatch(/const onPointerDown = \(event: MouseEvent\): void => \{[^}]*contains\(event\.target\)/s);

    // 判断为"在菜单内部"时必须**先 return**，不许走到 onClose()
    expect(menu).toMatch(
      /const onPointerDown = \(event: MouseEvent\): void => \{[\s\S]*?contains\(event\.target\)[^}]*return;[\s\S]*?onClose\(\);/s,
    );
    // 用的是根节点 ref 的 contains，而不是别的判断
    expect(menu).toContain("node.contains(event.target)");
  });

  it("hangs the root ref on the menu root element", async () => {
    const menu = await readMenu();

    expect(menu).toMatch(/const rootRef = useRef<HTMLDivElement>\(null\)/);
    const rootIndex = menu.indexOf('className="uniterminal-context-menu"');
    expect(rootIndex).toBeGreaterThan(-1);
    // ref 挂在菜单根 div 上（同一段 JSX 里）
    expect(menu.slice(Math.max(0, rootIndex - 200), rootIndex + 200)).toContain("ref={rootRef}");
  });

  it("keeps the item click handler as onSelect then onClose", async () => {
    const menu = await readMenu();

    // 菜单项按钮：先执行动作，再关菜单
    expect(menu).toMatch(/onClick=\{\(\) => \{\s*item\.onSelect\(\);\s*onClose\(\);\s*\}\}/);
    // 根 div 上的 stopPropagation 保留（它还有别的用处）
    expect(menu).toContain("onMouseDown={(event) => event.stopPropagation()}");
    // 焦点行为保持现状：不要抢焦点到第一项
    expect(menu).not.toContain("autoFocus");
  });

  it("keeps the escape and resize dismissal", async () => {
    const menu = await readMenu();

    expect(menu).toContain('event.key !== "Escape"');
    expect(menu).toContain('window.addEventListener("resize"');
    expect(menu).toContain('window.addEventListener("keydown"');
  });

  it("lets the menu style its own items instead of inheriting the pane button look", async () => {
    const css = await readCss();
    const rules = parseRules(css);
    const itemRules = rules.filter((rule) => rule.selector.includes("uniterminal-context-item"));
    expect(itemRules.length).toBeGreaterThan(0);

    // 主规则：选择器特异度必须高于 .uniterminal-pane button (0,1,1)
    const base = itemRules.find((rule) => rule.selector === ".uniterminal-context-menu .uniterminal-context-item");
    expect(base).toBeDefined();
    const classCount = (base?.selector.match(/\.[A-Za-z][\w-]*/g) ?? []).length;
    expect(classCount).toBeGreaterThanOrEqual(2);

    // 外观由菜单自己完整声明。
    // B4 起圆角与字号走设计令牌，断言跟着令牌走，但**要防的回归没变**：
    // 菜单项自己声明"小圆角（不是面板按钮的药丸 999px）+ 13px 字号 + 收紧的内边距"。
    const body = base?.body ?? "";
    expect(body).toContain("border: none");
    expect(body).toContain("border-radius: var(--ut-radius-sm)");
    expect(body).toContain("padding: 6px 10px");
    expect(body).toContain("font-size: var(--ut-font-sm)");
    // 令牌的实际取值也必须还是 4px / 13px——否则"换个名字"就能悄悄把规格改掉
    expect(css).toContain("--ut-radius-sm: 4px;");
    expect(css).toContain("--ut-font-sm: 13px;");
  });

  it("never lets the pane button pill radius leak into the menu items", async () => {
    const css = await readCss();
    const itemRules = parseRules(css).filter((rule) => rule.selector.includes("uniterminal-context-item"));

    for (const rule of itemRules) {
      // 999px 是面板按钮的药丸圆角，不该出现在菜单项里
      expect(rule.body).not.toContain("border-radius: 999px");
      expect(rule.body).not.toContain("999px");
    }
  });

  it("keeps the hover and disabled look of the menu items", async () => {
    const css = await readCss();
    const itemRules = parseRules(css).filter((rule) => rule.selector.includes("uniterminal-context-item"));

    // 悬停规则：必须唯一（否则 find 会挑错规则），并且底色仍是 12% 的 color-mix
    const hoverRules = itemRules.filter((rule) => rule.selector.includes(":hover"));
    expect(hoverRules).toHaveLength(1);
    expect(hoverRules[0]?.body).toContain("color-mix(in srgb, currentColor 12%, transparent)");

    // 禁用态规则：选择器**以** ":disabled" 结尾。
    // 不能用 includes(":disabled")——悬停规则的 :not(:disabled) 也会被它命中，
    // find 就会挑到没有 opacity 的那一条。
    const disabledRules = itemRules.filter((rule) => rule.selector.endsWith(":disabled"));
    expect(disabledRules).toHaveLength(1);
    expect(disabledRules[0]?.body).toContain("opacity: 0.5");
  });
});
