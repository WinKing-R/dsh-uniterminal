# UniTerminal 实施任务书（M0–M4）

> **For agentic workers:** 本文件是**索引与分解**，不是可直接执行的计划。执行时必须配合对应里程碑的详细计划（如 `2026-10-25-uniterminal-m0-skeleton.md`），那是唯一含逐步代码的计划。

**Goal:** 把已评审通过的 `docs/PRD.md`（67 条需求 / M0–M4）分解为 46 个可独立验收的工程任务，并固定任务间的接口与依赖顺序。

**Architecture:** 单个 npm 包承载两个半边——宿主半边（Node/Electron：四协议内核、凭据、路由、agent 工具）与浏览器半边（React 18：右栏 tab、xterm、面板 UI）。两侧只通过 `/api/uniterminal/*` 与 WebSocket 通信，共享 `src/types.ts` 的类型。

**Spec:** `docs/PRD.md`（v0.1，D1–D10 已锁定）

## Global Constraints（每个任务都隐含适用）

- Node ≥ 20；本机 node: `C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，pnpm: `...\dependencies\pnpm\bin\pnpm.mjs`
- TypeScript `strict` + `noUncheckedIndexedAccess`；纯 ESM；公共接口禁用 `any`
- 全部对外标识使用 `uniterminal` 命名空间：工具名 `uniterminal_*`、路由 `/api/uniterminal/*`、tab id `uniterminal`、配置目录 `~/.dsh/uniterminal/`
- 任何注册（tools / webServer / slots / panels）必须包 `try/catch`；插件 `apply` 永不抛错
- **绝不** import/require `electron`（`safeStorage` 路径已验否）
- 密码 / 口令 / 私钥明文绝不进入：工具入参、工具返回值、日志、审计、错误消息
- 依赖上限：宿主半边仅 `ssh2`、`ws`（+ M4 懒加载 `serialport`）；**不得**引入 `node-pty`（走 `ctx.pty`）
- 测试：vitest / node 环境；每个任务先写失败测试（UI 组件除外，见任务说明）
- 提交：每任务一次 commit，conventional commits
- DSH 下限：`engines.dsh >= 0.2.1-rc.2`

---

## 1. 仓库文件结构（先定型，再分任务）

```
dsh-Uniterminal/
├─ package.json                  # dsh.bundle / dsh.client / exports 双面
├─ cordis.patch.yml              # - insert: [{ id: uniterminal, name: '@winking-r/dsh-uniterminal' }]
├─ tsconfig.json  tsdown.config.ts  vitest.config.ts
├─ src/
│  ├─ index.ts                   # cordis: name / inject / apply
│  ├─ config.ts                  # schemastery Config（自动成设置页）
│  ├─ types.ts                   # 宿主+浏览器共享类型（Protocol / Capabilities / SessionInfo）
│  ├─ engine/
│  │  ├─ types.ts                # TransportAdapter / SessionHandle / ResolvedProfile
│  │  ├─ registry.ts             # kind -> adapter 注册表
│  │  ├─ ring-buffer.ts          # 有界输出缓冲
│  │  ├─ session-manager.ts      # 会话生命周期 + 订阅
│  │  ├─ ssh-transport.ts        # ssh2 适配器（可注入 client 工厂以便测试）
│  │  ├─ local-transport.ts      # M4: ctx.pty 后端
│  │  ├─ telnet-transport.ts     # M4: IAC 协商
│  │  └─ serial-transport.ts     # M4: serialport 懒加载
│  ├─ store/
│  │  ├─ profile-store.ts        # M1: profiles.json 原子写
│  │  ├─ ssh-config-import.ts    # M1: ssh_config 解析
│  │  ├─ known-hosts.ts          # M1
│  │  ├─ credential-provider.ts  # M2: 两档统一接口
│  │  ├─ vault.ts                # M2: scrypt + AES-256-GCM
│  │  ├─ audit.ts                # M2: JSONL 追加
│  │  └─ claim.ts                # M2: 命令分级裁决
│  ├─ tools/                     # M2: 8 个 defineTool
│  ├─ routes.ts                  # HTTP + WS
│  └─ client/
│     ├─ index.ts                # browser half apply(ctx)
│     ├─ right-pane.ts           # 双注册表探测
│     ├─ UniterminalTab.tsx  TerminalView.tsx  tab.module.css
│     ├─ HostListView.tsx        # M1
│     ├─ SftpPanel.tsx           # M3
│     └─ TunnelPanel.tsx         # M3
└─ test/                         # 与 src 镜像
```

**职责边界铁律**：`engine/*` 只认 `TransportAdapter`，不认协议；`store/*` 只认 `CredentialProvider`，不认凭据存在哪；`client/*` 只认 REST + WS，不认宿主内部。

---

## 2. M0 · 骨架（11 任务，详见 M0 计划）

| ID | 任务 | 产出接口 | 验收点 |
|---|---|---|---|
| M0-1 | 仓库脚手架（git/tsconfig/vitest/tsdown） | — | `pnpm typecheck` 0 错 |
| M0-2 | `RingBuffer` | `push/since/cursor/droppedBytes` | 3 个单测通过（含丢弃与游标单调） |
| M0-3 | `TransportAdapter` 契约 + `TransportRegistry` | `register/get/kinds` | 重复 kind 抛错 |
| M0-4 | `ssh-transport.ts`（注入式 client 工厂） | `createSshTransport()` | 假 client 下 open 可写可 resize |
| M0-5 | `SessionManager` | `open/list/write/read/resize/close/subscribe` | 未知 id 抛错；缓冲回读正确 |
| M0-6 | `/api/uniterminal/*` + WS 升级 | `createRoutes()` / `isLoopback()` | 非 loopback 被拒 |
| M0-7 | 宿主入口 `index.ts` + `config.ts` | cordis `name/inject/apply` | 缺服务时不抛错、注册项计数正确 |
| M0-8 | 双面包打包（package.json `dsh` 字段 + patch + tsdown） | `lib/index.js` + `lib/client.js` | 两产物存在且可被 require |
| M0-9 | `right-pane.ts` 双注册表探测 | `detectRightPane()` / `registerTab()` | 3 种 ctx 形态判定正确、优先级 betterSidebar |
| M0-10 | `TerminalView` + `UniterminalTab` | 右栏 tab UI | 构建通过（UI 无单测，见 M0 计划说明） |
| M0-11 | 端到端手动验收 | — | 装进 profile 后右栏能开 SSH tab 并敲通 |

**M0 出口**：装上插件后，右栏能开出一个可交互的 SSH 终端；任何一步失败都不影响 web shell 启动。

---

## 3. M1 · 会话（8 任务）

| ID | 任务 | 触及文件 | 产出接口 | 验收点 / PRD |
|---|---|---|---|---|
| M1-1 | Profile 持久化（原子写 + schema 校验） | `store/profile-store.ts` | `ProfileStore.load/save/upsert/remove` | 写中断不损坏文件；A-02 |
| M1-2 | 分组树 CRUD | `store/profile-store.ts` | `groupPath` 嵌套 ≥3 层 | 拖拽移动后结构正确；A-02 |
| M1-3 | `~/.ssh/config` 导入 | `store/ssh-config-import.ts` | `parseSshConfig(text)` | 解析 7 个指令，未知指令计数上报；A-04 |
| M1-4 | known_hosts 校验 | `store/known-hosts.ts` | `verifyHostKey()` | 指纹变更强制阻断；H-01 |
| M1-5 | keepalive + 重连退避 | `engine/ssh-transport.ts` | `reconnect` 状态机 | 1→2→4→8→16s 封顶 5 次；A-05 |
| M1-6 | 多会话管理 + 会话列表 | `engine/session-manager.ts` | 并发 ≥20 | 20 会话不崩、输出不串；A-03 |
| M1-7 | IPv6 与自定义端口 | `engine/ssh-transport.ts` | — | `2001:db8::1` 可连；A-08 |
| M1-8 | 主机列表 UI（树/搜索/空态） | `client/HostListView.tsx` | — | 空态给导入引导；J-03 |

---

## 4. M2 · 安全（10 任务）

| ID | 任务 | 触及文件 | 产出接口 | 验收点 / PRD |
|---|---|---|---|---|
| M2-1 | `CredentialProvider` 抽象（两档统一入口） | `store/credential-provider.ts` | `resolve(ref): Promise<string>` / `put/remove` | 上层只拿 ref，不感知档位；B-01 |
| M2-2 | 简单档：写宿主 `.credentials.yaml` | 同上 | `PlainProvider` | 落盘权限 0600，非本人可读时拒写；B-03 |
| M2-3 | 严格档：`vault.bin` | `store/vault.ts` | `scrypt`(N=2^15) + `aes-256-gcm` | 错主密码 5 次指数退避；B-04 |
| M2-4 | 首次启动引导 + `securityMode` | `client/FirstRun.tsx` | — | 两档说明等长无偏向；B-00 |
| M2-5 | 锁定/解锁/闲置超时 | `store/vault.ts` | `lock/unlock/isLocked` | 闲置 15 分钟自动锁定；B-06 |
| M2-6 | 每连接「记住密码」 | `store/profile-store.ts` | `auth.remember` | 关闭时仅内存，会话结束即清；B-05 |
| M2-7 | 两档迁移（含回滚） | `store/credential-provider.ts` | `migrate(from,to)` | 迁移失败两边都不丢；B-10 |
| M2-8 | 命令分级裁决 + 黑名单 | `store/claim.ts` | `judge(command): 'auto'|'confirm'|'danger'` | 白名单+无写入元字符才放行；匹配异常→danger；H-02/H-03 |
| M2-9 | 审计 JSONL | `store/audit.ts` | `append(entry)` / `query(filter)` | 只追加、字段齐、损坏即拒写；H-05/H-06 |
| M2-10 | agent 8 工具 + 审批接线 | `tools/*.ts` | `uniterminal_*` × 8 | 全前缀、全 try/catch、审批条可拦；域 I |

---

## 5. M3 · 文件与隧道（8 任务）

| ID | 任务 | 触及文件 | 产出接口 | 验收点 / PRD |
|---|---|---|---|---|
| M3-1 | SFTP 会话复用 | `engine/sftp.ts` | `ls/get/put/mkdir/rm/chmod` | 与终端共用一条 SSH 连接；D-01 |
| M3-2 | SFTP 面板 UI（懒加载树） | `client/SftpPanel.tsx` | — | 双击进目录；D-01 |
| M3-3 | 传输队列（并发 3/进度/取消/重试） | `engine/transfer-queue.ts` | `enqueue/pause/cancel` | 取消后清理临时文件；D-03 |
| M3-4 | chmod 图形化 | `client/ChmodDialog.tsx` | — | rwx 九宫格与八进制同步；D-05 |
| M3-5 | 远端在线编辑 | `client/remote-edit.ts` | `registerFileViewer` 探测 | 探测不到则内置简易编辑器；D-04 |
| M3-6 | -L / -R / -D 三路转发 | `engine/tunnel.ts` | `startLocal/startRemote/startSocks` | 各跑通一次真实场景；E-01~E-03 |
| M3-7 | 跳板链 `forwardOut` 串接 | `engine/jump-chain.ts` | `connectThroughChain()` | ≥3 跳；单跳失败定位到跳点；E-05 |
| M3-8 | 隧道面板 + autostart + 回收 | `client/TunnelPanel.tsx` | — | 断开默认回收派生隧道；E-04/E-06 |

---

## 6. M4 · 统一终端（9 任务）

| ID | 任务 | 触及文件 | 产出接口 | 验收点 / PRD |
|---|---|---|---|---|
| M4-1 | local adapter（`ctx.pty`） | `engine/local-transport.ts` | `kind:'local'` | PowerShell/bash 可交互；G-01 |
| M4-2 | telnet adapter（IAC） | `engine/telnet-transport.ts` | `kind:'telnet'` | ECHO/SGA/NAWS/TTYPE 四选项正确，其余回 DONT；G-02 |
| M4-3 | serial adapter（懒加载 + 降级） | `engine/serial-transport.ts` | `kind:'serial'` | 加载失败仅禁用该协议，其余可用；G-04/G-05 |
| M4-4 | 能力位驱动 UI 置灰 | `client/capabilities.ts` | 按 `capabilities` | Telnet 会话隐藏 SFTP/隧道入口且不报错；G-03 |
| M4-5 | 批量下发 | `tools/cluster.ts` | `uniterminal_cluster` | 失败不中断其余，逐台退出码；F-01 |
| M4-6 | 命令片段 | `client/Snippets.tsx` | `{{host}}` 变量 | 点击发送到当前会话；F-02 |
| M4-7 | 登录后自动执行 | `engine/auto-commands.ts` | — | 按序列执行，含最小 `{sleep}`；F-03 |
| M4-8 | 会话日志（文本/HTML） | `engine/session-log.ts` | — | 按会话与日期分文件；F-04 |
| M4-9 | 四协议端到端验收 | — | — | 四协议同 UI 可用；串口缺依赖时其余不受影响 |

---

## 7. 依赖与并行度

```
M0-1 → M0-2 → M0-3 → { M0-4, M0-5 } → M0-6 → M0-7 → M0-8 → M0-9 → M0-10 → M0-11
                                                                    │
M1  ←────────────────────────────────────────────────────────────── ┤（M0-11 之后）
M2  ←── 依赖 M1-1（Profile 存储）与 M0-6（路由）                      │
M3  ←── 依赖 M1-4（known_hosts）、M2-1（凭据）、M0-5（会话）           │
M4  ←── 依赖 M0-3（registry）；M4-1..M4-3 只需 M0，可与 M1 并行       ┘
```

**可并行组**：M1 与 M4-1..M4-3 可同时开工（互不触碰同一文件）；M3 必须等 M2-1；M4-5..M4-8 等 M2-10（工具面）。

---

## 8. 完成判据（Definition of Done，每任务）

1. 新增/修改的测试通过，且**先失败后通过**有记录
2. `pnpm typecheck` 0 错
3. 该任务的 PRD 需求 ID 已在其提交信息里引用（如 `feat: ring buffer (PRD M0-2)`）
4. 若触碰注册面（tools/routes/slots），必须验证"服务缺失时不抛错"
5. 一次 conventional commit，范围明确
