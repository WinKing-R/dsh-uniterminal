# UniTerminal M6 计划（终端外观：字体 + 配色）

**用户需求**：「字体能改吗？就像 MobaXterm 一样能定义字体和重点字词颜色标注之类的」

## 已查实的事实
- xterm 6.0.0：`registerDecoration` / `registerMarker` **存在** → 关键词高亮可行（但列入下一批）。
- `TerminalView.tsx:43` 现在写死 `fontFamily: "monospace"`，**没设 fontSize、没设 theme**。
- 插件**不能写宿主配置**：`dsh-pet` 源码注释「a plugin own Cordis Config IS its settings page; the Host derives one form per profile entry」→ 配置由宿主编辑，插件只读。

## 决策
| 项 | 决定 |
|---|---|
| 设置界面 | **终端面板内自带**（右上「外观」按钮），改完立刻生效 |
| 持久化 | **我们自己的 `~/.dsh/uniterminal/appearance.json`**（原子写）；插件 config 仅作为**默认值来源** |
| v1 范围 | **只有字体 + 配色**；关键词高亮单独一批 |
| 默认主题 | 跟随 DSH 明暗（读 `--dsw-alias-*` CSS 变量，读不到则回落到深色） |

## 接口契约（两个任务共同遵守）
```
GET  /api/uniterminal/appearance
POST /api/uniterminal/appearance

body / response:
{
  "appearance": {
    "fontFamily": "Cascadia Mono, Consolas, monospace",
    "fontSize": 14,             // 8..32 整数
    "lineHeight": 1.2,          // 1.0..2.0
    "letterSpacing": 0,         // 0..5
    "themeMode": "follow",      // follow | dark | light | custom
    "background": "#101418",    // 仅 custom 时使用，#rgb 或 #rrggbb
    "foreground": "#d6dde4",
    "cursor": "#7aa2f7",
    "selectionBackground": "#2a3441"
  }
}
```
- 成功：`200 { ok: true, appearance }`；GET 返回 `{ appearance }`（文件不存在时返回默认值）。
- 校验失败：`400 { error }`（字段越界/格式错，文案指明哪个字段）。
- 非回环 `403`；未注入 `503`；非 GET/POST `405`。
- **不引入 ANSI 调色板自定义**（v1 只调前景/背景/光标/选中色），调色板留到高亮批次再说。

## Task M6-1：宿主侧存储与路由
- 新建 `src/store/appearance.ts`：`AppearanceStore(dir)`，`load()` / `current()` / `save(patch)`；
  原子写（tmp → rename），校验同契约；文件损坏时**不抛错**，回落到默认值并记 diag。
- `src/config.ts` 增可选 `appearance` 默认值（同上字段，全部可选）；`src/index.ts` 把 config 的 appearance 作为 store 的 seed。
- `src/routes.ts` 增两条 exact 路由；`RouteDeps.appearance?`；断言经 `matchRoute`。

## Task M6-2：客户端外观面板
- `src/client/TerminalView.tsx`：接受 `appearance` 属性，构造时与变化时 `terminal.options.fontFamily/fontSize/lineHeight/letterSpacing/theme`；
  `themeMode: "follow"` 时从 `getComputedStyle(document.documentElement)` 读 `--dsw-alias-*`（取不到就回落深色）。
- 新建 `src/client/AppearancePanel.tsx`：字体（文本输入 + 几个预设如 Consolas / Cascadia Mono / JetBrains Mono / monospace）、
  字号（8..32 滑杆/数字）、行高、字距、主题模式（跟随/深色/浅色/自定义）、自定义时四个颜色（原生 `<input type="color">`）、
  「恢复默认」按钮；**改动即时应用到预览**（本地 state → TerminalView），「保存」才 POST。
- `src/client/UniterminalTab.tsx`：顶部加「外观」切换或弹层；挂载时 GET 一次拿当前值。

## 完成判据
1. 两任务各自 typecheck/test/build 全 0；工作区干净且必须提交。
2. 路由用例 ≥5（GET 默认、POST 保存、越界 400、非回环 403、无 deps 503）。
3. 存储用例 ≥4（roundtrip、损坏文件回落默认且不抛、越界拒绝、原子写不留 tmp）。
4. 产物含：`外观`、`字体`、`字号`、`行高`、`字距`、`跟随系统`、`恢复默认`。
5. 重启后真机验收：改字号/字体/配色即时生效；重启后仍在。