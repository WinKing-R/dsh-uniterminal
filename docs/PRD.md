# UniTerminal 产品需求文档（PRD）

| 项 | 值 |
|---|---|
| 产品名 | **UniTerminal**（工程代号 `dsh-Uniterminal`） |
| 形态 | DeepSeek Harness（DSH）双面插件：宿主半边（Node） + 浏览器半边（React） |
| 版本 | v0.1（首版待评审） |
| 日期 | 2026-02 |
| 状态 | **待用户评审** |
| 定位一句话 | 挂在 DSH 侧边栏里的**统一终端**：一条会话内核同时承载 SSH / 本地 shell / Telnet / 串口，终端既给人敲，也作为工具交给 agent 用，且每一次 agent 动手都可视、可拦、可审计。 |

---

## 0. 决策记录（本版本已锁定，评审通过后不再回滚）

| # | 决策点 | 结论 | 被否方案与否决理由 |
|---|---|---|---|
| D1 | SSH 传输内核 | **纯 JS：`ssh2` + `@xterm/xterm`**，不依赖系统 OpenSSH | 系统 `ssh` 子进程（功能白送但 Windows 需自带、SFTP/隧道不可编程、黑盒错误）；混合双路（两套认证源同步成本高） |
| D2 | 人与 agent 的关系 | **人机同权**：终端既是 UI，也是 agent 工具面 | 纯人工终端（无差异化）；agent 为主（人工体验次优） |
| D3 | 一期范围 | **全量打通骨架**：每项可用、不做深 | 深做终端体验（功能缺口期过长）；只做终端+会话（不满足"兼容所有常用功能"） |
| D4 | 与已装 `@linxin666/dsh-ssh` 的关系 | **全新独立实现，与其共存**，工具名/面板 id/配置目录/路由前缀全部隔离 | fork dsh-ssh（长期分叉、UI 范式受限于左栏全局面板）；替代它（迁移风险 + 破坏既有 agent 工作流） |
| D5 | 侧边栏承载 | **右栏、每会话独立 tab**；同时向 `dsh-better-sidebar` 与官方 `sidebarRightTabs` 双注册并做运行时探测 | 左栏全局面板（所有会话共享同一面板，上下文串味）；双入口（一期成本最高） |
| D6 | 协议范围 | **统一终端**：SSH + 本地 shell + Telnet + 串口，一期同做 | 仅 SSH（不符合 Uni 语义） |
| D7 | 四协议深度 | **统一骨架**：能连/能敲/能重连/能记日志/能挂侧边栏；**不做** TN3270/VT420/X11/Zmodem 等高级仿真 | SSH 完整 + 其余最小（体验割裂）；全量仿真（工作量数倍） |
| D8 | 敏感凭据存储 | **双档，首次启动由用户选择**：①设主密码 → 插件自管加密保险库（KDF + AEAD）②不设 → 存宿主 `.credentials.yaml`（0600 明文），两档共用 `CredentialProvider` 接口 | 强制设主密码（把低摩擦用户挡在门外）；插件自造明文文件（与宿主 0600 同风险却多一套实现） |
| D9 | agent 执行审批 | **分级审批**：只读白名单自动执行；写/危险命令人工确认；全程审计；**判定失败即视为危险** | 全部确认（agent 形同废掉）；全部免确认（生产机交给模型） |
| D10 | 单条连接的记忆粒度 | **每条连接独立「记住密码」开关**，关闭则仅驻留会话内存，绝不上盘 | 全局一刀切（生产机与测试机需求相反） |

### 0.1 已核实的平台事实（PRD 的技术前提，均有源码证据）

