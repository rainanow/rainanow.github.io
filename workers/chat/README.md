# yulo-chat

`yulo.top` 博客的聊天室后端：自建账号系统 + 实时消息，全部跑在 Cloudflare 免费套餐上。

- **运行时**：Cloudflare Workers
- **路由 / 校验**：Hono + [`@nanokajs/core`](https://www.npmjs.com/package/@nanokajs/core)（模型 → Drizzle schema / Zod 校验器）
- **认证**：[`@nanokajs/auth`](https://www.npmjs.com/package/@nanokajs/auth)（登录、JWT、refresh 轮换）
- **数据库**：D1（账号、消息、令牌吊销名单、限流计数）
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
   │                ├── /auth/*  注册、登录、刷新、登出
   │                ├── /api/*   当前用户、消息历史、发消息、撤回
   │                └── /api/ws  WebSocket 入口（纯转发）
   │
   ├──► D1 ── users / messages / auth_blacklist / rate_limits
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
│       └── 0001_chat_indexes.sql  # 手写索引，为了省 D1 读取额度
├── src/
│   ├── index.ts             # 入口：导出 Worker 与 ChatRoom
│   ├── app.ts               # 组装 Hono 应用（按 isolate 缓存）
│   ├── room.ts              # ChatRoom Durable Object
│   ├── hasher.ts            # scrypt 密码哈希（为什么不用自带的 PBKDF2，见文件注释）
│   ├── blacklist.ts         # D1 版 refresh 令牌吊销名单
│   ├── rate-limit.ts        # D1 固定窗口限流
│   ├── middleware.ts        # Cookie → Authorization 桥接、取客户端 IP
│   ├── origins.ts           # 来源白名单、Cookie/令牌读取
│   ├── config.ts            # 常量集中处
│   ├── models/              # 表定义（nanoka 字段 DSL）
│   └── routes/              # auth.ts / chat.ts
└── scripts/
    ├── smoke.mjs            # 后端端到端冒烟测试（43 项）
    ├── frontend-test.mjs    # 用 jsdom 跑真实 chat.js + 真实 Worker（23 项）
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
npm run smoke                # 后端 43 项
npm run frontend-test        # 前端 23 项（需要先 hugo 构建出 public/chat/index.html）
npm run inspect-d1           # 打印本地 D1 里的表结构、账号、限流、吊销名单
```

> `npm run smoke` 会真的注册账号。本地 D1 的注册限额是「同一 IP 每小时 5 次」，
> 反复跑会撞上 429 —— 用 `npm run inspect-d1` 看一眼，或者删掉 `.wrangler/state` 重来。
> 想手工清一下计数：
> ```bash
> node -e "const{DatabaseSync}=require('node:sqlite'),fs=require('fs');const p='.wrangler/state/v3/d1/miniflare-D1DatabaseObject';const f=fs.readdirSync(p).find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');new DatabaseSync(p+'/'+f).exec('DELETE FROM rate_limits')"
> ```

本地联调前端：

```bash
# 仓库根目录
hugo server            # http://localhost:1313/chat/
```

`wrangler.jsonc` 的 `ALLOWED_ORIGINS` 已经包含 `http://localhost:1313`，开箱可用。

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
| Workers 请求 | 100,000 / 天 | 每次 HTTP 调用 1 次；WebSocket 握手 1 次（连接期间不再计） |
| Workers CPU | **10 ms / 请求** | 见下方「最要紧的一条」——密码哈希刻意避开了这个坑 |
| D1 读取 | 5,000,000 行 / 天 | 登录查 1 行；历史一页 50 行（有索引）；发消息约 2 行 |
| D1 写入 | 100,000 行 / 天 | 发消息 1 行；登录失败 1 行；refresh 1 行 |
| DO 请求 | 100,000 / 天 | 握手 1 次 + 每条消息广播 1 次；心跳由运行时直接应答，不唤醒对象 |
| DO compute | 13,000 GB-s / 天 | 只在真正处理消息时计；空闲连接被 Hibernation 换出后不计 |
| D1 存储 | 5 GB | 一条消息不到 1 KB |

按这个量级，几十人同时在线、每天几千条消息都还有很大余量。

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

### 9. 发言频率限制在 isolate 内存里

这条路径本来就有「读用户 + 写消息」两次 D1 往返，再为限流加一次写不划算。
所以它是**软限制**（isolate 按 POP 分布，理论上能绕过），目的是防手滑连点，
安全边界是登录态 + 消息长度上限。登录和注册的限流则落在 D1 里，因为那是真的攻击面。

### 10. 没有做邮箱验证

免费套餐发不了验证邮件，所以账号只有用户名和密码。这也意味着**开放注册**，
靠限流 + 管理员撤回兜底。想关掉就把 `src/routes/auth.ts` 里的 `/auth/register`
改成校验一个环境变量里的邀请码。

---

## 测试覆盖

`npm run smoke`（43 项，后端）：

- 健康检查、CORS 预检（含非白名单来源拿不到允许头）
- 注册 / 大小写不同的重名被拒 / 非法输入
- 登录（含大小写不敏感的登录）、错误密码、Cookie 下发
- 未登录访问 `/api/me`、历史、WebSocket 一律被拒
- 非白名单 Origin 的 WebSocket 握手被拒（跨站劫持防护）
- 实时收发：`ready` / `message` / 在线人数
- 发言间隔限流、超长消息、历史游标分页与顺序
- 撤回本人消息 + 广播 + 历史消失
- refresh 轮换、旧令牌重放被拒、登出后 refresh 被拒
- 连续登录失败 11 次触发 429

`npm run frontend-test`（23 项，真实 `chat.js` + jsdom + 真实 Worker）：

- `chat.js` 引用的 18 个 `data-chat-*` 钩子在真实页面里都存在
- 未登录 → 注册 → 自动登录 → 加载历史 → WebSocket 连上
- 「自己发的消息」既走 HTTP 响应又走 WebSocket 广播，只渲染一条（去重）
- 消息里的 HTML 被当成纯文本，不会创建元素、不会触发行内事件
- 撤回后前端跟着移除、退出后回到登录面板、无未捕获 JS 错误
