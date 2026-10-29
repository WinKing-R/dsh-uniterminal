# UniTerminal 前端优化基线

> 只读分析产物（未修改任何产品代码）。生成于 2026-10-28，代码基线 `v0.2.16`（HEAD `47949e0`）。
> 用途：后续「设计 + 逻辑 + 语言」三层优化的唯一入口文档。先读 §5（不可推翻的约束）与 §6（改动风险），再动代码。
> 配套：`impeccable` skill。本项目 **无 PRODUCT.md / DESIGN.md** → 现有代码即视觉权威，窄范围打磨可直接做；重做视觉世界需先 init。

---

## 1. 项目与架构速览

**UniTerminal · DSH 远程终端插件**（`@winking-r/dsh-uniterminal` v0.2.16）——挂在 DSH Web GUI 右侧栏的 cordis 插件，做 SSH / SFTP / 端口转发。

```
src/          宿主半边  ~9.9k 行   routes.ts(2622) / ws-bridge(321) / engine(ssh-transport 732, tunnel 683, sftp 255, session-manager 320) / store(profile-store 673, security 420, appearance 323)
src/client/   React 前端 ~5.9k 行   UniterminalTab 1715 / HostListView 1368 / tab.module.css 730 / SftpPanel 927 / tab-state 534 / AppearancePanel 458 / TunnelPanel 433 / TerminalView 254 / right-pane 240
test/         13.8k 行 51 文件 704 用例（pnpm test 3.18s 全绿；pnpm typecheck exit 0）
docs/         PRD(412) + 4 份 acceptance + superpowers/plans/ledger-m0.md(3364 行决策台账)
```

**前端链路**：`src/client/index.ts` → `apply(ctx)` 注册右栏 tab 类型（`UniterminalTab`）→ 注入 `tab.module.css` + xterm.css → 面板级单存档 `tab-state.ts`（模块级 + sessionStorage 双写）。
**三视图**：终端（xterm，**只隐藏不卸载**）/ 文件（SFTP，首次点进才挂载）/ 隧道（同上）。
**会话栏**：标签**内自绘**（原生右栏丢弃 seed 载荷，见 §5-B9）。

---

## 2. 前端模块地图

| 文件 | 行数 | 职责 | 测试保护 |
|---|---|---|---|
| `UniterminalTab.tsx` | 1715 | tab 根：会话栏、连接/编辑浮层、notice、倒计时、外观/隧道面板挂载 | 11 个测试文件、40+ 用例（**最大风险源**） |
| `HostListView.tsx` | 1368 | 主机列表、分组树、搜索、连接/编辑表单、导入预览 | 10 个测试文件 |
| `tab.module.css` | 730 | **唯一**样式文件（全局非哈希类名） | 9 个测试文件，正则锁死（顺序敏感） |
| `SftpPanel.tsx` | 927 | SFTP 浏览/上传/下载/删除 | 5 用例真 import + 2 源码断言 |
| `tab-state.ts` | 534 | 会话集不可变模型 + 存储归档 + 认领保险 | 68 用例真 import（保护最好） |
| `AppearancePanel.tsx` | 458 | 字体/字号/行高/字距/主题/四色 | **零** |
| `TunnelPanel.tsx` | 433 | -L/-R/-D 隧道 | **零** |
| `TerminalView.tsx` | 254 | xterm 封装、主题、WS 收发 | 1 条源码正则 |
| `right-pane.ts` | 240 | 右栏注册表探测、tab id、档案脱敏 | 25 用例真 import |
| `StatusBar.tsx` | 114 | 1 秒串行轮询监控指标 | 1 条源码正则 |
| `select-field.tsx` | 125 | 自绘下拉（键盘/aria 完整） | 3 源码断言 |
| `confirm-dialog.tsx` | 83 | 确认弹框（不测量、贴面板零坐标） | 4 源码断言 |
| `context-menu.tsx` | 71 | 右键菜单 | 1 源码断言 |
| `inject-css.ts` / `report.ts` / `tab-icon.tsx` / `use-connect-countdown.ts` | 25/15/28/26 | 注入去重 / 错误上报 / 图标 / 倒计时 hook | **零** |

---

## 3. 视觉与数值体系审计（实测）

### 3.1 没有 token 层
自定义 CSS 变量**只有 1 个**：`--ut-border`（`tab.module.css:9-10`）。其余颜色靠宿主 `--dsw-alias-*` 变量 + **硬编码 fallback**：

| 语义色 | 硬编码处数 | 落点 |
|---|---|---|
| 危险 `#e5534b` | **11** | CSS 4（全是 `var(--dsw-alias-label-error, #e5534b)` 的 fallback）+ TSX 7（`HostListView.tsx:113`、`SftpPanel.tsx:12` 各定义一份常量） |
| 成功 `#3fb950` | 4 | CSS 1 + TSX 3 |
| 警告 `#d9a536` | 2 | TSX |
| 中性灰 `rgba(128,128,128,α)` | **7 个不同 α**（0.08/0.16/0.18/0.28/0.34/0.35/0.6） | CSS 硬编码 |
| 遮罩黑 `rgba(0,0,0,α)` | **5 个不同 α**（0.12/0.32/0.35/0.38/0.42） | CSS 硬编码 |
| 分组色兜底 `#d6dde4` / 钥匙古铜 `#b87333` | 3 / 1 | TSX |

→ **同一个语义色在不同文件里各写一遍**，共 4 份定义。

### 3.2 数值阶梯不成立
- **字号只有 4 档**：12 / 13 / 14 / 15px（CSS 16 处 + TSX 内联 44 处）。台账定的「三级阶梯 = 按钮 13 / 正文·标签·输入 14 / 分组标题 **16**」—— **16px 从未落地**：`.uniterminal-group-title`（`tab.module.css:412-420`）**没有 font-size**，继承 label 的 13px。
- **圆角 7 种**：4 / 5 / 6 / 8 / 10 / 12 / 999px。
- **间距两套并存**：padding {2,3,4,5,8,12,14,16}、gap {2,4,6,8,10}。
- **字重 4 档**：400 / 500 / 600 / 650。