| 事实 | 证据 |
|---|---|
| 插件清单即 `package.json` 的 `dsh` 字段，装配单元是 profile 的 `dsh.profile.bundles` 有序列表 | `~\.dsh\profiles\desktop\package.json`；`dsh-app-boot\lib\index.js:488-497` |
| 双面入口：`main` = 宿主半边，`exports["./client"]` = 浏览器半边 | `@linxin666/dsh-ssh\package.json:10,17-19` |
| 宿主导出 cordis 三件套 `name` / `inject` / `apply` | `dsh-ssh\src\index.ts:24,27,135` |
| 工具 = `defineTool({name,description,parameters,output,execute})` + `ctx.tools.register` | `dsh-ssh\src\tools.ts:92-136`；`src\index.ts:218-224` |
| HTTP 路由 / WS 升级：`ctx.webServer.register / registerUpgrade`（同 `kind+path` 重复注册抛错） | `dsh-host-webserver\lib\index.js:326-346` |
| 右栏两套注册表**同时装着**：官方 `ctx.sidebarRight` 与 `dsh-better-sidebar` 的 `ctx.betterSidebar` | `sidebar-right\lib\client.js:4849`；`dsh-better-sidebar\lib\client.js:31961,1415` |
| 右栏 tab 渲染 seat：`sidebar.right.pane.tab` / `.tab.title` / `.tab.guide.entry` | `dsh-client-ui-sidebar-terminal\lib\client.js:438-489` |
| 本地 shell 走宿主统一 PTY 后端，无需自引 `node-pty` | `dsh-terminal\lib\index.js:66,91,105`（`ctx.pty.registerBackend`） |
| 宿主跑在 Electron 的 Node 里；浏览器半边无 `fs`/`child_process` | `run_code` 栈 `node:electron/js2c/node_init`；`dsh-client-ui-sidebar\lib\client.js:1-11` |
| 前端 = React 18 + `@deepseek-ai/dsh-client-ui-primitives` + `*.module.css` 构建期内联，client 必须预打包成 `__ModuleLoader__`（tsdown） | `dsh-ssh\package.json:99` |
| `serialport` 与任何 telnet 库**当前环境均不存在** | 全量扫描 profile 与 asar 的 `node_modules` |
| 宿主凭据库是**明文 YAML + 0600 权限，不加密**；同时暴露 `CredentialProvider` 基类供插件接入自定义凭据源 | `dsh-credentials-local\lib\index.js:13-17,49,104,394`；`dsh-credentials` 导出 `CredentialProvider` |
| 无任何 `@deepseek-ai` 包 `require('electron')` 或使用 `safeStorage` → 操作系统钥匙串路径不可验证，不作为选项 | 全量扫描 306 个 `@deepseek-ai` 包 |

---

## 1. 产品定位

### 1.1 要解决的问题

运维与开发在 DSH 里干活时，SSH 是被切碎在两个世界的：

- **人的世界**：Xshell / MobaXterm / Termius —— 体验完整，但和 AI 对话、和工作流、和项目上下文完全隔离；
- **agent 的世界**：`ssh_exec` 之类的工具 —— 能跑，但人**看不见**它在敲什么、**拦不住**它敲错、**查不到**它敲过什么。

UniTerminal 的立足点：**把这两个世界折叠进同一个侧边栏 tab**。人在终端里敲的东西 agent 看得到上下文，agent 敲的每一条都落在人眼前的会话里，需要拦的时候一键拦。

### 1.2 目标用户

| 用户 | 场景 | 关键诉求 |
|---|---|---|
| 后端/运维工程师 | 同时维护 5-30 台机器，跨跳板机 | 会话不丢、断线重连、批量下发、SFTP 拖拽 |
| 嵌入式/网络工程师 | 交换机、路由器、开发板 | Telnet 与串口要能进同一个工作台，不另开软件 |
| DSH 的 agent 用户 | 让 agent 代跑部署/排查 | 命令可见、危险可拦、事后可审计 |

### 1.3 非目标（明确不做，防止范围蔓延）

- 不做 X11 转发与内置 X Server（MobaXterm 的护城河，一期不碰）
- 不做 RDP / VNC / SPICE（D6 只到 SSH/本地/Telnet/串口）
- 不做云同步与团队共享资产库（无账号体系，且与"本地加密保险库"冲突）
- 不做 TN3270/TN5250/VT420 等工业级仿真（D7）
- 不做 Zmodem/Xmodem 终端内传输（D7）
- 不自研 SSH 协议栈，一律基于 `ssh2`

### 1.4 与 `@linxin666/dsh-ssh` 的共存契约（D4 的强制约束）

| 维度 | dsh-ssh（已装 v0.4.7） | UniTerminal（本产品） |
|---|---|---|
| 面板范式 | 左栏全局面板 `sidebar.panellist` + 键控 `main` | **右栏每会话 tab** |
| Agent 工具名 | `ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster` | **`uniterminal_*` 前缀，绝不重名** |
| 配置 | `~/.dsh/dsh-ssh.json`（明文） | `~/.dsh/uniterminal/`（profiles.json + vault.bin） |
| HTTP 路由 | `/api/dsh-ssh` | `/api/uniterminal` |
| 面板 / tab id | `ssh` | `uniterminal` |
| WS 路径 | `/api/dsh-ssh/ws` | `/api/uniterminal/ws` |

> 冲突硬约束：`ctx.webServer.register` 对重复 `(kind,path)` 直接抛错，`ctx.tools.register` 对重名工具行为未定义——因此**所有外部可见标识必须带 `uniterminal` 命名空间**，并在启动时对已占用标识做检测后降级（而非崩溃）。

---

## 2. 架构与形态

