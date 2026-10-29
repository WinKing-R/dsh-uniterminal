import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 结构性断言：M10-B 之后 HostListView 只认分组表。
 * 这些契约没法从纯函数侧覆盖（组件要 react 运行时，测试环境里没有），
 * 所以直接读源码：字段名、端点、折叠键写错一个，界面就会静默退化成"所有主机塌到根层"。
 */
const SOURCE = readFileSync(new URL("../../src/client/HostListView.tsx", import.meta.url), "utf8");

describe("HostListView uses the groups table", () => {
  it("never reads profile.groupPath", () => {
    // 宿主 M10-A 起不再发 groupPath：读到 undefined 会让整棵树塌成根层
    expect(SOURCE.match(/profile\.groupPath/g) ?? []).toHaveLength(0);
    expect(SOURCE.match(/groupPath\s*:/g) ?? []).toHaveLength(0);
  });

  it("writes colours through POST /groups/color", () => {
    expect(SOURCE).toContain("/api/uniterminal/groups/color");
    // 旧表 appearance.groupColors 已无人读：客户端不该再碰它
    expect(SOURCE).not.toContain("groupColors");
    expect(SOURCE).not.toContain("APPEARANCE_ENDPOINT");
  });

  it("keys the collapsed groups by group id", () => {
    expect(SOURCE).toContain('"uniterminal.collapsed-groups"');
    expect(SOURCE).toMatch(/collapsedGroups\.includes\([A-Za-z]+\.id\)/);
    expect(SOURCE).toMatch(/toggleGroup\([A-Za-z]+\.id\)/);
  });

  it("binds profiles and members by groupId", () => {
    expect(SOURCE).toMatch(/profile\.groupId/);
    // 移动主机回的也是 id：groupPath 入参已从客户端消失
    expect(SOURCE).toMatch(/groupId\s*[,}]/);
  });

  it("builds the tree from parentId instead of path strings", () => {
    expect(SOURCE).toContain("buildGroupTree");
    expect(SOURCE).toContain("groupPathOf");
    expect(SOURCE).not.toContain("deriveGroups");
  });
});

/**
 * 共享层接入的回归锁。
 *
 * 面板里的裸 fetch 曾经各写一份失败文案；现在一律走 api.ts（永不抛错、文案单一出处），
 * 语义色一律走 tokens.ts。写错一个就会退化成「文案各写一份、颜色各写一份」的老样子。
 */