### 3.3 注释与代码已经漂移（"注释是失效的说明书"）
- `tab.module.css:96-100` 写「11px 仍偏大，收到 **10px**」，代码是 `font-size: 13px`；`:141-143` 写「字号统一 **10px**」，代码也是 13px。
- `:224-225` 写「名称定宽（**20ch**），与 HOST_NAME_MAX=20 对应」，代码是 `width: 16ch`；`:245` 又补一句「16ch：与 HOST_NAME_MAX=16 对应」—— 同文件内两种说法。
- `:409-412` 分组标题「与 NAME_MAX=16 对齐」—— 这条与代码一致。

### 3.4 两套样式系统混用（最容易复发的老坑）
- TSX 里 **180 处** `style={{ }}`（SftpPanel 52 / UniterminalTab 50 / HostListView 33 / TunnelPanel 29 / AppearancePanel 12 / StatusBar 2 / confirm-dialog 1 / context-menu 1）vs **97 处** `className=`。
- 内联 `fontSize` 44 处、`borderRadius` 10 处、`padding` 30+ 处 → **内联永远盖过 CSS**（台账已因此栽了 5 次：`ledger-m0.md:1726-1903`）。
- **实际后果**：`AppearancePanel.tsx:104,319`、`TunnelPanel.tsx:67,255`、`UniterminalTab.tsx:1170,1218,1483` 的内联 `borderRadius: 4` 把 CSS 定的**药丸按钮（999px）变成方角**——同一界面里两种按钮形状。

### 3.5 无障碍缺口
`aria-label` 计数：**SftpPanel 0 / TunnelPanel 0 / AppearancePanel 0 / StatusBar 0 / context-menu 0 / TerminalView 0**；HostListView 6、UniterminalTab 7、select-field 2、confirm-dialog 1。

### 3.6 类名是全局非哈希的
`tab.module.css:1-3` 自述「类名不做哈希」→ `.uniterminal-*` 与宿主全局类名共存，撞名风险由前缀兜底，但**无法与宿主主题变量做统一 token 化**。

---

## 4. 文案与语言审计（实测 283 条含中文的字面量）

> **本节是 B3 之前的审计快照。** B3 已按 `docs/copy-guide.md` 把术语、句式、标点统一，
> 现状与定案见 **§13**。本节保留是为了留住"当时错在哪"，不是待办清单。

### 4.1 术语分裂（同一概念多个说法）

| 概念 | 实际出现的说法 | 证据 |
|---|---|---|
| **密码** | 「已记住口令」/「密码（已记住）」/「已保存的密码」/「已保存密码无需输入直接连接」 | `HostListView.tsx:834` vs `UniterminalTab.tsx:1391,1402` vs `save-confirm.ts:40` |
| **连接** | 建会话说「连接失败/连接中」，测连通性也说「连接」，靠「测试/连通」区分 | `UniterminalTab.tsx:1023,1527` vs `HostListView.tsx:775,887` |
| **分组** | 「分组」/「组」/「**分组路径**」（旧 path 数据模型遗留，M10 已改 groupId 树） | `HostListView.tsx:443` |
| **新建/添加** | 「添加主机」按钮 + 「新建分组」/「新建会话」 | `HostListView.tsx:1041,1078` vs `UniterminalTab.tsx:1288` |
| **改名** | 「重命名分组」/「分组名没有变化」/「分组的新名称」 | `HostListView.tsx:539,546,1226` |
| **其它/其他** | 用「其它」 | `SftpPanel.tsx:53` |

### 4.2 内部工程语言泄漏到界面
- `HostListView.tsx:792`：**「M1 只支持 SSH 连接：」**——里程碑编号直接给用户看。
- 代码里仍保留 `VAULT_LOCKED`（`UniterminalTab.tsx:143`）与界面文案「凭据库当前不可读」（`:1001`）——与「界面不得暗示已取消的加密/保险库能力」有张力（D-2a 已取消主密码与保险库）。

### 4.3 排版规范两套
- 引号：界面用「」（如「删除分组「x」？」）vs 说明文用（）（如「（私钥文件本身不会被删除）」）→ `HostListView.tsx:1349,1359` vs `save-confirm.ts:45`。
- 全角加号「＋ 新建分组…」vs 普通「新建」→ `HostListView.tsx:1100`。
- 省略号统一用 `…`（连接中…/测试中…/创建中…/上传中…）——一致，保持。

### 4.4 失败提示的统一性
大量「X失败：」+ **后端原文透传**（删除失败 / 保存失败 / 信任主机失败 / 关闭会话失败 / 移动分组失败…），**缺"下一步动作"**；台账 M8-1/M8-2 要求 7 码分类（timeout→refused→dns→unreachable→hostkey→auth→unknown），这些散点尚未统一收口。

### 4.5 已有定案的文案（沿用，不要改写）
- 「密码以明文保存在本机凭据文件，受 Windows 账户权限保护」——常驻小字。
- 「只监听本机回环，局域网其它机器无法访问」/「远端端口在会话关闭时才会释放」。
- 「连通 ✓ 260 ms」/「连通 ✗ <原文>」——10 秒后自动清除。
- 「会话已结束：宿主上已经没有这条会话」/「正在接回会话」。
- 「＋ 新建分组…」/「移入分组…」。

---

## 5. 已被拍板不可推翻的约束（来自 docs/PRD.md + ledger-m0.md）

### A. 用户级否决（20 条，摘关键）
终端锁屏（D-12）· 主密码/锁定/解锁/加密保险库（D-2a）· shell 模式屏幕擦除（D-13）· 用 tmux 隔离驱动 TUI（D-14）· `*.uniterminal-part-*` 自动清理（M8-16，用户原话「不要在后续版本里自行加自动清理」）· 主机名染分组色（M9-19）· 磁盘监控（M8-24）· 钥匙图标闪光斜线（M11-20）。

### B. 交互形态否决
每会话一个右栏标签（M9-1/M9-3 探针定论）· 弹框用 fixed 或任何坐标方案（M49/M50/M54）· 原生 select 与 appearance:none 不补箭头（M29/M36）· datalist 做分组选择（M34）· **emoji 图标**（M11-4/M41）· 主题分支式配色（改 currentColor 派生，M11）· **危险色常驻**（只在 hover 转红，M12-6）· 密码/私钥回填界面（M2a-11）· `••••` 写进 input value（M8-7）· 就地行内删除确认（M12）· 三列全定宽（M9-13）· 提示文案保留 Markdown 星号（M19）。