### 2.1 双面插件

```
@winking-r/dsh-uniterminal
├─ package.json          # dsh.bundle.patch / dsh.client.inject / platform:web / engines
├─ cordis.patch.yml      # - insert: [{ id: uniterminal, name: '@winking-r/dsh-uniterminal' }]
├─ lib/index.js          # 宿主半边（Node/Electron）：会话内核、保险库、路由、agent 工具
├─ lib/client.js         # 浏览器半边（React 18，预打包为 __ModuleLoader__）
└─ docs/PRD.md
```

**宿主半边职责**：四协议 TransportAdapter 实现、会话池、保险库（KDF/AEAD）、`/api/uniterminal/*` 路由与 WS 升级、agent 工具注册、审批裁决、审计落盘。
**浏览器半边职责**：右栏 tab 注册、xterm 实例管理、主机列表、SFTP 面板、隧道面板、审批弹层、审计查看。

### 2.2 会话内核：TransportAdapter 抽象

```ts
interface TransportAdapter {
  readonly kind: 'ssh' | 'local' | 'telnet' | 'serial'
  connect(profile: ResolvedProfile, signal: AbortSignal): Promise<SessionHandle>
  capabilities: { exec: boolean; sftp: boolean; tunnel: boolean; resize: boolean }
}
```

一条铁律：**UI 与会话层只认 `SessionHandle`（统一字节流 + resize + 状态事件），不认协议。** 四个适配器共用同一套 tab、同一套日志、同一套重连策略、同一套审计。差异只允许出现在 `capabilities` 声明里——UI 按能力位灰掉不可用功能（例如 Telnet 会话不显示 SFTP 与隧道入口）。

| 适配器 | 实现基座 | 关键点 |
|---|---|---|
| `ssh` | `ssh2` Client，`shell({term,rows,cols})` + `setWindow` | 跳板链用 `forwardOut(127.0.0.1,0,jumpHost,22)` 拿 stream 作下一跳 `sock`；SOCKS/HTTP 代理用 `socks-proxy-agent` 注入 `sock` |
| `local` | 宿主 `ctx.pty.registerBackend`（**不自引 node-pty**） | 复用 DSH 统一终端后端，随宿主版本演进 |
| `telnet` | 自研最小 IAC 协商（仅 `IAC WILL/WONT/DO/DONT` + `ECHO`/`SGA`/`NAWS`/`TTYPE`） | 解决"服务端不回显导致双字符"的经典坑；不做 MUDP 等扩展 |
| `serial` | `serialport`（**唯一原生依赖，本项目唯一安装风险**） | 加载失败时**禁用该协议**并在 UI 明示原因，绝不让 `apply` 抛错 |

### 2.3 侧边栏接入（D5，含双注册表兜底）

```
探测顺序（启动时执行一次，结果缓存）：
  1. ctx.betterSidebar 存在  → registerTab({ id:'uniterminal', kind:'terminal'|'custom', dedupeKey:'uniterminal:<sessionId>', component })
  2. ctx.sidebarRightTabs 存在 → register({ id, kind:'terminal', multiple:true, title, guide })
  3. 两者都空 → 记录诊断事件，在左栏 `sidebar.panellist` 提供降级入口（不静默消失）
```

**硬性要求**：
- 所有 DOM / seat 注册必须包 `try/catch` —— 插件 `apply` 抛错会导致整个 web shell 启动失败（比"没有 UI"更严重）。
- seat 属"可选加入"，宿主未声明该 seat 时注册回调根本不执行 —— 必须提供**可观测的降级**，不能静默无 UI。

### 2.4 技术选型清单

| 层 | 选型 | 许可 | 说明 |
|---|---|---|---|
| SSH 传输 | `ssh2` ^1.17 | MIT | 交互 shell+PTY、SFTP v3、`forwardOut`、agent 全支持；**无** ProxyJump/scp/X11/ssh_config 解析，需自建 |
| 终端 | `@xterm/xterm` ^6 + `addon-fit`/`addon-webgl`/`addon-search`/`addon-serialize`/`addon-web-links` | MIT | `addon-canvas` 已从主线移除；**WebGL 失败必须回退 DOM 渲染器** |
| 代理链 | `socks-proxy-agent` | MIT | 产出 socket 注入 `ssh2` 的 `sock` |
| ssh_config 解析 | `ssh-config-loader`（或等价轻量实现） | MIT | `ssh2` 不自带，需自解析 |
| 本地 PTY | 宿主 `ctx.pty` | — | 不引 `node-pty` |
| 串口 | `serialport` | MIT | 原生模块，风险项 |
| 加密（仅严格档） | Node 内置 `crypto`：`scrypt` (N=2^15,r=8,p=1) + `aes-256-gcm` | — | 零依赖实现保险库 |
| 凭据接口 | 宿主 `@deepseek-ai/dsh-credentials` 的 `CredentialProvider` 基类 | — | 两档共用同一读取入口，切换只换 provider |
| 前端栈 | React 18 + `@deepseek-ai/dsh-client-ui-primitives` + CSS Modules | — | 必须 tsdown 预打包 |

