# vendor/jet-hub — 上游免费渠道包的来源与再构建

本目录是 **[dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)**
（Jet Hub）的完整拷贝，由 `dsh-our-free-model` 的 Host 半身在独立 fiber 上挂载，
使 CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、
Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini、OpenCode 这十四个渠道的
登录流程、账号池、积分领取、模型黑名单与本地 OpenAI 网关原样可用。

- 上游仓库：`https://gitee.com/iJetLi/deepseek-harness-codearts`
- 吸收的提交：`345f0a07b22713c0ae189ca7d8b97ec4f64626c6`（2026-10-06）
- 许可证：MIT（见 `LICENSE`，与上游一致）

## 目录内容

| 路径 | 说明 |
| --- | --- |
| `src/` | 上游 TypeScript 源码，逐字节保留（便于审计与再构建） |
| `pack.js` | **插件运行时实际加载的代码**：由 `lib/` 经 `scripts/build-channel-pack.mjs` 打包成单文件（jose/undici 内联，`@deepseek-ai/*` 保持外部），使发布清单不超文件上限 |
| `qoder-auth-wasm.wasm` | Qoder 加密推理所需的 WASM，必须与 `pack.js` 同目录（`pack.js` 按 `import.meta.url` 定位它） |
| `locale/` | 上游文案 |
| `scripts/`、`tsconfig.json`、`package.json` | 再构建所需的元数据（`lib/` 与 `node_modules/` 不入库，按下面步骤重建） |

宿主提供的依赖（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials`、
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不在此目录，按 Node 解析规则
从安装它的 profile 的 `node_modules` 取；缺少时渠道包整体降级（`/summary.channels`
报告 `state: "failed"` 与原因），免费车道不受影响。

## 再构建

`lib/` 由上游自己的工具链产出，步骤与上游一致：

```bash
# 0) esbuild 与上游 devDependencies 不在本仓库：准备一份上游 checkout（或
#    npm i -D esbuild typescript @deepseek-ai/*），下方以 OFM_ESBUILD_DIR 指向它
# 1) 用上游工具链把 src/ 编译回 lib/（在准备好的 checkout 内执行）
npx tsc -p <checkout>/tsconfig.json            # 产出 <checkout>/lib/*.js
# 2) 把 lib/ 拷到 vendor/jet-hub/lib/，同时把 jose、undici 的**实体目录**拷到
#    vendor/jet-hub/node_modules/（打包器要在本目录内解析它们；上游 checkout 里
#    是 pnpm 符号链接，cp -r 时解引用即可）
# 3) 打包 + 摆放 WASM：
npm run channel-pack                            # 产出 vendor/jet-hub/pack.js（2.7 MiB 单文件）
cp vendor/jet-hub/lib/qoder-auth-wasm.wasm vendor/jet-hub/qoder-auth-wasm.wasm
# 4) 清理构建中间件（lib/ 与 node_modules/ 不入库、不随包分发）
rm -rf vendor/jet-hub/lib vendor/jet-hub/node_modules
```

本目录**不含**上游的浏览器半身（`plugin-src/client`）与其 Jet Hub 设置页——
界面由 `dsh-our-free-model` 自己的三页界面取代，渠道操作经上游的
`/api/jet-hub` RPC 完成（`connection.rpc.call('/api', 'jet-hub', { method, payload })`）。
