# UniTerminal M1 实施计划（会话与资产）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 - [ ] 跟踪。

**Goal:** 让主机成为资产：持久化、可分组、可从 ~/.ssh/config 导入、连接前校验主机指纹、断线能自动重连；同时清掉 M0 的三项技术债。

**Architecture:** 新增 src/store/*（纯 Node，可单测）承载持久化与校验；SessionManager 增加 onOpened/onClosed 钩子（替代 ws-bridge 的猴补）；ws-bridge 在会话关闭时释放该会话的升级路由；UI 增加主机列表视图。

**Spec:** docs/PRD.md 域 A（会话管理）、域 H-01（known_hosts）；任务书 M1-1~M1-8。

## Global Constraints（同 M0，逐条适用）

- 全部对外标识走 uniterminal 命名空间；所有注册包 try/catch；apply 永不抛错
- 公共接口禁用 any；ESM，相对导入带 .js；verbatimModuleSyntax 已开
- **密码/口令不得进入**：profiles.json、日志、审计、错误消息。M1 的持久化只存非敏感字段
- 配置目录 ~/.dsh/uniterminal/；所有写盘必须原子（临时文件 + rename）
- 每个任务先写失败测试；UI 任务（M1-8）由人工验收覆盖
- 每任务一次 conventional commit，引用任务 ID

## 文件结构（M1 新增/改动）

```
src/store/profile-store.ts      # profiles.json 原子读写 + schema 校验 + 分组查询
src/store/ssh-config-import.ts  # ~/.ssh/config 解析
src/store/known-hosts.ts        # 指纹存储与校验（SHA256）
src/engine/session-manager.ts   # 增 onOpened/onClosed/autoReconnect
src/ws-bridge.ts                # 去猴补；会话关闭释放路由
src/client/HostListView.tsx     # 主机列表 + 分组树 + 导入按钮
src/client/UniterminalTab.tsx   # 先显示列表，选中主机后进终端
```

---

### Task M1-1: Profile 持久化

**Files:** Create src/store/profile-store.ts, test/store/profile-store.test.ts

**Interfaces（后续任务依赖，不要改名）**

- interface StoredProfile { id: string; name: string; kind: ProtocolKind; groupPath: string[]; host?: string; port?: number; user?: string; keepaliveMs?: number; connectTimeoutMs?: number; tags?: string[]; createdAt: number; updatedAt: number }
- class ProfileStore { constructor(file: string); load(): Promise<void>; list(): StoredProfile[]; get(id: string): StoredProfile | undefined; upsert(p: StoredProfile): Promise<void>; remove(id: string): Promise<void>; groups(): string[][] }
- 文件格式：{ version: 1, profiles: StoredProfile[] }

- [ ] **Step 1 失败测试**（5 例）
  - 文件不存在 → list() 返回空数组
  - upsert 后 get 能取回；createdAt 首次写入、updatedAt 每次更新
  - 同一 id upsert 两次不产生重复
  - 写入是原子替换：实现必须 writeFile(tmp) 再 rename，测试用 spy 断言 rename 被调用
  - 非法内容（version 不是 1，或 profiles 非数组）→ load() 抛错，错误信息含 profiles.json，**不得静默清空**
- [ ] **Step 2 跑测试确认失败**
- [ ] **Step 3 实现**：readFile + JSON.parse + 校验；写入用临时文件 + rename；目录用 mkdir recursive
- [ ] **Step 4 跑测试确认通过**
- [ ] **Step 5 提交** feat: profile store with atomic persistence (M1-1)

### Task M1-2: 分组树查询

**Files:** Modify src/store/profile-store.ts；Test test/store/profile-store.test.ts（追加）

**Interfaces:** groups(): string[][] 返回去重后的分组路径集合（按字典序）。分组**只由 groupPath 派生**，不建独立表。

- [ ] Step 1 追加测试：3 个 profile（空路径、生产/华东、生产/华北）→ groups() 含 生产 与 生产/华东
- [ ] Step 2 确认失败 → Step 3 实现（遍历拼接前缀）→ Step 4 通过
- [ ] Step 5 提交 feat: derive group tree from profile paths (M1-2)

### Task M1-3: ssh_config 导入

**Files:** Create src/store/ssh-config-import.ts, test/store/ssh-config-import.test.ts

**Interfaces**

- interface ImportedHost { alias: string; host?: string; port?: number; user?: string; identityFile?: string; proxyJump?: string; localForwards: { bindPort: number; destHost: string; destPort: number }[] }
- interface ImportResult { hosts: ImportedHost[]; skipped: { alias: string; reason: string }[]; directives: string[] }
- parseSshConfig(text: string): ImportResult

规则：只解析 Host / HostName / User / Port / IdentityFile / ProxyJump / LocalForward；Host 含 * 或 ? 直接跳过（reason wildcard）；未知指令收集到 directives（去重）；Include 不递归，记入 skipped（reason include-unsupported）；Match 之后整体忽略并记 reason match-unsupported。

- [ ] Step 1 测试（5 例）：基本解析；多 Host 行共享配置；通配符跳过；未知指令进 directives；Match 之后被忽略
- [ ] Step 2 确认失败 → Step 3 实现（逐行、key value 或 key=value 均可、值去引号）→ Step 4 通过
- [ ] Step 5 提交 feat: ssh_config import parser (M1-3)

### Task M1-4: known_hosts 指纹校验

**Files:** Create src/store/known-hosts.ts, test/store/known-hosts.test.ts；Modify src/engine/ssh-transport.ts

**Interfaces**

- interface KnownHostEntry { host: string; port: number; fingerprint: string; addedAt: number }
- class KnownHosts { constructor(file: string); load(): Promise<void>; check(host, port, fingerprint): match | unknown | mismatch; trust(host, port, fingerprint): Promise<void> }
- 指纹形态：SHA256:base64（ssh2 的 hostVerifier + hostHash sha256 给出的形态）

ssh-transport 的 connect 增加 hostHash sha256 与 hostVerifier：unknown 时按策略（默认拒绝）抛 Error 含 uniterminal: unknown host key；mismatch 抛 Error 含 uniterminal: host key changed；match 放行。策略可注入 { onUnknown: reject | trust } 供测试与 UI 覆盖。

- [ ] Step 1 测试（4 例）：unknown → reject；trust 后 match；指纹变化 → mismatch；onUnknown 为 trust 时自动写入
- [ ] Step 2 确认失败 → Step 3 实现 → Step 4 通过
- [ ] Step 5 提交 feat: known_hosts fingerprint verification (M1-4)

### Task M1-5: 会话钩子与断线重连

**Files:** Modify src/engine/session-manager.ts, test/engine/session-manager.test.ts

**Interfaces**

- SessionManager 新增 onOpened(cb): () => void 与 onClosed(cb): () => void（供 ws-bridge 使用，替代猴补）
- 新增选项 autoReconnect?: { delaysMs: number[] }，默认 [1000,2000,4000,8000,16000]
- 会话条目新增 reconnectAttempts: number

行为：handle.onClose 触发且非用户主动 close() → 按 delaysMs 退避重连，最多 delaysMs.length 次；重连成功后向订阅者推送一段 UTF-8 提示，内容为 换行 + [uniterminal] reconnected + 换行；达到上限后状态置 closed 并触发 onClosed。用户 close() 不触发重连。

- [ ] Step 1 测试（4 例）：onOpened 收到 id；onClosed 在 close 后触发；模拟掉线 → 用 vi.useFakeTimers 断言两次退避后达上限并触发 onClosed；用户 close 不重连
- [ ] Step 2 确认失败 → Step 3 实现（重连重建 handle 并重新订阅，**保持同一 session id**）→ Step 4 通过
- [ ] Step 5 提交 feat: session hooks and backoff reconnect (M1-5)

### Task M1-6: 释放每会话升级路由（D-1 / D-2）

**Files:** Modify src/ws-bridge.ts, test/ws-bridge.test.ts

改用 manager.onOpened / onClosed，删除对 manager.open 的赋值；会话关闭时调用该会话的 disposer 并从 claimed 移除。新增测试：打开→关闭→该路径不在 registerUpgrade 的路径集合中；再次打开不因重复键抛错。

- [ ] Step 1 追加测试 → Step 2 确认失败 → Step 3 实现 → Step 4 通过 → Step 5 提交 refactor: release per-session upgrade routes via hooks (M1-6)

### Task M1-7: IPv6 与自定义端口回归锁

**Files:** Modify src/engine/ssh-transport.ts；Test test/engine/ssh-transport.test.ts（追加）

- [ ] Step 1 测试：host 为 2001:db8::1 时 config.host 原样（不加方括号）；port 2222 原样；未给 port 时默认 22
- [ ] Step 2 确认失败（若已满足则记录为回归锁）→ Step 3 实现/确认 → Step 4 通过 → Step 5 提交 test: lock ipv6 and custom port passthrough (M1-7)

### Task M1-8: 主机列表 UI 与 profiles 路由

**Files:** Create src/client/HostListView.tsx；Modify src/client/UniterminalTab.tsx、src/routes.ts

**人工验收**（不写单测，属既有例外）：重启后右栏 + 打开 UniTerminal 先看到主机列表；空态给出「从 ~/.ssh/config 导入」按钮；导入后出现按分组缩进的条目；点条目进入终端表单并预填主机/用户/端口。

- [ ] Step 0 **接线 knownHosts（硬性）**：在 apply 里构造 KnownHosts(~/.dsh/uniterminal/known_hosts.json) 并 load()，把 { knownHosts, onUnknownHostKey } 传进 createSshTransport。
      M1-4 的 hostVerifier 只有在注入 knownHosts 时才启用；不接这一步，known_hosts 就是死代码。验收必须证明「连接未知主机被拒绝」在真实宿主里成立。
- [ ] Step 1 路由：GET /profiles 返回 profiles 与 groups；POST /profiles/import 读 ~/.ssh/config 并 upsert；DELETE /profiles/:id
- [ ] Step 2 UI 实现 → Step 3 pnpm build 通过 → Step 4 提交 feat: host list with ssh_config import (M1-8)

### Task M1-9: 修复脆弱测试（D-3）

**Files:** Modify test/index.test.ts

- [ ] Step 1 把单 tick setTimeout(0) 改为 await vi.waitFor 断言
- [ ] Step 2 pnpm test 连跑 5 次全绿 → Step 3 提交 test: replace tick-wait with vi.waitFor (M1-9)

---

## 完成判据

1. 每个 M1 任务都有 FAIL→PASS 记录
2. pnpm typecheck 为 0；pnpm test 全绿且连跑 5 次稳定
3. pnpm build 产出两包；profiles.json 与 known_hosts 均在原子写入下生成
4. 真实宿主里：能持久化主机、能从 ssh_config 导入、能在指纹变化时明确阻断