**明确不选**：`russh`（Rust/napi，预编译分发成本高，留作二期吞吐瓶颈时的替换点，接口层预留）；`libssh2`（Node 绑定非一等公民、Windows 构建痛）；`@xterm/headless`（主进程渲染削弱前端能力）；系统 `ssh` 委派（D1 已否，二期作为 `ssh_config` 复杂场景的降级适配器）；Electron `safeStorage`（宿主全家不引 electron 模块，路径不可验证）。

---

## 3. 功能需求

优先级沿用调研口径：**P0** = 缺了就不算终端工具；**P1** = 现代工具默认预期（一期必补）；**P2** = 差异化，二期。每条均给可测验收标准。

### 域 A · 连接与会话管理

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| A-01 | 四协议连接（SSH2 / 本地 / Telnet / 串口） | P0 | 四种 profile 均能在右栏开 tab 并拿到可交互字节流 |
| A-02 | 会话保存与分组树 | P0 | 支持分组嵌套 ≥3 层；拖拽移动分组；重启后结构不丢 |
| A-03 | 多会话标签 | P0 | 同会话内并发 ≥20 个 tab 不崩；互不串输出 |
| A-04 | 从 `~/.ssh/config` 导入 | P1 | 解析 `Host/HostName/User/Port/IdentityFile/ProxyJump/ProxyCommand/LocalForward`；未知指令忽略并计数上报 |
| A-05 | 断线自动重连 + 保活 | P1 | Keepalive 间隔可配（默认 30s）；断线后按退避重连（1→2→4→8→16s，封顶 5 次），重连期间 tab 保留滚动缓冲 |
| A-06 | 会话恢复 | P2 | 重开 GUI 后恢复上次的 tab 集合（不含终端内容，除非开启会话日志） |
| A-07 | 分屏 / 同步输入 | P1 | 同步输入模式下，一次敲击广播到选中会话集合；退出即恢复 |
| A-08 | IPv6 与自定义端口 | P1 | `2001:db8::1` 与任意端口均可连 |

### 域 B · 认证与凭据（D8 / D10）

`securityMode: 'protected' | 'plain'` 是凭据库的顶层字段，**首次启动由用户二选一**。两档共用 `CredentialProvider` 读取入口——上层会话代码永远不知道密码存在哪，切换档位不需要改任何连接逻辑。

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| B-00 | **首次启动凭据策略引导** | P0 | 首次需要保存密码时弹出二选一：①「设置主密码」→ 严格档 ②「不设置」→ 简单档；两档风险说明等长、无诱导（不做默认勾选偏向）；选择写入 `securityMode`，可事后切换但需走 B-10 |
| B-01 | 密码认证 | P0 | 两档均可用；密码明文永不进入工具入参、工具返回值、日志、审计、错误消息 |
| B-02 | 公钥认证（RSA/ECDSA/Ed25519） | P0 | 支持带口令私钥；口令按当前档策略存储 |
| B-03 | 简单档：凭据存宿主 `.credentials.yaml` | P0 | 经 `CredentialProvider` 写入；文件权限必须 0600（宿主会拒绝非本人可读的文件）；UI 明示"当前为明文存储" |
| B-04 | 严格档：自管加密保险库 | P0 | `scrypt` 派生 32B 密钥；`aes-256-gcm`；密文含随机 salt + nonce；错误主密码 5 次后指数退避 |
| B-05 | 每条连接「记住密码」开关（D10） | P0 | 每条 profile 独立；关闭时密码仅驻留会话内存，会话结束即清；开关状态在主机列表上可见 |
| B-06 | ~~保险库生命周期（仅严格档）~~ **已被 D-2a 取代** | — | 主密码与锁定/解锁机制已整体取消（用户决策），凭据固定明文存储；终端锁屏亦明确不做 |
| B-07 | 密钥生成与管理 | P1 | 内置 Ed25519/RSA 生成，导出 OpenSSH 格式；不生成弱于 2048 位 RSA |
| B-08 | ssh-agent 集成 | P1 | Windows 支持 Pageant 与 openssh-agent；macOS/Linux 支持 `SSH_AUTH_SOCK` |
| B-09 | keyboard-interactive / OTP | P2 | 支持多轮 challenge 应答 |
| B-10 | 两档切换与迁移 | P1 | 简单→严格：设主密码后把宿主 YAML 中的 UniTerminal 条目重加密并从宿主移除；严格→简单：明确警示后写回宿主。迁移失败必须回滚，不得两边都丢 |
| B-11 | 主密码不可找回的明确告知（仅严格档） | P0 | 设主密码时强制勾选"丢失即无法恢复"；提供「重置保险库」= 销毁并重新录入 |
| B-12 | 凭据整包导出/迁移 | P1 | 严格档导出加密包（同主密码可解）；简单档导出宿主 YAML 片段并警示明文；均支持导入 |