### C. 视觉规格（已定型，只能在同方向上收敛）
字号三级阶梯 按钮 13 / 正文·标签·输入 14 / 分组标题 16 · 分组标题字重 650 · 按钮 border-radius 999px 药丸 · `--ut-border` = currentColor 22% · 浮层表面 = Canvas 不透明底 + 主题色渐变薄涂 + `color: inherit` · 主机行 = 列表项不常驻描边 · 行内动作按钮默认透明 + opacity .55，hover 才浮现 · 文字徽标 → 内联 SVG 图标。

### D. 硬技术约束
apply 永不抛错 · cordis 声明制（客户端必须导出 `inject = ["slots","locale"]`）· **密码/口令/私钥永不进入**前端 DOM/日志/错误/profiles.json · profiles.json 只存 `identityPath` 路径 · 写盘原子（tmp+rename，临时名唯一）· loopback 围栏 · 路由必须经 `matchRoute` 测试 · TS strict + noUncheckedIndexedAccess · 终端只隐藏不卸载、文件/隧道 visitedViews 懒挂载 · 会话身份只来自 `props.tab.id` · `src/client/report.ts` 是前端错误上报唯一通道 · 对话框必须 `useLayoutEffect` + ResizeObserver 且挂载自检 `closest(".uniterminal-pane")` · 确认弹框焦点默认落在「取消」 · 提示自动消失统一走 `use-auto-dismiss`(6000ms)，只用于「操作反馈」不用于「状态说明」。

---

## 6. 改动风险地图（测试）

**测试形态**：`environment: "node"`、无 jsdom、无 react devDep → **前端零渲染测试**。只有三种：① 纯函数单测（真 import）② **读源码字符串断言** ③ 在 `routes.test.ts` 里把 react mock 成记账桩后**手写遍历桩树**。无快照测试 → **改文案 = 直接红**。

### 6.1 三层改动各会踩什么
- **语言层**：大量逐字中文断言（`会话已结束`、`复制会话`、`连接超时倒计时`、`重置颜色`、`清除`、`上传完成`…）→ **必然大面积红**。
- **设计层**：① 类名被 `toContain("className=\"uniterminal-xxx\"")` 锁死 ② CSS 断言用 `[^}]*` 正则 → **声明顺序敏感**（`panel-spec.test.ts` 锁 `display:flex → flex-direction:column → gap:10px` 的顺序）。
- **逻辑层**：几乎不被保护，但有硬编码结构不变量：
  - `HostListView.tsx` 里 `<ConfirmDialog` **恰好 3 个**；`UniterminalTab.tsx` 里 **恰好 2 个**
  - `className="uniterminal-check"` **恰好 4 个**，且等于 `type="checkbox"` 出现次数
  - 会话栏必须 `display:none` 隐藏（不是卸载）；不得出现 `openTab(` / `closeTab(`
  - 外观/隧道面板必须保留 `visitedViews.has("files"/"tunnels")`

### 6.2 零保护区（改了没测试拦，但也没测试兜）
`AppearancePanel.tsx` · `TunnelPanel.tsx` · `client/index.ts` · `inject-css.ts` · `report.ts` · `tab-icon.tsx` · `use-connect-countdown.ts`，以及所有**交互行为**（搜索输入、右键菜单点击、表单提交、xterm 收发、轮询、键盘操作、焦点/Esc）。

### 6.3 台账沉淀的方法论（改代码时照做）
1. **样式"没生效"从不报错**——本项目连续 5 次栽在同一类（漏写 font-size / 内联盖过类 / 选择器范围太窄 / 只覆盖 button 没覆盖 span,input,select / 优先级不足）。**改样式先核对"选择器覆盖了哪些元素"**，别看截图猜。
2. 同选择器重复规则要合并（`uniterminal-hostdetail` 曾有 3 条互相覆盖）。
3. **单一事实来源**：认证方式（8 处 → `src/auth-kinds.ts`）、名称上限（→ `src/name-limits.ts`）、监控分段（→ `monitorSegments`）。改枚举/白名单前先 grep 同名常量。
4. **提交前门禁必须全绿**（台账有两次红灯下提交）。

---



---

## 7. 现状问题清单（按层重排；全部带证据）

> 排序依据：**功能坏 > 逻辑债 > 语言 > 视觉 > 无障碍**。P0 里有 6 条是「用户点不到 / 看到误导 / 会断链」的真缺陷，不是审美问题。

### P0 · 功能不可达与逻辑错误（先修这些）

| # | 问题 | 证据 |
|---|---|---|
| P0-1 | **分组「重命名」「删除分组」在界面上不可达** | `setGroupMenu` 只声明（`HostListView.tsx:288`）、只在 `onClose` 里被用（`:1318`），**从未被赋非空值**；全 `src/client` 只有一处 `onContextMenu`（`:811`，主机行），分组行（`:1163-1255`）没有 → M58 刚做的功能没有入口。连带 `setRenamingId`（`:266`）与 `setPendingFolderId`（`:264`）永远拿不到值 |
| P0-2 | **成功提示渲染成错误红色** | `.uniterminal-notice{color:var(--dsw-alias-label-error,#e5534b)}`（`tab.module.css:70-73`）承载「已删除 X」「已导入 N 台主机」「已保存配置」「已交给浏览器下载：X」（`HostListView.tsx:1344` / `UniterminalTab.tsx:1593` / `SftpPanel.tsx:822`）→ **成功 = 红色** |
| P0-3 | **一次性提示可能永不过期** | `use-auto-dismiss.ts:20-24` 的 effect 依赖 `clear`，而调用点每次渲染都传新箭头（`HostListView.tsx:244` / `UniterminalTab.tsx:312` / `SftpPanel.tsx:320`）→ 父组件每重渲染一次就重建 6 秒计时器 |
| P0-4 | **工具栏那套 CSS 根本没生效** | `.uniterminal-toolbar`（`tab.module.css:655-677`，含 flex-wrap / nowrap 那套）只用在「移入分组」浮层（`HostListView.tsx:926`）；真正的列表工具栏是**裸 div**（`:960` 用内联 `style={{display:"flex",alignItems:"center",gap:8}}`）→ 窄窗口按钮竖排的原始问题没被这段 CSS 治住 |
| P0-5 | **只有 SSH 能连，但可以存 local/telnet/serial** | 请求校验放行四种 kind（`routes.ts:78`），只注册了 ssh 适配器（`index.ts:166-174`）→ 连接必 500 `transport "local" is not available`（`registry.ts:20`） |
| P0-6 | **未知主机指纹靠正则解析错误文本** | 前端 `UniterminalTab.tsx:164` 用 `/unknown host key for (.+):(\d+) \(([^)]+)\)/` 从错误文本里抠出 host/port/fingerprint；后端原文来自 `known-hosts.ts:165` → `routes.ts:2216-2221` 原样透传。**改这段文案 = 信任主机流程立刻断链**。且传输层分类 code（timeout/refused/dns/unreachable/hostkey/auth，`routes.ts:243-318`）**只进 diag 不进响应体** → 前端无法机器判别错误类型 |
| P0-7 | **proxyJump / proxyChain 命名陷阱** | 存档案用 `proxyJump`（`routes.ts:559`），建会话请求用 `proxyChain`（`routes.ts:433`），**两者互不相通** → 表单层必须显式映射 |
| P0-8 | **状态栏取数失败整条消失且无任何提示** | `StatusBar.tsx:73` `if (sample === undefined) return null;`（折中修法见 §10：从未成功过就不占位，曾经可用过才提示） |
| P0-9 | **跳板链在「从列表连接」这条路径上完全丢失** | 建会话请求字段是 `proxyChain`（`routes.ts:433`），存档案字段是 `proxyJump`（`routes.ts:559`）；`POST /profiles/test` 已做映射（`routes.ts:882` `proxyChain: stored.proxyJump`），但前端连接请求 `UniterminalTab.tsx:978-985` 只发 `{id,kind,host,port,user,auth}` —— **没有 proxyChain** → 带跳板机的主机从列表点「连接」会绕过跳板机直连 |