describe("HostListView goes through the shared layers", () => {
  it("has no raw fetch left", () => {
    expect(SOURCE.match(/\bfetch\(/g) ?? []).toHaveLength(0);
    expect(SOURCE).not.toContain("parseJsonSafe");
    expect(SOURCE).toContain('from "./api.js"');
  });

  it("routes every JSON call through api.get / api.post / api.del", () => {
    expect(SOURCE).toContain("api.get<");
    expect(SOURCE).toContain("api.post<");
    expect(SOURCE).toContain("api.del<");
  });

  it("keeps the two /profiles/import shapes apart", () => {
    // 预览回 {preview,found,skipped[]}，真导入回 {imported,skipped[],directives[]}：
    // 两种形状各自照旧处理，不许「顺手统一」成一种
    expect(SOURCE).toContain('api.post<ImportPreviewResponse>("/api/uniterminal/profiles/import"');
    expect(SOURCE).toContain("dryRun: true");
    expect(SOURCE).toContain('api.post<ImportResponse>("/api/uniterminal/profiles/import", {})');
    expect(SOURCE).toContain("payload.found ?? 0");
    expect(SOURCE).toContain("payload.imported ?? 0");
    expect(SOURCE).toContain("payload.directives?.length ?? 0");
  });

  it("takes the semantic colours from the shared tokens", () => {
    expect(SOURCE).toContain('from "./tokens.js"');
    // 取值不变：颜色不再在本文件里各写一遍
    expect(SOURCE).not.toContain("--dsw-alias-label-success");
    expect(SOURCE).not.toContain("--dsw-alias-label-warning");
    expect(SOURCE).not.toContain("--dsw-alias-label-error");
    expect(SOURCE).not.toContain("#b87333");
    expect(SOURCE).not.toContain("#d6dde4");
  });
});

/**
 * B3 语言层：主机列表的文案按 docs/copy-guide.md 统一。
 *
 * 这一轮只改文案、不改行为，所以断言锁的是**用词**：
 * 术语表说死的词不许漂，内部字段名不进界面，
 * 而"不许误伤"的既有语义（成功提示、连接测试结论）一个字都不许动。
 */
describe("HostListView copy conventions (B3)", () => {
  it("不出现「口令」「其它」「服务器」", () => {
    // 术语表：SSH 密码统一叫「密码」；「口令」只允许出现在「私钥口令」这个词组里
    expect(SOURCE.replace(/私钥口令/g, "")).not.toContain("口令");
    // 文件类型叫「其他」
    expect(SOURCE).not.toContain("其它");
    // 主机条目叫「主机」，远端那台机器叫「远端主机」
    expect(SOURCE).not.toContain("服务器");
  });

  it("不出现里程碑编号与内部字段名", () => {
    // 工程编号是给开发者看的，不给用户（规范 §四）
    expect(SOURCE).not.toMatch(/M\d+ 只支持/);
    // 内部字段名不进界面（规范 §2.1）
    expect(SOURCE).not.toContain("session.id");
  });

  it("分组不叫「分组路径」", () => {
    // M10 之后数据模型已是 groupId 树，没有"路径"这回事（术语表）
    expect(SOURCE).not.toContain("分组路径不能为空");
    expect(SOURCE).toContain("分组不能为空：多级用 / 分隔，例如 生产/华东");
  });

  it("失败提示不暴露内部字段名，原始细节进 diag", () => {
    expect(SOURCE).not.toContain("宿主没有返回新分组的 id");
    // ensureGroupId 只报**原因**：动作前缀由各调用点拼，否则会拼出双前缀
    expect(SOURCE).toContain('throw new GroupCreateError("服务返回异常，请重试")');
    expect(SOURCE).toContain('reportClient("client.group-create-failed"');
  });

  it("分组失败只有一个动作前缀：用户不会看到「失败：…失败：」", () => {
    const ensure = SOURCE.slice(SOURCE.indexOf("async function ensureGroupId"), SOURCE.indexOf("async function moveToGroup"));

    // ensureGroupId 自己不带动作前缀（带了就会和外层拼成两个"失败"）
    expect(ensure).not.toContain("失败：");
    expect(ensure).toContain('throw new GroupCreateError("服务返回异常，请重试")');

    // 三个入口各自的最终文案：一个动作前缀 + 原因
    // 新建分组（列表上的新建分组框）
    expect(SOURCE).toContain('setFolderError("新建分组失败：" + result.error.message)');
    expect(SOURCE).toContain('setFolderError("新建分组失败：" + errorText(error))');
    // 移动分组（把主机挪到别的分组）
    expect(SOURCE).toContain('setNotice("移动分组失败：" + errorText(error))');
    // 添加/保存主机时顺带建分组
    expect(SOURCE).toContain('"新建分组失败：" + error.message');

    // 反向锁：任何一条界面文案都不许同时带两个动作前缀
    const literals = SOURCE.match(/["'`][^"'`\n]*["'`]/g) ?? [];
    expect(literals.filter((text) => /失败：[^"'`]*失败：/.test(text))).toEqual([]);
    expect(SOURCE).not.toMatch(/失败：[^"'\n]*失败：/);
  });

  it("口令相关的界面文案统一叫「密码」", () => {
    expect(SOURCE).toContain('aria-label="已记住密码"');
    expect(SOURCE).toContain("两种都试：私钥与已保存的密码一起交给 SSH");
    expect(SOURCE).toContain("只会删掉这台主机的配置与已保存的密码，不会影响远端主机。");
  });

  it("非 SSH 连接的提示与宿主同一句口径", () => {
    // 宿主对非 ssh 的建会话请求回的就是「目前只支持 SSH 连接」
    expect(SOURCE).toContain('setNotice("目前只支持 SSH 连接")');
  });

  it("这一轮不许误伤的既有文案原样保留", () => {
    // 成功提示（规范 §2.2）
    expect(SOURCE).toContain('setOk("已删除 " + profile.name)');
    expect(SOURCE).toContain('setOk("已新建分组 " + path.join(" / "))');
    expect(SOURCE).toContain('"已导入 "');
    // 连接测试结论（术语表）
    expect(SOURCE).toContain('"连通 ✓ "');
    expect(SOURCE).toContain('"连通 ✗ "');
    // 分组颜色按钮（M58）与它的说明
    expect(SOURCE).toContain('title="重置这个分组的名称颜色：回到默认前景色"');
    expect(SOURCE).not.toContain("清除这个分组的自定义名称颜色");
  });
});