> 关于 B-03：宿主凭据库**不加密**，只有 0600 权限（`dsh-credentials-local\lib\index.js:104` 会拒绝非本人可读的文件）。因此简单档的安全边界必须由 UI 诚实说明，不能包装成"已加密"。
> 关于 B-05：既然选了"简单档存宿主"，单条连接的记忆开关就从可选增强升为 **P0**——它是不设主密码的用户唯一的精细控制手段。

### 域 C · 终端交互与渲染

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| C-01 | VT100/xterm 兼容仿真 | P0 | 通过 vttest 核心用例；tmux/vim/htop 全屏程序正常 |
| C-02 | Unicode / 宽字符 / CJK | P0 | 中日韩双宽字符、emoji、组合字符不出现列错位 |
| C-03 | 回滚缓冲与搜索 | P0 | 默认 5000 行可配至 100000；搜索高亮 + 上下跳转 |
| C-04 | 复制粘贴（含多行确认） | P0 | 多行粘贴默认弹出确认（可关）；右键行为可选 |
| C-05 | 256 色 / 真彩色 / 字体连字 | P1 | 真彩色渲染正确；连字开关生效 |
| C-06 | 渲染器自动降级 | P0 | WebGL 初始化失败时自动回退 DOM 渲染器并提示一次 |
| C-07 | 大输出吞吐 | P1 | `yes` 或 `cat` 200MB 文件时 UI 不冻结（帧率 ≥30fps），提供"暂停输出缓冲"按钮 |
| C-08 | 终端内搜索/序列化 | P1 | `addon-search` 与 `addon-serialize` 生效，可导出当前会话文本 |
| C-09 | 主题与字体 | P1 | 内置 ≥4 套配色；可导入 iTerm/xterm 主题 JSON；字体族/字号/行高可调 |

### 域 D · 文件传输（仅 SSH）

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| D-01 | 集成 SFTP 面板 | P1 | 与终端同 tab 内可切换；目录树懒加载；双击进目录 |
| D-02 | 上传/下载（拖拽） | P1 | 支持文件与目录递归；拖入即入队；失败可重试 |
| D-03 | 传输队列（进度/暂停/取消/重试） | P1 | 并发上限可配（默认 3）；进度按字节；取消后清理临时文件 |
| D-04 | 远端文件在线编辑 | P1 | 打开远端文件走右栏 editor（复用 `dsh-better-sidebar` 的 `registerFileViewer`，探测不到则内置简易编辑器） |
| D-05 | 权限与属主修改 | P1 | chmod 图形化（rwx 九宫格 + 八进制同步）；chown 需人工确认 |
| D-06 | 双栏本地-远端对照 | P2 | 左右分栏 + 镜像同步预览 |
| D-07 | 断点续传 / 限速 | P2 | 大文件可续；带宽上限可设 |

### 域 E · 端口转发与隧道（仅 SSH）

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| E-01 | 本地转发 -L | P1 | `forwardOut` 实现；端口占用时明确报错并建议替代端口 |
| E-02 | 远程转发 -R | P1 | `forwardIn` 实现；需服务端 `AllowTcpForwarding` 支持，失败给出可读原因 |
| E-03 | 动态 SOCKS -D | P1 | 内置最小 SOCKS5 服务端；浏览器可直连验证 |
| E-04 | 隧道管理面板 + 持久化 | P1 | 隧道列表含状态灯/流量/启停；随会话自动建立开关；重启后自动恢复 autostart 隧道 |
| E-05 | 跳板链（ProxyJump） | P1 | 支持 ≥3 跳；单跳失败定位到具体跳点；`ProxyCommand` 降级为二期 |
| E-06 | 隧道冲突与回收 | P1 | 会话断开时其派生隧道的处理策略可选（保留/回收），默认回收 |

