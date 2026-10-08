# yulo-chat

`yulo.top` 博客的聊天室后端：自建账号系统 + 实时消息，全部跑在 Cloudflare 免费套餐上。

- **运行时**：Cloudflare Workers
- **路由 / 校验**：Hono + [`@nanokajs/core`](https://www.npmjs.com/package/@nanokajs/core)（模型 → Drizzle schema / Zod 校验器）
- **认证**：[`@nanokajs/auth`](https://www.npmjs.com/package/@nanokajs/auth)（登录、JWT、refresh 轮换）
- **数据库**：D1（账号、消息、令牌吊销名单、限流计数、上传配额、全站请求计数）
- **对象存储**：R2（上传的图片 / 音视频 / 文档，直连对外，不走 Worker）
- **实时推送**：Durable Objects + WebSocket Hibernation
- **前端**：博客仓库里的 `assets/js/chat.js`，页面在 `content/chat.md` → `/chat/`

---

## 架构

```
浏览器 (https://yulo.top/chat/)
   │
   │  ① 登录 / 注册 / 历史 / 发消息   —— 跨域 fetch，带 HttpOnly Cookie
   ▼
api.yulo.top  ──  Worker（Hono + nanoka）
   │                ├── 全站请求计数 + 熔断（每 10 秒落一次 D1，见「免费额度核算」）
   │                ├── /auth/*  注册、登录、刷新、登出
   │                ├── /api/*   当前用户、消息历史、发消息、撤回、上传
   │                └── /api/ws  WebSocket 入口（纯转发）
   │
   ├──► D1 ── users / messages / auth_blacklist / rate_limits / upload_usage
   │
   ├──► R2 ── 上传的文件（线上由 R2 直连对外，不经过 Worker）
   │
   └──► ChatRoom Durable Object（一个房间一个实例）
            └── 用 Hibernation API 持有所有 WebSocket，
                收到新消息就广播给所有在线连接，并维护在线人数
```

为什么 WebSocket 走独立的 Durable Object 而不是轮询 D1：
免费套餐的 D1 是按**读取行数**计的，轮询等于每个在线用户每几秒烧一次额度；
而 DO 的连接空闲时会被换出内存（Hibernation），不计 compute duration，
心跳还由运行时直接回 `pong`，连唤醒都不产生。几十人同时在线也远在免费额度内。

**为什么 API 必须挂 `api.yulo.top`、不能挂 `xxx.workers.dev`**：
前端把 token 放在 HttpOnly Cookie 里（JS 读不到，XSS 偷不走）。Cookie 要能带上，
`api.yulo.top` 与 `yulo.top` 必须属于**同一个可注册域**（同站），
这样 `SameSite=Lax` 就够用。挂到 `workers.dev` 会变成跨站，
只能退回 `SameSite=None`，而它会被浏览器的第三方 Cookie 策略拦掉。

---

## 目录结构

```
workers/chat/
├── wrangler.jsonc           # Worker 配置：自定义域、D1、DO、CORS 白名单
├── nanoka.config.ts         # 模型注册表（nanoka generate 读它）
├── drizzle.config.ts        # drizzle-kit 配置
├── .dev.vars                # 本地开发密钥（已 gitignore）
├── drizzle/
│   ├── schema.ts            # nanoka 生成，勿手改
│   └── migrations/
│       ├── 0000_*.sql       # drizzle-kit 生成（手工加过 COLLATE NOCASE）
│       ├── 0001_chat_indexes.sql        # 手写索引，为了省 D1 读取额度
│       └── 0006_messages_cursor_index.sql  # 手写：复合游标的配套索引（见第 21 条）
├── src/
│   ├── index.ts             # 入口：导出 Worker 与 ChatRoom
│   ├── app.ts               # 组装 Hono 应用（按 isolate 缓存）
│   ├── room.ts              # ChatRoom Durable Object
│   ├── hasher.ts            # scrypt 密码哈希（为什么不用自带的 PBKDF2，见文件注释）
│   ├── blacklist.ts         # D1 版 refresh 令牌吊销名单
│   ├── rate-limit.ts        # D1 固定窗口限流
│   ├── global-limit.ts      # 全站每日请求数熔断（内存累加 + 每 10 秒落库，见「免费额度核算」）
│   ├── quota.ts             # 上传配额：文件数按天、字节数按累计总量（见第 23 条）
│   ├── system-message.ts    # 系统提示（进出房间 / 撤回）的文案与落库语句（见第 25 条）
│   ├── middleware.ts        # Cookie → Authorization 桥接、取客户端 IP
│   ├── origins.ts           # 来源白名单、Cookie/令牌读取
│   ├── config.ts            # 常量集中处
│   ├── models/              # 表定义（nanoka 字段 DSL）
│   └── routes/              # auth.ts / chat.ts / media.ts
└── scripts/
    ├── smoke.mjs            # 后端端到端冒烟测试（156 项）
    ├── frontend-test.mjs    # 用 jsdom 跑真实 chat.js + 真实 Worker（161 项）
    ├── purge-test.mjs       # 清空房间的去重与批量切分（17 项，纯逻辑）
    ├── verify-build.mjs     # 构建产物 + 后端源码不变量（32 项，CI 里也跑）
    ├── rate-limit-test.mjs  # 真实限流阈值（22 项，自带 STRICT_RATE_LIMIT 的 server）
    ├── probe-production.mjs # 探线上健康
    └── inspect-d1.mjs       # 直接读本地 D1 的 SQLite，排查用
```

---

## 本地开发

```bash
cd workers/chat
npm install
npm run migrate:local        # 建本地 D1 表结构
npm run dev                  # http://127.0.0.1:8787
```

`.dev.vars` 里已经放了一个仅用于本地的 `AUTH_SECRET`，不用额外配置。

测试（需要另一个终端开着 `npm run dev`）：

```bash
npm run typecheck            # TypeScript 全量检查
npm run smoke                # 后端 128 项
npm run frontend-test        # 前端 153 项（需要先 hugo 构建出 public/chat/index.html）
npm run verify-build         # 构建产物 + 后端源码不变量 24 项（不需要 dev server，hugo 构建完就能跑）
npm run purge-test           # 清空房间的去重与批量切分 17 项（纯逻辑，不需要任何服务）
npm run rate-limit-test      # 真实阈值 22 项（自己起一个 STRICT_RATE_LIMIT 的 dev server）
npm run inspect-d1           # 打印本地 D1 里的表结构、账号、限流、吊销名单
npm run probe-production     # 探线上 api.yulo.top + /chat/ 页面是否健康
```

> `probe-production` 会往**生产**的 `rate_limits` 写一行：它要探「登录路由」，
> 而登录失败是被记账的（那正是限流的一部分）。写入的 key 是
> `login:<你的IP>:definitely-not-a-real-user-xyz` —— 带一个不存在的用户名，
> 所以既不会影响任何真实账号，也不会把正常登录锁住。跑多少次都安全。
> 其余探测（健康检查、CORS 预检、非法入参注册、页面抓取）都不写库。

> **`verify-build` 和 `typecheck` 已经接进 CI**（仓库根的 `.github/workflows/hugo.yaml`）。
> 守第 11 条那个 `partialCached` 事故的检查从此不再只靠手工跑 ——
> 改坏 footer 会在 CI 就红，而不是等线上「注册按钮点不动」。
> 详见下方「测试覆盖」一节。

> `npm run smoke` 会真的注册账号。注册限额是「同一 IP 每小时 5 次」，而这个脚本一轮要用掉 3 次，
> 所以它**开始前会自动清掉本地 `rate_limits`**（只在目标是 `127.0.0.1` / `localhost` 时才动手，
> 指向远端时直接跳过，不会碰生产数据）。想看当前计数就 `npm run inspect-d1`。

> **改了 `wrangler.jsonc` 里的 `database_id` 之后，本地要重新跑一次 `npm run migrate:local`。**
> Miniflare 的本地 D1 文件名是按 database_id 派生的，换了 id 等于换了一个空库，
> 旧文件还留在 `.wrangler/state` 里但已经没人用了。症状是接口全 500、
> 日志报 `D1_ERROR: no such table: ...`。（`npm run inspect-d1` 会自动挑最近修改的那个库并提示。）

本地联调前端：

```bash
# 仓库根目录
hugo server            # http://localhost:1313/chat/
```

默认情况下页面里的 `data-api` 指向 `https://api.yulo.top`，也就是**线上后端**
——`ALLOWED_ORIGINS` 里已经放了 `http://localhost:1313`，所以改前端时直接对着线上 API 调是可行的。
代价是注册的账号、发的消息都会真的写进线上 D1。

想让本地页面连本地 Worker，用 Hugo 的环境变量覆盖，不用改文件：

```powershell
# PowerShell
$env:HUGO_PARAMS_CHAT_APIBASE = "http://127.0.0.1:8787"; hugo server
```

```bash
# bash / zsh
HUGO_PARAMS_CHAT_APIBASE=http://127.0.0.1:8787 hugo server
```

改完前端记得重建一次并跑 `npm run verify-build`，它守的是这次线上事故的那两个不变式。

---

## 部署

> 下面标 **[你操作]** 的步骤需要你自己的 Cloudflare / GitHub 凭据，Agent 代替不了。

### 0. 前置条件

- Cloudflare 账号，且 `yulo.top` 这个 zone 在该账号下（已经确认 NS 指向 Cloudflare）
- 本机 `wrangler` 已登录：**[你操作]** `npx wrangler login`

### 1. 创建 D1 并回填 database_id

**[你操作]**

```bash
npx wrangler d1 create yulo-chat
```

把输出里的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`
（现在那里是一串全 0 的占位值；本地 `--local` 不用它，线上必须换掉）。

### 2. 建表

**[你操作]**

```bash
npm run migrate:remote
```

### 3. 注入签名密钥

**[你操作]** 生成一个随机值并写入（`AUTH_SECRET` 必须 ≥ 32 字符）：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npx wrangler secret put AUTH_SECRET
```

### 4. 确认 CORS 白名单

`wrangler.jsonc` 里的 `vars.ALLOWED_ORIGINS` 目前是：

```
https://yulo.top,http://localhost:1313
```

上线后如果不想再让本地地址跨域访问，把后半段删掉再部署一次即可（非必须）。

### 5. 部署

**[你操作]**

```bash
npm run deploy
```

`wrangler.jsonc` 里声明了 `routes: [{ pattern: "api.yulo.top", custom_domain: true }]`，
部署时 wrangler 会自动创建这个自定义域和对应的 DNS 记录。

### 6. 验证

```bash
curl https://api.yulo.top/api/health
# {"ok":true,"service":"yulo-chat"}
```

然后浏览器打开 `https://yulo.top/chat/`，注册一个账号试试。

### 7. 把自己设成管理员

管理员可以撤回**别人**的消息。注册完之后：

**[你操作]**

```bash
npx wrangler d1 execute yulo-chat --remote \
  --command "UPDATE users SET role='admin' WHERE username='你的用户名'"
```

### 8. 博客侧

`hugo.toml` 里已经配好（`params.chat.apiBase = "https://api.yulo.top"`），
`content/chat.md` 和导航入口也已就位。把改动推到 `main`，
GitHub Actions 会照常构建并部署到 GitHub Pages —— 它只处理 `public/`，
不会碰 `workers/`。

### 以后想自动化部署 Worker（可选）

在仓库根加一个独立的 workflow，push 到 `main` 且改动了 `workers/chat/**` 时触发：

```yaml
# .github/workflows/deploy-chat-worker.yaml
name: Deploy chat worker
on:
  push:
    branches: [main]
    paths: ['workers/chat/**']
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - working-directory: workers/chat
        run: npm ci
      - working-directory: workers/chat
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

需要在仓库 Secrets 里加 `CLOUDFLARE_API_TOKEN`（权限：Workers Scripts:Edit、D1:Edit）
和 `CLOUDFLARE_ACCOUNT_ID`。

---

## 免费额度核算

| 资源 | 免费额度 | 这个应用的消耗 |
| --- | --- | --- |
| Workers 请求 | 100,000 / 天 | 每次 HTTP 调用 1 次；WebSocket 握手 1 次（连接期间不再计）。**超了是 1027 错误页**，所以自己另设了一道同值熔断，见下 |
| Workers CPU | **10 ms / 请求** | 见下方「最要紧的一条」——密码哈希刻意避开了这个坑 |
| D1 读取 | 5,000,000 行 / 天 | 登录查 1 行；历史一页 50 行（有索引）；发消息约 2 行 |
| D1 写入 | 100,000 行 / 天 | 发消息 1 行；登录失败 1 行；refresh 1 行。**超了是拒绝执行查询**，不是计费 |
| DO 请求 | 100,000 / 天 | 握手 1 次 + 每条消息广播 1 次；心跳由运行时直接应答，不唤醒对象 |
| DO compute | 13,000 GB-s / 天 | 只在真正处理消息时计；空闲连接被 Hibernation 换出后不计 |
| D1 存储 | **单库 500 MB**（账号级 5 GB） | 一条消息不到 1 KB，单库够放几十万条 |
| R2 存储 | 10 GB-month | 上传配额卡在全站累计 8 GB（见下）。**超了是开始计费**，不是拒绝 |

按这个量级，几十人同时在线、每天几千条消息都还有很大余量。

### 所有阈值一览（改限流先看这张表）

| 触发点 | 桶键 | 允许次数 | 窗口 | 备注 |
| --- | --- | --- | --- | --- |
| 登录失败 | `login:<ip>:<用户名>` | 10 | 1 小时 | `peekRateLimit` 只读预检，**失败才记账**（成功登录不写） |
| 注册 | `register:<ip>` | 5 | 1 小时 | ⚠️ **实际只放行 4 次**，见下 |
| 刷新令牌 | `refresh-ip:<ip>`，认得出账号时换成 `refresh:<sub>` | 30 | 1 分钟 | 解不出 `sub` 就退回按 IP（不能放行） |
| 登出 | `logout-ip:<ip>`，认得出账号时换成 `logout:<sub>` | 30 | 1 分钟 | 被限流也照样清 Cookie（第 22 条） |
| 发言 | `message:<sub>` | 10 | 10 秒 | 连发几句不会被误伤 |
| 上传 | `upload:<sub>` | 10 | 10 秒 | 改阈值时**别只在调用点改数字**，读常量 |
| 撤回 | `delete:<sub>` | 30 | 1 分钟 | 独立计数器，见第 15 条 |
| 改密码 | `password:<sub>` | 30 | 1 分钟 | 限流排在「验旧密码」之前，先挡住再烧 scrypt |
| 管理员操作（禁言 / 注销） | `moderation:<sub>` | 30 | 1 分钟 | 防误点和脚本刷管理员令牌 |
| **全站请求**（熔断） | `requests:<UTC 日期>` | 100,000 | 1 天 | fail-open，见下 |
| 全站上传文件数 | `daily:global:<日>` | 300 | 1 天 | 硬拒（429） |
| 单人上传文件数 | `daily:user:<id>:<日>` | 100 | 1 天 | 硬拒；撤回时退回**上传那天** |
| 单人累计上传字节 | `total:user:<id>` | 5 GiB | **永不** | 只有撤回才退，见第 23 条 |
| 全站累计上传字节 | `total:global` | 8 GiB | **永不** | 只有撤回才退 |

> **单次上传的大小上限不在上面这张表里**（它不是频率，是单次请求的闸）：
> 普通用户 **16 MB**、管理员 **100 MB**（`MAX_UPLOAD_BYTES` / `MAX_UPLOAD_BYTES_ADMIN`）。
> 100 MB 是**平台**的请求体上限，再往上写没有意义；两个数字在前端也各有一份
> （提前拦住 + 提示文案里的数字），前后端是否相等由 `verify-build` 钉住。
> ⚠️ 上传**必须带 `Content-Length`**，否则 **411** —— 理由见第 24 条。

**完全没有限流的**：所有 `GET`（历史、成员名单、`/api/me`）走的是「登录 + 索引」那套，
没有计数；`DELETE /api/rooms/:room`（清空房间）只查管理员角色 —— 它是刻意留给管理员的
大批量清理出口，不能顺手给它加额度，否则清理一座刷屏房会先把自己卡住。

> ⚠️ **表里是「允许次数」，代码里要写「+1」。** `consumeRateLimit` 是「先记账、再判断」
> （`hits < limit` 才放行），传 N 表示第 N 次就被拦 —— 想放行 30 次必须传 31。
> 所以 `config.ts` 里所有常量都叫 `*_ALLOWED_PER_WINDOW`，调用点一定能看见 `+ 1`。
> 唯一的例外是注册：它传的是 `REGISTER_LIMIT` 本身、没 `+1`，
> 于是**声明 5 次、实际放行 4 次**。这是历史遗留，`rate-limit-test` 里把 4 写死在断言上，
> 改的时候两边要一起动。

### 全站请求熔断：把平台的硬边界翻译成人话

Workers 免费版一天 10 万请求，超了 Cloudflare 直接返回 **1027 错误页**（免费额度按
**UTC 午夜**重置）—— 那是「整站突然打不开」，连一句能看懂的话都没有。

所以 `src/global-limit.ts` 自己记一笔账，到顶就回 429 + 中文原因 + `Retry-After`。
`GLOBAL_DAILY_REQUEST_LIMIT = 100_000` 和平台额度**同值**：目的不是把额度压小，
而是在撞上平台硬墙之前**先自己拦住**，把 1027 换成一句人话。

它是**成本护栏，不是安全边界**，所以有两处刻意的「不精确」：

| 决定 | 理由 |
| --- | --- |
| 计数走 isolate 内存，**每 10 秒**才批量落一次 D1 | 每请求写一次 = 每天 10 万行写，正好等于 D1 免费额度的**全部**写入量（而且 D1 超了是拒绝查询）。改成每 10 秒落一次后，写入量降到约 8,640 行/天 |
| 同步失败只记日志、**照常放行**（fail-open） | 护栏自身坏掉不该让网站打不开。这与按账号限流的 fail-closed **方向相反**，改的时候别照搬那边 |

判断用的是「库里的总数 + 本 isolate 还没落库的 `pending`」。每个 isolate 各有一份 pending，
所以计数只会**偏保守地早拦**（最坏早拦 10 秒的量），不会漏放很久。

> 复用 `rate_limits` 那张表（`id` / `hits` / `windowStart` 形状正好够），所以**不需要新迁移**。
> 每次同步都会刷新 `windowStart` —— 否则 `rate-limit.ts` 那套「超过 24 小时就删」的清理
> 会把这行当成过期数据清掉，而它其实还在用。
>
> 中间件挂在**CORS 之后**（见 `app.ts`）。挂前面的话 429 响应没有 CORS 头，
> 前端拿到的是一个不透明的网络错误，而不是那句中文提示。

### 和 CPU 10 ms 同性质、本地测不出上线才炸的另外三个上限

这三个都是**单次请求内**的硬限制。本地 `wrangler dev` 一个都不强制，
所以测试全绿不代表线上安全。给任何路径加逻辑前，先数一遍它用了几次。

| 上限 | 免费套餐 | 付费套餐 | 说明 |
| --- | --- | --- | --- |
| D1 查询数 / 一次 Worker 调用 | **50** | 1,000 | 见下 |
| 子请求 → Cloudflare 内部服务 / 每次调用 | **1,000** | 10,000 | R2 的 head/get/put/delete、D1 都算 |
| 子请求 → 外部网络 / 每次调用 | **50** | 10,000 | 这个才是大多数人口中的「subrequest 上限」 |

**D1 的 50 次最容易被忽略。** 现有路径逐条数过（2026-10-08 核）：

| 路由 | D1 查询数 |
| --- | --- |
| `POST /auth/login` 成功 | 2 |
| `POST /auth/refresh` | 3（限流 1 + 黑名单读 1 + 写 1；handler 不查 users 表） |
| `POST /api/messages` | 4 |
| `POST /api/uploads` | 约 10（限流 1 + 用户 1 + 配额预检四条并发 + `markUpload` 四条 batch） |
| `DELETE /api/messages/:id` 带 3 个媒体 | 约 15（含限流那 1 次 + 退配额的 4 条 batch） |
| `GET /api/members`（`scope=all`） | 2（但一次读 500 行，**按行数计费**） |
| `GET /api/members?scope=online` | 1（只查自己那一行；users 表**一行都不读**） |
| `DELETE /api/rooms/:room`（清空） | 约 4（读 body 1 + 删消息 1 + 审计流水 1 + 限流/清理） |

最宽的是撤回那条，约 15 次，离 50 还差得远。
但**加一次限流就是加一次查询**，改动前先回来数一遍。

> 表里那两个「约」指两件事：`rate-limit.ts` 每 32 次写入会顺带清一次过期行
> （踩上那一拍就多一条 `DELETE`），以及配额那四把尺子每次都是**四条语句一起发**。
> 所以别按整数去卡，加逻辑前把上表那一行重新加一遍。
>
> 全站请求熔断**不在这个表里**：它每 10 秒才写一次 D1，摊到单条请求约等于 0 ——
> 这正是它不按「每请求一行」记的原因（那样一天就是 10 万行，吃掉 D1 的全部写入额度）。

> `scope=online` 那一行的价值不在「少一次查询」，而在「少读 **500 行**」——
> D1 是按读取行数计费的，成员名单原本每次有人进出都要刷全表。
> 详见 `/api/members` 那个路由上的注释。

都还有余量，但**给某条路径加一次限流就是加一次查询**。如果哪天某个路由要拆成
更多查询，先回来重新数一遍。

**R2 逐个删会撞 1,000。** `DELETE /api/rooms/:room`（清空房间）原先对每个媒体
对象调一次 `MEDIA.delete(key)`。房间文件超 1000 个时会在第 1001 个上失败，
而 `try/catch` 会把异常吞掉、`app.db.delete` 照常执行 →
**消息没了、文件永久残留**，正是这个项目最想避免的孤儿对象。
`R2Bucket.delete()` 支持传数组（一次最多 1000 key），所以这条路径必须走批量。

---

## 设计取舍与踩过的坑

这几条都是实际调试出来的，不是理论推演。改动前请先读一遍。

### 1. 密码哈希必须用原生 scrypt，不能用库自带的 PBKDF2

`@nanokajs/auth` 默认的 `pbkdf2Hasher` 走 WebCrypto，迭代次数硬编码 310,000。
本机实测**单次约 40 ms**，而免费套餐的 CPU 上限是 **10 ms / 请求**，
超了直接返回 1102，不是变慢而是整个请求被掐掉。
更麻烦的是本地 `wrangler dev` **不强制**这个限制，所以本地全绿、上线必挂。

所以 `src/hasher.ts` 用 `node:crypto` 的 scrypt（原生实现、走线程池，不在 isolate 线程上跑），
并在 `wrangler.jsonc` 打开 `nodejs_compat`。存储格式自带参数
（`$scrypt$N$r$p$salt$hash`），以后调参不用洗数据。

### 2. 模型里的密码字段必须叫 `password`

`createAuth({ fields })` 里的名字是**一物两用**的：

```js
const passwordValue = body[passwordField]   // 读请求体
const storedHash    = user[passwordField]   // 读数据库行
```

字段名如果叫 `passwordHash`，登录请求就得发 `{"passwordHash": "<明文密码>"}` ——
既反直觉又危险。所以这一列叫 `password`（存的确实是 scrypt 哈希，Django 也是这个惯例），
再配 `.writeOnly()` 保证它不会出现在任何响应里。

### 3. 登录限流中间件不能 clone 请求体，也不能靠 try/catch 记账

两个坑叠在一起：

- **读 body 要用 `c.req.json()`**，不能用 `c.req.raw.clone().json()`。
  Hono 把 body 文本缓存在 `bodyCache.text`，下游 `loginHandler` 再调 `json()` 会命中缓存；
  clone 出去读是另一份流，既不入缓存又把原始 body 消耗掉，结果 `loginHandler`
  解析失败并抛它自己的 `HTTPException(401)` —— 现象是**密码完全正确也一律 401**。
- **失败记账要看 `c.res.status`**，不能写在 `catch` 里。
  Hono 的 `compose` 是在「抛出的那一层」就地调用 `onError` 并把响应写进 `c.res`，
  异常不会冒泡回上层中间件。写成 `try/catch` 会静默失效（限流表里永远没有记录）。

### 4. WebSocket 转发必须原样透传，身份校验放在 DO 里

升级请求一旦 `new Request(original, { headers })` 就不再是「运行时的升级请求」，
DO 里的 `acceptWebSocket()` 会拒绝。所以 Worker 侧不做鉴权、只做 Origin 校验
（防跨站 WebSocket 劫持），把 `c.req.raw` 原样转给 DO，由 `room.ts` 自己读 Cookie、
验 JWT、查用户名。代价是每次握手多一次 D1 读取，可以接受。

### 5. 撤销登录态靠 D1 吊销名单，而不是删 Cookie

JWT 是无状态的，删掉 Cookie 并不能让已经泄露的 refresh token 失效。
所以开了 `jwt.rotation: true`，每用一次就换新的 jti，旧的进 D1 名单。
登出接口（`POST /auth/logout`，库不提供 `logoutHandler`，是自己实现的）
会用库导出的 `verify()` 验明 refresh token 后主动吊销它。
库只自带 KV 版名单，这里换成 D1 版：少配一个云资源，而且
**D1 强一致、KV 最终一致**（库的 README 自己写了 KV 版存在并发 refresh 都通过的窗口）。
名单里存的是 `sha256(jti)`，不是明文。

### 6. 索引是手写的，因为 nanoka 的字段 DSL 不支持索引

`drizzle/migrations/0001_chat_indexes.sql` 给消息表建了
`(room, deleted, createdAt)` 复合索引。D1 按读取行数计费，
没有索引时一次历史翻页就要全表扫描，按 5000 条消息估算差 100 倍。
这个索引不在 drizzle 快照里，所以后续 `drizzle-kit generate` 不会重复建也不会删它。

> 注意：这个索引后来被 `0006_messages_cursor_index.sql` **替换**掉了 ——
> 历史游标改成 `(createdAt, id)` 复合键之后，它满足不了新的 `ORDER BY`
> （原因和验证方法见第 21 条）。现在生效的是
> `messages_room_deleted_created_id_idx (room, deleted, createdAt, id)`，
> 前三个列和它相同，所以它是纯粹的替代而不是叠加。

### 7. `users.username` 用了 `COLLATE NOCASE`（手改了生成出来的迁移）

SQLite 的比较和唯一索引都跟随列的排序规则。列声明成 NOCASE 之后：
唯一索引自动不区分大小写（`Alice` / `alice` 不能注册成两个账号），
`loginHandler` 内部的 `WHERE username = ?` 也天然不区分大小写，
不用在登录路径上拦截改写请求体。drizzle 的 schema 模型不记录 collation，
所以这个手改对后续 diff 不可见，不会产生漂移。

### 8. 应用按 isolate 缓存

`getChatApp()` 只构建一次。这不是微优化：`createAuth()` 在构造时会**立刻**算一次
`hasher.hash('__dummy__')`（防用户名枚举的时序侧信道），那是一次完整的 scrypt。
若每个请求都重建，就等于每请求白扔一次 scrypt，10 ms 预算根本扛不住。

### 9. 发言限流曾放在 isolate 内存里，现已搬到 D1（保留作为「为什么不能放内存」的记录）

最初的理由是「这条路径本来就有读用户 + 写消息两次 D1 往返，再为限流加一次写不划算」，
所以它是**软限制**（isolate 按 POP 分布、随时回收，换个接入点就能绕过），
只用来防手滑连点。

**这个取舍后来被推翻了**（commit `bb99fb1`）：内存计数挡得住手滑，挡不住真想刷的人——
攻击者每次请求落在不同 isolate 上，等于每次都是全新的空计数。
现在发言和上传都走 `consumeRateLimit` 落 D1，固定窗口、跨 isolate 可靠。

留着这条是想说明：**「isolate 内存计数够用」是一个会在压力下失效的假设。**
判断某个状态能不能放内存，要问「攻击者换接入点之后还算数吗」，而不是「正常情况下准不准」。

### 10. 没有做邮箱验证

免费套餐发不了验证邮件，所以账号只有用户名和密码。这也意味着**开放注册**，
靠限流 + 管理员撤回兜底。想关掉就把 `src/routes/auth.ts` 里的 `/auth/register`
改成校验一个环境变量里的邀请码。

### 11. 聊天室的 `<script>` 必须由短代码输出，不能放 `extend_footer.html`

**这条是上线后真实故障换来的，后果最严重，改动前务必读完。**

PaperMod 的 `baseof.html` 这样调用 footer：

```
{{ partialCached "footer.html" . .Layout .Kind (.Param "hideFooter") (.Param "ShowCodeCopyButtons") }}
```

`partialCached` 的缓存键是后面那几个参数，**里面没有页面路径**。
而 `/chat/` 和每一篇普通文章页的 `.Layout` 都是空、`.Kind` 都是 `page`，
于是它们**共用同一个缓存条目**——谁先渲染，谁就决定了那一整组页面的 footer 内容。

当初把 `<script src=chat.js>` 写在 `extend_footer.html` 里，结果：

- **本地构建**恰好 `/chat/` 先渲染，脚本被泄漏到 `about/` 和所有文章页上，`/chat/` 自己有脚本 → 看起来一切正常；
- **CI 构建**换成别的页面先渲染，`/chat/` 反而拿不到脚本 → 页面骨架在、状态永远停在「正在加载…」，
  一行 JS 都不执行，表现为「注册按钮点不动」。

现在脚本由 `layouts/shortcodes/chat.html` 输出，和骨架用同一个条件、同一次渲染，
结构上不可能再对不上，也不受任何 partial 缓存策略影响。
`npm run verify-build` 把这两个不变式固定成了自动检查：
**`/chat/` 必须有 chat.js，其它任何页面都不许有**。

另外 `assets/js/chat.js` 开头加了一个 `window.__yuloChatBooted` 幂等保护，
万一短代码被误用两次（或有人把脚本挪回 head），也不会把事件监听器绑两遍。

### 12. 改 `database_id` 会让本地 D1 变成空库

Miniflare 的本地 D1 文件名是按 `database_id` 派生的哈希。把 `wrangler.jsonc` 里的占位
UUID 换成真实的之后，本地会多出一个**空**的库文件，旧文件还在但已无人使用。
症状是本地接口全部 500、日志报 `D1_ERROR: no such table: rate_limits`，很容易误判成代码坏了。

本地重新 `npm run migrate:local` 即可（线上不受影响，线上是 `migrate:remote` 管的那一份）。

### 13. 本地 `http://localhost` 上不能带 Secure Cookie

会话 Cookie 配了 `Secure`（线上必须），但浏览器**会直接拒绝「http + Secure」这个组合**——
Chrome 把这种 `Set-Cookie` 丢掉，只在 Network 面板的 Response Headers 里留个痕迹。

症状很迷惑：

- 注册 / 登录接口都返回 **200**，但紧接着 `/api/me` 就是 **401**，前端提示「登录状态没拿到」；
- **注册其实是成功的**，账号真的建好了（数据库里有），于是更容易误判成「密码记错了」。

所以 `src/app.ts` 里 `secure` 改成读一个环境变量：`.dev.vars` 写 `COOKIE_SECURE=false` 就关掉，
线上没有这个变量则保持 `true`。`.dev.vars` 已被 gitignore，生产读不到，不存在被误关的风险。

**同一个坑的另一面**：Cookie 的 host 必须前后一致。`localhost:1313` 配 `localhost:8787`
属于同站（SameSite 只比 scheme + 域名，**不看端口**），Cookie 正常；
但只要有一边写成 `127.0.0.1`，就变成跨站，`SameSite=Lax` 的 Cookie 一样不会被带上，
表现和上面一模一样。所以本地预览的两个地址都用 `localhost`。

### 14. 清空房间：R2 批量删，而且**不要**顺手加「分页」

`DELETE /api/rooms/:room` 原来对每个媒体对象调一次 `MEDIA.delete(key)`。
`key` 逐个删看起来天然省内存，但它是**一次内部子请求**，而 Workers 免费套餐对
Cloudflare 内部服务的子请求上限是 **1000 次 / 调用**（对外部网络只有 50 次）。
房间文件超过 1000 个就会在第 1001 个上失败。

之所以说这个 bug 致命，是因为失败被 `catch` 吞掉，而后面的 `app.db.delete` 照常执行：
**消息全没了、文件永久残留**，而那些 URL 是公开可访问的——「清空」只清掉一半，
且不可恢复。

现在用 `MEDIA.delete(key[])` 按 1000 一批删，并且**用 Set 先去重**
（同一个文件被多条消息引用时只删一次、只计一次）。

**不要给它加分页。** 分页查消息会多花 D1 查询，而 D1 查询的上限是 **50 次 / 调用**，
比 R2 子请求的 1000 稀缺得多，是更紧的约束。消息正文一行最多 500 字，
一间房全部读进来的内存占用在这个量级下完全可接受，所以保持「一条 SQL 查完」。
加了个字段或换个房间名就想翻页的直觉在这里是错的。

`npm run purge-test`（17 项，纯逻辑）把这段批次逻辑的边界钉住了，
其中 1001 那个 case 就是这条坑的回归测试。

### 15. 撤回限流：必须独立计数器，且 `consumeRateLimit` 有个 off-by-one

撤回原先**完全没有限流**，是整个后端唯一一条「无限制、每条都写库」的路由。
它比发言更值得限，因为一次请求撬动的资源多得多：D1 读 2 行 + 写 1 行 + 一次 DO 广播，
带媒体时还有 R2 head × N、R2 delete × N、退配额的 D1 batch（4 条语句 ——
文件数和累计字节各两把尺子，见第 23 条）。

两个必须记住的点：

**① 不能用 `message:` 那个计数器。** 撤回和发言是不同性质的操作，
共用一个桶会互相干扰：一个连着撤回几条旧消息的人，会发现接下来几分钟**发不出话**——
而他只是收拾自己的房间。所以 key 是 `delete:<userId>`。

**② 限流放在 `Message.findOne` 之前**（刻意的 fail-closed）。
放到后面的话，攻击者拿随机 id 打过来就是无限次「读一行 + 404」，这层保护等于没有。
代价是「本来就删不掉」的请求也占额度，但前端一条消息只渲染一个撤回按钮，
点两下第二下拿到 404 就到头了，30 次/分钟的额度足够。

**③ off-by-one：传 N 只放行 N-1 次。** `consumeRateLimit` 是「先记账、再判断」，
窗口里的第 1 条（`hits = 1`）必须放行，所以传 31 才恰好放行 30 次。
**这个坑踩过两次了**（发消息那次、撤回这次），所以这次在 `config.ts` 里
用 `DELETE_ALLOWED_PER_WINDOW = 30` 命名意图、在调用处写 `+ 1`，
并实测验证过：全新用户连打 34 次，前 30 次 404、第 31 次起 429。

阈值是 30 次/60 秒，理由写在 `config.ts` 那个常量上。
管理员的大批量清理**不要**走这个接口 —— 那是「清空房间」的活，
走 `DELETE /api/rooms/:room`（R2 批量删，不受这条限制）。

回归测试：`npm run smoke` 的「撤回限流」一节 6 项，其中一条专门验
**「撤回被限流不影响发言」**（两个计数器分开），这正是 ① 要防的事。

### 16. 迁移文件名：drizzle-kit 按 journal 的 **idx** 编号，会撞上手工改过名的文件

加审计字段那次（`0003_audit_fields.sql`）踩到的：

drizzle-kit 生成的文件名是 `${idx 补零}_${随机名}.sql`，而 `idx` 来自
`drizzle/migrations/meta/_journal.json` 里最后一条 entry。仓库里已经有一个
`0002_create_upload_usage.sql`（它当初也是手工改的名，为了给手写的
`0001_chat_indexes.sql` 让位），所以 journal 里的 idx 号和文件名的数字**不是一回事**：

```
journal: idx 0 → 0000_gray_leo
         idx 1 → 0002_create_upload_usage   ← 手工改过名
         idx 2 → ?   drizzle-kit 会生成 0002_xxx.sql  ← 撞车
```

它照样生成了 `0002_volatile_tyrannus.sql`，和已有文件同前缀。
**wrangler d1 migrations apply 是按文件名排序应用的**，两个 0002 谁先谁后不确定，
线上库的结构就可能对不上。

处理办法：把新文件改名成 `0003_xxx.sql`，并且**同步改 journal 里那条 entry 的 tag**
（快照文件 `meta/0002_snapshot.json` 是按 idx 命名的，不用动）。
改完再跑一次 `drizzle-kit generate`，应当输出 `No schema changes, nothing to migrate` ——
这一句是在确认快照跟上了，没留下漂移。

以后再加迁移，先 `ls drizzle/migrations/` 看一眼现在用到几号了。

### 17. `/auth/refresh` 必须限流，而且废 token 不能成为后门

rotation 开着意味着**每一次成功 refresh 都会往 `auth_blacklist` 写一行**（旧 jti 入名单）。
所以这个接口本质上是「匿名可用的 D1 写接口」—— 请求里只有一个 refresh Cookie，
不需要 access token、不过 `auth.middleware()`。不限流就等于把 10 万行/天的写额度
挂在一个谁都能打的端点上。

两个实现要点：

**① 桶键优先用 token 里的 `sub`。** 但 refresh 路径拿不到 `sub`（没有 middleware），
所以限流中间件得**自己先 `verify()` 一次**把 token 解开。这次验签是亚毫秒级，
相对 10 ms CPU 预算可以忽略，换来的是「按账号限流」的准确度——
不然同一出口 IP 下的几百人会互相连坐。

**② 解不出 `sub` 时退回按 IP 记账，不能放行。** 令牌无效/过期时 `verify()` 会抛，
这时如果直接 `next()` 跳过限流，「拿一堆废 token 反复打」就成了免费的 D1 写路径。
实测验证过这个分支：废 token 前 30 次正常返回 401、第 31 次起 429，
额度和有效 token 完全一致。

> 写这条的测试时要注意：本地请求的 `clientIp()` 一律落到 `unknown`，
> 也就是**所有测试共用一个 IP 桶**。不换桶的话，上一轮跑测试留下的计数还在里面，
> 断言会「碰巧」通过——它验的是上一轮的结果。所以测试里给了一个本轮独有的
> `X-Forwarded-For`。

回归测试：`npm run smoke` 的「refresh 限流」一节 5 项。

---

### 18. 对象不能当 fetch 的 `body` 直接传（会变成 `"[object Object]"`）

`fetch` 的 `body` 只认字符串 / `Blob` / `BufferSource` / `FormData` /
`URLSearchParams` / `ReadableStream`。给它一个普通对象**不会报错**，
而是 `String()` 成 `"[object Object]"`、`Content-Type` 自动变成 `text/plain`。
后端收到一个语法合法但内容不对的 JSON，于是回一句「请输入当前密码」——
驴唇不对马嘴，而且用户看到的提示离按钮很远。

线上真实事故（2026-10-04 复盘）：**改密码永远失败**；
**禁言返回 200 却什么都没做**（后端把残缺请求当成了「解除禁言」，见第 19 条），
管理员看到「已禁言 XXX」还以为处理好了 —— 后者比前者坏得多。

修法分两层，缺一不可：

**① 公共入口兜住。** `api()` 收到纯对象就 `JSON.stringify` 并补 `Content-Type`。
只挑「纯对象」下手，`Blob` / `FormData` / `TypedArray` 一律放行
（上传走的就是 `body: blob`，序列化它会把上传弄坏）。

**② 调用点也写清楚。** 两个调用点都显式写成 `JSON.stringify(...)` + `jsonHeaders()`。
兜底是为了防下一个犯同样错误的人，不是为了让自己这行写得含糊。

> ⚠️ 判定纯对象要用**品牌检查**：
> `Object.prototype.toString.call(body) === '[object Object]'`。
> **不要**用 `Object.getPrototypeOf(body) === Object.prototype` ——
> 后者跟 realm 绑死，跨 realm（jsdom、iframe）时普通对象的原型不是本 realm 的
> `Object.prototype`，于是会被判成「不认识」而放行。
> 这个坑是前端测试抓出来的：断言全红，而 chat.js 在真浏览器里看起来完全正常
> —— 也就是说，**这里如果判错，只在一种环境里坏，而那种环境恰好是测试**。

回归测试：`npm run frontend-test` 的「请求体序列化」一节（12 项，直接对
切出来的归一化函数做单元断言 —— 不需要 admin、也不需要真的改掉测试账号的密码）。

---

### 19. 接口不能把「字段缺失」和「显式 null」合并成同一个值

`moderation.ts` 的禁言接口原先写的是：

```ts
const parsed = muteSchema.safeParse({ minutes: body?.minutes ?? null })
```

而 `minutes: null` 的语义是**解除禁言**。于是 `{}`（字段缺失）和
`{ minutes: null }`（明确要求解除）落到了同一个分支里 —— 一个残缺请求
会**真地把人解除禁言，并返回 200**。

这类「用错也返回成功」的接口是最难查的一种：没有异常、没有错误码、
没有任何东西进日志，只有一句看起来完全正常的成功提示。而它是被第 18 条
那条前端 bug 顺手暴露出来的。

**规则：缺失 → 400，显式 null → 业务语义。** 判据写 `'minutes' in body`，
而不是 `body.minutes ?? null`。`??` 会抹掉「有没有这个字段」这个信息，
而这里恰恰只有这个信息能区分两种意图。

回归测试：`npm run smoke` 里 3 项（缺字段 400 / `null` body 400 /
被拒的请求没有偷改禁言状态）。

---

### 20. WebSocket 的寿命必须被「建立它的那张凭证」卡住

WebSocket 只在握手时验一次令牌，之后 DO 再也不看它。于是这三件事对一条
**已经建好**的连接毫无影响：

- access token 到期；
- 改密码（`revokeAllSessions` 清空了会话表）；
- 账号被管理员注销（`users` 行都没了）。

后果是「人已经删了，只要他不刷新页面就能一直收消息」，而且成员名单里还显示在线。
发声/上传/握手都查 D1，所以「发」是拦住的，漏的恰好是「收」。

两层修法：

**① 握手时确认「这个人还有活着的会话」。** 和用户名合成一条 SQL：

```sql
SELECT u.username,
       EXISTS (SELECT 1 FROM user_sessions WHERE userId = u.id AND expiresAt >= ?2) AS live
FROM users AS u WHERE u.id = ?1
```

少了这条，改完密码 30 分钟内照样能拿旧令牌重连进房间 —— 改密码等于没改。

**② 把令牌的 `exp` 记进 `SocketAttachment`，广播前踢掉过期的。**
这是「连接的最长寿命 = 它凭以建立的那张凭证的寿命」这句设计的落地。

> 为什么放在**广播路径**上，而不是开个 alarm 定时扫：
> 没有广播的时候也就没有内容可漏；而广播一来 DO 必然醒着。
> 等于零额外唤醒、零额外查询。代价是过期连接最多多活「到下一条消息为止」，
> 而这段时间房间里本来就没有新内容。

推论：`ACCESS_TOKEN_TTL_SECONDS` 现在**同时是 WebSocket 的寿命上限**，
调大它等于延长「被注销的账号还能收多久消息」。改那个值时要一起想。

另外顺手修掉一处重复广播：同一条连接异常断开时运行时**既叫 `webSocketError`
又叫 `webSocketClose`**，于是「leave」会播两次 —— 房间里其他人看到同一个人
连着退出两回。用一个不持久化的 `WeakSet` 按连接去重。

回归测试：`npm run smoke` 的「会话吊销后 WebSocket 开不出来」一节 3 项
（吊销前连得上 → 改密码 → 旧令牌握手被拒 401）。
`npm run verify-build` 另有 3 项静态断言钉住 `exp` / 会话校验 / 踢人调用还在。

---

### 21. 复合索引必须和 `ORDER BY` 一起改，否则会把省下的读取额度连本带利花回去

历史消息的游标从单键 `createdAt` 改成了 `(createdAt, id)` 复合键。
动机是**修丢消息**：`createdAt` 是毫秒整数、不唯一，一页正好切在一组同毫秒
消息中间时，单键游标会把「同毫秒、本页没包含」的那几条一起排掉，
而它们**从此再也翻不出来**，且没有任何提示。

危险的地方在这里：`messages.id` 是 **text 主键、不是 rowid**，
所以同一毫秒内它的顺序和索引里的隐含顺序（rowid 升序）**不一致**。
只把 `id` 加进 `ORDER BY`、不动索引的话，老索引就满足不了排序，
SQLite 会把**整个房间**的行读出来再排序 —— 那比压根没有索引更贵，
因为它把 `0001_chat_indexes.sql` 省下来的读取额度连本带利花回去了。

所以 `0006_messages_cursor_index.sql` 把 `id` 加到索引末尾，并删掉原索引
（新索引的前缀 `(room, deleted, createdAt)` 与原索引完全相同，原索引成了纯冗余，
留着只会让每条消息的 INSERT 多维护一个索引）。

**以后改查询形状都要做一遍这个验证：**

```sql
EXPLAIN QUERY PLAN
SELECT id FROM messages
WHERE room = 'general' AND deleted = 0 AND (createdAt, id) < (1790000000000, 'ffff')
ORDER BY createdAt DESC, id DESC LIMIT 51;
```

判据有两条，缺一不可：

1. 出现 `USING COVERING INDEX messages_room_deleted_created_id_idx`；
2. **不出现** `USE TEMP B-TREE FOR ORDER BY`。

第 2 条是关键。只看到「用了索引」还不够 —— 用了索引、又额外排序，
照样是全表读。2026-10-04 实测四种查询形状（首屏 / 行值游标翻页 /
旧单键游标 / 导出的 ASC）全部满足上面两条。

游标条件的写法也有讲究：用**行值比较** `(createdAt, id) < (?, ?)`，
而不是 `createdAt < ? OR (createdAt = ? AND id < ?)`。两者结果一样，
但只有行值形式能被 SQLite 稳定地转成一次索引区间扫描（上面那条
`SEARCH ... AND (createdAt,id)<(?,?)` 就是实测结果）。

参数传**裸毫秒数**而不是 `Date`：`createdAt` 列在库里就是整数（`timestamp_ms`），
而 raw `sql` 模板不会帮忙把 `Date` 转成毫秒 —— 硬塞进去会变成字符串比较，
那才是真正会出错的地方。

导出接口的 `truncated` 也一起修了：原先取 `EXPORT_LIMIT` 条再判
`>= EXPORT_LIMIT`，房间恰好有 1000 条时会**谎报截断**。
改成取 1001 条判 `>`。

---

### 22. 挂在前面的中间件提前 `return`，会让路由里的「清理动作」永远跑不到

给 `/auth/logout` 加限流时踩到的。`logoutThrottle` 挂在路由**前面**，
被限流时直接 `return` —— 于是路由里那两句 `deleteCookie` 从来不执行。
而前端收到**任何**响应（包括 429）都会把自己切回未登录状态。

结果是「界面上显示已退出、Cookie 却还在」，下次刷新页面又自动登录了。
用户会认为「退出登录坏了」——**这比不限流还糟**。

所以被限流时也要把两个 Cookie 清掉：不花钱的动作照做，只把「写黑名单」那一步限掉。

同一轮里另外三处：

- **登出原先完全没有限流。** `revokeRefreshToken` 每次都要往 `auth_blacklist`
  写一行，而这条路由没有鉴权门槛（认不出令牌也照跑）—— 和第 17 条
  「refresh 必须限流」是同一个性质，只是那条更早被注意到。
- **广播失败不能把已经成功的写报成 500。** `Message.create` 落库之后才广播；
  如果 DO 抖一下让异常冒到 `onError`，调用方拿到 500，而消息其实已经在库里了。
  前端的反应是把文本还回输入框、用户再按一次 → **库里多出一条重复消息**。
  也就是说广播失败会「伪造出一个写入失败」，并因此造成真实的重复写入。
  `broadcast()` 内部吞掉异常（并 `console.error` 留痕），响应状态只反映业务写。
- **R2 的归属判定要用不可变的 `userId`，不能用用户名。** 用户名可复用：
  账号注销后那行 `users` 就没了，别人能注册同名账号 —— 按用户名比对会让他
  有权删掉前任上传的文件，额度还退到新账号头上。老对象（metadata 里没有
  `uploaderId`）退回按用户名比，否则就成了「历史文件谁都删不掉」，比不修还糟。

---

### 23. 上传配额：文件数按天、字节数按累计总量，四个键共用一张表

配额有**四把尺子**（原先两把），分成两类 —— 这个划分不是随口定的：

| 键 | 量的是 | 重置 | 挡什么 |
| --- | --- | --- | --- |
| `daily:user:<id>:<YYYY-MM-DD>` | 文件数 100/天 | 每天 | 一个人短时间刷一堆小文件 |
| `daily:global:<YYYY-MM-DD>` | 文件数 300/天 | 每天 | 注册一堆小号一起刷 |
| `total:user:<id>` | 累计字节 5 GB | **永不** | 一个人把聊天室当网盘 |
| `total:global` | 累计字节 8 GB | **永不** | 所有人加起来占满 R2 |

**字节为什么必须累计、不能按天。** 按天重置挡不住网盘用法：每天传满一点，
存储只增不减，而 R2 的免费额度是按**存储量**算的（10 GB-month），
跟「每天传多少」无关。所以字节那把尺子永不清零 —— 只有撤回才退。

**数额是倒推出来的**：R2 免费 10 GB-month，超了是**开始计费**而不是拒绝执行，
所以全站卡在 8 GB、留 2 GB 余量；单账户 5 GB 的含义是「一个人最多占一半」。
单位一律 1024 进制，和仓库里别处一致。

**为什么要四个键而不是两个。** 只按人不挡「注册一堆号」—— 而注册是开放的
（第 10 条）；只按全站不挡「某一个人」，而且一个人刷满会连累所有人。两层各一把。

**半笔账必须退回去。** `markUpload` 四条语句一次 `db.batch`，逐条看 `meta.changes`；
任何一条没更新到（说明额度在那次**纯读**的预检之后被别人抢走了）就把已经记上的
**全部退掉**，让状态回到「这次上传没发生过」。调用方拿到 `false` 就去删刚传的对象并回 429。
预检负责把提示说清楚（「今天已经传了 100 个文件」vs「存储满了，删掉一些」），
带条件的写负责保证计数**永远不越界**，两者分工不同、缺一不可。

**这次改动没有迁移。** `upload_usage` 表本来就有 `id` / `bytes` / `count` 三列，
四个键只是把两个维度分开记（每行只有一个有值）。
代价是**旧数据没有回填**：改之前已经躺在 R2 里的文件不计入累计字节，
也就是 8 GB 这条线是从 0 开始算的 —— 要精确的话得扫一遍 bucket 反推，
按当前体量不值得。

回归测试：`npm run smoke` 的「上传配额」一节，分别验累计字节和按天文件数**两条**拒绝路径，
外加「清空额度后能继续传」。键名和塞账本的方式是否一致，由 `npm run verify-build` 守着。

---

### 24. 管理员的大文件上传必须走流式，而且 R2 只收「长度已知」的流

上限按角色分档：普通用户 16 MB，管理员 100 MB。100 MB 这个数字**不是选的，
是平台的请求体上限本身** —— 再往上写也没有意义，请求根本到不了 Worker
（超了是平台直接回 413）。真正的约束是另外两道墙：Worker 单实例内存 **128 MB**、
CPU **10 ms / 请求**。

所以超过 16 MB 那一档**不能**再 `arrayBuffer()`：把 100 MB 拷进内存这件事本身
就贴着那两道墙。改成「只把开头几 KB 读进内存做魔数嗅探 → 剩下的字节原样转交 R2」，
Worker 里始终没有整份文件。

三个只有踩过才知道的细节：

1. **R2 的 `put()` 只收长度已知的流。** 直接把一个 `ReadableStream` 丢给它，
   会抛 `TypeError: Provided readable stream must have a known length
   (request/response body or readable half of FixedLengthStream)`。
   我们的流既不是 request body（头已经被嗅探读掉了）、也没有长度，
   所以必须过一层 `FixedLengthStream(declared)`。它顺带还是个**长度校验器**：
   实写字节数多于或少于声明值都会让流报错 —— 于是「声明 16 MB 实传 100 MB」
   骗不过账本，那一档的记账因此是精确的。
2. **泵不能 await 在 `put()` 前面。** `FixedLengthStream` 不囤数据：可读端没人消费时
   `writer.write()` 会一直等，而消费它的正是那个**还没被调用**的 `put()`。
   先 await 泵再 await put 就是死锁。正确写法是「先把泵挂起来跑，再把可读端交给 put，
   最后 await 泵」——而且这个 promise 必须被 await 掉，否则日志里会多一个
   unhandled rejection，把真正的错因（put 那条）淹没。
3. **`Content-Length` 从「最好有」变成了「必须有」**（缺失 → **411**）。
   以前缺这个头是允许的（读进来再量），但那条路有个洞：客户端用
   `Transfer-Encoding: chunked` 不带长度，我们就会把整个请求体读进内存，
   而平台允许 100 MB。浏览器 `fetch()` 传 Blob / File 一定带长度，所以这不妨碍真实前端。

另外两处顺序上的讲究：**配额检查提到了读请求体之前**（`checkUploadQuota` 是纯读的，
它不消耗额度，消耗额度的是后面的 `markUpload`；提前判能让一次被拒的 100 MB 上传
不用先传完再收到 429）；**记账用 R2 回给我们的实际大小**而不是声明值。

回归测试：`smoke` 的「管理员大文件上传」一节 —— 真的发 17 MB 并**读回来核对字节数**
（流式上传最典型的失败方式是「接口回 201、R2 里只有一个零头」）、
累计字节账本按真实大小记账、普通用户 413、缺 `Content-Length` 411、额度到顶 429。
「大文件那一档必须用 `FixedLengthStream`」这条**本地测不出来**（开发机上不撞那两道墙），
所以额外在 `verify-build` 里放了一条静态断言把实现方式钉住。

---

### 25. 系统提示（进出房间 / 撤回）和普通消息**同表**存

「谁进了房间」「谁撤回了一条」现在是**真正的消息行**（`messages.kind = 'system'`），
不再是前端拼的一句话。分表存会逼出「两路归并 + 跨表游标」，而历史、清空、导出
三处都得跟着改；同表存之后它们天然按 `(createdAt, id)` 和时间交错，
翻页一行都不用改。

四个值得记下来的决定：

1. **用哨兵作者，不是让 `userId` 可空。** `messages` 那几列都是 NOT NULL，
   改成可空在 SQLite 上等于重建整张表。所以系统行填全零 uuid（RFC 4122 的 nil uuid，
   `crypto.randomUUID()` 永远不会产出）与 `SYSTEM_USERNAME`，二分靠 `kind`，
   **不靠「某个字段是不是空」**。
2. **文案在服务端定。** 因为它要落库：同一条提示对所有人和所有时间都必须长得一样，
   包括刷新之后从历史里读出来的那份。「管理员撤回了**别人**的消息」这句还需要同时知道
   操作者和作者，那个信息只有服务端有。
3. **按「人」而不是按「连接」播报。** 同一个人开三个标签页是三条 WebSocket，
   关掉其中一个不该播「离开了房间」，已经有连接时再连也不该再播「加入了房间」。
   判据是「除了这条连接，还有没有别的连接挂在同一个 userId 上」——
   注意 `webSocketClose` 回调里那条刚断开的 ws **仍然**会被 `getWebSockets()` 返回
   （运行时还没来得及摘掉它），不把自己排除掉的话这个判断永远为真。
4. **房间名记在连接上（`SocketAttachment.room`）。** DO 的实例名是外部用
   `idFromName(room)` 算出来的，实例**没有 API 能问出自己叫哪个房间**；靠「第一次握手时
   记进内存」在 DO 被驱逐后会退回默认值，而驱逐后那条连接断开时恰恰要靠它写离场提示。
   attachment 是跟着连接持久化的，不受驱逐影响。

**写提示失败只记日志，不让请求失败**：撤回本身已经生效（`deleted = true` 已落库、
媒体也删了），为补不上一条提示把请求报成 500，用户会看到「撤回失败」而再点一次只拿到 404；
进出提示更是在**握手过程中**和**断开回调**里写的，让一次 D1 抖动把整个 WebSocket
握手变 500 明显不成比例。

**系统提示不能被撤回**（`kind !== 'user'` → 403）：它不是谁「说」的，而且撤回本身
又会生成一条新提示。前端的渲染层根本不给系统提示加撤回按钮，所以这一条主要是挡手拼请求。

前端那一半：`kind === 'system'` 走一条**居中的窄条**（小字、淡色、无气泡、无撤回按钮、
宽度贴合内容），刻意和对话区分开 —— 渲染成气泡会让人以为有个叫「系统」的人在发言，
渲染成完整一条会把对话截断。正文只能进 `textContent`（里面含**用户可控**的用户名）。

回归测试：`smoke` 的「系统消息」一节（广播文案、进历史、开第二个标签页不重复播、
关一个标签页不播离场、管理员也撤不掉、自己撤 / 管理员撤别人两种文案）；
`frontend-test` 的「系统提示」一节（窄条那几条 CSS 声明、无气泡无撤回按钮、
用 `textContent` 而不是 `innerHTML`）。

---

## 测试覆盖

一共 **366 项**（四个进 CI 的脚本；另有 `rate-limit-test` 22 项，不在 CI 里）。
（项数会随测试增加变化，`2026-10-08` 实测值如下。）

```bash
npm run typecheck      # tsc --noEmit，CI 里也跑
npm run verify-build   # 32 项，只看 Hugo 产物 + 后端源码不变量，不需要任何服务
npm run purge-test     # 17 项，纯逻辑，不需要任何服务
npm run smoke          # 156 项，需要 wrangler dev
npm run frontend-test  # 161 项，需要 wrangler dev + 构建出的 public/chat/
npm run rate-limit-test # 22 项，自己起一个 STRICT_RATE_LIMIT 的 dev server
```

`npm run smoke`（156 项，后端）：

- 健康检查、CORS 预检（含非白名单来源拿不到允许头）
- 注册 / 大小写不同的重名被拒 / 非法输入
- 登录（含大小写不敏感的登录）、错误密码、Cookie 下发
- 未登录访问 `/api/me`、历史、WebSocket 一律被拒
- 非白名单 Origin 的 WebSocket 握手被拒（跨站劫持防护）
- 实时收发：`ready` / `message` / 在线人数
- 发言频率限流（10 秒 10 次，连发几句不会被误伤）、超长消息、历史游标分页与顺序
- 撤回本人消息 + 广播 + 历史消失；撤回连带删掉媒体对象并退上传额度
- **撤回限流**：打满后 429、带 `Retry-After`、在此之前正常走到业务逻辑，
  且**不影响发言**（两个计数器分开，见第 15 条）
- 上传配额：**两条拒绝路径各验一遍**（累计字节触顶、当日文件数触顶），
  外加额度恢复后能继续上传（见第 23 条）
- 管理员导出与清空：非管理员被拒、导出是原始数据、清空只影响目标房间
- **成员名单**：`scope=online` 只回在线的人、带用户名、未登录仍 401
- refresh 轮换、旧令牌重放被拒、登出后 refresh 被拒
- 连续登录失败 11 次触发 429
- **refresh 限流**：有效 token 打满后 429；**废 token 也会被限住**（不是后门）
- **审计**：撤回记下了「操作者」（管理员撤别人时 deletedBy ≠ 作者）；
  清空房间在 `room_purges` 留了一行流水
- **禁言接口**：缺 `minutes` 字段 → 400、`body` 是 JSON `null` → 400，
  且被拒的请求**不会偷改禁言状态**（见第 19 条）
- **会话吊销后 WebSocket 开不出来**：先证明吊销前连得上，改密码后再握手 → 401
  （见第 20 条。这是「改密码要真的把人踢下线」的服务端那一半）
- **系统消息**：进房间时广播一条「XX 加入了房间」并落库、同一个人开第二个标签页
  不重复播、关掉其中一个标签页不播离场、最后一条断开才播；管理员也**撤不掉**系统提示
  （403，而不是 404/200）；自己撤写成「XX 撤回了一条消息」、管理员撤别人的写成
  「XX（管理员）撤回了 YY 的一条消息」。见第 25 条
- **管理员大文件上传**：真的发 17 MB → 201、**读回来核对字节数没被截断**、
  累计账本按真实大小记；普通用户同样的大小 → 413（理由里写 16 MB）；
  缺 `Content-Length` → 411；全站存储到顶 → 429。见第 24 条

`npm run frontend-test`（161 项，真实 `chat.js` + jsdom + 真实 Worker）：

- `chat.js` 引用的 18 个 `data-chat-*` 钩子在真实页面里都存在
- 未登录 → 注册 → 自动登录 → 加载历史 → WebSocket 连上
- 「自己发的消息」既走 HTTP 响应又走 WebSocket 广播，只渲染一条（去重）
- 消息里的 HTML 被当成纯文本，不会创建元素、不会触发行内事件
- 外站图片不会被渲染成 `<img>`（媒体白名单生效）
- 撤回后前端跟着移除；**被限流时显示服务端的中文原因、且消息不会被移除**
- 退出后回到登录面板、无未捕获 JS 错误
- **请求体序列化**：把 `chat.js` 里那段归一化逻辑按固定标记切片、单独 eval 出来做
  单元断言（对象 body 变 JSON 文本 + 补 Content-Type、字符串/`null`/`Blob`/`FormData`
  原样放行、重复调用幂等），外加一条「代码里没有 `body: {` 这种写法」的静态断言。
  见第 18 条 —— 这几条是冲着那个「改密码点了没反应」来的，
  而且**不需要 admin、也不需要真的改掉测试账号的密码**。

`npm run verify-build`（24 项，只检查 Hugo 构建产物，不需要 dev server）：

- `/chat/` 存在、加载了 `chat.js`、有聊天室骨架
- **其它任何页面都没有** `chat.js`、也没有聊天室骨架
  —— 专门守第 11 条那个 `partialCached` 事故，跑一次就能发现脚本串页或丢失
- **消息长度上限前后端一致**：从 `src/config.ts` 抠出 `MAX_MESSAGE_LENGTH`，
  再从构建出的 `/chat/` 里抠出输入框的 `maxlength`，两者必须相等。
  这一项是后来加的 —— 那个数字原先在后端两处、前端一处各写一遍，
  而常量本身没人 import（是个死常量）。现在两边各有单一来源，
  「它们相等」这件事由这条检查钉住。
- **后端源码不变量**（16 项，见第 19/20/22/23 条）：refresh 的会话校验排在限流**之后**、
  `/auth/logout` 挂着限流、`broadcast` 里的 `stub.fetch` 包在 `try` 里、
  `SocketAttachment` 带 `exp`、握手查 `user_sessions`、广播前踢过期连接、
  禁言区分「字段缺失」与 `null`；以及配额那四个键的构造函数在 `quota.ts` 里存在、
  `smoke.mjs` 塞账本用的键与之一致、`app.ts` 挂了全站请求熔断**且挂在 CORS 之后**。

  > 最后那几条（「键名一致」「挂载顺序」）是**跨文件**的断言，专治「改了 A 忘了改 B」——
  > 这次改配额时，`smoke.mjs` 里塞账本的键和 `quota.ts` 里的构造函数就是必须同步的两处。
  > `media.ts` 里那个写死的上传限流值是后来靠读代码才发现的，现在由
  > `rate-limit-test` 的「上传限流」一节兜住。

  > 这一类只能做**静态**断言（比位置、比包含关系），因为要证明它们得让 DO
  > 在测试中途挂掉、或者把限流打满一个窗口 —— 而本地限流是放宽的，
  > 那种断言在开发机上永远绿。**它比没有强，但要清楚它弱在哪**：
  > 拦得住「有人把这段逻辑挪走/删掉」，拦不住「逻辑还在、但写错了」。
  > 能真跑的部分交给 smoke 和 frontend-test。
  >
  > 写法上有个硬要求：断言一律先确认「锚点字符串还在」，再比位置。
  > 反过来写的话，一次改名会让 `indexOf` 返回 -1、比较结果碰巧为真 ——
  > 断言变成空转，那还不如不写。

**这个脚本已经接进 CI**（`.github/workflows/hugo.yaml` 的 `Verify chat script placement` 步骤），
所以那次事故不会再靠肉眼发现。它只 import `node:fs` / `node:path` / `node:url`，
零第三方依赖，所以 CI 里不需要先 `npm ci`。

### 已知测试盲区（写出来免得以后误以为覆盖了）

两条分支**在当前测试框架里跑不到**，不是「懒得写」，是构造不出来：

1. **`evictIfExpired()` 真正关掉连接那一下。** 要触发它，得让连接的 `exp`
   在测试过程中过去 —— 而连接上的 `exp` 来自 access token，测试里那把 token
   的有效期是 30 分钟。想构造就只能：
   - 手工签一个短 exp 的 JWT —— 等于在测试里自己实现一遍签名（万一库里
     改了 claim 约定，这条测试会因为错误的原因变红，比没有更误导）；
   - 或者等 30 分钟。
   所以这条目前只有 3 项静态断言守着（`exp` 进 attachment、握手查会话、
   广播前调 `evictIfExpired`）。**静态断言拦得住「调用被删掉」，
   拦不住「函数体写错了」** —— 改这段时请手工验一次。
2. **`markUpload()` 返回 `false` 那个分支**（额度在预检之后被抢走）。
   预检和守卫用的是**同一组条件**，所以单线程下两者永远一致；
   要让它分歧必须有真正的并发。而并发的上传会先撞上「上传限流」
   （10 秒 10 次），两个 429 混在一起就分不清是谁挡的。
   现在被覆盖到的是它的**成功路径**（每次上传都会走这四条带条件的 UPSERT，
   写错了所有上传都会 429），**拒绝路径没有** —— 但「拒绝路径的账没记错」
   由 `smoke` 的配额一节从**外侧**验了一遍（塞满账本 → 429 → 清空 → 又能传）。

另外，`npm run rate-limit-test`（22 项）这一套自己起 `STRICT_RATE_LIMIT` 的 dev server，
**不在 CI 里跑**（CI 起 dev server 成本太高）。改限流相关代码时要手动跑一次 ——
它是唯一能验出「阈值到底放行多少次」的地方（smoke 跑在放宽模式，429 断言在那边永远绿）。
它目前覆盖：注册 / 登录 / 撤回 / 发言 / 上传 / refresh 六条路径，
**新增一条限流就顺手在这里加一节**：断言方向是「前 N 次必须成功、第 N+1 次才 429」，
写成「第二次就被拦」会把正常的连发行为测成 bug。

`npm run purge-test`（17 项，纯逻辑，不需要 dev server）：

- 清空房间时**跨消息去重**：同一个文件被多条消息引用，只删一次、只计一次
- 批量切分正确：999 → 1 批、**1000 → 1 批（不越界）**、
  **1001 → 2 批（修的就是这个 case）**、2500 → 3 批，每批不超 1000、不重不漏

为什么不真传 1000 个文件去验：那太慢，而且会真的写 R2。
这个脚本把路由里那段批次逻辑抄出来喂假 key，抄而不是 import 是因为
那段逻辑内联在 handler 里——**以后改了路由里的批大小，这里会先对不上而暴露出来**。