### P1 · 逻辑层结构债

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | **42 处裸 fetch，无共享请求层**；错误提取表达式 `String(payload.error ?? response.status)` **重复 27 次**；「失败：」**39 处** | `src/client/**` 全量统计 |
| P1-2 | **diag 上报三份实现**，payload 形状还不一致 | `report.ts:5` / `UniterminalTab.tsx:176` / `TerminalView.tsx:86`（都打 `/api/uniterminal/diag`） |
| P1-3 | **语义色常量四处各写一遍** | `HostListView.tsx:111-113` / `SftpPanel.tsx:12` / `StatusBar.tsx:13-17` / TerminalView 内联 |
| P1-4 | **两套下拉并存** | 自绘 `SelectField` vs 原生 `<select>`（`TunnelPanel.tsx:342`、`AppearancePanel.tsx:329`）——原生弹层不继承主题变量，正是 `select-field.tsx:9-17` 记录过的「深色主题白底浅字」问题 |
| P1-5 | **两套存储访问方式** | `HostListView` 直接用 `globalThis.sessionStorage`（`:134,:145`）vs `tab-state` 的可注入存储 |
| P1-6 | ~~**死代码块**~~ → **已核验：几乎全是「故意保留的安全网」** | 三查（生产调用方 / 测试覆盖 / 台账点名）后：真正三查全空的只有 `EMPTY_SESSION_SET`（已删）；`claimSessionTab`/`forgetSessionTab`/`readProfileSnapshot` **其实是活代码**（遗留标签接回路径在用，原判「生产零调用」有误）；M9-2 泄漏保险机器是 171 条远端 shell 泄漏后的安全网，**默认保留**且已在文件里写明来历；`right-pane.ts` 的 `resolveOpenTab/resolveCloseTab` 仍未处理 |
| P1-7 | **未使用常量** | `REMEMBERED_LABEL="已记住"`、`KEY_AUTH_LABEL="私钥"`（`HostListView.tsx:101,103`）声明后无引用 |
| P1-8 | **同一条 notice 渲染在两处**，靠条件表达式避免重复 | `UniterminalTab.tsx:1549-1551` 与 `:1592-1594`（注释自述逻辑脆弱） |
| P1-9 | **同构代码四组** | `SELECT_STYLE`（TunnelPanel:61-68 / AppearancePanel:98-105）；`fetchStoredProfile`（UniterminalTab:780-790 / HostListView:648-654）；关闭会话请求三份（UniterminalTab:231 / :562 / :673）；浮层外壳手写 6 遍（HostListView:903,1006,1037 / UniterminalTab:1360,1622,1699） |
| P1-10 | **时间常量重复** | 6000ms 出现两次（`use-auto-dismiss.ts:4` 与 `SftpPanel.tsx:187`） |
| P1-11 | **会话标题两条并行生成路径** | `tab-state.ts:324 uniqueSessionTitle` vs `UniterminalTab.tsx:217 snapshotTitle` |
| P1-12 | **只有一个全局 busy** | `HostListView.tsx:245` → 任何操作期间禁用整页按钮，无逐行 loading |
| P1-13 | **会话栏 ARIA 用错** | `role="tablist"` + 子元素是 `aria-pressed` 的 button（`UniterminalTab.tsx:1253,1262`）——不是 `role="tab"`，无 tabpanel 关联、无方向键 |
| P1-14 | **组件体积失控** | `UniterminalTab` 1715 行 / 41 个 useState；`HostListView` 1368 / 28；`SftpPanel` 927 / 18。4 段大 JSX 未抽子组件（connectForm `:1359-1569`、sessionBar `:1250-1295`、sessionToolbar `:1298-1357`、banner `:1162-1247`）；`HostListView` 的 `row()` 是内联函数组件（`:806-956`），列表未虚拟化 |

### P2 · 语言层（详见 §4）

术语分裂（密码/口令、连接/会话、分组路径、新建/添加、其它/其他）· 界面泄漏工程编号（`M1 只支持 SSH 连接：`）· 代码仍留 `VAULT_LOCKED` 与「凭据库当前不可读」· 两套引号规范（「」vs（））· 失败提示「X失败：」+ 后端原文透传、无下一步动作 · 「加载中」三种写法 · 分隔符 │ 与 · 混用 · 成功/失败共用同一 class（P0-2）。

### P3 · 设计层（详见 §3）

无 token 层（语义色 11 处 / 灰 7 α / 遮罩 5 α）· 字号 4 档而台账要求 3 档阶梯（分组标题 16px 从未落地）· 圆角 7 种 · 间距两套 · 注释与代码漂移（10px/20ch）· 180 处内联样式 vs 97 处 className · 内联 `borderRadius:4` 覆盖药丸按钮 · 同选择器重复定义 4 组 · 「玻璃主题不透明」那段 CSS 写 4 遍。