### 域 F · 批量与自动化

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| F-01 | 多会话批量执行 | P1 | 选中 N 台并发下发，逐台回显输出与退出码，失败不中断其余 |
| F-02 | 命令片段（Snippets） | P1 | 可分组、可变量占位（`{{host}}`）；点击发送到当前会话 |
| F-03 | 登录后自动执行 | P1 | 每 profile 可配启动命令序列；支持 `{sleep}` 等最小指令 |
| F-04 | 会话日志（文本/HTML） | P1 | 开、关可配；按会话与日期分文件；日志路径可配 |
| F-05 | 脚本化 CLI 入口 | P2 | 提供 headless 调用方式（复用 `uniterminal_*` 工具面即可） |

### 域 G · 统一终端的其余协议（D6/D7 增量）

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| G-01 | 本地 shell（PowerShell/bash/zsh/sh） | P1 | 走 `ctx.pty` 后端；cwd 可配；与 SSH 会话共用同一 tab 组件 |
| G-02 | Telnet 连接 | P1 | 自定义端口；**IAC 协商正确**：`ECHO`（本地回显）、`SGA`、`NAWS`（随窗口 resize 上报）、`TTYPE` |
| G-03 | Telnet 能力降级 | P1 | SFTP/隧道/exec 入口在 Telnet 会话中灰掉并给 tooltip，不得报错 |
| G-04 | 串口连接 | P1 | 端口枚举、波特率/数据位/停止位/校验/流控全可配；热插拔后列表刷新 |
| G-05 | 串口不可用降级 | P0 | `serialport` 加载失败 → 该协议在 UI 中禁用并显示原因，**插件其余功能完全可用** |
| G-06 | 发送十六进制 / 行尾控制 | P2 | 可切换 \r\n / \n / \r 发送行尾 |

### 域 H · 安全与审计（D9）

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| H-01 | 主机密钥校验 + known_hosts | P0 | 首次连接展示指纹并要求确认；指纹变更**强制阻断**并要求显式覆盖；known_hosts 落在 `~/.dsh/uniterminal/known_hosts` |
| H-02 | 命令分级裁决引擎 | P0 | 只读白名单命中且**不含写入型 shell 元字符**（`>`、`>>`、`tee`、`|` 管道到 shell）→ 自动放行；否则需确认；**匹配异常一律判定为危险**（fail-closed） |
| H-03 | 危险命令硬黑名单 | P0 | `rm -rf`、`mkfs`、`dd of=/dev/`、`shutdown`、`reboot`、`chmod -R 777 /`、`iptables -F`、`kill -9 1`、`curl|sh` 等命中即需二级确认（输入会话名确认，非单击） |
| H-04 | 审批可观测 | P0 | 需确认时，右栏该会话 tab 出现审批条（命令全文 + 判定理由 + 允许/拒绝），超时默认拒绝 |
| H-05 | 审计流水 | P0 | `~/.dsh/uniterminal/audit/YYYY-MM-DD.jsonl`，字段：`ts, actor(human|agent), tool, sessionId, peer, command, verdict(auto|approved|denied), exitCode, durationMs`；agent 发起的记录必须可追溯到工具调用 |
| H-06 | 审计不可篡改（追加语义） | P1 | 只追加，不做原地修改；提供导出；审计文件损坏时拒绝启动审计而非静默丢写 |
| H-07 | WS / API 围栏 | P0 | 仅 loopback 可连；升级握手校验来源与一次性 token；拒绝时返回 403 不泄漏内部信息 |
| H-08 | 明文泄露防线 | P0 | 密码/口令/私钥内容永不进入：工具入参、工具返回值、日志、审计、错误消息。工具只接受 `credentialRef` |

### 域 I · agent 工具面（D2 的落地）

统一设计：8 个工具，全部 `uniterminal_` 前缀，全部 action 化，全部返回结构化的 `{ ok, data | error }`。

| 工具 | action | 能力 | 默认审批级 |
|---|---|---|---|
| `uniterminal_hosts` | `list` / `upsert` / `remove` | 资产 CRUD（不含任何凭据明文） | list=自动；upsert=确认；remove=二级确认 |
| `uniterminal_sessions` | `list` / `open` / `close` / `send` / `read` | 会话生命周期与交互 | list=自动；open/close=确认；send=走 H-02 裁决；read=自动 |
| `uniterminal_exec` | — | 一次性命令（仅 ssh/local） | 走 H-02 裁决；Telnet/串口调用返回明确的 `unsupported` 错误 |
| `uniterminal_sftp` | `ls` / `get` / `put` / `mkdir` / `rm` / `chmod` | 文件与目录 | ls=自动；get=自动；put/mkdir/chmod=确认；rm=二级确认 |
| `uniterminal_tunnel` | `start` / `list` / `stop` / `stop_all` | 隧道 | list=自动；start/stop=确认 |
| `uniterminal_cluster` | — | 批量下发 | 按批次一次性确认（含目标机列表与全文命令） |
| `uniterminal_vault` | `status` / `unlock` / `lock` | 保险库状态 | status=自动；unlock **不通过工具暴露**（只能人机界面解锁）；lock=自动 |
| `uniterminal_audit` | `query` | 审计检索 | 自动 |

