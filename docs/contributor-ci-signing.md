# 贡献者检查与发布签名

## 目标与约束

- 普通贡献者无需发布私钥即可验证代码、协议、恢复、前端及 adapter 隔离。
- main 是现有客户端的自动更新源，合并发布源码前必须完成签名和摘要对齐。
- 保留既有 Ed25519 公钥、客户端更新源、清单格式和 LF 发布字节约定。
- 不向 fork PR 提供 Secrets，不在签名 job 执行候选提交的代码或 npm 生命周期。
- 签名产物只是一份待审查补丁，不自动提交、推送、合并、打 tag 或发布。
- 假设发布频率较低，优先使用标准 Node/Git，无新增运行依赖；审批和私钥归维护者管理。

## 决策记录

| 决策 | 考虑过的方案 | 选择原因 |
| --- | --- | --- |
| 将代码检查与发布就绪分开 | 所有 PR 都跑签名摘要校验；直接删掉发布校验 | 前者把维护者签名待办混入代码失败，后者会放行损坏的更新源 |
| 默认 `npm test` 仍为完整验证 | 默认跳过发布套件 | 避免旧命令静默失去发布保护 |
| 可信 main 脚本读取候选 Git 对象 | 带私钥 checkout PR 并运行其构建脚本 | 候选脚本及 `src/updater.js` 都可能被贡献者更改，不能在 Secrets job 导入 |
| 受保护手动流程生成补丁 | 合并后自动重签；自动向 main 写入 | main 即更新源，合并到重签之间的漂移会影响旧客户端；补丁可在合并前审查 |
| 保留发布就绪合并门禁 | 普通代码检查通过就直接合并 | 代码通过与可安全升级是两件独立的验收事实 |

不改为新发布分支或 tag 更新源：只改新客户端的默认 URL 无法迁移旧客户端。

## 贡献者

```bash
npm run test:contributor
npm install
npm run typecheck
git diff --check
```

项目没有构建步骤。类型检查仅覆盖 adapter；不得称其覆盖整个插件。

贡献者模式仍运行 catalog 的结构、来源及 adapter 隔离检查；只将发布字节和
最近内容 revision 的对齐交给维护者。清单与目录完整性记录之间的一致性仍检查。
不要用占位签名或新公钥让检查变绿，不要将已有签名复制到修改过的清单。

GitHub 的 `offline` 与 `typecheck` 是代码检查。`release-readiness` 运行
`npm run test:release`，失败表示发布准备尚未完成；由持钥维护者处理。
默认 `npm test` 跑所有套件；`npm run test:release` 专门检查真实清单、升级链和目录。

## 维护者配置（一次性）

本次代码改动不会替你创建 Secrets、审批人或分支保护。需要仓库管理权限完成：

1. 创建 Environment `release-signing`，配置 Required reviewers，并禁止运行发起者自行审批；
   Deployment branches 仅允许 `main`，关闭管理员绕过（平台支持时）。
2. 保护规则确认生效后，把**既有**发布私钥的 PEM 内容存入该 Environment 的
   `RELEASE_MANIFEST_PRIVATE_KEY`。不要使用普通仓库 Secret，不要生成替代信任根。
3. main 的合并门禁要求 `offline`、`typecheck` 和 `release-readiness` 全部成功，
   并要求分支与 main 保持最新。仅添加 workflow 文件不会配置这些保护。
4. 使用保留候选提交历史的普通 merge。Squash 或 rebase 会改变内容 commit SHA，
   破坏目录 revision 的约定；不得在签名完成后改变合并方式。

首次引入本流程时，工作流还未进入 main，维护者先按 `RELEASING.md` 的本地签名方法
完成当前 PR 的清单与目录记录，并跑完整测试；之后才能从 main 启动新流程。

## 为审查完的候选准备签名

1. 将最新 main 合入候选分支，完成审查和代码检查；记录完整 40 位候选 commit SHA。
2. 从 **main** 手动运行 `prepare-release`，填入 `candidate_sha`。
   Environment 审批人在放行前核对输入 SHA、diff 和代码检查结果。
3. 工作流固定使用本次 main 的脚本，仅 fetch 候选 Git 对象，不 checkout 候选。
   main 已前移、候选不是 main 的后代、错钥、降级、路径越界、链接文件、
   超出客户端清单限制都会失败，不产生可用签名补丁。
4. 下载 `signed-release-<SHA>` Artifact（保留 7 天），解压后审查
   `receipt.json` 与 `release.patch`。receipt 记录可信 main、候选提交、
   最近内容 commit、发布版本和补丁 SHA-256。

在无私钥的本地候选工作区应用补丁；下例 `ARTIFACT` 是已下载并解压的目录：

```bash
test -z "$(git status --porcelain)"
ARTIFACT=/absolute/path/to/signed-release-artifact
node --input-type=module - "$ARTIFACT" "$(git rev-parse HEAD)" <<'NODE'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
const [dir, head] = process.argv.slice(2)
const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json')))
const patch = fs.readFileSync(path.join(dir, 'release.patch'))
assert.equal(receipt.candidate, head, '候选已变化，请重新准备')
assert.equal(receipt.patchSha256, crypto.createHash('sha256').update(patch).digest('hex'))
NODE
git apply --check "$ARTIFACT/release.patch"
git apply "$ARTIFACT/release.patch"
git diff --check
git diff --stat
npm test
npm run typecheck
# 仅提交这四份发布记录，不同时修改发布源码
git add feed/manifest.json catalog/integrity.json catalog/dsh-plugin.json catalog/provenance.json
git commit -m "准备已审查候选的发布签名与目录记录"
```

补丁同时刷新两个 catalog revision 为候选中最近触及 `package.json` / `files` 的提交；
这次元数据提交不改变发布字节，因此无需再改 revision。补丁格式与客户端解析/验签契约
由真实 updater 校验。签名只承诺候选字节，不代表测试或代码审查已经通过。

维护者将签名提交送回原 PR 分支，或建立包含原贡献提交和签名提交的整合分支/PR；
贡献者仍无需私钥。待 GitHub 三个检查全绿后按普通 merge 合入 main。
候选源码、版本或 main 再变化时重新准备，不沿用旧补丁。按 `RELEASING.md`
继续 tag、CDN purge 和安装用户视角的 live audit。

## 安全边界与验收限制

- `prepare-release` 只有 `contents: read`，私钥仅在签名步骤的环境变量中存在；
  Node 在启动 Git 子进程前移除该环境变量，Artifact 不含私钥。
- 它仅从 Git blob 读取普通发布文件与四份 JSON 记录，候选脚本、Git hooks、
  checkout filters、npm install 和候选模块均不执行。签名 API 的测试钥注入入口
  不暴露为 CLI 参数；正式 CLI 固定验证可信 main 的内置公钥。
- 测试使用一次性夹具密钥和隔离 Git 仓库，不修改正式清单，也不验证真实 GitHub
  Environment 审批、Secrets 配置或正式发布；这些必须由维护者配置后验收。
- 发布就绪检查仍可能因当前 main 的旧清单漂移失败。该流程不把未签署的 main
  描述为可发布，不改变已安装客户端的验签与回滚机制。

## 回退

停用 `prepare-release` 工作流，删除 Environment Secret（由维护者执行）；
继续使用本地既有私钥及 `npm test` 完整门禁。回退代码检查分层时恢复旧 workflow
和 test runner。已经签名的清单仍按原公钥验证，不需要用户数据迁移。