### P4 · 无障碍

SFTP 文件行不可键盘操作（`SftpPanel.tsx:866-873` div+onClick，无 tabIndex/role/键盘事件）· 提示条无 `role="status"`/`aria-live`（HostListView:1344 / UniterminalTab:1550,1593 / SftpPanel:822 / AppearancePanel:455）· 右键菜单有 role 无焦点管理 · ConfirmDialog 无焦点陷阱、关闭不还焦点、标题 aria-label 与标题文本重复 · aria-label 缺口（SftpPanel/TunnelPanel/AppearancePanel/StatusBar/context-menu/TerminalView 全 0）。

---

## 8. 前后端契约要点（改文案/加错误态前必读）

### 8.1 路由面
32 条路由全在 `/api/uniterminal` 前缀下，**全部强制 loopback**（非回环 403 `{error:"forbidden"}`）。前端当前用到 **25 条**；未用的 7 条：`GET /health`、`POST /sessions/exec`、`GET /groups`、`POST /profiles/key/delete`、`POST /security/setup|unlock|lock`。

### 8.2 错误约定（前端唯一能机器判别的地方只有 4 处）
- **失败一律 `{error: string}`**；文本中英混杂（路由校验中文、传输层英文原文、store 英文）。
- 状态码全集：200/201/204/400/401/403/404/405/409/500/503。
- 带结构化字段的仅 4 处：① `409 {error, code:"exists", path, size}`（SFTP 目标已存在）② `401 {ok:false,error}`（主密码错）③ `201 {profile, warning}`（私钥未配置）④ `POST /profiles/test` **恒 200**，成败看 `ok` 字段。
- **前端现在完全不按状态码分支**，全靠 `!response.ok` + 文本。

### 8.3 WS 协议
S→C：二进制帧（终端原始字节）+ 文本帧仅 `{"type":"close",reason}`；C→S：`{"type":"input",data}` / `{"type":"resize",cols,rows}`。**无心跳、无客户端自动重连、无 cursor 续传**——重连只能从 ring buffer 起点全量重放；断线恢复靠「孤儿会话接管」。

### 8.4 会话状态机
服务端只有 `status: "open" | "closed"`。**「连接中」阶段尚无 sessionId**（无法取消连接）；**「重连中」status 仍是 open**，API 看不出，只有输出流里插入 `[uniterminal] reconnected`（退避 1/2/4/8/16s × 5 次）。**孤儿/接管不是服务端状态**，是前端对 `GET /sessions` 与本地会话表求差集。

### 8.5 与前端共用的常量
`NAME_MAX = 16`（主机名与分组名共用）· `CONNECT_COUNTDOWN_AFTER_MS = 5000`（前 5 秒不显示倒计时）· appearance 默认：`Cascadia Mono, Consolas, monospace` / 14px / lineHeight 1.2 / letterSpacing 0 / follow / `#101418` `#d6dde4` `#7aa2f7` `#2a3441`（范围：字号 8..32、行高 1..2、字距 0..5、颜色只认 #rgb/#rrggbb、**未知字段直接 400**）。

### 8.6 语义陷阱
`remember` **不是**「允许使用已存口令」的开关，只是「连接成功后保存口令」的布尔（口令本体在保险库 ref `profile:<id>`）· 删除分组 = 删子树，**主机回根层而不是被删** · 导入响应里 `skipped` 预览是**数字**、真导入是**数组** · 隧道 `-R` 的 bindPort 是服务端实际分配的端口 · socks 隧道不能指定目标 · SFTP 路径必须绝对、每连接只留 1 个通道。

---

## 9. 仍需外部确认的 9 项

1. **宿主 `webServer.register` 是否支持 `kind:"prefix"`** —— `routes.ts:207-222` 只是宿主匹配器的**复刻实现**，宿主源码在 app.asar 内未读。若宿主只认 exact，`DELETE /profiles/:id` 永远匹配不上（**最高优先**）。
2. 宿主 `registerUpgrade` 的 path 匹配语义（`ws-bridge.ts:226-227` 的注释未验证）。
3. `POST /security/setup` 在 auto-plain 之后**恒 409**（`security.ts:237` + `index.ts:82-87`）是否产品预期 → 决定「安全档位 UI」能否做。
4. 浅色主题真实观感（台账自述「无法在此环境验证」，`ledger-m0.md:2154`）。
5. `M1-15b` 掉回主机页的根因始终未定位（症状已用 sessionStorage 绕过）。
6. 前端连接倒计时用的 timeoutMs 取自 `profile.connectTimeoutMs` 还是 config（服务端优先级：profile > config > 20000）。
7. `/monitor` 的磁盘字段是死代码还是待恢复（取数命令已不调 df，但解析器还在）。
8. 宿主 CSS 变量全集（只确认了本插件引用到的 12 个 `--dsw-*`）。
9. `lib/` 构建产物是否与 `src/` 同步（本次只读 `src/`）。

---

## 10. 建议的推进分批

| 批次 | 内容 | 风险 |
|---|---|---|
| **B0 修缺陷** | P0-1 分组菜单入口 · P0-2 成功色 · P0-3 提示计时器 · P0-4 工具栏 CSS 挂载 · P0-8 状态栏失败态 | 低，多为小改；P0-1 需补右键菜单挂载 |
| **B1 契约对齐** | P0-6 指纹解析解耦（后端补结构化字段）· P0-5 只支持 SSH 的事实收紧 · P0-7 字段映射显式化 · **P0-9 连接时补传 proxyChain** | 中，涉及后端或跨端契约 |
| **B2 逻辑层收敛** | P1-1/2/3 抽请求层 + 统一错误提取 + 统一 diag + 语义色单一来源；P1-6/7 删死代码 | 中，改动面广但行为不变 |
| **B3 语言层** | §4 的术语/句式/引号/工程编号；错误提示收口到分类句式 + 下一步动作 | 中，**必然大面积改测试断言** |
| **B4 设计层** | token 层 · 字号阶梯落地 · 圆角/间距收敛 · 内联样式归位 · 重复选择器合并 · 注释订正 | 中高，CSS 断言顺序敏感 |
| **B5 无障碍** | P4 全部 | 中 |
| **B6 组件拆分** | P1-14：抽 `<SessionBar>` `<ConnectForm>` `<SessionToolbar>` `<HostRow>` 等 | 高，纯结构调整，收益最后 |

