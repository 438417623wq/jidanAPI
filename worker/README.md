# EAC 网关（Cloudflare Worker）部署与轮换

Worker 是协付渠道的**唯一持密方**：插件里密封的只是本网关的地址和一个签名密钥，中继（relay）的真实 key 只存在 Worker 的环境变量里。插件被逆向得到的只是一个可以随时吊销的间接入口。

```
插件（签名请求，无密钥） → Worker（验签/白名单/限速，注入真 key） → 中继
```

## 签名契约（worker.js 实现并锁定）

```
x-ofm-timestamp: <unix 毫秒>
x-ofm-signature: hex(HMAC-SHA256(secret, "<ts>\n<METHOD>\n<path>\n<hex(sha256(body))>"))
```

- 时间戳偏离超过 `CLOCK_SKEW_SECONDS`（默认 600s）即拒绝（防重放）；
- 签名恒时比较，`SIGNING_SECRETS` 里任意一个匹配即放行（轮换期间新旧并存）；
- 仅放行 `GET /v1/models` 与 `POST /v1/chat/completions`，其余 404；
- `MODELS` 白名单之外的模型 403；请求体超过 `MAX_BODY_BYTES` 413；
- 可选 `RATE_LIMITER` 绑定按 IP 限速。

## 部署

### 方式一：面板粘贴（无需本地工具）

1. Cloudflare Dashboard → Workers & Pages → **Create** → Create Worker，名字随意（如 `ofm-eac-gateway`），Deploy 后 **Edit code**，把本目录 `worker.js` 全文粘进去，Deploy。
2. Worker → **Settings → Variables and Secrets**，添加：
   - Secret `UPSTREAM_URL` = 中继地址（形如 `https://<relay-host>/v1`，取私有凭据文件里的 `base`）
   - Secret `UPSTREAM_API_KEY` = 中继 key（`sk-…`，取 `D:\our free model\eac-channel.private.json` 的 `apiKey`）
   - Secret `SIGNING_SECRETS` = 签名密钥（取同一文件的 `signingSecret`）
   - Variable `MODELS` = 六个模型 id 的逗号列表（见 `wrangler.toml`）
3. （可选）Settings → Bindings → **Rate Limit** 绑定，名字必须叫 `RATE_LIMITER`（如 30 次/60 秒）。

### 方式二：wrangler

```bash
npm i -g wrangler && wrangler login
cd worker
npx wrangler secret put UPSTREAM_URL
npx wrangler secret put UPSTREAM_API_KEY
npx wrangler secret put SIGNING_SECRETS
npx wrangler deploy        # 如需限速，先取消 wrangler.toml 里 bindings 的注释
```

`wrangler tail` 可看实时日志（每请求一行：path/status/耗时，无 body、无 key、无签名）。

## 上线切换（把真 key 从插件里拿掉）

1. 部署完成后，把 Worker 地址（`https://<name>.<subdomain>.workers.dev/v1`，**必须以 `/v1` 结尾**）填进 `D:\our free model\eac-channel.private.json` 的 `workerBase`。
2. 重铸密封件：`node scripts/eac-vault-mint.mjs "D:\our free model\eac-channel.private.json"`（此时起 seal 只含 Worker 地址 + 签名密钥）。
3. 按发布 runbook 出版（版本号、公告、清单重签、双提交）。发布完成后在**中继侧轮换旧 key**——旧版插件自然失效，Worker 用新 key 不受影响。

## 轮换预案

- **签名密钥泄露**（表现：陌生来源的合法签名请求）：`SIGNING_SECRETS` 改为 `"新密钥"`（或 `"新密钥,旧密钥"` 保兼容）→ deploy → 出新版插件；确认旧流量归零后移除旧密钥再 deploy。整个过程秒级生效，中继 key 不用动。
- **中继 key 泄露**：在中继侧轮换 → 更新 Worker 的 `UPSTREAM_API_KEY` → deploy。客户端零改动。
- 两个都泄露：上面两条各做一遍，顺序不限。

## 本地验证

离线套件直接驱动本仓库的 `worker.js`（同一份代码，无逻辑漂移）：`node scripts/test-all.mjs --only vault`，覆盖验签通过/时间戳过期/坏签名/未知路径/白名单外模型/超限 body/流式转发全链路。
