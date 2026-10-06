# OFM GitHub 授权后 Desktop 未登录：服务器排查与修复交接

日期：2026-10-06  
网关：`https://ai.dtyg123.dpdns.org/eac`  
适用：自建 Node EAC 网关及其 Nginx / Cloudflare 代理链路。

## 1. 需要服务器侧完成什么

用户在浏览器完成 GitHub 授权后，OFM Desktop 仍显示未授权，等待页面没有完成登录。

请维护者完成三件事：

1. 查本次 OAuth 回调和令牌领取是否到达同一网关进程，以及该进程是否重启。
2. 部署附件中的 `auth-github.mjs` 修复，启用“保留领取 → 客户端保存 → 确认领取”协议。
3. 用一个全新的 Desktop 登录会话验收，确认用户令牌落盘、授权状态正确。

本机客户端修复已安装；**远端尚未完成部署，不能把本问题标记为已解决**。本次不调整 GitHub / Star 要求，也不切换强制鉴权开关。

## 2. 已确认的证据

| 检查项 | 实际结果 | 能说明什么 |
| --- | --- | --- |
| 早先一次真实令牌领取 | HTTP 520，约 8446ms，非 JSON、没有令牌；后续重试 pending | 领取链路出现过远端错误；尚无日志，不能确定 520 来自哪一层 |
| 再次授权后，领取当前 UI 的关联码 | HTTP 200，约 2626ms，`status=pending` | 当次响应没有提供可领取令牌 |
| 本机用户授权文件 | 领取前后均不存在 | Desktop 没有成功保存用户令牌 |
| 远端 `/auth/status` | HTTP 200；configured=true、required=false、authorized=false | OAuth 已配置，当前为兼容期；未携带令牌时未授权是正常结果 |
| 随机关联码、无令牌请求 `POST /auth/ack` | HTTP 404，`not found` | 当前访问链路没有提供新版确认接口；修复版应返回 401 |
| 远端 `/auth/github/start` | HTTP 302；回调地址是同域 `/eac/auth/github/callback`；state 对应请求的关联码 | 发起端的回调地址和关联码绑定符合预期 |
| 无效 state 的回调 | HTTP 400，授权已过期 | 回调路径能够到达预期授权处理器 |
| 本机修复文件 | index、client、eac-login 的 SHA 与修复源码一致 | 本机已经装入此次客户端修复 |

**还不能确定的根因：** 浏览器成功页是否对应当前等待的关联码、旧接口是否已消费令牌、进程是否重启、多实例是否造成状态不一致。应以本次成功页和服务器日志核实，不根据 HTTP 520 或 pending 单独下结论。

## 3. 修复内容与交付文件

交付包包含：

- `README_CN.md`：本文。
- `auth-github.mjs`：修复后的服务器授权模块。
- `auth-github.patch`：相对于基线提交的单文件补丁，路径为 `worker/auth-github.mjs`。
- `SHA256SUMS`：交付文件的 SHA-256。

基线提交：`713b03f2dbd9556a776fc8a50a8a2976a363da5a`。  
**本次授权修复目前是独立工作区中的未提交修改。PR #107 和上述基线提交不包含这份新增修复，直接拉取它们不能完成部署。** 请审查随包文件或补丁后部署。

原模块 SHA-256：

```text
34ab5203f8867f82e5a3aa258f4a29975c1c15e8343dbd64d9c8eb6e1f07a6ec
```

修复模块 SHA-256：

```text
2c2b03a3d3fa6cc28dbe144e9976d70125716c21a81a5ed396fbd376ca9b9549
```

### 领取协议

| 客户端请求 | 修复后行为 |
| --- | --- |
| 旧客户端：`GET /auth/poll?link=...` | 保留原有一次领取行为 |
| 新客户端：`GET /auth/poll?link=...&retain=1` | 成功响应返回 token 和 `ackRequired:true`；确认前保留同一令牌，最多 15 分钟 |
| `POST /auth/ack?link=...`，携带匹配的 `x-ofm-user` | 确认后移除待领取记录，返回 200；重复有效确认可幂等成功 |
| ACK 不携带令牌，或令牌与待领取记录不匹配 | 返回 401，不消费待领取记录 |
| 令牌已吊销或 Star 判定已失效 | 不重新交付该令牌 |

新客户端先原子保存并回读本机令牌，再确认领取。保存失败时不确认，稍后可以重领。客户端还修复了轮询错误提示、并发领取、关闭设置后继续登录、退出登录竞态。

**限制：** 待领取记录仍在进程内存中，修复没有实现跨重启或多实例共享。服务端重启后，需要重新发起登录。

