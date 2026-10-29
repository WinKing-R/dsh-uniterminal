# UniTerminal M2a 实施计划（凭据保险库 + 记住密码）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 让用户不必每次输密码：首次启动二选一（设主密码 → 加密库 / 不设 → 0600 明文），每条连接可「记住密码」，密码框支持显示/隐藏。

**Spec:** docs/PRD.md 域 B（B-00~B-06、B-10~B-12）；D8 双档、D10 每连接开关。

## 与 PRD 的一处偏离（已裁决）

PRD D8 原写「简单档存宿主 `.credentials.yaml`」。实际该文件是 `dsh-credentials-local` 的私有格式（refs/records/kind/payload 严格校验），写入有损坏宿主凭据库的风险。
**改为**：简单档写插件自己的 `~/.dsh/uniterminal/credentials.json`，强制 0600，非本人可读时拒写；UI 明示「明文存储」。

## 文件与存储

```
~/.dsh/uniterminal/security.json     { version: 1, mode: 'protected' | 'plain' }
~/.dsh/uniterminal/vault.bin         { version, kdf:{name:'scrypt',N,r,p,saltB64}, ivB64, tagB64, ciphertextB64 }
~/.dsh/uniterminal/credentials.json  { version: 1, entries: { [ref]: secret } }   # 仅简单档，0600
```

## Task M2a-1: 安全存储与双档 provider

**Files:** Create src/store/security.ts, test/store/security.test.ts

**Interfaces（后续任务依赖，不要改名）**

- `type SecurityMode = 'protected' | 'plain'`
- `interface SecurityState { mode: SecurityMode | null; locked: boolean }`
- `class SecurityStore {`
    `constructor(dir: string);`
    `load(): Promise<void>;`
    `state(): SecurityState;`
    `setup(mode: SecurityMode, masterPassword?: string): Promise<void>;`   // 已 setup 过则抛错
    `unlock(masterPassword: string): Promise<boolean>;`
    `lock(): void;`
    `put(ref: string, secret: string): Promise<void>;`
    `get(ref: string): Promise<string | undefined>;`
    `remove(ref: string): Promise<void>;`
    `listRefs(): string[];`
  `}`

**关键要求**
1. 严格档：`scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1 })`；`aes-256-gcm`；每次写入重新随机 iv；校验 tag 失败 → 抛 `uniterminal: master password is wrong`（不得静默返回空）
2. 严格档未解锁时 `put/get` 抛 `uniterminal: vault is locked`
3. 简单档：写入前 `mkdir` + 写临时文件后 `chmod 0600` + rename；**读取时若文件权限允许非本人可读 → 拒绝加载并抛错**（与 dsh-credentials-local 同策略）
4. 主密码错误计数：连续 5 次失败后指数退避（每次失败后等待 2^n ms，上限 30s，仅内存计数）
5. 所有写盘原子（临时文件 + rename）；损坏文件抛错且不清空

- [ ] Step 1 测试（≥8 例）：setup 两种模式；重复 setup 抛错；严格档 roundtrip；错密码抛错且计数递增；未解锁读写抛错；简单档 roundtrip 且文件权限 0600；权限过宽时拒绝加载（用 chmod 0644 断言）；损坏 vault 抛错不清空
- [ ] Step 2 确认 RED → Step 3 实现 → Step 4 GREEN → Step 5 提交 feat: dual-mode credential vault (M2a-1)

## Task M2a-2: security 路由

**Files:** Modify src/routes.ts, test/routes.test.ts

- `GET /api/uniterminal/security` → `{ mode, locked }`
- `POST /api/uniterminal/security/setup` `{ mode, masterPassword? }`（protected 时密码至少 8 位）→ 200；重复 setup → 409
- `POST /api/uniterminal/security/unlock` `{ masterPassword }` → 200 `{ ok }`；错误 → 401 JSON
- `POST /api/uniterminal/security/lock` → 200
- 全部 exact 路由；loopback 围栏；所有响应 JSON；断言经 matchRoute 分派

## Task M2a-3: 记住密码（D10）

**Files:** Modify src/store/profile-store.ts（加 `remember?: boolean`）、src/routes.ts（会话创建时取密码）、test/*

- 会话创建请求若不带 `password`，且 profile 有 `remember: true` 且保险库可解 → 从 `profile:<id>` 取密码；取不到则 400 明确提示「需要密码或先解锁保险库」
- 请求带 `password` 且 profile `remember: true` 且保险库可写 → 连接成功后 `put('profile:'+id, password)`
- **密码永不写入 profiles.json**；`StoredProfile` 只多一个布尔 `remember`

## Task M2a-4: UI（密码可见性 + 记住密码 + 保险库引导）

**Files:** Modify src/client/UniterminalTab.tsx、src/client/HostListView.tsx（显示是否已记住）

- 密码框右侧加眼睛按钮，切换 `type=password/text`；按钮 `aria-label` 明确
- 密码框下加「记住密码」复选框（默认勾选，但简单档下额外提示「将以明文保存在本机」）
- 首次进入若无 security 状态 → 顶部引导条：二选一（设主密码 / 不设），两档说明等长、无诱导
- 严格档未解锁时，连接前先要求解锁（输入主密码）

## Task M2a-5: 真实宿主验收（人工）

1. 首次进入出现二选一引导；选「不设主密码」→ 明文模式，UI 有明文提示
2. 连接主机时勾「记住密码」并输入密码 → 成功；断开后重新连接**无需再输密码**
3. 密码框眼睛按钮可切换明文/密文
4. `profiles.json` 中**不含**任何密码字段；`credentials.json` 权限为 0600
5. 重设为「设主密码」模式 → 连接前要求解锁，错误密码被拒

## 完成判据

1. 每个任务 FAIL→PASS 记录；2. typecheck/test/build 全 0，连跑 5 次稳定；3. 真实宿主五条验收通过；4. `profiles.json` 零口令字段（grep 证明）