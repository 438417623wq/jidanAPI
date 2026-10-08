# Our Free Model 独立本地服务

这是独立产品的源码入口，不需要 DSH、Cordis、DSH profile 或宿主凭据库。
当前完成第一阶段的公共核心与入口拆分；发布包、网页管理和账号型渠道后续实现。
本阶段从完整仓库运行，暂不能仅复制本目录或将它单独作为 npm 包安装。

## 启动

需要符合仓库 `engines` 要求的 Node.js。在仓库根目录执行：

```powershell
npm run start:standalone
```

也可以指定端口和数据目录：

```powershell
npm run start:standalone -- --port 18900 --data-dir F:\ofm-data
```

启动打印实际 API 地址与密钥文件位置，不打印密钥。默认端口是 `18900`；
端口被占用时沿用共享监听器的自动选端口逻辑。后续启动优先使用本产品上次保存的端口；
`--port` 可以覆盖，`0` 表示由系统分配。

## 数据与鉴权

- 默认目录：`~/.our-free-model`；环境变量 `OFM_HOME` 或 `--data-dir` 可以覆盖。
- 不读取 `DSH_HOME`，不导入 DSH 的配置或凭据。
- API Key 为此产品单独生成，保存在该目录的 `settings.json` 的 `forwardKey` 字段。
- `GET /health` 提供不含凭据的产品状态；推理接口与模型清单需要 `Authorization: Bearer <API Key>`。
- 同一个数据目录只能启动一个本地服务实例。正常退出会清除 `service.lock`。
- 异常退出后若锁仍存在，先检查锁文件记录的 PID，确认旧进程已停止，再移除该锁文件。
- 默认只监听回环地址，此阶段不提供局域网转发和管理接口。

插件仍使用 `DSH_HOME/our-free-model` 或 `~/.dsh/our-free-model`，两者默认互不影响。
不要主动把独立服务的 `OFM_HOME` 指向插件的数据目录。

## 当前接口与渠道

- `GET /v1/models`
- `POST /v1/chat/completions`，包括流式与非流式请求
- `POST /v1/responses`，包括流式与非流式请求
- 匿名免费模型与 Kilo 免费模型
- 本地模型缓存、用量统计、周期刷新、请求取消与退出清理

启动先绑定监听器，再异步刷新模型清单。默认不发可用性探测请求，避免启动就消耗推理额度；
`--probe` 可启用探测。上游不可达时保留缓存；`--no-refresh` 完全跳过清单刷新与周期任务。

EAC 宿主授权、账号渠道包、插件热重载和插件自更新均不在独立入口挂载。
网页管理尚未实现；访问 `/` 或 `/health` 当前返回 JSON 状态。

## 验证

```powershell
npm run test:standalone
npm run test:contributor
```

独立服务专项测试只使用本机 HTTP 替身，不访问真实上游。测试覆盖独立数据与密钥、
两个 API 协议、流式响应、缓存、并发刷新、退出清理及进程级 DSH 依赖隔离。