## 4. 部署前检查

先确认实际进程名、入口、部署目录、监听端口和进程管理用户。`/www/eac-gateway/` 与端口 `17788` 只是仓库示例，尚未核实这台服务器的实际值。

### 4.1 进程与重启情况

在运行该网关的用户下执行。下面只输出 PM2 的运行信息，不打印环境变量里的密钥：

```bash
pm2 jlist | node -e '
let text = "";
process.stdin.on("data", chunk => text += chunk);
process.stdin.on("end", () => {
  for (const p of JSON.parse(text)) {
    const e = p.pm2_env || {};
    console.log(JSON.stringify({
      name: p.name, pid: p.pid, id: p.pm_id,
      status: e.status, script: e.pm_exec_path, cwd: e.pm_cwd,
      mode: e.exec_mode, watch: e.watch,
      restarts: e.restart_time, unstableRestarts: e.unstable_restarts,
      startedAt: e.pm_uptime
    }));
  }
});'
```

本实现要求 **fork 模式、单实例、watch=false**。网关会写 stats.json，开启目录 watch 可能反复重启；cluster / 多实例会各自持有待领取队列和用户令牌索引。还应检查 Nginx upstream、容器副本或其他启动器是否指向多个网关。

如果需要纠正进程模式，通过现有部署配置处理这个网关，保留原入口、cwd、运行用户和环境变量。不要执行 `pm2 restart all` 或 `pm2 delete all`。

### 4.2 对照日志

请用户提供新一轮登录的时间，查该时间附近的：

- Nginx access / error 日志：callback、poll 的时间、HTTP 状态、上游状态与耗时，以及连接关闭 / 上游重置。
- PM2 或其他启动器日志：同一时段 PID、重启计数、退出、崩溃、OOM 和 watch 重启。
- Cloudflare 事件：若再次出现 520，记录**那次 520 自己的** Ray ID 与时间，对照源站日志。其他成功响应的 Ray ID 不能替代。

需要回答：成功回调由哪个进程处理；随后 poll 是否到达同一进程；期间是否重启；成功回调的关联码是否与 Desktop 的关联码相同。

现有应用日志不保证包含这些完整信息。必要时短期加入 PID、路径、状态和关联码摘要诊断，验收后撤下；不要记录完整 OAuth code/state、用户令牌或 GitHub 凭据。Nginx 原始 request_uri 可能已经含 OAuth 参数，分享日志前只保留路径和诊断字段，敏感参数留在服务器内核对。

### 4.3 代理和配置

- 公共回调地址应为 `https://ai.dtyg123.dpdns.org/eac/auth/github/callback`，与 OAuth App 配置对应。
- Nginx 原样转发 `/eac/`，不剥掉前缀；允许 `/eac/auth/*` 的 GET 和 POST，且不缓存授权响应。
- 对比本机回环端口与公网：本机 ACK=401、公网 ACK=404 时，先查代理路由、旧 upstream 或其他实例；两边都 404 时，先核对实际加载的代码。
- 保留原 `USER_STORE_KEY`、签名密钥、GitHub OAuth 配置、用户存储路径和中继配置。不要在修复时新生成或轮换这些密钥，否则既有授权可能失效。
- `REQUIRE_USER_TOKEN=0` 表示兼容期，不会阻止正确登录。开启强制鉴权不会修好令牌领取，应保持原部署策略。

## 5. 部署步骤

以下是单文件更新流程。**所有占位值必须替换为核实后的实际值**；进程重启会清空待领取登录，也可能中断在途对话，请安排维护窗口。

```bash
DEPLOY_DIR='/实际网关部署目录'
FIX_DIR='/交付包解压目录'
APP_NAME='实际PM2网关进程名'

cd "$FIX_DIR"
sha256sum -c SHA256SUMS
node --check "$FIX_DIR/auth-github.mjs"
sha256sum "$DEPLOY_DIR/auth-github.mjs"
```

核对当前模块 SHA。如果与上面的原模块 SHA 不一致，先比较服务器定制内容与补丁，人工合并并审查；**不要直接覆盖未知版本**。补丁路径以仓库根目录为基准，部署目录扁平存放文件时，不要直接在该目录运行 git apply。

原模块匹配且修复已审查后：

```bash
BACKUP_DIR="$DEPLOY_DIR/backup-eac-auth-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$BACKUP_DIR"
cp -p "$DEPLOY_DIR/auth-github.mjs" "$BACKUP_DIR/auth-github.mjs"

cp "$FIX_DIR/auth-github.mjs" "$DEPLOY_DIR/auth-github.new.mjs"
chmod --reference="$DEPLOY_DIR/auth-github.mjs" "$DEPLOY_DIR/auth-github.new.mjs"
node --check "$DEPLOY_DIR/auth-github.new.mjs"
mv "$DEPLOY_DIR/auth-github.new.mjs" "$DEPLOY_DIR/auth-github.mjs"
pm2 restart "$APP_NAME"
```

