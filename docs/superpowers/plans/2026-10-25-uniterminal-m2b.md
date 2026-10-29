# UniTerminal M2b 实施计划（私钥 / 证书登录）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 支持用私钥登录（含带口令的私钥），两种入口：宿主读本地路径（首选）、粘贴私钥内容（备选）。

**用户决策**：私钥入口 = 「宿主读本地路径 + 也可粘贴内容」；与 M2a 分批，此为第二批。

## 安全边界（不可协商）

1. **私钥内容永不进 `profiles.json`**。路径方式只存 `identityPath` 字符串；粘贴方式只存进 `credentials.json`（ref = `key:<profileId>`），与口令同库同保护级别。
2. **私钥内容永不进入任何 HTTP 响应、diag 日志、错误消息**。错误里只能出现路径或「private key rejected」这类类别信息。
3. **路径方式不在插件目录留副本**：连接时按需 `readFile`，不落盘、不缓存到 profiles.json。

## 数据模型

```ts
// profiles.json 里每条 profile 新增（非敏感）
interface ProfileAuth {
  kind: 'password' | 'key';            // 'agent' 留待 M2c
  identityPath?: string;               // 路径方式：仅存路径
}
// ResolvedProfile（内存态，不进磁盘）新增
privateKey?: string;                   // 私钥内容（PEM/OpenSSH），仅内存
passphrase?: string;                   // 私钥口令，仅内存
```

## Task M2b-1：后端与传输层

**Files:** Modify src/engine/types.ts、src/engine/ssh-transport.ts、src/store/profile-store.ts、src/routes.ts、test/engine/ssh-transport.test.ts、test/store/profile-store.test.ts、test/routes.test.ts

**接口**
- `ResolvedProfile` 增加 `privateKey?: string`、`passphrase?: string`（**仅内存**）
- `ssh-transport` 的 connect 配置透传 `privateKey` 与 `passphrase`（有才传）
- `StoredProfile` 增加 `auth?: { kind: 'password' | 'key'; identityPath?: string }`；解析校验：kind 必须是两者之一，identityPath 若存在必须是非空字符串

**会话创建时的认证解析（优先级固定）**
1. `auth.kind === 'key'`：
   - `identityPath` 存在 → `await readFile(path,'utf8')`；读失败（ENOENT/EACCES）→ **400**，错误含 `uniterminal: identity file is not readable` 与路径
   - 否则若凭据库有 `key:<id>` → 用其内容
   - 两者都无 → **400**，错误含 `uniterminal: no private key configured`
   - `passphrase` 从凭据库 `key-passphrase:<id>` 取（可选）
   - **此分支不需要密码**（R-17：必须在此放行，否则私钥登录被「password required」挡住）
2. `auth.kind === 'password'` 或未设置 → 走 M2a-3 既有逻辑（不变）

**新增路由（全部 exact）**
- `POST /api/uniterminal/profiles/key`　body `{ profileId, privateKey, passphrase? }` → 写入 `key:<profileId>` 与可选 `key-passphrase:<profileId>`，返回 `{ ok: true }`；**响应不得回显任何密钥内容**
- `POST /api/uniterminal/profiles/key/delete`　body `{ profileId }` → 删除两条 ref，返回 `{ ok, removed }`

## Task M2b-2：UI

- 主机表单增加「认证方式」选择：`密码` / `私钥`
- 选「私钥」时显示：`私钥文件路径`（输入框，预填 ssh_config 导入的 identityFile）+ 或「粘贴私钥内容」按钮 + `私钥口令（可选）`
- 路径方式：`POST /profiles` 写 `auth:{kind:'key', identityPath}`；粘贴方式：先 upsert profile 再 `POST /profiles/key`
- 已配置私钥的主机在列表显示「私钥」标记，与「已记住」并列
- 错误文案：`identity file is not readable` → 「私钥文件读不到，请检查路径」；`no private key configured` → 「尚未配置私钥」

## 验收判据（M2b-3 真实宿主）

1. 用路径方式配置一台用私钥登录的主机 → 密码框留空也能连上
2. 私钥带口令时能正确解锁
3. `profiles.json` 里只有路径、**无任何密钥内容**（grep 证明）
4. diag 与 HTTP 响应中无密钥内容（用含私钥的临时文件验证）
5. 路径错误时给出可操作提示，不是 500