> 依赖关系：B3/B4 都要求先有 B2 的单一事实来源，否则会来回改两遍。
> 每批结束跑 `pnpm typecheck` + `pnpm test`（704 用例），改过的 UI 文件跑一次 `impeccable detect --json`。



---

## 11. 本轮（B0 + B1）已修复清单与残留

> 完成于 2026-10-28。门禁：`tsc --noEmit` exit 0 · `vitest run` **55 文件 / 755 用例全绿**（基线 51 / 704）· `impeccable detect --json` 对改动的 7 个界面文件返回 `[]`。

### 已修复

| 原编号 | 问题 | 修法 | 位置 |
|---|---|---|---|
| P0-1 | 分组右键菜单不可达 | 分组行加 `onContextMenu`（面板相对坐标，与主机行同一套算法）；调色板 `stopPropagation` | `HostListView.tsx:1157-1175`、`:1218` |
| P0-2 | 成功提示渲染成错误红 | 新建共享模型 `notice.ts`（kind = ok / error）+ `.uniterminal-notice-ok`；四个面板统一走 `useNotice()` | `src/client/notice.ts`、`tab.module.css:74-82` |
| P0-3 | 一次性提示可能永不过期 | `clear` 经 ref 传递，计时器依赖降为 `[active, ms]` | `use-auto-dismiss.ts:27-37` |
| P0-4 | 工具栏那套 CSS 没生效 | 真正的列表工具栏挂上 `.uniterminal-toolbar`；补 `.uniterminal-toolbar > button { align-self: center }` | `HostListView.tsx:956`、`tab.module.css:678-680` |
| P0-5 | 只支持 SSH 却能存不能连 | 建会话只接受 `kind==="ssh"`，其它一律 400「目前只支持 SSH 连接」 | `routes.ts:449-467`、`:2220` |
| P0-6 | 指纹靠正则啃英文原文 | 后端响应体加 `code` 与 `host/port/fingerprint`；前端两段式解析（结构化优先，旧正则保留兜底） | `routes.ts:327-353`、`:2269-2277`、`UniterminalTab.tsx:177-241` |
| P0-8 | 状态栏失败无任何提示 | **从未取到过样本仍不占位**（尊重 M8-20）；曾经可用过才给一行低对比替代，原因进 title | `StatusBar.tsx` |
| P0-9 | 跳板链在连接时丢失 | 连接请求补 `proxyChain`（只有非空才带、原样透传、字段名必须是 proxyChain） | `UniterminalTab.tsx:1054-1057` |
| 附加 | 死常量 `REMEMBERED_LABEL` / `KEY_AUTH_LABEL` | 删除（界面用的是 SVG 图标 + title） | `HostListView.tsx` |
| 附加 | 一次性提示规则三处各写一份 | 统一到 `notice.ts`（6 秒规则只剩一个来源） | `src/client/notice.ts` |

### 残留（本轮未修，按优先级）

1. **「复制会话」路径仍丢跳板链**（P0-9 同族）——快照白名单 `sanitizeProfileSnapshot`（`right-pane.ts:58-87`）里没有 `proxyJump`。
   修法：白名单加 `proxyJump`（严格校验）+ `duplicateSession` 带上 `proxyChain` + 同步改 `test/client/session-tabs.test.ts` 的白名单断言。
   **建议下一批第一个做。**
2. **SFTP 上传失败文案不在 notice 通道**——这是有意的：失败行永远不自动消失（`SftpPanel.tsx:186`）。要统一需另开"不自动过期"通道。
3. **外观面板的成功提示现在会 6 秒后消失**（统一过期规则的结果），且位置从按钮旁挪到下方。要常驻需另加通道。
4. **UniterminalTab 还有两处写死 `.uniterminal-notice`（红）**：`:1601`「正在连接 user@host:port…」（状态说明）、`:1262` resetError（横幅内独立 state）。
5. **前端仍不按 HTTP 状态码分支**——只用了后端新给的 `code` 做指纹判断；错误文案的统一收口属 B3。
6. **宿主半边改动需重启 DSH 才生效**；本轮未做真机验证（仓库无浏览器自动化设施）。

### 本轮的门禁与工具足迹

- `node ./node_modules/typescript/bin/tsc --noEmit` → exit 0
- `node ./node_modules/vitest/vitest.mjs run` → 55 files / 755 tests passed
- `impeccable detect --json <7 个改动的界面文件>` → `[]`（无机械告警）
- 未新增任何依赖；未 git commit；未重启 DSH。
- 改动文件：`src/routes.ts`、`src/client/{notice.ts(新),use-auto-dismiss.ts,StatusBar.tsx,HostListView.tsx,UniterminalTab.tsx,SftpPanel.tsx,AppearancePanel.tsx,tab.module.css}`、`test/routes.test.ts`、`test/client/{notice.test.ts(新),status-bar.test.ts(新),proxy-chain.test.ts(新),notice-usage.test.ts(新),panel-persistence.test.ts,host-row-actions.test.ts,toolbar-layout.test.ts}`
- ⚠️ `HostListView.tsx` 的 blob 是仓库里唯一混合行尾的（CRLF+LF）且 `core.autocrlf=true` → `git diff` 会显示整文件改写。**看真实改动请用** `git diff --ignore-cr-at-eol -- src/client/HostListView.tsx`（本轮 38 增 / 32 删）。


---

## 12. B2（逻辑层收敛）结果

> 门禁：`tsc --noEmit` exit 0 · `vitest run` **56 文件 / 809 用例全绿** · `tsdown` exit 0 ·
> `impeccable detect` 对 12 个界面文件返回 `[]`。

### 量化

| 指标 | B2 前 | B2 后 |
|---|---|---|
| 裸 `fetch`（共享层之外） | **40** | **3**（SFTP 下载文件流 / SFTP 上传 XHR / 状态栏轮询——按设计该留） |
| 重复的错误提取表达式 | **27** | **3** |
| 自己写 `report()` 的面板 | **3** | **0**（统一到 `report.ts`，并加了凭据字段丢弃） |
| 语义色定义处 | **6 个文件各写一遍** | **1 个**（`tokens.ts`） |
| 原生 `<select>` | 2 处 | **0**（换自绘 SelectField） |

### 新增的共享模块