暂存文件保留 `.mjs` 扩展名，以便 Node 正确执行语法检查。确保以原部署用户执行并保持原文件所有者；不要删除 users.json 或更换 .env。使用 systemd / 宝塔其他启动器时，通过原启动器只重启此网关。

## 6. 验收

### 6.1 本机回环与公网接口

以下探针使用随机不存在的关联码，不读取或消费用户令牌。端口示例必须按实际监听值调整：

```bash
LOCAL_PORT='17788' # 替换为实际端口
GATEWAY_ROOT='https://ai.dtyg123.dpdns.org/eac'
PROBE_LINK=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')

curl --silent --show-error --max-time 20 --request POST \
  "http://127.0.0.1:$LOCAL_PORT/eac/auth/ack?link=$PROBE_LINK" \
  --write-out '\nHTTP %{http_code}\n'

curl --silent --show-error --max-time 20 --request POST \
  "$GATEWAY_ROOT/auth/ack?link=$PROBE_LINK" \
  --write-out '\nHTTP %{http_code}\n'

curl --silent --show-error --max-time 20 \
  "$GATEWAY_ROOT/auth/poll?link=$PROBE_LINK&retain=1" \
  --write-out '\nHTTP %{http_code}\n'
```

预期：两次无令牌 ACK 都是 **401**，poll 是 **200 / pending**。ACK=404 表示没有到达新版处理器；HTML 或 5xx 应继续对照代理及源站日志。这个探针只能证明路由与协议已部署，不能代替完整登录验收。

### 6.2 全新登录会话

1. 部署稳定后，在修复版 Desktop 取消旧等待，再发起全新登录；使用这次新打开的入口，不能复用旧成功页。
2. 本人完成 GitHub 授权及 Star 检查，保持 Desktop 设置页打开。
3. 确认新版 poll 返回 ok / ackRequired，Desktop 保存用户令牌后 ACK=200，界面变成已授权。核对接口时不要把令牌打印到日志或转发给他人。
4. 确认本机用户文件位于实际 DSH_HOME 下的 `our-free-model/eac-user.json`。文件存在本身不代表授权有效，还要确认携带该令牌时 `/auth/status` 为 authorized=true。
5. 关闭再打开设置，授权仍正确；用户同意测试退出登录时，确认本机文件被清除、服务端该令牌失效。
6. 观察进程持续运行，没有因 stats 写入反复重启。若仍 pending，回到第 4 节核对同次关联码和进程，不反复让用户重登来代替诊断。

## 7. 验证边界与回滚

本地已完成：贡献者套件 27/27，通过旧协议、新协议保留重领 / ACK、错误或已吊销令牌、15 分钟过期、客户端保存失败、并发领取、退出竞态、错误提示和页面恢复回归。adapter 类型检查、运行文件语法检查、git diff --check 均通过。

**尚未完成：** 服务器部署、520 日志根因定位、最终真实 GitHub 登录与授权令牌落盘验收。完整套件使用本地桩与回环服务，不证明远端已经修好。

需要回滚时，恢复本次备份的授权模块并仅重启此网关：

```bash
cp -p "$BACKUP_DIR/auth-github.mjs" "$DEPLOY_DIR/auth-github.mjs.rollback"
mv "$DEPLOY_DIR/auth-github.mjs.rollback" "$DEPLOY_DIR/auth-github.mjs"
pm2 restart "$APP_NAME"
```

不要恢复旧 users.json 覆盖部署后的新授权，也不要删除用户表。若本次修正了 PM2 / 代理配置，保留各自原配置备份；回退配置需再次审查，尤其不要把已确认会造成状态丢失的 cluster / watch 配置直接恢复上线。回滚同样清空内存中的待领取记录，用户需要重新发起登录。

## 8. 请维护者回传的结果

- 实际入口和目录、进程模式、实例数、watch 值、重启情况。
- 线上 `auth-github.mjs` SHA-256、本机回环与公网 ACK 的状态码。
- 一次新登录中 callback → poll → 本机保存 → ACK → authorized 的结果。
- 若失败：时间、路径、HTTP / upstream 状态、进程是否重启；若有 520，附该次 Ray ID。
- 采用的修复、验收结果和仍未解决的问题。不要回传 OAuth 参数、用户令牌或服务器密钥。