**只读白名单（H-02 初版）**：`ls, stat, cat, head, tail, wc, grep, find(无 -delete/-exec), ps, top -b -n1, df, du, free, uptime, whoami, id, uname, hostname, date, pwd, git status, git log, systemctl status, journalctl -n, docker ps, ss -tlnp, netstat`。

### 域 J · 外观与可用性

| ID | 需求 | 级 | 验收标准 |
|---|---|---|---|
| J-01 | 快捷键（含多键组合） | P1 | 至少覆盖：新建/关闭 tab、切 tab、清屏、搜索、粘贴确认开关、发送片段 |
| J-02 | 多语言 | P1 | 中文 / English；走宿主 locale 服务 |
| J-03 | 空态与错误态 | P0 | 无主机时给"从 ssh_config 导入"引导；连接失败给出分层原因（DNS/网络/认证/算法/主机密钥） |
| J-04 | 通知 | P2 | 长任务（>10s 命令或批量）完成时提示 |
| J-05 | 专注模式 | P2 | 折叠侧栏其他面板，仅留终端 |

---

## 4. 非功能需求

| 项 | 指标 |
|---|---|
| 首字节延迟 | 同城 <150ms（连接建立到可见提示符） |
| 渲染 | ≥60fps 常态；1MB/s 持续输出下 ≥30fps |
| 并发会话 | ≥20 个活跃 PTY 会话不崩 |
| SFTP 吞吐 | 同城千兆 ≥30MB/s（单文件） |
| Tab 冷启动 | 侧边栏 tab 打开到可交互 <500ms |
| 内存 | 20 会话 + 各 5000 行缓冲 <800MB |
| 健壮性 | 任一协议适配器崩溃不得拖垮插件；`apply` 永不抛错（全部 try/catch + 诊断事件） |
| 兼容 | DSH `engines.dsh >= 0.2.1-rc.2`；宿主 PTY/侧边栏 API 缺失时逐项降级 |

---

## 5. 数据模型

```
~/.dsh/uniterminal/
├─ profiles.json        # 非敏感元数据
├─ vault.bin            # 仅严格档：加密保险库（salt + nonce + ciphertext + tag + kdf 参数）
├─ known_hosts
├─ audit/YYYY-MM-DD.jsonl
├─ sessions/<sessionId>.log
└─ themes/
```

```ts
type Protocol = 'ssh' | 'local' | 'telnet' | 'serial'
type SecurityMode = 'protected' | 'plain'   // 严格档 / 简单档，首次启动由用户选择

interface Profile {
  id: string; name: string; protocol: Protocol; groupPath: string[]
  // ssh
  host?: string; port?: number; user?: string
  auth?: { type: 'password' | 'publickey' | 'agent' | 'keyboard-interactive'; credentialRef?: string; remember?: boolean }
  jumpChain?: { host: string; port?: number; user: string; credentialRef?: string }[]
  proxy?: { type: 'socks5' | 'http'; url: string }
  // local
  shell?: string; cwd?: string
  // telnet
  terminalType?: string
  // serial
  path?: string; baudRate?: number; dataBits?: 5|6|7|8; stopBits?: 1|2
  parity?: 'none'|'even'|'odd'|'mark'|'space'; flowControl?: 'none'|'xon/xoff'|'rts/cts'
  // 共用
  keepaliveMs?: number; connectTimeoutMs?: number
  autoCommands?: string[]; tags?: string[]
  tunnels?: TunnelSpec[]
}

interface TunnelSpec { id: string; mode: 'local'|'remote'|'socks'
  bindHost?: string; bindPort?: number; destHost?: string; destPort?: number; autostart?: boolean }

interface AuditEntry { ts: number; actor: 'human'|'agent'; tool?: string; sessionId: string
  peer: string; command: string; verdict: 'auto'|'approved'|'denied'
  exitCode?: number; durationMs?: number }
```

---

## 6. 交互与信息架构

```
右栏（每会话独立）
├─ Tab: UniTerminal（一个会话一个 tab，dedupeKey = uniterminal:<sessionId>）
│  ├─ 顶栏：主机名 · 协议徽标 · 状态灯 · 延迟 · [SFTP] [隧道] [片段] [审计] [关闭]
│  ├─ 主体：xterm 终端（或 SFTP 双栏 / 隧道列表，按顶栏切换）
│  └─ 底部：审批条（仅在需确认时出现）
└─ 空态页：主机列表（分组树）+「新建」「从 ssh_config 导入」「打开本地 shell」
```

