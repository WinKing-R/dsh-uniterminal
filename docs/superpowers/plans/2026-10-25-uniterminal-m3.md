# UniTerminal M3 实施计划（文件传输 + 端口转发/隧道）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 补齐 PRD 域 D（SFTP）与域 E（-L/-R/-D 转发、跳板链）。

## 架构决策（先定，避免后续返工）

1. **SFTP 复用已有 SSH 连接**，不为文件传输再开一条连接。
   做法：`SessionHandle` 增加可选 `openSftp?(): Promise<SftpLike>`，ssh2 适配器用 `client.sftp()` 实现。
   理由：① 避免二次认证（私钥/口令只解一次）② 避免服务器连接数配额浪费 ③ 与终端共享同一 known_hosts 校验结果。
2. **路由用「单一 exact + 操作分发」**，不为每个文件操作单开路由：`POST /api/uniterminal/sftp/op { sessionId, op, ... }`。传输另用流式端点（大文件不能 base64）：
   - `GET  /api/uniterminal/sftp/download?sessionId=&path=`（响应流）
   - `POST /api/uniterminal/sftp/upload?sessionId=&path=`（请求流）
3. **隧道同样单一 exact + 操作**：`POST /api/uniterminal/tunnels`（start）与 `POST /api/uniterminal/tunnels/stop`，外加 `GET /api/uniterminal/tunnels`。
4. 所有新端点：loopback 围栏 + JSON 错误体 + 断言经 `matchRoute`；**必须有「生产装配下不返回 503」的运行时断言**（接线检查项）。

## Task M3-1：SFTP 后端

**Files:** Modify src/engine/types.ts、src/engine/ssh-transport.ts、src/routes.ts、src/index.ts；Create src/engine/sftp.ts、test/engine/sftp.test.ts；Modify test/routes.test.ts

**接口**
- `SessionHandle` 增可选 `openSftp?(): Promise<SftpLike>`
- `interface SftpLike { list(path): Promise<SftpEntry[]>; stat(path): Promise<SftpStat>; mkdir(path): Promise<void>; unlink(path): Promise<void>; rmdir(path): Promise<void>; rename(from,to): Promise<void>; chmod(path, mode): Promise<void>; createReadStream(path): NodeJS.ReadableStream; createWriteStream(path): NodeJS.WritableStream }`
- `interface SftpEntry { name: string; path: string; type: 'file'|'dir'|'symlink'|'other'; size: number; mtime: number; mode: number }`
- ssh2 实现：`client.sftp()` 后包一层，`readdir` 映射成 `SftpEntry[]`（`longname` 不解析，用 `attrs`），流用 ssh2 的 `createReadStream/createWriteStream`

**行为要求**
- 会话不存在 → 404；会话不支持 SFTP（非 ssh）→ 400 且文案说明；SFTP 子系统打开失败 → 500 且带 ssh2 原文
- `path` 必须非空字符串；拒绝未以 `/` 开头的相对路径（400，文案「路径必须是绝对路径」）
- 超出会话权限的错误原样返回（ENOENT / EACCES），不吞

## Task M3-2：隧道后端（-L / -R / -D）

**Files:** Create src/engine/tunnel.ts、test/engine/tunnel.test.ts；Modify src/routes.ts、src/index.ts、test/routes.test.ts

- `-L`：本地 `net.createServer` 监听 127.0.0.1:bindPort，每个连接调 `client.forwardOut('127.0.0.1', bindPort, destHost, destPort)` 打通
- `-R`：`client.forwardIn(destHost, destPort)` + `tcpip` 事件 → 本地连 destHost:destPort 后 pipe
- `-D`：内置最小 SOCKS5 服务端（只支持 CONNECT，无认证），每个请求走 forwardOut
- 隧道表：`{ id, sessionId, mode, bindHost, bindPort, destHost, destPort, state, bytesIn, bytesOut }`；会话关闭时**自动回收**其派生隧道
- 端口占用 → 400 且建议替代端口；`forwardIn` 被服务端拒绝（AllowTcpForwarding no）→ 400 且给出可读原因

## Task M3-3：跳板链（ProxyJump）

- 用 `forwardOut('127.0.0.1', 0, jumpHost, jumpPort)` 得到 stream 作下一跳 `sock`，逐跳串接后再建目标连接
- 支持 ≥3 跳；单跳失败要能定位到具体跳点（错误信息含第几跳与主机）

## Task M3-4：UI（SFTP 面板 + 隧道面板）

- 终端页顶部加两个切换：`终端` / `文件` / `隧道`
- 文件面板：目录树懒加载、双击进目录、上传（拖入）、下载、新建目录、删除（二次确认）、chmod 九宫格、显示传输进度
- 隧道面板：列表（模式/本地端口/目标/状态/流量）、新建（-L/-R/-D 表单）、启停
- 所有响应 `parseJsonSafe`；大文件传输不得把内容读进内存

## 完成判据

1. 每任务 FAIL→PASS；typecheck/test/build 全 0
2. **真实宿主验收**：能列目录、能上传下载一个 >10MB 文件、能开一条 -L 隧道并用本地端口访问目标服务、-R 与 -D 各跑通一次
3. 会话关闭后其隧道自动消失（`GET /tunnels` 不含）
4. 新端点在生产装配下不返回 503（接线断言）