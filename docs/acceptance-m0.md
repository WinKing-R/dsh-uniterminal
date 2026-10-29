# M0 端到端验收单（M0-11）

> 这份文件是给**重启 Host 之前/之后**用的。重启 DSH Host 会终止发起安装的那个会话，所以步骤与排障都写在这里，而不是只在对话里。

## 0. 已经验证过什么（不需要你重复）

| 项 | 证据 |
|---|---|
| 39 个用例（含真实 http + 真实 ws 集成） | `pnpm test` 连跑 5 轮 VITEST_EXIT=0 |
| 类型检查 | `tsc --noEmit` 退出码 0 |
| 双面包构建 | `lib/index.js` 15.27 kB（ESM）、`lib/client.js` 680.87 kB（CJS + `__ModuleLoader__` 包裹） |
| 宿主产物冒烟 | `apply` 注册出 2 条 HTTP 路由；首条 `register` 抛错时仍尝试第二条且不抛 |
| 客户端产物冒烟 | tab 注册成功；样式 xterm 7112B + tab 1259B 注入；二次 `apply` 去重；无注册表只告警不抛 |
| 依赖卫生 | `any` 0 处；未引 `@deepseek-ai/cordis`；react 未进产物 |

**没验证过的是「真实宿主里的集成」**：右栏注册表探测结果、`registerUpgrade` 在真实 webServer 上是否可用、SSH 端到端收发。这三件事只有重启后能验。

## 1. 安装（在 profile 目录执行）

```bash
cd ~/.dsh/profiles/desktop
pnpm add "link:E:/DeepSeekWS/codingWork/dsh-Uniterminal"
```

用 `link:` 而不是 `file:`：`link:` 建符号链接，我们后续 `pnpm build` 后无需重装。

然后编辑 `~/.dsh/profiles/desktop/package.json`，在 `dsh.profile.bundles` **数组末尾**追加一项：`"@winking-r/dsh-uniterminal"`。

注意：不要同时往 profile 自己的 `cordis.patch.yml` 里加挂载行——那是「手工挂载」通道，与 bundle 通道同时用会导致同一插件挂两次（`dsh-better-sidebar` 的 patch 里明确警告过：双挂载会让整个插件树在启动时报 duplicate route 而失败）。我已确认 profile 的 `cordis.patch.yml` 当前没有 `uniterminal` 相关行。

## 2. 重启并观察四条判据

### 判据 1 · 不白屏
最关键。`apply` 抛错会拖垮整个 web shell。若白屏，先去 Host 日志找 `uniterminal` 字样。

### 判据 2 · 右栏的 `+` 菜单里出现 UniTerminal

**注意：注册 tab 类型不等于自动打开 tab。** `betterSidebar.registerTab` 只登记一种类型，类型会出现在右栏的 `+` 新建菜单里，需要点它才会开出实例。所以正确的观察点不是「侧边栏多了一个 tab」，而是「`+` 菜单里多了一项」。

若点开菜单没有该项，打开浏览器控制台（F12）找这一条告警：`uniterminal: right pane unavailable (<target>): <error>`

- `<target>` = `betterSidebar` 且带 error → 注册到了 better-sidebar 但被拒（看 error 原文）
- `<target>` = `sidebarRightTabs` → `ctx.betterSidebar` 未暴露，走了官方注册表
- `<target>` = `none` → 两套注册表都不可用：检查 `dsh.client.inject` 与 `/plugins/<id>/client.js` 是否加载
- 完全没有 `uniterminal` 字样 → 客户端产物没被执行（`apply` 未运行）

### 判据 3 · SSH 能收发
填一台你能连的主机（主机/用户/端口），点连接：
- 出现提示符 → 通
- 停在「连接失败」→ 看 notice 文案，它是路由返回的 error 原文（DNS / 认证 / 超时都会带具体原因）

### 判据 4 · 窗口 resize 生效
拖动窗口后在该终端里执行 `stty size`，行列数应跟着变。变了说明 resize → setWindow 链路通。

## 3. 排障对照表

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| 白屏 | `apply` 抛错 | 查 Host 日志 `uniterminal`；应用内所有注册已包 try/catch，若仍抛说明是 import 阶段（如 schemastery 解析失败） |
| 右栏无 tab，控制台无告警 | 客户端 bundle 压根没被加载 | Network 查 `/plugins/@winking-r/dsh-uniterminal/client.js`；确认 `dsh.client.platform` 为 web |
| 右栏无 tab，告警 target=none | 两套注册表都不可用 | 检查 profile 里 `dsh-better-sidebar` 是否启用；确认客户端 inject 列表与真实插件一致 |
| 有 tab，点连接报 Method Not Allowed | HTTP 路由没注册上 | 访问 `/api/uniterminal/health` 应返回 `ok` 为 true 的 JSON |
| 有 tab，连接成功但终端空白 | WS 升级路由没注册 | 检查 Host 日志有无 upgrade route not registered；确认宿主 `webServer.registerUpgrade` 存在 |
| 终端出现重复字符 | 回显未处理 | 属 M0 范围外（回显由远端 PTY 负责），记下来进 M1 |

## 4. 回滚

```bash
cd ~/.dsh/profiles/desktop
pnpm remove @winking-r/dsh-uniterminal
```

并从 package.json 的 `dsh.profile.bundles` 里删掉该项。重启后即恢复原状，不影响 `@linxin666/dsh-ssh`（两者命名空间完全隔离）。

## 5. 请回报什么

1. 四条判据各自的结果
2. 若失败：target 值、控制台完整告警文本、Host 日志里 uniterminal 相关行
3. `curl http://127.0.0.1:57760/api/uniterminal/health` 的原始输出
## 6. 客户端半边自诊断（M0-15）

客户端产物在模块加载时会写一个全局标记：`window.__UNITERMINAL__`。重启后在浏览器控制台执行 `__UNITERMINAL__`，返回值直接指出问题在哪一层：

| 返回值 | 含义 | 下一步 |
|---|---|---|
| `undefined` | 客户端产物**压根没被加载** | 宿主没把它放进 boot 图，或 bundle 解析失败 |
| `phase: "module"` 且没有别的变化 | 产物加载了，但 `apply` **从未被调用** | cordis 的 `inject` 依赖（`slots`/`locale`）未被满足 |
| `phase: "apply"`，`services.betterSidebar: "object"` | 探测到 better-sidebar 服务 | 看 `attempts` 里每次注册的 `target`/`ok`/`error` |
| `services.betterSidebar: "absent"` | 服务未暴露给客户端插件 | 需改走官方 `sidebarRightTabs` 注册表 |
| `finalError` 有值 | 注册被拒 | 错误原文即原因 |
