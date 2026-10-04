# Issue #34 请求阶段诊断

## 范围与决策

- 为本地转发和 LAN 中继的 Chat Completions / Responses POST 请求记录阶段。
- 服务于排查慢链路的用户和维护者，帮助区分请求体上传、转交和模型调用等待。
- 使用宿主 info logger；每个请求只记录固定数量事件，不逐 token 记录，不新增存储。
- 只输出服务端生成的请求 ID、受限的父请求 ID、固定端点、时间和结果。
- 不输出请求正文、模型输入输出、请求头、密钥、IP 或用户提供的模型名称。
- 不调整超时、重试、心跳或用量计费，不声称能够修复插件之外的传输延迟。

采用请求阶段日志，而非只增加完成日志：后者仍无法观察未完成的上传。
暂不新增 UI 或持久化请求数据库，避免扩大配置、迁移和维护范围。
日志回调异常不能影响请求，所有监听随请求结束清理。

## 事件

宿主日志前缀为 `our-free-model request:`，其后是 JSON。
`requestId` 标识当前一跳；LAN 中继为本地转发提供 `parentId`，
可将两跳关联。父 ID 仅供诊断，不作为认证依据。客户端提供的
`x-ofm-request-id` 在 LAN 入口被替换；本地入口总是生成自己的新 ID。

`at` 为 Unix 毫秒时间；`elapsedMs` 使用单调时钟计算相对入口的耗时。

| stage | 含义 |
| --- | --- |
| received | Node 已解析 HTTP 请求头，尚未读取完整请求体 |
| body_received | 请求体读取完成；本地入口还已完成 JSON 解析 |
| relay_dispatch | LAN 中继开始创建到本地转发的 HTTP 请求 |
| relay_connected | 中继到本地转发的 TCP 连接已建立 |
| dispatch | 本地转发开始调用 completion 回调 |
| first_delta | 流式回调首次产生非空文本、思考或工具参数增量 |
| generation_finished | completion 回调已返回 |
| finished | HTTP 响应已交给 Node 输出，附 HTTP 状态和执行结果 |
| aborted | HTTP 请求或响应在完成前断开 |

`dispatch` 包含适配器准备和请求上游的过程，不证明上游已收到请求。
`first_delta` 不包含 HTTP 响应头、SSE 心跳和空增量；它也不保证客户端
已经显示正文。非流式调用不报告此事件。
`finished` 不证明远端客户端已收到全部字节；流式 HTTP 200 仍可能
携带生成失败，需同时检查本地转发的 `outcome`。LAN 中继的
`outcome: relayed` 只表示转交完成，生成结果应查询关联的本地事件。

## 使用与限制

请求体尚未传完时应只有 `received`；收到 `body_received` 后长时间
没有 `generation_finished`，说明等待已经进入插件处理阶段。
LAN 请求可按本地事件的 `parentId` 查找中继 `requestId`。
每一跳的终态只记录一次，取消后的迟到生成结果不再追加事件。

没有用量记录不等于请求没有到达；没有入口日志也需先排除日志过滤、
进程重启或日志丢失。HTTP 请求头解析之前的 DNS、TCP、TLS 和代理
排队仍需调用方及代理日志定位。SSE 注释心跳仅保活连接，不能重置
只消费有效内容增量的 pi-ai 空闲看门狗。

## 验证记录

- `node scripts/forward-test.mjs` 通过，新增 14 项诊断场景检查，包含
  未完成上传、上传中断、两种端点的流式与 JSON、认证及 JSON 拒绝、
  心跳、流式失败、取消、LAN 关联、logger 异常、畸形 URL 和无关轮询。
- `node scripts/tui-test.mjs` 通过，新增 4 项宿主 logger 集成检查，
  覆盖本地生命周期、LAN 两跳关联及两个转发密钥不进入日志。
- 合并 `origin/main`（`77a5998`）后，`npm test` 返回 19/22；
  三个失败项为 `manifest`、`release`、`catalog`，原因是发布源码
  与旧签名清单、目录摘要不匹配。当前 main 也包含尚未重签的已合并
  发布文件变化，本次另修改了 `index.js` 和 `src/forward.js`。
  其他套件通过，包含上述两个受影响套件及已合并的热力图回归。
- 使用原工作区已安装的 TypeScript 执行
  `tsc --noEmit -p tsconfig.json`，退出码为 0；此检查范围仅为 adapter。
- `node --check src/forward.js`、`node --check index.js` 与
  `git diff --check` 通过。
- 未复现用户当时的外部传输环境，未进行真实 DSH 桌面验收或发布升级。

## 发布

修改发布源码后，维护者需使用既有发布私钥重签清单，同步目录完整性
记录，并按 `RELEASING.md` 刷新 revision。贡献者不替换签名公钥。