- `src/client/api.ts`——统一请求层。失败固定成 `{ message, status, code?, payload? }`；**永不抛错**；
  **200 + {ok:false} 也算失败**（宿主 /profiles/test 的形状）；**不把请求体写进错误信息**。
- `src/client/tokens.ts`——语义色单一来源（取值与旧值逐字一致）。
- `src/client/ui.ts`——`SELECT_STYLE` 一份。

### 已关闭的问题项

| 原编号 | 结论 |
|---|---|
| P1-1 | ✅ 40 处裸 fetch → 共享请求层；27 处重复错误提取收口 |
| P1-2 | ✅ 三份 report 实现 → 一份，且新增凭据字段丢弃（递归、大小写不敏感、按"包含"匹配） |
| P1-3 | ✅ 语义色六处 → `tokens.ts` 一处 |
| P1-4 | ✅ 两处原生 select → 自绘 SelectField（M36 裁定），前端再无原生 select |
| P1-6 | ✅ 改写为「已核验保留并写明理由」：真正三查全空的只有 `EMPTY_SESSION_SET`（已删）；M9-2 泄漏保险机器保留 |
| P1-9 | 🟡 部分：三份「关闭会话」已合成一条；`MODE_LABEL` 已推导；两份 `fetchStoredProfile` 未合并（失败语义不同，方案已备） |

### 仍未关闭（下一批）

| 原编号 | 状态 |
|---|---|
| P1-5 两套存储访问 | **结构性受阻**：`tab-state.ts` 没有"任意键"读写出口（`activeStorage()` 是模块私有的）。补丁已备好（加两个通用读写函数 + 旧键名 `uniterminal.collapsed-groups` 一字不改），要动 tab-state 的公共面，值得单独一轮 |
| P1-9 两份 fetchStoredProfile | 方案已备：抽 `src/client/stored-profile.ts` + 判别联合（区分「失败」与「没有这台主机」） |
| P1-11 两条标题生成路径 | `snapshotTitle`（管叫什么）与 `uniqueSessionTitle`（管重名编号）并行；合并前要先定"兜底文案归谁"与"同 id 改名时旧标题算不算占用" |
| P1-12 全局 busy | 未动 |
| P1-13 会话栏 ARIA | 属 B5 无障碍 |
| P1-14 组件拆分 | 属 B6 |

### 本轮新发现的、已记进台账的教训

1. **同一个失败有两种形状**——宿主 /profiles/test 既可能回非 2xx，也可能回 200 + {ok:false}。
   统一错误形状时，别忘了旧代码在两条分支上写的是**不同的文案**（否则会出现「连通 ✗ HTTP 200」）。
2. **两份"看起来一样"的函数不能合并**——若失败语义不同（一个 throw、一个吞），共用"吞"的那份会让界面在真实故障时说错话。
3. **"统一存储访问"可能根本无从下手**——先确认被复用的那层**真的提供了你要的接口**。
4. 换掉原生 select 后，CSS 里 `.uniterminal-overlay-panel select` 那几条规则成了死规则（属 B4）。

## 13. B3（语言层）落地记录

规范全文见 **`docs/copy-guide.md`**（术语表 / 句式 / 标点 / 四类禁止事项）。本节只记"改了什么、留下什么"。

### 13.1 术语定案

| 概念 | 定案 | 改掉的旧说法 |
|---|---|---|
| SSH 密码 | **密码** | 口令（"口令"只许出现在"私钥口令"里；"口令保护"是已取消的加密能力，界面不许提） |
| 一次已建立的 SSH 连接 | **会话** | —— |
| 结束一条会话 | **断开连接** | 关闭会话（同一个动作两种说法，统一成前者；台账 M9-11 与 acceptance-m2a 都用"断开连接"） |
| 测一次连通性 | **测试连接** | 连接测试（行内那个短按钮仍写"测试"） |
| 主机条目 | **主机** | 服务器 |
| 分组 | **分组** | 分组路径（M10 之后数据模型已是 groupId 树） |
| 文件类型 | **其他** | 其它 |

### 13.2 内部字段名不再进界面

6 处内部标识（`session.id` / `ws 地址` / `tunnel` / "宿主没有返回新分组的 id"）统一改成
**「服务返回异常，请重试」**，原始细节写进 diag
（`client.create-failed` / `client.duplicate-failed` / `client.adopt-failed` /
`client.group-create-failed` / `client.tunnel-create-failed`，各带一个静态 `reason`）。

### 13.3 失败提示的形状

- 唯一形状：**`<动作>失败：<原因>（<下一步>）`**；另一种允许的形状是 `<对象>不可用：<原因>`。
- 宿主给的分类文案（超时 / 拒绝 / DNS / 不可达 / 指纹 / 认证）本身就是"原因 + 下一步"，前端**不再二次翻译**。
- **一个提示里不许有两个动作前缀**——已修「移动分组失败：新建分组失败：…」（靠 `GroupCreateError` 标记让各调用点自拼一个动作词）。

### 13.4 约定守卫（新增）

`test/client/copy-conventions.test.ts`：跨文件扫描**用户可见文案**（含中文的字符串字面量），守住 4 条——
不出现内部字段名 / 不出现里程碑编号 / 不用「其它」/「口令」只许在"私钥口令"里。

扫描前**先剥注释**（字符顺序状态机，字符串里的 `//` 原样保留）：旧做法把注释里带引号的中文也算成界面文案，
实测 **29 个文件里 98 条（25%）是误报**。守卫因此改用"剥完注释的源码"再查。

### 13.5 留下的

- 宿主原文透传时仍带 `uniterminal: ` 前缀（全项目既有约定；收口要动 api.ts）。
- `src/routes.ts` 的注释仍写"关闭会话"——那是 API 层的说法，端点就叫 `sessions/close`；界面侧已统一为"断开连接"。
- 三处重复的注释剥离器（copy-conventions / notice-usage / host-list-view-contract）待抽成共享助手。
- 守卫只扫字符串字面量，**扫不到 JSX 静态文本**（B3 改的那条横幅标题就是 JSX 文本）——
  要守住"加密/解锁/锁定"这类词，得再加一条 JSX 文本扫描。
## 14. 公开仓库姿态：凭据存储

插件要开源到公网，所以这一节记的不是"还想优化什么"，而是**已经把什么删掉了、为什么**。

### 14.1 删掉了什么

自研的 protected 档（主密码 + 插件自管的加密文件：scrypt + AES-256-GCM + vault.bin）整套删除：

