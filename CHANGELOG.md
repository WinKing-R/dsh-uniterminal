# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

`0.x` 阶段：**次要版本可能包含不兼容变更**（配置项与插件 API 仍可能调整），补丁版本只修缺陷。

## [Unreleased]

## [0.2.17] - 2026-10-29

### 修复

- **行尾「更多操作」按钮的菜单被面板右边缘裁掉**：锚点靠右时菜单仍向右伸展，伸出面板后被宿主的
  `overflow` 裁掉，「移入分组…」「测试连接」只显示半截。现在锚点过半宽时改为**右对齐、向左展开**；
  鼠标右键、`Shift+F10`/菜单键、「⋯」按钮三条入口共用同一套判定（`src/client/menu-anchor.ts`）。

### 文档

- 新增 `CONTRIBUTING.md`：源码断言的约定（改 CSS/文案要同步更新断言、不要删断言）、
  DOM 测试模板（`// @vitest-environment jsdom` + `afterEach(cleanup)`）、CSS 契约、
  以及**禁止用固定字符数切源码**这条踩过两次的坑。
- README 补「右栏承载」一节：装了 `DSH-better-sidebar` 优先注册到 `ctx.betterSidebar`，
  否则回落官方 `sidebarRightTabs`。

## [0.2.16] - 2026-10-29

首个公开发布版本（MIT）。

### 新增

- SSH 终端（xterm.js）、SFTP 文件管理、端口转发（`-L` / `-R` / `-D`）、跳板链、分组管理、外观设置。
- 一个侧边栏标签装多条会话，顶部会话栏切换；同一主机连两次显示 `#2`；刷新页面自动接回会话。
- **凭据交给操作系统密码箱**（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），
  插件自身不实现任何加密；只有机器没有系统密码箱时才回落明文文件（0600 + 原子写），并在界面如实说明。
- 失败提示区分 7 类原因（超时 / 拒绝 / DNS / 不可达 / 主机指纹 / 认证 / 未知）并给出下一步动作；
  内部字段名不再出现在界面上（细节只进 diag）。

### 无障碍

- 右键菜单与确认弹框：打开即聚焦、方向键/Home/End、`Tab` 焦点陷阱、关闭后**把焦点还给触发元素**。
- 提示条改为常驻 live region（成功 `status/polite`、失败 `alert/assertive`），读屏能听见错误。
- SFTP 文件行支持键盘选中（`aria-pressed`）；主机行「连接 / 测试」的可访问名带主机名。

### 设计

- 引入 token 层（字号 13/14/16 三级阶梯、圆角 4/6/10/999、灰阶与遮罩、语义色单一来源）。
- 内联样式收敛 66%（541 → 182 条声明）；重复选择器 4 组 → 0 组。

### 质量

- 严格 TypeScript（`strict` + `noUncheckedIndexedAccess`）：`:any` 与 `@ts-ignore` 均为 0。
- 64 个测试文件 / 915 个用例（含 jsdom 真实交互用例）；`pnpm audit --prod` 零已知漏洞。
- `prepublishOnly` 强制跑 typecheck + test + build，过不了发不出去。

[Unreleased]: https://github.com/WinKing-R/dsh-uniterminal/compare/v0.2.17...HEAD
[0.2.17]: https://github.com/WinKing-R/dsh-uniterminal/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/WinKing-R/dsh-uniterminal/releases/tag/v0.2.16
