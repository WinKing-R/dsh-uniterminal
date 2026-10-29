# 发布前清单（UniTerminal）

> 面向维护者。逐项勾选，全绿再 `npm publish`。
> 本仓库尚未有 `origin`、从未推送——**现在做的清洗会直接决定公开历史里留下什么**，所以脱敏是硬要求，不是可选项。

---

## 1. 许可证（当前**未完成**，阻塞发布）

- [x] 由**作者本人**选定许可证（MIT / Apache-2.0 / AGPL-3.0 …）——这是法律决定，代码里不能替作者选 → **已选 MIT**
- [x] 在仓库根新增 `LICENSE` 文件（正文用 SPDX 官方文本，不要改写）→ 已建
- [x] 在 `package.json` 补 `"license": "<SPDX 标识符>"` 字段 → `"MIT"`
- [x] README 顶部「状态」表里的「许可证：**待定**」改成实际许可证名 → `MIT`

> **没有许可证 = 法律上默认保留所有权利。** 别人既不能改也不能用，仓库公开了也**不构成开源**。
> 许可证不定下来之前，不要发布。

## 1b. 历史里的个人数据 —— **已完成（重开历史）**

开发期的提交里曾经包含过作者的机器信息（家目录路径、内网地址、一台真实主机的条目）。
这些内容在**第一次推送之前**就已经处理掉了，方式是**重开一条干净的历史**：

- 旧历史（含全部开发提交）已完整备份到仓库外的 `../uniterminal-backup.bundle`（`git bundle verify` 通过）。
  需要查旧记录时：`git clone ../uniterminal-backup.bundle <dir>`。**这个备份不要上传、不要放进仓库。**
- 现在的历史只有一条初始提交，工作树里不含任何机器信息；
  `git cat-file --batch-all-objects` 的对象总数与 `git rev-list --objects --all` **相等**（无残留的不可达对象）。
- 开发过程本身没有丢：`docs/superpowers/plans/ledger-m0.md` 是逐条的决策与教训记录。

**发布前复核（两个都必须是 0）**：

```bash
git log --all --oneline -S '192.168.' | wc -l      # 内网地址
git grep -n '192\\.168\\.' -- . | wc -l              # 工作树
```

（作者自己的公开句柄出现在包名与版权行里是正常的，不算泄漏。）

## 2. 仓库元数据（当前**未完成**）

- [ ] `package.json` 补 `"repository"`（形如 `{ "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" }`）
- [ ] `package.json` 补 `"author"`
- [ ] `package.json` 补 `"bugs"`（issue 入口 URL）
- [ ] `package.json` 补 `"homepage"`
- [ ] 创建远端仓库、`git remote add origin …`，并**先推送一次再发 npm**（npm 页面上的「Repository」链接要能点开）

> 以上四项当前**故意留空**：它们取决于仓库最终挂在哪个账号下。

## 3. 工作区干净 + 构建产物是最新的

- [ ] `git status` 无未提交改动（发布必须对应一个可复现的提交）
- [ ] `lib/` 是最新构建：`pnpm build` 之后**再跑一遍测试**
- [ ] `pnpm typecheck` exit 0
- [ ] `pnpm test` 全绿（当前基线：**64 文件 / 915 用例**）
- [ ] `pnpm build` exit 0

> `lib/` 在 `.gitignore` 里**不进版本库**，但会进 npm 包（`files` 白名单第一项）。
> 所以每一版发布前都必须重新构建——`scripts.prepublishOnly` 已经把「typecheck + test + build」串起来兜底，
> 但**别依赖它**替你看结果。

## 4. 版本号

- [ ] 按语义化版本升号（`npm version patch|minor|major`）
- [ ] 首次公开发布建议停在 `0.x`，并在 README「状态」里写明 **API 与配置项仍可能变**
- [ ] `package.json` 的 `version` 与 README「状态」表里的版本号一致
- [ ] `engines.node` 与 `dsh.engines.dsh` 与实际要求相符（当前 `>=20` / `>=0.2.1-rc.2`）

## 5. 发布

```bash
npm publish
```

`package.json` 里已经配好 `"publishConfig": { "access": "public" }`。
**这一条是必须的**：`@winking-r/dsh-uniterminal` 是带 scope 的包，缺了它 `npm publish` 会按私有包处理并直接失败。
若把它删了，等价写法是：

```bash
npm publish --access public
```

## 6. 发布前自查

### 6.1 包里到底有什么

```bash
npm pack --dry-run
```

- [ ] 文件清单里**只有**：`package.json`、`README.md`、`LICENSE`（有的话）、`docs/SECURITY.md`、`lib/**`、`cordis.patch.yml`
- [ ] **没有** `src/`、`test/`、`docs/superpowers/`、`node_modules/`、`.env`、任何密钥、任何大文件

> `SECURITY.md` 放在 `docs/SECURITY.md`，所以 `files` 里写的是 `"docs/SECURITY.md"`（不是 `"SECURITY.md"`）。
> LICENSE 由 npm 自动包含，SECURITY.md 不会——不写进 `files` 就不会进包。

### 6.2 已跟踪文件里没有个人路径与内网 IP

对 `git ls-files` 的全部文件扫一遍，下面四个模式必须**全部为 0**：

```bash
git ls-files -z | xargs -0 grep -nIP \
  'C:[\\/]Users[\\/](?!<you>)[A-Za-z0-9._-]+|192\.168\.|winking|colaTools'
echo "exit=$?  （1 = 无匹配，符合预期）"
```

- [ ] 输出为空

允许留下的**只有占位形式**：`C:\Users\<you>\…`、`192.0.2.x`（RFC 5737 的 TEST-NET-1 文档保留段）。
`localhost` / `127.0.0.1` 上的临时端口不必改——本机回环不泄漏信息。

### 6.3 台账没有被「脱敏」改坏

- [ ] `docs/superpowers/plans/ledger-m0.md` 里的因果、数字、结论、教训**一个字没动**，只换了标识符
- [ ] `package.json` 的 `dependencies` / `devDependencies` / `version` 与上一版一致

## 7. 发布后

- [x] `npm view @winking-r/dsh-uniterminal` 能看到新版本 → **已发布 0.2.16（MIT）并通过 registry 侧独立验证**
- [ ] npm 页面上的 README 渲染正常、示例可跑、链接不 404
- [x] 在 README 补安装徽章 / 一行安装命令（`pnpm add @winking-r/dsh-uniterminal`）
- [ ] 登记到 DSH 插件列表（如果官方有这样的清单）
- [ ] 打 git tag（`git tag v<version> && git push --tags`）并写 release notes

## 8. 关于 `docs/` 的定位

- `docs/` **不进 npm 包**（`files` 里只有 `docs/SECURITY.md`），所以它**不是**「对外文档质量」的一部分——
  规划记录、验收单、台账保持内部工程笔记的原样即可。
- 但 `docs/` **会进 GitHub**：公开仓库里谁都能读。所以第 6.2 条的脱敏对 `docs/` **同样是硬要求**，
  与它进不进包无关。