关键状态：未解锁保险库时，所有需凭据的连接显示"先解锁保险库"；协议能力不可用（如串口缺依赖）时，该项在选择器里带禁用态与原因 tooltip。

---

## 7. 里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| **M0 骨架** | 双面包打通、cordis 挂载、右栏 tab 双注册探测、一个 SSH 会话可交互 | 装上插件能在右栏开到可敲的终端 |
| **M1 会话** | profiles CRUD + 分组、多会话、断线重连、keepalive、known_hosts、IPv6 | 20 会话并发不崩；指纹变更被阻断 |
| **M2 安全** | 双档凭据引导（严格档保险库 + 简单档走宿主 0600）、`CredentialProvider` 抽象、每连接记住开关、密钥管理、agent 8 工具、分级审批、审计 | 两档各自可用且可互迁；严格档密码零落盘、简单档文件权限 0600；危险命令被拦并可审计回溯 |
| **M3 文件与隧道** | SFTP 面板+队列+在线编辑+chmod、-L/-R/-D、跳板链、隧道面板 | 三条转发各跑通一次真实场景 |
| **M4 统一终端** | 本地 shell（ctx.pty）、Telnet（IAC）、串口（含降级）、批量下发、片段、登录后命令 | 四协议同 UI 可用；串口缺依赖时其余功能不受影响 |
| **M5 打磨（二期）** | 主题/字体/快捷键/多语言/日志导出/专注模式/分屏同步输入 | — |

一期 = **M0–M4**，与 D3「全量打通骨架」一致。

---

## 8. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 右栏两套注册表同时装载，注册到不渲染的一侧会**静默无 UI** | 高 | 启动探测 + 结果缓存 + 降级到左栏入口；探测失败本身写入诊断事件 |
| R2 | `serialport` 是原生模块，当前环境未安装 | 中 | 懒加载 + 失败即禁用该协议；绝不在 `apply` 阶段引入 |
| R3 | seat 是"可选加入"，宿主未声明则回调不执行 | 中 | 见 R1 的降级路径；提供"检测面板为何不显示"的诊断视图 |
| R4 | `ssh2` 单线程吞吐上限 | 中 | 适配器接口预留 `russh` 替换点；大输出走暂停/序列化策略 |
| R5 | Telnet IAC 自研回归面 | 中 | 一期只做 ECHO/SGA/NAWS/TTYPE 四个选项，其余一律 `DONT` 回应 |
| R6 | 与 `dsh-ssh` 的命名冲突 | 高 | 全量 `uniterminal` 命名空间 + 启动检测后降级 |
| R7 | 主密码丢失 = 数据不可恢复（**仅严格档**） | 高 | 首次强提示 + 加密包导出迁移；明确不提供找回。简单档不受此风险影响 |
| R10 | 简单档密码明文落盘 | 高 | 首次引导给出等长无诱导的风险说明 + 依赖宿主 0600 校验 + 每条连接可单独关闭记住 + UI 常驻标注当前档位 |
| R8 | 插件 `apply` 抛错会拖垮 web shell 启动 | 高 | 所有注册包 try/catch；协议/面板均按"可失败"设计 |
| R9 | `ssh2` 不支持 `ssh_config` 全量语义 | 中 | 一期自解析常用 7 个指令；`ProxyCommand` 与其余指令二期走系统 ssh 降级适配器 |

**未决（不阻塞评审）**：Xshell/Xftp、Termius、Warp 的官方功能页因反爬未能取到正文，相关细项标"待核实"；这些工具的功能均非本 PRD 的 P0 判定依据，二期细化时人工补证。

---

## 9. 调研依据

功能分级来自 21 个产品的实证调研（MobaXterm、SecureCRT、Royal TSX、ZOC、WindTerm、Tabby、Electerm、NxShell、Termix、HexHub、WinSCP、PuTTY、Mosh、VS Code Remote-SSH、JetBrains Gateway 等），技术选型来自 `ssh2`/`xterm.js` 官方文档与 Tabby/Electerm/Termix 三个量产实现的架构对照。DSH 扩展点结论均带"文件:行号"证据（见 0.1 节）。

P0 共识边界（**缺一即不合格**）：SSH2 连接、密码认证、公钥认证、xterm/VT100 仿真、Unicode/宽字符、会话保存与分组、回滚搜索与复制粘贴、主机密钥指纹校验。本 PRD 的 A/B/C/H 四域已全覆盖，且因加入 agent 面而额外收紧（H-02~H-08）。