| 删掉的东西 | 去处 |
|---|---|
| `deriveKey` / `seal` / `openVault` / `parseVault` / `decodeField` 与全部 KDF 常量 | `src/store/security.ts` |
| `setup(mode, masterPassword)` / `unlock()` / `lock()` / `#key` / `#vault` | 同上 |
| 失败计数与退避、闲置自动上锁计时器 | 同上（没有"解锁"就没有重试与计时） |
| `POST /security/setup` · `/unlock` · `/lock` 三条路由 | `src/routes.ts`（公开 API 面上它们从来没被前端调用过） |
| `POST /security/reset-to-plain` | 改名 `POST /security/clear-legacy`，旧路径直接消失、不留别名 |
| `GET /security` 的 `locked` 字段 | 改成 `{ mode:"plain", legacy:boolean }` |
| 界面上的「改为明文模式」整套文案 | 改成「清理旧版凭据」语义 |

### 14.2 为什么删

- **它在产品流程里走不到**：前端从来没有主密码输入框，也从来没调用过那三条端点。
- **它却要被人审**：开源仓库的审阅者一定会问"谁在用？scrypt 参数怎么定的？"——而答案只能是"没人用"。
  一段没人走得到的密码学 = 一块没有 threat model、没有审计、没有使用方的攻击面。
- **界面本来就不许提它**（acceptance-m2a 判据 3）：代码里有能力、界面里不许提，是靠措辞遮掩的三不管状态。
  删掉之后这条约束自然成立——因为确实没有那项能力。
- **今天的退出路径本来也是丢弃**：`reset-to-plain` 从来不解密，只是把 vault 扔掉。
  删掉密码学不改变任何用户拿得到的结果。

### 14.3 现在的姿态

唯一且自洽：**明文 + 0600/NTFS ACL + 文档诚实说明**。

- 凭据文件：`credentials.json`（明文）+ `security.json`（登记，恒为 `plain`）。
- 权限保护一条没削弱：写入仍是「临时文件 → chmod 0600 → rename」，
  POSIX 上还有属主校验（权限过宽直接拒绝加载，绝不清空）。
- 界面上不出现「加密」「主密码」「解锁」「锁定」「明文模式」——
  `test/client/notice-usage.test.ts` 里加了一条**反向锁**：剥掉注释后扫整段源码，
  连 JSX 静态文本一起扫（13.5 记的那条"扫不到 JSX"因此补上了）。
- 旧档（vault.bin）只被**识别**，不被读取：启动时只标 `legacy=true` 并提示用户，**不静默删**；
  用户点「清理旧版凭据」才删。旧档里的密码不解密、不迁移（没有能读它的代码了），**那一部分**要重新输入一次；
  **明文库里已经记住的密码不受影响**——清理只丢弃旧格式文件里那份读不出来的数据。

### 14.4 下一步

接**操作系统密码箱**：Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service。
那才是"密码不该明文落盘"的正解——安全边界交给 OS，仓库不用自己发明密码学。
本轮不做任何新依赖、不碰 package.json；接口面届时再收敛一次。

## 15. 公开仓库姿态：操作系统密码箱

M65 把自研的 protected 档整套删掉之后，剩下的问题是"密码该不该明文落盘"。
本节记 M66 的答案：**把边界交给操作系统**，本仓库不自己发明密码学。

### 15.1 做了什么

| 位置 | 变化 |
|---|---|
| `src/store/credential-backend.ts`（新） | `CredentialBackend` 接口 + `FileBackend`（原明文文件逻辑搬过来）+ `KeychainBackend`（系统密码箱）+ 只读探测 |
| `src/store/security.ts` | 变成后端门面：选后端、迁移、降级；明文文件的规矩（0600 原子写 / 属主校验 / 损坏即报错）一条没弱化 |
| `src/routes.ts` | `GET /security` 加 `storage` / `storageLabel` / `degraded`；`/security/refs` 改 await；密码箱不可用有**独立**的错误 |
| `src/index.ts` | 启动时（在 `ready` **之内**）探测一次 + 迁移 |
| `src/client/UniterminalTab.tsx` | 常驻小字按后端变化 |
| `package.json` / `tsdown.config.ts` | 只多一个依赖 `@napi-rs/keyring`（原生模块，必须 external） |

### 15.2 三个关键决定

1. **后端是可替换的实现，不是一条 if。**
   `CredentialBackend` 五个方法、后端可注入 → 测试用假实现，**不依赖真机密码箱**，
   也不会在用户的凭据管理器里留下任何东西（测试进程一律不碰真机密码箱）。
2. **探测必须是只读的。**
   `findCredentialsAsync` 列举一次就够——**不为了探测去写一条测试凭据**
   （写进去再删掉会在用户的凭据管理器里留痕，还可能半路失败留下垃圾）。
3. **Linux 必须显式 pin `secret-service`。**
   不 pin 的话底层库会"Secret Service → 内核 keyring"回落，而内核 keyring **不跨重启、也不是加密存储**——
   静默用它就是欺骗用户。pin 之后该后端不可用会**抛错**（而不是回落），正好交给降级逻辑。

### 15.3 降级要诚实

- **插件起得来比什么都重要**：原生模块装不上 / 密码箱被锁 / 条目歧义（Ambiguous），一律降级到明文文件。
- 降级时**不假装**：降级状态下"取不到"**不等于**"没存过" →
  独立的错误「系统密码箱不可用，请稍后重试」，而不是那句会骗人的"请输入密码"。
- 界面常驻小字按后端变化：文件后端下保留验收单锁定的那句原文，密码箱后端下换成平台对应那一句。

### 15.4 迁移的铁律

逐条搬、**全部写成功之后**才删 `credentials.json`；中途失败保留原文件、继续用文件后端。
绝不会出现"删了文件但密码没搬进去"。

### 15.5 留下的

- 降级期间**不做全量回写**（把密码箱里的每条都读出来写进文件）——风险大于收益。
  代价是：降级时密码箱里的旧条目暂时取不到（界面已如实说明，文档写在 `docs/SECURITY.md`）。
- `tsdown.config.ts` 的 `external` 已被 tsdown 标记为 deprecated（建议改用 `deps.neverBundle`），
  本轮沿用既有写法没有顺手改：改了要重新验证产物里 external 的行为，不该混在一次功能提交里。

