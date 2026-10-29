# UniTerminal M2c 实施计划（参考他家设计后采纳的两项）

**来源**：用户提供 `@linxin666/dsh-ssh` 的主机面板截图（8 列表格 + 测试/编辑/删除/连接 + 搜索 + 分组筛选）。

## 采纳决策（已与用户确认）

| 项 | 采纳 | 理由 |
|---|---|---|
| 编辑主机 | ✅ | 现状改一台主机只能删了重建，是真缺陷 |
| 测试连接 | ✅ | 现在只能「连一下看看」，失败要回列表重来 |
| 搜索 + 分组筛选 | ❌ | 用户未选；主机数还少 |
| 备注字段 | ❌ | 用户未选 |
| 环境 / 标签 三列 | ❌ | 与 `groupPath` 语义重叠，双维度只会让用户纠结 |
| 表格式 8 列布局 | ❌ | **我们是右栏（窄）**，8 列不可读；他家是左侧宽面板 |
| 顶部 tab（主机/终端/传输/隧道/集群） | ❌ | 与 DSH「每会话一右栏 tab」范式冲突 |

## Task M2c-1：编辑主机

**Files:** Modify src/client/HostListView.tsx（若需可加 src/client/HostForm.tsx）

- 主机行增加「编辑」按钮 → 打开与「添加主机」同一个内联表单，但预填现有值，标题为「编辑 <name>」
- 保存走 `POST /api/uniterminal/profiles`（同一 upsert，带原 `id`）
- **必须回传原有字段**：`auth`、`remember`、`createdAt` 等。`ProfileStore.upsert` 是整条替换，漏字段会被静默清空（这是 M2a-3 踩过的坑）
- 校验与「添加」一致（名称/主机非空、端口 1..65535）

## Task M2c-2：测试连接

**Files:** Modify src/routes.ts、src/client/HostListView.tsx、test/routes.test.ts

- 新增 exact 路由 `POST /api/uniterminal/profiles/test`，body `{ id }`
- 语义：按该 profile 解析认证（与 `/sessions` 同一套 `resolveAuth`），**直接 `registry.require(kind).open()` 建立临时连接**，拿到结果后立即 `close()`；**不创建受管会话**（不入 manager、不占 ring buffer）
- 返回：成功 `{ ok:true, ms }`；失败 `{ ok:false, error, ms }`（错误原文照给，便于诊断）；未找到 profile → 404；非回环 403；无 deps 503
- 超时：用 `profile.connectTimeoutMs ?? 15000`
- **不得**在响应或 diag 中出现任何密钥/口令内容
- UI：主机行「测试」按钮 → 行内显示「连通 ✓ 123 ms」或错误原文；请求中禁用按钮

## 完成判据

1. routes 新增用例 ≥5：成功 200 `{ok:true,ms}` 且 manager 未新增会话；认证失败返回 `{ok:false,error}`；未知 id 404；非回环 403；无 deps 503；断言经 matchRoute
2. 编辑保存后 `profiles.json` 中 `auth`/`remember` 未被清空（有测试或用例级断言）
3. typecheck/test/build 全 0；产物含「编辑」「测试」文案
4. 真实宿主验收：改名后列表立即更新；测试一台可达主机显示耗时；测试一台不可达主机显示错误原文