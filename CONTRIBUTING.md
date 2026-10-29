# 贡献指南

## 环境

- Node **>= 20**（`package.json` 的 `engines`，最低兼容声明）；**CI 实际测的是 22 与 24**——Node 20 已于 2026-04 EOL，别拿它当目标
- 包管理器用 **pnpm**（仓库有 `pnpm-lock.yaml`，不要用 npm 提交 `package-lock.json`）
- DSH **>= 0.2.1-rc.2**（`package.json` 的 `dsh.engines`）

```bash
pnpm install
pnpm typecheck   # tsc --noEmit（strict + noUncheckedIndexedAccess）
pnpm test        # vitest run：65 文件 / 922 用例，约 3.5 秒
pnpm build       # tsdown：宿主半边 ESM + 客户端 CJS
```

提交前这三条必须全绿；`npm publish` 也会通过 `prepublishOnly` 强制跑一遍。
**CI 在 push / PR 到 `main` 时跑同样这三条**（Node 22 与 24，Ubuntu）。

`pnpm install` 会打印一行 `Ignored build scripts: cpu-features, ssh2` —— **这是预期的**。
那两个构建脚本我们主动不执行（`cpu-features` 是 ssh2 的可选加速件，缺了走纯 JS 实现），
而 pnpm 默认会因此以非零码退出，所以 `pnpm-workspace.yaml` 里声明了 `strictDepBuilds: false`。
它只关掉「跳过构建即报错」，不放开任何构建脚本 —— 别把它当成遗留配置删掉。

## 目录

| 路径 | 是什么 |
|---|---|
| `src/` | **宿主半边**（Node）：HTTP 路由、SSH/SFTP/隧道引擎、凭据存储 |
| `src/client/` | **浏览器半边**（React 18，注入 DSH 右栏） |
| `test/` | 测试，按被测对象分 `client/ engine/ store/` 与顶层入口测试 |
| `docs/` | 文案规范、安全模型、发布清单、开发台账（`superpowers/plans/ledger-m0.md`） |

## ⚠️ 本项目用「源码断言」守护约定 —— 改代码时必须同步改断言

仓库里有 **24 个测试文件**会读取源码文本并断言（`readFile(...src/...)`），
用来在没有 linter/AST 工具的情况下锁住那些"代码能过编译但约定被破坏"的事，例如：

- 界面文案里**不许出现**「口令」「其它」「加密」「session.id」（`test/client/copy-conventions.test.ts`）
- CSS 必须保留药丸圆角、字号阶梯、浮层不透明画布、危险色只在 hover（`panel-spec` / `surface-contrast` / `danger-on-hover`）
- 凭据**不得**进 DOM / 日志 / 诊断

**所以：改 CSS、改界面文案、移动函数位置，都可能让这些断言变红——而功能其实没坏。**
处理规则：

1. **同步更新断言，不要删断言**。把"旧写法"换成"新写法"，保留它要防的回归意图。
2. 若断言锁的是**已经不该成立的旧约定**，改成锁新约定，并在 PR 说明里写清"为什么这条约定变了"。
3. **用结构切分，不要用固定字符数切分**。判断"某个分支/函数里不许出现 X"时，
   按函数边界或分支判据切（`indexOf(": entry.wsUrl === undefined ?")`），
   不要写 `sliceAfter(source, "…", 700)` —— 源码一变短/变长，窗口就会飘到隔壁去
   （`session-bar.test.ts` 与 `a11y-wiring.test.ts` 都踩过这个坑）。

## DOM 测试

交互行为（点击、键盘、焦点）用 jsdom + Testing Library 测，在**文件头**声明环境：

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);   // 必须：本项目没开 vitest globals，RTL 的自动清理注册不上
```

参考 `test/client/context-menu.dom.test.tsx`（菜单键盘导航）、`confirm-dialog.dom.test.tsx`（焦点陷阱）、
`sftp-row-keyboard.dom.test.tsx`（键盘选中）。
**注意 jsdom 里 `getBoundingClientRect()` 恒为 0**，几何/定位逻辑请抽成纯函数单测（见 `test/client/menu-anchor.test.ts`）。

## 改界面文案前先读 `docs/copy-guide.md`

术语、句式、标点、禁用词都在那里，改完记得同步 `copy-conventions.test.ts`。

## CSS 约定

- **声明顺序即契约**：测试用 `[^}]*` 正则匹配规则体，改顺序会连锁变红。新增声明尽量追加在末尾。
- 数值一律走 `--ut-*` 令牌（字号 13/14/16、圆角 4/6/10/999、灰阶、遮罩、语义色）。
- **压不过 `.uniterminal-pane button`（0,1,1）时用两级选择器**（如 `.uniterminal-pane button.uniterminal-compact`），
  **不要用 `!important`**（全仓声明层面为 0）。
- 浮层/菜单必须留在面板内：靠右时用 `menuAnchor()` 改成右对齐向左展开，不要试图让 `overflow` 放开。

## 安全

读 `docs/SECURITY.md`。硬性要求：密码/私钥/口令短语**永不**进入 DOM、日志、错误消息、诊断上报、`profiles.json`；
凭据交给操作系统密码箱，**不要自己实现加密**。

## 提交

一次提交做一件事，说明里写清"为什么"而不是"改了什么"。不要求签名，但请确保：
`typecheck` + `test` + `build` 全绿，且没有把 `lib/`（构建产物，已在 .gitignore）塞进提交。
