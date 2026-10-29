# UniTerminal · DSH 远程终端插件

[![npm](https://img.shields.io/npm/v/@winking-r/dsh-uniterminal.svg)](https://www.npmjs.com/package/@winking-r/dsh-uniterminal)
[![license](https://img.shields.io/npm/l/@winking-r/dsh-uniterminal.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-WinKing--R%2Fdsh--uniterminal-blue)](https://github.com/WinKing-R/dsh-uniterminal)

SSH / SFTP / 端口转发，挂在 DSH 右侧栏里。**一个侧边栏标签里装多条会话**（顶部会话栏切换；同一台主机连两次显示 `#2`），
每条会话的终端、文件、隧道三视图并列。

## 状态

| 项 | 值 |
|---|---|
| 版本 | `0.2.16`（`0.x`：API 与配置项仍可能变，按语义化版本升号） |
| 许可证 | **MIT**（见 [LICENSE](LICENSE)）——可自由使用、修改、商用，保留版权声明即可 |
| 环境 | DSH `>=0.2.1-rc.2`、Node `>=20` |

**本插件把密码交给操作系统密码箱保管（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），自己不实现任何加密。**
只有「这台机器没有系统密码箱」时才回落到明文文件，并在界面上如实说明——细节见 [docs/SECURITY.md](docs/SECURITY.md)。

```
主机管理 → 连接 → ┌ 终端 (xterm + shell)
                  ├ 文件 (SFTP：浏览 / 上传 / 下载 / 删除)
                  └ 隧道 (-L 本地转发 / -R 远程转发 / -D SOCKS5)
```

## 安装

前提：DSH `>=0.2.1-rc.2`（见本包 `package.json` 的 `dsh.engines`）、Node `>=20`。
从源码装还需要 pnpm；用打好的 `tgz` 安装则**不需要**自己构建。

```bash
# 在 DSH 的 desktop profile 目录下执行
cd ~/.dsh/profiles/desktop

# 方式一：从 npm 安装（推荐，不需要 Node 工具链）
pnpm add @winking-r/dsh-uniterminal

# 方式二：从源码链接（改代码即生效，开发用）
pnpm add "link:<你的本仓库绝对路径>"

# 方式三：从目录安装（用打包好的 tgz）
pnpm add "file:<tgz 的绝对路径>"
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组里追加一行本包名：

```json
"@winking-r/dsh-uniterminal"
```

重启 DSH。若右栏没有自动出现本插件，用右栏的 `+` 手动添加一个 `UniTerminal` 标签。

> **改动代码后必须重启 DSH**：宿主半边（`lib/index.js`）在启动时加载，硬刷新页面不会生效。

### 卸载

```bash
# 先从 dsh.profile.bundles 里删掉本包名，然后
cd ~/.dsh/profiles/desktop
pnpm remove @winking-r/dsh-uniterminal
```

重启 DSH。主机档案与凭据留在 `~/.dsh/uniterminal/`，如需一并清除请见下方「数据存放」。

## 功能

| 域 | 能力 |
|---|---|
| 主机 | 添加 / 编辑 / 删除（二次确认）/ 分组；从 `~/.ssh/config` 导入；连接前「测试」连通性；**孤儿会话可接管或关闭** |
| 认证 | 密码、私钥（读本地路径或粘贴内容）、**两者可同时启用**；按主机「记住密码」；跳板链 `ProxyJump` |
| 终端 | xterm.js，自适应尺寸，断线重连；面板重挂载与**页面刷新**后会话与输出不丢（存档落 `sessionStorage`） |
| 文件 | SFTP 浏览、多选上传（带进度、可取消）、下载、新建目录、删除 |
| 隧道 | `-L` 本地转发、`-R` 远程转发、`-D` SOCKS5；仅监听 `127.0.0.1`；随会话关闭自动回收 |
| **AI 可调用** | 注册两个工具：`uniterminal_list_sessions`（发现会话）与 `uniterminal_exec`（在会话里执行命令并取回 stdout/退出码）。**任何 AI 会话无需额外上下文即可使用**。默认 `mode=exec`（独立通道、不碰用户终端）；`mode=shell` 会把命令与标记打进用户正在看的终端并留在屏幕上，仅用于延续 shell 状态 |

## 配置项（DSH 插件设置）

| 键 | 默认 | 说明 |
|---|---|---|
| `term` | `xterm-256color` | 终端 TERM 类型 |
| `bufferBytes` | 1 MiB（`1048576`） | 每个会话的输出回放缓冲 |
| `connectTimeoutMs` | 20000 | 连接超时（毫秒） |
| `knownHostsPolicy` | `reject` | 未知主机指纹策略：`reject` 拒绝并要求显式信任 / `trust` 自动信任并落盘 |
| `agentExec` | `on` | 面向 AI 会话的 exec 入口：`off` 时既不注册 `uniterminal_exec` 工具，`/sessions/exec` 也一律 403 |
| `appearance` | 内置默认 | 终端外观默认值（字体、字号、行高、字距、主题模式与四个颜色）。用户改过的值存 `~/.dsh/uniterminal/appearance.json`；插件写不了宿主配置，只把这里当默认值来源 |

## 数据存放（`~/.dsh/uniterminal/`）

| 文件 | 内容 | 敏感性 |
|---|---|---|
| `profiles.json` | 主机、分组、认证方式、跳板链。**绝不含密码或私钥内容** | 低 |
| `credentials.json` | 记住的口令与粘贴的私钥（**明文**）——**只在没有系统密码箱的机器上存在** | **高** |
| `security.json` | 凭据登记（`mode: plain` + `storage: keychain\|file`，即"密码存在哪"） | 低 |
| `vault.bin` | **旧版**（已停用）加密凭据文件——不再被读取，可在界面上「清理旧版凭据」删掉 | — |
| `known_hosts.json` | 已信任的主机指纹 | 低 |
| `appearance.json` | 终端外观偏好（字体、字号、行高、主题与颜色），只影响界面 | 低 |
| `diag.log` | 诊断事件（不含任何凭据内容） | 低 |

## 安全

密码存在哪、谁能读到它、怎么清、怎么迁移：**[docs/SECURITY.md](docs/SECURITY.md)**（威胁模型 + 已知限制）。

一句话版：**有系统密码箱就用系统密码箱**（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），
**插件自己不实现任何加密**；没有系统密码箱的机器回落明文文件，界面上会如实说明。

## 已知限制（请先读这一段）

1. **凭据存在哪，取决于这台机器有没有系统密码箱**：
   - **有**（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service）→ 密码交给操作系统保管，插件**不实现任何加密**；旧的明文库会**逐条搬进密码箱，搬完删掉**，不留明文副本。
   - **没有** → 回落明文文件 `credentials.json`，靠 `chmod 0600` 与 Windows 账户目录权限保护；Windows 上 `chmod` 实际无效，真实防护来自 NTFS ACL。**不要在多用户共用的机器上勾选「记住密码」。**
   - **密码箱这一刻用不了**（被锁 / 服务没起）→ 临时改用本机文件，界面会明说；此前存在密码箱里的条目暂时取不到。
   界面表单页常驻小字会说明当前用的是哪一种（详见 [docs/SECURITY.md](docs/SECURITY.md)）。
   **不再提供插件自管的加密档位**：旧版那套「主密码 + 插件自管加密文件」已整体删除，既不提供也不支持。
   本机若还留着旧版凭据文件，界面会提示「清理旧版凭据」。**清理只会丢弃旧格式文件里那份读不出来的数据——明文库里已记住的密码不受影响**；旧档里的那份密码需要重新输入一次。
2. **不提供终端锁屏**（明确不做的决策，不是遗漏）。离开座位时已连接的会话没有保护——需要时请自行锁屏或断开连接。
3. **`-R` 远程转发**已在真实服务器（OpenSSH 9.9，`AllowTcpForwarding yes`）验证通路成立。仍未解决的是：**停止隧道不会立即释放服务端的远端端口**，要等会话关闭（ssh2 不提供 cancel-tcpip-forward）；在此期间到达的连接会被明确拒绝，不会穿透。
4. **跳板链每跳使用同一套凭据**（同一口令或同一私钥）。「跳板机用 A 钥、目标机用 B 钥」尚未支持。
5. **覆盖式上传**优先用 OpenSSH 的 `posix-rename@openssh.com` 做原子替换；服务器不支持时会退化为「先删目标再改名」，存在极短窗口（目标暂时不存在）。
6. ~~没有会话列表 UI：刷新页面会丢失前端会话存档~~ → **已解决（M4-1）**：存档写入 `sessionStorage`，刷新后自动回到终端并重连；列表页会列出「未接管的会话」，可一键接管（无需重新输入密码）或关闭。
7. **SFTP 路径记忆、`-R` 端口即时释放**在待办中。终端锁屏已明确不做。
8. **shell 模式拒绝交互式/全屏程序**（vi/vim/nano/less/top/htop/watch/man/tmux/screen/ssh/su）：它们会占满用户终端、提示符回不来。按分段首词判定，sudo vim、xargs vim 之类仍可绕过——真正的防线是审计日志。若将来需要让 AI 驱动 TUI，主流做法是塞进 detached tmux 会话（send-keys + capture-pane），届时需要在服务器安装 tmux。
9. **AI 命令执行的安全边界**：工具默认开启，但只能操作**你已打开的会话**——AI 无法自行建立连接或提交凭据。每次执行都会写入 `diag.log`（命令预览截断 120 字符并 scrub 口令/私钥）。如不需要，把 `agentExec` 设为 `off`。

## 结构

```
src/
  index.ts           宿主入口：注册路由、装配 store、启动 WS 桥
  routes.ts          HTTP API（全部 exact 路由 + loopback 围栏）
  ws-bridge.ts       终端 WebSocket（每会话一条升级路径，回放 ring buffer）
  config.ts          插件配置 schema
  engine/            协议无关层
    types.ts           SessionHandle / 通道能力接口
    registry.ts        协议注册表（ssh 已实现；telnet/serial 留位）
    ssh-transport.ts   ssh2 适配：认证、跳板链、SFTP 通道缓存、转发通道
    session-manager.ts 会话生命周期、重连、通道能力访问器
    ring-buffer.ts     输出回放缓冲
    sftp.ts            SFTP 能力与三级 rename 策略
    tunnel.ts          -L/-R/-D 隧道管理与回收
  store/             持久化
    profile-store.ts / known-hosts.ts / security.ts / ssh-config-import.ts
  client/            React 半边（预打包进 __ModuleLoader__）
    UniterminalTab.tsx  列表 / 表单 / 三视图切换
    TerminalView.tsx    xterm 封装
    SftpPanel.tsx       文件面板
    TunnelPanel.tsx     隧道面板
```

## API 一览

全部 29 条路径（`src/routes.ts` 的 `UNITERMINAL_ROUTES`）。除最后一行的内部端点外，都是用户可见接口；
所有端点都要求 **loopback 来源**，非回环地址一律 403。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/uniterminal/health` | 健康检查 |
| GET/POST | `/api/uniterminal/profiles` | 主机列表（GET）/ 新增与编辑（POST） |
| DELETE | `/api/uniterminal/profiles/<id>` | 删除主机 |
| POST | `/api/uniterminal/profiles/import` | 导入 ssh_config（预览，不写盘） |
| POST | `/api/uniterminal/profiles/test` | 测试连通性 |
| POST | `/api/uniterminal/profiles/key` · `/profiles/key/delete` | 粘贴私钥 / 清除 |
| POST | `/api/uniterminal/profiles/forget-password` | 取消「记住密码」并删掉那条凭据 |
| POST | `/api/uniterminal/folders` | 新建分组 |
| POST | `/api/uniterminal/folders/rename` | 分组改名 |
| POST | `/api/uniterminal/folders/delete` | 删除分组 |
| GET | `/api/uniterminal/groups` | 分组列表 |
| POST | `/api/uniterminal/groups/color` | 设置分组颜色 |
| POST | `/api/uniterminal/hosts/trust` | 首次连接信任主机指纹（写入 `known_hosts.json`；指纹已变则 409 拒绝） |
| GET/POST | `/api/uniterminal/appearance` | 外观设置：读取（GET）/ 保存增量（POST） |
| GET/POST | `/api/uniterminal/sessions` | 会话列表（GET）/ 建立会话（POST） |
| POST | `/api/uniterminal/sessions/exec` | 执行命令（`mode: exec` 独立通道 / `shell` 打进当前 shell） |
| POST | `/api/uniterminal/sessions/close` | 断开连接 |
| GET/POST | `/api/uniterminal/sftp/download` · `/sftp/upload` | 流式下载 / 上传 |
| POST | `/api/uniterminal/sftp/op` | ls / stat / mkdir / unlink / rmdir / rename / chmod |
| GET/POST | `/api/uniterminal/tunnels` | 隧道列表（GET）/ 启动（POST） |
| POST | `/api/uniterminal/tunnels/stop` | 停止隧道（`-R` 的服务端端口要等会话关闭才释放） |
| GET | `/api/uniterminal/security` | 凭据状态（`mode` 恒为 `plain`，另带 `storage` / `degraded` / `legacy`：密码存在哪、是否临时降级、本机是否还留着旧版文件） |
| GET | `/api/uniterminal/security/refs` | 已记住的条目名（只有名字，没有密钥） |
| POST | `/api/uniterminal/security/clear-legacy` | 清理旧版凭据文件（破坏性动作，body 需 `confirm: true`） |
| WS | `/api/uniterminal/ws/<sessionId>` | 终端数据流 |
| GET/POST | `/api/uniterminal/diag` · `/monitor` · `/sftp/upload-progress` | **内部用**：前端诊断上报、状态栏采样轮询、上传进度轮询。供本插件前端自己用，接口形状不承诺稳定 |

## 开发与验证

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest，915 用例 / 64 文件
pnpm build        # tsdown → lib/index.js (ESM) + lib/client.js (CJS)
```

**915 个用例**覆盖：路由匹配器（复刻宿主 prefix 语义）、凭据库与密码箱降级、profile store 与分组迁移、SFTP 通道复用、隧道 loopback 围栏与回收、跳板链 sock 传递、上传原子提交与中断清理、前端组件的键盘可达性与对比度。

验收记录见 `docs/acceptance-*.md`，决策与踩坑台账见 `docs/superpowers/plans/ledger-m0.md`（含 20 余条裁定与教训）。

## 故障排查

**出问题先看 `~/.dsh/uniterminal/diag.log`**——事件里只有 id、路径、状态与错误文本，不含口令或私钥（写入前 scrub）。
报问题时把**最后 50 行**贴出来，足够定位大多数故障。

```bash
tail -n 50 ~/.dsh/uniterminal/diag.log
```

常见症状：

| 症状 | 先查什么 |
|---|---|
| 插件在右栏不出现 | `dsh.profile.bundles` 里有没有追加本包名；**重启过** DSH 没有（硬刷新不够） |
| 连接报 `unknown host key` | 主机指纹未信任；走一次「首次连接信任主机指纹」流程，或在设置里把 `knownHostsPolicy` 设为 `trust` |
| 提示「系统密码箱不可用」 | 密码箱被锁 / 服务没起；此时新密码会临时写进本机文件，此前存在密码箱里的条目暂时取不到 |
| 状态栏一直空白 | 远端不是 Linux（解析器按 `/proc` 取值），或该会话已断开 |

## 设计取舍（供后续维护参考）

- **认证方式以界面为准**：请求里带 `auth` 就覆盖磁盘存档；未表态时才用存档默认值。明确表态（只选私钥）失败就报错，绝不静默降级用密码。
- **能力访问器，不暴露会话句柄**：`SessionManager` 只暴露 `openSftp(id)` / `openTunnels(id)`，路由层拿不到会话控制面。
- **SFTP 每连接一个通道**（缓存 Promise + 失效重建）；隧道通道与真实 TCP 连接 1:1。
- **上传原子化**：写临时文件 → 成功才改名；中断或失败清理临时文件。
- **诊断日志不含凭据**：`diag.log` 只记 id / 路径 / 错误文本，口令与私钥在写入前 scrub。

## 许可证

[MIT](LICENSE) © 2026 WinKing-R

可以自由使用、修改、分发、商用，保留版权与许可声明即可。**软件按「原样」提供，不附任何担保**——
这个插件会连 SSH、执行命令、读写远端文件，请自行承担使用风险。
