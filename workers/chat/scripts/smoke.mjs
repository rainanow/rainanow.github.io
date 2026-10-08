/**
 * 本地冒烟测试：对 `wrangler dev` 起的 Worker 打一遍完整流程。
 *
 * 覆盖的是最容易悄悄坏掉、又最难手工点的路径：
 *   注册 / 大小写不敏感登录 / Cookie 会话 / WebSocket 广播 / 历史分页 /
 *   refresh 轮换 + 吊销 / 撤回 / 登录限流 / 跨站 WebSocket 拦截
 *
 * 用法：先 `npx wrangler dev`（另开一个终端），再 `node scripts/smoke.mjs`
 */

import { readdirSync, statSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const BASE = process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8787'
const ORIGIN = 'https://yulo.top'

/**
 * 跑之前清掉本地限流计数。
 *
 * 注册限额是「同一 IP 每小时 5 次」，而这个脚本一轮要用掉 **3 次**：
 *   1. 主测试账号（成功）
 *   2. 重名账号（用户名大写）—— 409，但**已经记过账了**
 *   3. 「审计：谁删的」那一节的 victim 账号
 *
 * 注意**非法输入那一次不算**：注册接口是**先校验格式、后记账**，
 * 所以 `username: 'x'` 那次直接 400 返回，压根没走到限流。
 * 别照着「有 4 次 register 调用」去数额度 —— 那是 4 次调用、3 次记账。
 *
 * 3/5 意味着再加两个注册就会撞限额，连跑两遍必然 429 ——
 * 表现成一片红，很容易被误判成代码坏了。
 *
 * 只在本机地址上动手，指向远端时直接跳过，绝不会去清生产环境的数据。
 */
/** 只在目标是本机时才动手，指向远端一律跳过，绝不碰生产数据。 */
function isLocalTarget() {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)
}

/** 打开本地那份 D1 的 SQLite（Miniflare 用它当存储），跑一段同步操作。 */
function withLocalDb(work) {
  const dir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  // 本地库文件名按 database_id 派生，改过 id 会留下旧文件，所以要挑最新的那个
  const newest = readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0]

  if (newest === undefined) return
  const db = new DatabaseSync(join(dir, newest.name))
  try {
    work(db)
  } finally {
    db.close()
  }
}

function resetLocalRateLimits() {
  if (!isLocalTarget()) return

  try {
    withLocalDb((db) => db.exec('DELETE FROM rate_limits'))
    console.log('（已清空本地限流计数）')
  } catch (error) {
    console.log(`（跳过清理本地限流计数：${error.message}）`)
  }
}

/**
 * 直接把「全站上传额度」塞满，用来验证熔断。
 *
 * 不真传 100 个文件是因为那太慢，而且会把本地 R2 撑起来。
 * 反正验的是「额度用完之后接口的态度」，账本怎么来的不重要。
 *
 * ⚠️ **键名必须和 `src/quota.ts` 里那四个构造函数保持一致**。写错了不会报错，
 * 只会让这一节变成空转 —— 现象是「额度明明塞满了却还能传」，
 * 而不是「找不到表」。所以 `npm run verify-build` 里有一条专门核对键名。
 */
function forceGlobalBytesQuota() {
  withLocalDb((db) => {
    db.exec('DELETE FROM upload_usage')
    db.prepare('INSERT INTO upload_usage (id, bytes, count) VALUES (?, ?, ?)')
      .run('total:global', 8 * 1024 * 1024 * 1024, 0)
  })
}

function forceGlobalCountQuota(day) {
  withLocalDb((db) => {
    db.exec('DELETE FROM upload_usage')
    db.prepare('INSERT INTO upload_usage (id, bytes, count) VALUES (?, ?, ?)')
      .run(`daily:global:${day}`, 0, 99999)
  })
}

function clearUploadQuota() {
  withLocalDb((db) => db.exec('DELETE FROM upload_usage'))
}

/** 直接把本地账号提成管理员，用来验证权限门禁（比走接口/改 D1 快）。 */
function setLocalRole(username, role) {
  withLocalDb((db) => {
    db.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, username)
  })
}

resetLocalRateLimits()

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// --- Cookie jar（Node 的 fetch 不会自动管理 Cookie，手动来） -----------------

function jarFrom(response) {
  const jar = {}
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index === -1) continue
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

function request(path, { jar, method = 'GET', body, origin, headers: extra } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (jar !== undefined) headers['Cookie'] = cookieHeader(jar)
  if (origin !== undefined) headers['Origin'] = origin
  // 额外头：上传接口要 X-Filename，禁言测试要一个 Content-Type 不一样的请求。
  // 放在最后覆盖，别让它能把 Cookie/Origin 顶掉。
  if (extra !== undefined) Object.assign(headers, extra)
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/**
 * 上传接口的请求长得不一样：请求体是**原始字节**（不是 JSON），
 * 文件名走 X-Filename 头。所以单独一个函数，别把 request 搞复杂。
 */
function uploadRequest(path, { jar, contentType, filename, bytes }) {
  const headers = { 'Content-Type': contentType, Origin: ORIGIN }
  if (filename !== undefined) headers['X-Filename'] = encodeURIComponent(filename)
  if (jar !== undefined) headers['Cookie'] = cookieHeader(jar)
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body: bytes })
}

/**
 * 用 `node:http` 发一次上传，专门用来构造 `fetch()` 造不出来的请求形状。
 *
 * 这个测试脚本里**只有这里**这么发请求，两个原因：
 *
 *   ① `fetch()` 只要拿到 body 就一定会带上真实的 Content-Length，
 *      而我们要测的恰恰是「声明值和实际不符」与「压根没有长度」两种情况；
 *   ② 服务端在这些情况下（411 / 413 / 429）**不会读完请求体**就回话，
 *      平台于是会把连接直接重置。用 fetch 的话下一条请求会复用那条
 *      已经死掉的连接，报一个莫名其妙的 `ECONNRESET` —— 看着像服务端坏了，
 *      其实是客户端没换连接。所以这里 `agent: false`：一个请求一条连接。
 *
 * 不真的写那 17 MB 是**有意**的：这些断言验的是「按声明值走哪条分支」
 * （大小上限、配额），而这些分支都在读请求体之前。真正需要完整字节的
 * 是「流式上传没被截断」那条，它老老实实发 17 MB（见下面的 ②③）。
 */
function rawUpload(path, { jar, contentType, filename, declaredLength, chunk }) {
  return new Promise((resolve) => {
    const target = new URL(`${BASE}${path}`)
    const headers = {
      'Content-Type': contentType,
      Origin: ORIGIN,
      'X-Filename': encodeURIComponent(filename),
      Cookie: cookieHeader(jar),
    }
    // 不设这个头 → node 自动改用 `Transfer-Encoding: chunked`（正好是 411 那条用例）
    if (declaredLength !== undefined) headers['Content-Length'] = String(declaredLength)

    let seen = null
    const outbound = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        headers,
        agent: false,
      },
      (response) => {
        seen = { status: response.statusCode, body: '' }
        response.setEncoding('utf8')
        response.on('data', (piece) => {
          seen.body += piece
        })
        response.on('end', () => resolve(seen))
        // 读完之前连接被重置：状态码和已读到的内容仍然算数
        response.on('error', () => resolve(seen))
      },
    )

    /*
     * 写入报错有两种可能：服务端已经回话了（正是我们要的），或者连接真坏了。
     * 所以**不立刻**把结果定成 0 —— 先给响应一点时间到；到不了才按 0 报，
     * 那种情况下断言会红，说明确实什么都没收到。
     */
    outbound.on('error', () => {
      setTimeout(() => resolve(seen ?? { status: 0, body: '' }), 300)
    })

    if (chunk !== undefined) outbound.write(chunk)
    outbound.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- 极简 WebSocket 客户端 -------------------------------------------------

function openSocket({ jar, origin = ORIGIN, room = 'general' } = {}) {
  const headers = {}
  if (jar !== undefined) headers['Cookie'] = cookieHeader(jar)
  if (origin !== null) headers['Origin'] = origin

  const socket = new WebSocket(`${BASE.replace('http', 'ws')}/api/ws?room=${room}`, { headers })
  const inbox = []
  const waiters = []

  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString())
    inbox.push(event)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        clearTimeout(waiter.timer)
        waiter.resolve(event)
      }
    }
  })

  const next = (predicate, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const existing = inbox.find(predicate)
      if (existing !== undefined) {
        resolve(existing)
        return
      }
      const waiter = { predicate, resolve }
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error(`等待 WebSocket 事件超时（已收 ${JSON.stringify(inbox)}）`))
      }, timeoutMs)
      waiters.push(waiter)
    })

  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    socket.once('error', reject)
  })

  /*
   * `inbox` 也交出去。
   *
   * `next()` 是「等一个**匹配**的事件」，而有些断言要问的是反面：
   * 「这件事**没有**发生」（同一个人开第二个标签页时不该再播一条「加入了房间」）。
   * 那种断言没法用 `next()` 表达 —— 它只会一直等到超时，看不出「一条也没有」
   * 和「来了别的、但不是这条」的区别。直接数 inbox 才说得清。
   */
  return { socket, next, opened, inbox }
}

// --- 开始 ------------------------------------------------------------------

console.log(`冒烟测试目标：${BASE}`)

section('健康检查')
{
  const response = await request('/api/health')
  const payload = await response.json()
  check('GET /api/health 返回 200', response.status === 200, `实际 ${response.status}`)
  check('服务名正确', payload.service === 'yulo-chat')
}

section('CORS 预检（含上传用的自定义头）')
{
  // 浏览器发跨域 POST + Content-Type: application/json 之前，一定会先发一个 OPTIONS 预检。
  // Node 的 fetch 不做预检，所以这一段必须手工构造，否则「本地全绿、一上浏览器就挂」。
  const preflight = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  check('预检返回 2xx', preflight.status >= 200 && preflight.status < 300, `实际 ${preflight.status}`)
  check(
    '回显了具体来源（不是 *）',
    preflight.headers.get('access-control-allow-origin') === ORIGIN,
    `实际 ${preflight.headers.get('access-control-allow-origin')}`,
  )
  check(
    '允许携带凭证',
    preflight.headers.get('access-control-allow-credentials') === 'true',
    `实际 ${preflight.headers.get('access-control-allow-credentials')}`,
  )
  check(
    '允许 content-type 头',
    (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('content-type'),
    `实际 ${preflight.headers.get('access-control-allow-headers')}`,
  )

  // 上传接口带的是自定义头 X-Filename —— 它不在浏览器的「简单头」之列，
  // 必须在 CORS 里显式放行。漏了的话预检直接失败，请求压根发不出去，
  // 前端只看到 fetch 层的 NetworkError，服务端连日志都不会有（线上真踩过）。
  const uploadPreflight = await fetch(`${BASE}/api/uploads`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-filename',
    },
  })
  check(
    '预检放行了上传用的 X-Filename 头',
    (uploadPreflight.headers.get('access-control-allow-headers') ?? '')
      .toLowerCase()
      .includes('x-filename'),
    `实际允许的头：${uploadPreflight.headers.get('access-control-allow-headers') ?? '（无）'}`,
  )

  const evil = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  check(
    '非白名单来源拿不到允许头',
    evil.headers.get('access-control-allow-origin') === null,
    `实际 ${evil.headers.get('access-control-allow-origin')}`,
  )

  const actual = await fetch(`${BASE}/api/health`, { headers: { Origin: ORIGIN } })
  check(
    '普通 GET 也带上 CORS 头',
    actual.headers.get('access-control-allow-origin') === ORIGIN,
    `实际 ${actual.headers.get('access-control-allow-origin')}`,
  )
}

section('注册')
const username = `tester${Date.now().toString(36).slice(-6)}`
const password = 'correct-horse-battery'
{
  const response = await request('/auth/register', {
    method: 'POST',
    body: { username, password },
  })
  check('注册成功返回 201', response.status === 201, `实际 ${response.status}`)
  const payload = await response.json()
  check('响应里有 id', typeof payload.id === 'string' && payload.id.length > 0)
  check('响应里**没有**密码字段', payload.password === undefined && payload.passwordHash === undefined)

  const tooShort = await request('/auth/register', {
    method: 'POST',
    body: { username: 'x', password: 'short' },
  })
  check('非法输入返回 400', tooShort.status === 400, `实际 ${tooShort.status}`)

  // users.username 上有 COLLATE NOCASE，大小写不同也算同一个名字
  const duplicate = await request('/auth/register', {
    method: 'POST',
    body: { username: username.toUpperCase(), password },
  })
  check('大小写不同的重名被拒（COLLATE NOCASE）', duplicate.status === 409, `实际 ${duplicate.status}`)
}

section('登录与会话')
let jar = {}
{
  const wrong = await request('/auth/login', {
    method: 'POST',
    body: { username, password: 'wrong-password' },
  })
  check('错误密码返回 401', wrong.status === 401, `实际 ${wrong.status}`)

  // 大小写不敏感的登录：用大写用户名登录应该也能成功
  const response = await request('/auth/login', {
    method: 'POST',
    body: { username: username.toUpperCase(), password },
  })
  check('大写用户名也能登录（不区分大小写）', response.status === 200, `实际 ${response.status}`)
  jar = jarFrom(response)
  check('下发了 access_token Cookie', typeof jar.access_token === 'string')
  check('下发了 refresh_token Cookie', typeof jar.refresh_token === 'string')

  const me = await request('/api/me', { jar })
  const profile = await me.json()
  check('带 Cookie 能拿到自己的资料', me.status === 200 && profile.username.toLowerCase() === username.toLowerCase())
  check('资料里没有密码字段', profile.password === undefined && profile.passwordHash === undefined)

  const anonymous = await request('/api/me')
  check('不带 Cookie 访问 /api/me 返回 401', anonymous.status === 401, `实际 ${anonymous.status}`)

  const anonymousHistory = await request('/api/messages')
  check('不带 Cookie 读历史返回 401', anonymousHistory.status === 401, `实际 ${anonymousHistory.status}`)
}

section('WebSocket 鉴权与跨站防护')
{
  const noCookie = openSocket({})
  let noCookieStatus = 'connected'
  try {
    await noCookie.opened
  } catch (error) {
    noCookieStatus = error.message
  }
  noCookie.socket.terminate()
  check('不带 Cookie 的握手被拒 401', noCookieStatus === 'HTTP 401', `实际 ${noCookieStatus}`)

  const badOrigin = openSocket({ jar, origin: 'https://evil.example' })
  let badOriginStatus = 'connected'
  try {
    await badOrigin.opened
  } catch (error) {
    badOriginStatus = error.message
  }
  badOrigin.socket.terminate()
  check('非白名单 Origin 的握手被拒 403', badOriginStatus === 'HTTP 403', `实际 ${badOriginStatus}`)
}

section('实时收发')
{
  const client = openSocket({ jar })
  await client.opened
  const ready = await client.next((event) => event.type === 'ready')
  check('收到 ready 事件', ready.type === 'ready')
  check('在线人数至少 1', ready.online >= 1, `实际 ${ready.online}`)

  const posted = await request('/api/messages', {
    method: 'POST',
    jar,
    body: { body: '第一条消息 👋' },
  })
  check('发消息返回 201', posted.status === 201, `实际 ${posted.status}`)
  const { message } = await posted.json()

  const pushed = await client.next((event) => event.type === 'message' && event.message.id === message.id)
  check('同一条消息经 WebSocket 推了回来', pushed.message.body === '第一条消息 👋')
  check('推送里带用户名', pushed.message.username.toLowerCase() === username.toLowerCase())

  // ⚠️ 发言限流的断言**不在这里** —— 它要求限流真的生效，
  // 而本地 .dev.vars 开了 RELAX_LOCAL_LIMITS（见 rate-limit-test.mjs 的说明）。
  // 早先它内嵌在本节里，于是本地一开放宽 smoke 就红，人会误以为代码坏了。
  // 现在它住在 scripts/rate-limit-test.mjs，由 npm run rate-limit-test 跑。

  const tooLong = await request('/api/messages', {
    method: 'POST',
    jar,
    body: { body: 'x'.repeat(501) },
  })
  check('超长消息返回 400', tooLong.status === 400, `实际 ${tooLong.status}`)

  await new Promise((resolve) => setTimeout(resolve, 1600))

  const history = await request('/api/messages', { jar })
  const page = await history.json()
  check('历史里能查到这条', page.messages.some((item) => item.id === message.id))
  check('历史按时间正序返回', page.messages.every((item, index, all) => index === 0 || all[index - 1].createdAt <= item.createdAt))
  check('hasMore 是布尔值', typeof page.hasMore === 'boolean')
  check(
    '历史消息里没有密码字段',
    page.messages.every((item) => item.password === undefined && item.passwordHash === undefined),
  )

  // 撤回
  const deleted = await request(`/api/messages/${message.id}`, { method: 'DELETE', jar })
  check('撤回自己的消息返回 200', deleted.status === 200, `实际 ${deleted.status}`)
  await client.next((event) => event.type === 'deleted' && event.id === message.id)
  check('撤回事件推送到位', true)

  const after = await request('/api/messages', { jar })
  const pageAfter = await after.json()
  check('撤回后历史里不再出现', !pageAfter.messages.some((item) => item.id === message.id))

  // 成员名单。放在这里是因为 WebSocket 还连着——正好能验证「在线」这一栏不是写死的。
  const anonymous = await request('/api/members')
  check('未登录访问成员名单返回 401', anonymous.status === 401, `实际 ${anonymous.status}`)

  const memberRes = await request('/api/members', { jar })
  check('登录后能拿到成员名单', memberRes.status === 200, `实际 ${memberRes.status}`)
  const memberList = await memberRes.json()
  check('名单里有自己', memberList.members.some((item) => item.username === username))
  check(
    '自己连着 WebSocket 时标记为在线',
    memberList.members.find((item) => item.username === username)?.online === true,
  )
  check('每条都带 online 布尔值', memberList.members.every((item) => typeof item.online === 'boolean'))
  check('名单里没有密码字段', memberList.members.every((item) => item.password === undefined))
  check('名单回显了房间名', memberList.room === 'general', `实际 ${memberList.room}`)
  check('默认 scope 是 all', memberList.scope === 'all', `实际 ${memberList.scope}`)

  /*
   * scope=online：这条路径的意义就是**不读 D1 的 users 表**，
   * 所以这里验的不是「能不能拿到名单」，而是三件事：
   *   1. 只回在线的人（离线的一个都不该出现）；
   *   2. 带上了用户名（否则前端拿到一堆 id 也没法显示）；
   *   3. 未登录仍然 401 —— 别为了省一次查询把鉴权也省了。
   */
  const onlineRes = await request('/api/members?scope=online', { jar })
  check('scope=online 返回 200', onlineRes.status === 200, `实际 ${onlineRes.status}`)
  const onlineList = await onlineRes.json()
  check('scope=online 只回在线的人', Array.isArray(onlineList.members) && onlineList.members.every((m) => m.online === true), `实际 ${JSON.stringify(onlineList.members).slice(0, 120)}`)
  check(
    'scope=online 带上了用户名（否则前端显示不出来）',
    onlineList.members.every((m) => typeof m.username === 'string' && m.username.length > 0),
    `实际 ${JSON.stringify(onlineList.members).slice(0, 120)}`,
  )
  check(
    'scope=online 里能找到自己（WebSocket 还连着）',
    onlineList.members.some((m) => m.username === username),
    `实际 ${onlineList.members.map((m) => m.username).join(',')}`,
  )
  check('scope=online 的人数不超过全量人数', onlineList.total <= memberList.total, `${onlineList.total} vs ${memberList.total}`)

  const anonOnline = await request('/api/members?scope=online')
  check('scope=online 未登录仍然 401（省查询不能省鉴权）', anonOnline.status === 401, `实际 ${anonOnline.status}`)

  /*
   * 降级路径的形状检查。
   *
   * 线上代码里有个不显然的判断：DO 如果回了 userIds 却没回 members
   * （老版本 DO / 两边代码不同步），`scope=online` 会**自动退回全量**，
   * 而不是回一个空列表 —— 因为空列表会让前端把所有人都标成离线，
   * 那是「显示错」而不是「显示慢」。
   *
   * 这里没法真的造一个老版本 DO，但能验「有人在线时 scope=online 一定给得出用户名」，
   * 也就是那条降级分支的前提不成立时它一定会生效。
   */
  const onlineNames = onlineList.members.map((m) => m.username)
  check(
    '有人在线时 scope=online 一定带得出用户名（降级分支不会误触发）',
    onlineList.members.length === 0 ||
      (onlineList.members.length > 0 && onlineNames.every((n) => typeof n === 'string' && n.length > 0)),
    `在线 ${onlineList.members.length} 人：${onlineNames.join(',')}`,
  )

  client.socket.close()
}

section('上传与媒体')
{
  // 最小 PNG：8 字节魔数 + 一点点数据，足够让类型嗅探认出它是图片
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

  const anonymous = await uploadRequest('/api/uploads', {
    contentType: 'image/png',
    filename: 'anon.png',
    bytes: pngBytes,
  })
  check('未登录上传返回 401', anonymous.status === 401, `实际 ${anonymous.status}`)

  const uploaded = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: '测试图.png',
    bytes: pngBytes,
  })
  check('登录后能上传图片', uploaded.status === 201, `实际 ${uploaded.status}`)
  const asset = await uploaded.json()
  check('识别为 image', asset.kind === 'image', `实际 ${asset.kind}`)
  check('返回了媒体 URL', typeof asset.url === 'string' && asset.url.includes('/api/media/'))
  check('文件名原样保留（含中文）', asset.filename === '测试图.png', `实际 ${asset.filename}`)

  const served = await fetch(asset.url, { headers: { Cookie: cookieHeader(jar) } })
  check('上传后能读回来', served.status === 200, `实际 ${served.status}`)
  check('图片以 image/png 内联返回', served.headers.get('content-type') === 'image/png')

  // 换一个会被当成纯文本的 HTML：必须拒掉，
  // 否则下载下来双击就能在浏览器里执行
  //
  // 这里原先睡 3.4 秒「绕开上传间隔限流」—— 那个「3 秒 1 个」的最小间隔已经改成
  // 「10 秒 10 次」，而本节一共只传三次，不需要再等了。
  const htmlUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'text/html',
    filename: 'evil.html',
    bytes: new TextEncoder().encode('<html><body>x</body></html>'),
  })
  check('HTML / SVG 这类标记文本被拒', htmlUpload.status === 415, `实际 ${htmlUpload.status}`)

  const svgUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/svg+xml',
    filename: 'evil.svg',
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  })
  check('SVG 被拒（它能在浏览器里执行脚本）', svgUpload.status === 415, `实际 ${svgUpload.status}`)

  // 撤回要连带删掉媒体对象
  // （发言限流是「10 秒 10 次」，本节只有这一条，不用再等了）
  const withMedia = await request('/api/messages', {
    method: 'POST',
    jar,
    body: { body: `![图](${asset.url})`, room: 'general' },
  })
  const posted = await withMedia.json()
  check('带媒体的消息能发出去', withMedia.status === 201, `实际 ${withMedia.status}`)

  const removed = await request(`/api/messages/${posted.message.id}`, { method: 'DELETE', jar })
  check('撤回带媒体的消息返回 200', removed.status === 200, `实际 ${removed.status}`)

  const afterDelete = await fetch(asset.url, { headers: { Cookie: cookieHeader(jar) } })
  check('撤回后媒体对象也被删了', afterDelete.status === 404, `实际 ${afterDelete.status}`)

  const gone = await request('/api/messages', { jar })
  const gonePage = await gone.json()
  check(
    '撤回后历史里不再有这条',
    !gonePage.messages.some((item) => item.id === posted.message.id),
  )
}

section('上传配额')
{
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  // 文件数那把尺子按北京时间切日
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

  clearUploadQuota()
  const before = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-a.png',
    bytes: pngBytes,
  })
  check('额度充足时能正常上传', before.status === 201, `实际 ${before.status}`)

  /*
   * ① 全站**累计字节**到顶。这是新口径（原先按天算），也是这一节最该守住的东西：
   *    存储满了的解决办法是删文件，不是等到明天 —— 所以文案里必须是「存储空间」，
   *    不能是「今天」。文案写错不会让接口挂掉，只会把人误导到错的方向。
   */
  forceGlobalBytesQuota()
  const bytesBlocked = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-b.png',
    bytes: pngBytes,
  })
  check('全站累计存储到顶后上传被挡（429）', bytesBlocked.status === 429, `实际 ${bytesBlocked.status}`)
  const bytesBody = await bytesBlocked.json()
  check(
    '理由说的是存储空间，不是「今天」',
    typeof bytesBody.error === 'string' && bytesBody.error.includes('存储空间'),
    `实际 ${JSON.stringify(bytesBody)}`,
  )

  // ② 全站**当日文件数**到顶：另一把尺子，切日口径是北京时间
  forceGlobalCountQuota(day)
  const countBlocked = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-c.png',
    bytes: pngBytes,
  })
  check('全站当日文件数到顶后上传被挡（429）', countBlocked.status === 429, `实际 ${countBlocked.status}`)
  const countBody = await countBlocked.json()
  check(
    '理由是「今天…明天再来」这一侧',
    typeof countBody.error === 'string' && countBody.error.includes('今天'),
    `实际 ${JSON.stringify(countBody)}`,
  )

  clearUploadQuota()
  const after = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-d.png',
    bytes: pngBytes,
  })
  check('额度恢复后能继续上传', after.status === 201, `实际 ${after.status}`)
}

section('管理员：导出与清空')
{
  // 先确认「不是管理员就别想」—— 前端藏按钮只是省事，门禁必须在服务端
  const forbiddenExport = await request('/api/rooms/general/export', { jar })
  check('非管理员导出被拒（403）', forbiddenExport.status === 403, `实际 ${forbiddenExport.status}`)

  const forbiddenPurge = await request('/api/rooms/smokeprobe', { method: 'DELETE', jar })
  check('非管理员清空被拒（403）', forbiddenPurge.status === 403, `实际 ${forbiddenPurge.status}`)

  setLocalRole(username, 'admin')

  /*
   * 先往 general 里补一条**不会被删**的消息。
   *
   * 为什么必须自己造：以前这两个用例（导出有内容、清空没误伤 general）
   * 是靠「之前几轮测试在 general 里攒下的消息」通过的。在**全新库**上跑，
   * general 是空的 —— 因为前面「撤回」「撤回带媒体」两个用例
   * 正好把本轮发到 general 的消息都撤掉了，于是这两条直接红。
   *
   * 测试不能依赖上一轮留下的状态，否则换个环境就误报成代码坏了。
   */
  await sleep(2200)
  const seed = await request('/api/messages', {
    method: 'POST',
    jar,
    body: { body: '给导出用例垫一条消息', room: 'general' },
  })
  check('垫的消息发成功了', seed.status === 201, `实际 ${seed.status}`)

  const exported = await request('/api/rooms/general/export', { jar })
  check('管理员能导出房间', exported.status === 200, `实际 ${exported.status}`)
  const dump = await exported.json()
  check('导出里带上了消息', Array.isArray(dump.messages) && dump.messages.length > 0)
  check(
    '导出的是原始数据（格式交给前端定）',
    dump.messages.every(
      (item) => typeof item.username === 'string' && typeof item.body === 'string',
    ),
  )

  // 清空拿一个临时房间试，别去动 general —— 那会毁掉别的用例
  const probeRoom = 'smokeprobe'
  await sleep(2200)
  await request('/api/messages', { method: 'POST', jar, body: { body: '会被清掉的消息一', room: probeRoom } })
  await sleep(2200)
  await request('/api/messages', {
    method: 'POST',
    jar,
    body: {
      body: '![图](https://pub-x.r2.dev/2026-09/00000000-0000-0000-0000-000000000000.png)',
      room: probeRoom,
    },
  })

  const purged = await request(`/api/rooms/${probeRoom}`, { method: 'DELETE', jar })
  check('管理员能清空房间', purged.status === 200, `实际 ${purged.status}`)
  const purgedBody = await purged.json()
  check('清空报告了删除条数', purgedBody.removedMessages === 2, `实际 ${purgedBody.removedMessages}`)

  const afterPurge = await request(`/api/messages?room=${probeRoom}`, { jar })
  const afterPage = await afterPurge.json()
  check('清空后那个房间空了', afterPage.messages.length === 0, `实际 ${afterPage.messages.length}`)

  const untouched = await request('/api/messages?room=general', { jar })
  const untouchedPage = await untouched.json()
  check('清空只影响目标房间，别的房间没被误伤', untouchedPage.messages.length > 0)
}

section('refresh 轮换与吊销')
{
  const first = jar.refresh_token
  const rotated = await request('/auth/refresh', { method: 'POST', jar })
  check('refresh 返回 200', rotated.status === 200, `实际 ${rotated.status}`)
  const rotatedJar = jarFrom(rotated)
  check('refresh 轮换了 Cookie', typeof rotatedJar.refresh_token === 'string' && rotatedJar.refresh_token !== first)

  const replay = await request('/auth/refresh', { method: 'POST', jar: { refresh_token: first } })
  check('旧 refresh token 重放被拒（吊销生效）', replay.status === 401, `实际 ${replay.status}`)

  const loggedOutJar = { ...jar, ...rotatedJar }
  const logout = await request('/auth/logout', { method: 'POST', jar: loggedOutJar })
  check('登出返回 200', logout.status === 200, `实际 ${logout.status}`)

  const afterLogout = await request('/auth/refresh', { method: 'POST', jar: loggedOutJar })
  check('登出后 refresh 被拒', afterLogout.status === 401, `实际 ${afterLogout.status}`)
}

section('审计：谁删的、什么时候删的')
{
  /*
   * 这两个字段存在的唯一理由就是 README 里那句「软删方便留着追责」。
   * 只有 deleted 布尔的话，你只能知道「它被删了」，回答不了「谁删的」——
   * 所以这里专门造一个**操作者 ≠ 作者**的场景：让另一个账号发消息，
   * 由管理员（上面已经提权的主账号）撤掉。这正是最需要能追查的那种情况。
   *
   * 断言直接读本地库，因为接口只回 { ok: true }，审计字段不对外暴露
   * （也不该暴露给普通用户）。
   */
  if (!isLocalTarget()) {
    console.log('  （目标不是本机，跳过：审计字段要直接读本地 D1）')
  } else {
    // 本节的删除用的是主账号，而前面「撤回限流」那一节刚把它的撤回额度打满
    // （30 次/60 秒）。不清的话这里会拿到 429，测试失败跟审计逻辑本身没关系。
    //
    // 选择在这里清桶、而不是靠「把本节挪到限流测试之前」，是因为顺序耦合太脆弱 ——
    // 将来谁调整一下章节顺序就会莫名其妙变红。让它自己备好前置条件更稳。
    withLocalDb((db) => db.exec("DELETE FROM rate_limits WHERE id LIKE 'delete:%'"))

    const me = await request('/api/me', { jar })
    const adminProfile = await me.json()

    const victim = `victim${Date.now().toString(36).slice(-6)}`
    const victimPass = 'victim-password-123'
    await request('/auth/register', { method: 'POST', body: { username: victim, password: victimPass } })
    const victimLogin = await request('/auth/login', {
      method: 'POST',
      body: { username: victim, password: victimPass },
    })
    const victimJar = jarFrom(victimLogin)

    await sleep(2200)
    const posted = await request('/api/messages', {
      method: 'POST',
      jar: victimJar,
      body: { body: '这条消息会被管理员撤掉', room: 'auditprobe' },
    })
    const postedBody = await posted.json()
    check('别人的消息发成功了', posted.status === 201, `实际 ${posted.status}`)

    const deleted = await request(`/api/messages/${postedBody.message.id}`, { method: 'DELETE', jar })
    check('管理员能撤回别人的消息', deleted.status === 200, `实际 ${deleted.status}`)

    let row = null
    withLocalDb((db) => {
      row = db
        .prepare('SELECT userId, deleted, deletedBy, deletedAt FROM messages WHERE id = ?')
        .get(postedBody.message.id)
    })

    check('撤回记下了操作者（deletedBy 非空）', row?.deletedBy != null, `实际 ${row?.deletedBy}`)
    check(
      'deletedBy 是**操作者**而不是作者（这是审计的关键）',
      row?.deletedBy === adminProfile.id && row?.deletedBy !== row?.userId,
      `deletedBy=${row?.deletedBy} admin=${adminProfile.id} 作者=${row?.userId}`,
    )
    check('deleted 仍然是 true', row?.deleted === 1 || row?.deleted === true, `实际 ${row?.deleted}`)
    check(
      'deletedAt 记下了时间',
      typeof row?.deletedAt === 'number' && row.deletedAt > 0,
      `实际 ${row?.deletedAt}`,
    )
  }
}

section('审计：清空房间的流水')
{
  /*
   * 清空房间是**硬删**，消息行整个没了，软删那套字段连写入的机会都没有。
   * 所以另有一张 room_purges 记元数据。这里验它真的落了一行，
   * 且记的是操作者（不是任何消息作者）。
   */
  if (!isLocalTarget()) {
    console.log('  （目标不是本机，跳过：审计流水要直接读本地 D1）')
  } else {
    let purgeRow = null
    withLocalDb((db) => {
      purgeRow = db
        .prepare(
          'SELECT room, purgedBy, purgedByUsername, removedMessages, removedMedia FROM room_purges WHERE room = ? ORDER BY createdAt DESC LIMIT 1',
        )
        .get('smokeprobe')
    })

    check('清空房间在 room_purges 里留了一行', purgeRow != null, '没找到流水')
    if (purgeRow != null) {
      check('流水记下了房间名', purgeRow.room === 'smokeprobe', `实际 ${purgeRow.room}`)
      check('流水记下了操作者用户名', typeof purgeRow.purgedByUsername === 'string' && purgeRow.purgedByUsername.length > 0, `实际 ${purgeRow.purgedByUsername}`)
      check('流水记下了操作者 id', typeof purgeRow.purgedBy === 'string' && purgeRow.purgedBy.length > 0, `实际 ${purgeRow.purgedBy}`)
      check('流水记下了删了多少条', purgeRow.removedMessages === 2, `实际 ${purgeRow.removedMessages}`)
    }
  }
}

section('会话吊销：改密码后旧 token 失效')
{
  /*
   * 这条守着的是一个**真实漏洞的回归**：改密码如果不吊销会话，
   * 之前泄露的 refresh token 照样能换出新 access token —— 密码改了但没生效。
   *
   * 注意要**重新登录**拿一个干净的 jar：前面几节已经把主账号的
   * refresh 轮换过多次，而且「refresh 限流」那节会把它打满。
   */
  const relogin = await request('/auth/login', { method: 'POST', body: { username, password } })
  check('重新登录成功', relogin.status === 200, `实际 ${relogin.status}`)
  const pwJar = jarFrom(relogin)

  const before = pwJar.refresh_token
  check('拿到了 refresh token', typeof before === 'string' && before.length > 0)

  // 改密码：先验旧密码错会被拒
  const wrongOld = await request('/api/me/password', {
    method: 'POST',
    jar: pwJar,
    body: { currentPassword: 'definitely-wrong', newPassword: 'brand-new-password-1' },
  })
  check('旧密码不对时拒绝（403）', wrongOld.status === 403, `实际 ${wrongOld.status}`)

  // 两次新密码不一致时后端也应挡（后端只收 newPassword，一致性由前端保证，
  // 这里验的是「旧密码错」不会被误判成 200）
  const changed = await request('/api/me/password', {
    method: 'POST',
    jar: pwJar,
    body: { currentPassword: password, newPassword: 'brand-new-password-1' },
  })
  check('改密码成功', changed.status === 200, `实际 ${changed.status}`)
  const changedBody = await changed.json()
  check('吊销了至少一个会话', changedBody.revokedSessions >= 1, `实际 ${changedBody.revokedSessions}`)

  // 关键断言：改密码【之前】那个 refresh token 必须换不出东西
  const replay = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: `refresh_token=${before}` },
  })
  check('改密码前的 refresh token 失效了（401）', replay.status === 401, `实际 ${replay.status}`)

  // 改回去，否则后面 logout 那节会用旧密码
  const back = await request('/auth/login', {
    method: 'POST',
    body: { username, password: 'brand-new-password-1' },
  })
  check('新密码能登录', back.status === 200, `实际 ${back.status}`)
  const backJar = jarFrom(back)
  const restore = await request('/api/me/password', {
    method: 'POST',
    jar: backJar,
    body: { currentPassword: 'brand-new-password-1', newPassword: password },
  })
  check('能改回原密码（测试不留副作用）', restore.status === 200, `实际 ${restore.status}`)
}

section('管理员：禁言与注销')
{
  if (!isLocalTarget()) {
    console.log('  （目标不是本机，跳过：需要改本地库提权）')
  } else {
    // 用一个**独立的管理员账号**，不复用主账号。
    // 理由：主账号的「moderation:<sub>」限流桶在别处可能被占，
    // 而且拿主账号去测「不能对自己操作」这类断言会互相干扰。
    withLocalDb((db) => db.exec("DELETE FROM rate_limits WHERE id LIKE 'register:%'"))

    const adminName = `boss${Date.now().toString(36).slice(-5)}`
    const adminPass = 'admin-password-123'
    await request('/auth/register', { method: 'POST', body: { username: adminName, password: adminPass } })
    const adminLogin = await request('/auth/login', { method: 'POST', body: { username: adminName, password: adminPass } })
    const adminJar = jarFrom(adminLogin)
    setLocalRole(adminName, 'admin')
    // 提权后要重新登录：access token 里没有 role claim，
    // 而管理路由每次都查库，所以旧 token 也能用，不必重登。

    const targetName = `tgt${Date.now().toString(36).slice(-5)}`
    const targetPass = 'target-password-123'
    await request('/auth/register', { method: 'POST', body: { username: targetName, password: targetPass } })
    const targetLogin = await request('/auth/login', { method: 'POST', body: { username: targetName, password: targetPass } })
    const targetJar = jarFrom(targetLogin)
    const targetProfile = await (await request('/api/me', { jar: targetJar })).json()

    // ① 禁言
    const mute = await request(`/api/users/${targetProfile.id}/mute`, {
      method: 'POST', jar: adminJar, body: { minutes: 60 },
    })
    check('管理员能禁言', mute.status === 200, `实际 ${mute.status}`)
    const muteBody = await mute.json()
    check('禁言返回了截止时间戳', typeof muteBody.mutedUntil === 'number', `实际 ${muteBody.mutedUntil}`)

    // ② 被禁言后三处都要拦住
    await sleep(2200)
    const speak = await request('/api/messages', { method: 'POST', jar: targetJar, body: { body: '禁言后发言', room: 'modprobe' } })
    check('被禁言后发不了消息（403）', speak.status === 403, `实际 ${speak.status}`)

    const upload = await request('/api/uploads', { method: 'POST', jar: targetJar, headers: { 'X-Filename': 'a.txt' } })
    check('被禁言后传不了文件（403）', upload.status === 403, `实际 ${upload.status}`)

    // 用 openSocket 而不是 fetch：Node 的 fetch 不认 ws:// 协议。
    const ws = openSocket({ jar: targetJar, room: 'modprobe' })
    let wsStatus = 'connected'
    try {
      await ws.opened
    } catch (error) {
      wsStatus = error.message
    }
    ws.socket.terminate()
    check('被禁言后连不上 WebSocket（403）', wsStatus === 'HTTP 403', `实际 ${wsStatus}`)

    // ③ 解除
    const unmute = await request(`/api/users/${targetProfile.id}/mute`, {
      method: 'POST', jar: adminJar, body: { minutes: null },
    })
    check('能解除禁言', unmute.status === 200, `实际 ${unmute.status}`)
    await sleep(2200)
    const speak2 = await request('/api/messages', { method: 'POST', jar: targetJar, body: { body: '解除后发言', room: 'modprobe' } })
    check('解除后能发消息（201）', speak2.status === 201, `实际 ${speak2.status}`)

    // ③b 请求体残缺必须 400，**不能**被当成「解除禁言」。
    //
    // 起因是前端一个 P0：`body: { minutes: n }` 被 fetch 变成 "[object Object]"，
    // 而后端 `body?.minutes ?? null` 把「字段缺失」和「显式 null」合并成同一个值，
    // 于是残缺请求返回 200 且真的解除了禁言 —— 管理员看到「已解除禁言」
    // 还以为自己点对了。这类「用错也返回成功」的接口最难查，所以单独盯住。
    const reMute = await request(`/api/users/${targetProfile.id}/mute`, {
      method: 'POST', jar: adminJar, body: { minutes: 60 },
    })
    check('重新禁言成功（后面用来验证 400 不改状态）', reMute.status === 200, `实际 ${reMute.status}`)

    const noField = await request(`/api/users/${targetProfile.id}/mute`, {
      method: 'POST', jar: adminJar, body: {},
    })
    check('缺 minutes 字段要 400', noField.status === 400, `实际 ${noField.status}`)

    const nullBody = await request(`/api/users/${targetProfile.id}/mute`, {
      method: 'POST', jar: adminJar, body: null,
    })
    check('body 是 JSON null 要 400', nullBody.status === 400, `实际 ${nullBody.status}`)

    const afterBad = await (await request('/api/members', { jar: adminJar })).json()
    const targetRow = (afterBad.members ?? []).find((m) => m.username === targetName)
    check(
      '被拒的请求没有偷改禁言状态',
      targetRow !== undefined && targetRow.muted === true,
      `实际 muted=${targetRow && targetRow.muted}`,
    )

    // ④ 不能对自己操作
    const adminProfile = await (await request('/api/me', { jar: adminJar })).json()
    const selfMute = await request(`/api/users/${adminProfile.id}/mute`, { method: 'POST', jar: adminJar, body: { minutes: 10 } })
    check('不能禁言自己（400）', selfMute.status === 400, `实际 ${selfMute.status}`)
    const selfDelete = await request(`/api/users/${adminProfile.id}`, { method: 'DELETE', jar: adminJar })
    check('不能注销自己（400）', selfDelete.status === 400, `实际 ${selfDelete.status}`)

    // ⑤ 非管理员不能操作别人
    const targetMuteOther = await request(`/api/users/${adminProfile.id}/mute`, {
      method: 'POST', jar: targetJar, body: { minutes: 10 },
    })
    check('非管理员不能禁言别人（403）', targetMuteOther.status === 403, `实际 ${targetMuteOther.status}`)

    // ⑥ 注销
    const before2 = await (await request('/api/messages?room=modprobe', { jar: adminJar })).json()
    const targetMessages = before2.messages.filter((m) => m.username === targetName).length
    check('目标发过消息（后面验证保留）', targetMessages > 0, `实际 ${targetMessages}`)

    const del = await request(`/api/users/${targetProfile.id}`, { method: 'DELETE', jar: adminJar })
    check('管理员能注销用户', del.status === 200, `实际 ${del.status}`)
    const delBody = await del.json()
    check('注销报告了改写了几条消息', delBody.renamedMessages === targetMessages, `${delBody.renamedMessages} vs ${targetMessages}`)

    const relogin2 = await request('/auth/login', { method: 'POST', body: { username: targetName, password: targetPass } })
    check('被注销的人登不上了（401）', relogin2.status === 401, `实际 ${relogin2.status}`)

    const after = await (await request('/api/messages?room=modprobe', { jar: adminJar })).json()
    const stillThere = after.messages.filter((m) => m.body.includes('解除后发言'))
    check('消息本身被保留（注销不该删别人的发言）', stillThere.length > 0, `实际 ${stillThere.length}`)
    check('作者名改成了「已注销」', stillThere.every((m) => m.username === '已注销'), `实际 ${stillThere.map((m) => m.username).join(',')}`)
  }
}

/*
 * 会话被吊销之后，WebSocket **开不出新连接**。
 *
 * 这是「改密码 / 注销账号要真的把人踢下线」这件事的服务端那一半。
 * 前端只会在自己收到 401 时才关掉 socket，而别人那条连接不会主动配合；
 * 所以判据必须落在 DO 的握手上：他名下的 user_sessions 被清空之后，
 * 那把**还没过期**的 access token 也开不出新连接。
 *
 * 为什么这段单独放最后、用全新账号：它会把受害者的会话全部吊销，
 * 掺进别的 section 会让那些用例依赖「谁先跑」。
 */
section('会话吊销后 WebSocket 开不出来')
{
  const victimName = `ws${Date.now().toString(36).slice(-5)}`
  const victimPass = 'ws-revoke-password-1'
  await request('/auth/register', { method: 'POST', body: { username: victimName, password: victimPass } })
  const victimLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: victimName, password: victimPass },
  })
  const victimJar = jarFrom(victimLogin)

  // 先证明「正常情况下连得上」。少了这一步，下面那条断言可能只是因为
  // 这个房间/这个账号本来就连不上 —— 那种测试比没有更糟。
  const before = openSocket({ jar: victimJar, room: 'wsrevoke' })
  let beforeStatus = 'connected'
  try {
    await before.opened
  } catch (error) {
    beforeStatus = error.message
  }
  before.socket.terminate()
  check('吊销之前连得上（否则下一条断言没有意义）', beforeStatus === 'connected', `实际 ${beforeStatus}`)

  // 改密码 = 清空他名下的全部会话
  const revoked = await request('/api/me/password', {
    method: 'POST',
    jar: victimJar,
    body: { currentPassword: victimPass, newPassword: 'ws-revoke-password-2' },
  })
  check('用它自己的令牌改密码成功', revoked.status === 200, `实际 ${revoked.status}`)

  /*
   * 关键点：那把 access token **仍然在有效期内**（30 分钟），只是它背后的会话没了。
   * 老代码只验「签名对不对 + 用户行在不在」，所以这里能连上 ——
   * 改完密码，攻击者照样能重连进房间继续读，“改密码”也就白改了。
   * 新代码在握手时多问一句「这个人还有活着的会话吗」，于是拒掉。
   */
  const after = openSocket({ jar: victimJar, room: 'wsrevoke' })
  let afterStatus = 'connected'
  try {
    await after.opened
  } catch (error) {
    afterStatus = error.message
  }
  after.socket.terminate()
  check(
    '会话被吊销后，旧令牌开不出新 WebSocket（401）',
    afterStatus === 'HTTP 401',
    `实际 ${afterStatus}`,
  )
}

/*
 * ── 系统消息 ──
 *
 * 房间里「谁进了 / 谁走了 / 谁撤回了一条」会写成**一条真正的消息**落库
 * （`messages.kind = 'system'`），而不是只在前端拼一句话。这一节守的就是它：
 * 事件推得到、历史查得到、一个人开多个标签页不会刷屏、管理员也撤不掉它。
 *
 * 为什么单开一个房间（sysmsg）：进出提示是按**房间**广播的，
 * 混在 general 里的话，别的 section 每开一次 socket 就会往这里塞一条
 * 「XX 加入了房间」，断言会变成看运气。
 */
section('系统消息：进出房间')
{
  // 这一节要新注册一个「同伴」账号来当旁观者，先把注册/限流计数腾出来
  // （注册限额是 5 次/小时、实际只放行 4 次，前面几节已经用掉不少）。
  resetLocalRateLimits()

  /*
   * 重新登录拿一个干净的 jar。
   *
   * 上一节（改密码）把主账号名下的**全部会话**都吊销了（这正是那一节要验的东西），
   * 所以最早那个 `jar` 虽然 access token 还没过期，但 DO 握手时会问
   * 「他还有活着的会话吗」，问出 false → 401。
   * HTTP 那几处用老 jar 也能过，但混用两个 jar 只会让以后的人困惑。
   */
  const reloginMain = await request('/auth/login', { method: 'POST', body: { username, password } })
  const mainJar = jarFrom(reloginMain)
  check('主角重新登录成功（下面几条断言的前提）', typeof mainJar.access_token === 'string')

  const peerName = `peer${Date.now().toString(36).slice(-5)}`
  const peerPass = 'peer-password-123'
  await request('/auth/register', { method: 'POST', body: { username: peerName, password: peerPass } })
  const peerLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: peerName, password: peerPass },
  })
  const peerJar = jarFrom(peerLogin)
  check('同伴账号注册并登录成功（后面几条断言的前提）', typeof peerJar.access_token === 'string')

  const ROOM = 'sysmsg'

  // 同伴先进房间，当旁观者。他自己那条加入提示也会推到他自己的连接上
  // （DO 的 publish 是发给房间里所有连接，包括刚进来的这条）——
  // 所以下面的断言都按**文案**匹配，不能只按 kind，否则会撞上他自己的那条。
  const watch = openSocket({ jar: peerJar, room: ROOM })
  await watch.opened
  const waitSystem = (fragment, timeoutMs = 5000) =>
    watch.next(
      (e) => e.type === 'message' && e.message?.kind === 'system' && e.message.body.includes(fragment),
      timeoutMs,
    )
  const countSystem = (fragment) =>
    watch.inbox.filter(
      (e) => e.type === 'message' && e.message?.kind === 'system' && e.message.body.includes(fragment),
    ).length

  // ① 主角进房间 → 旁观者收到一条系统消息
  const mainTabOne = openSocket({ jar: mainJar, room: ROOM })
  await mainTabOne.opened
  const joined = await waitSystem(username)
  check('有人进房间时广播了一条系统消息', joined.message.kind === 'system')
  check(
    '文案是「XX 加入了房间」',
    joined.message.body === `${username} 加入了房间`,
    `实际 ${joined.message.body}`,
  )
  check(
    '系统消息的作者是哨兵值，不是真实账号',
    joined.message.userId === '00000000-0000-0000-0000-000000000000',
    `实际 ${joined.message.userId}`,
  )

  // ② 同一个人再开一个标签页：不该再播一条（进出提示按**人**算，不按连接算）
  const mainTabTwo = openSocket({ jar: mainJar, room: ROOM })
  await mainTabTwo.opened
  await sleep(800)
  check(
    '同一个人开第二个标签页，不再播「加入了房间」',
    countSystem(`${username} 加入了房间`) === 1,
    `实际收到 ${countSystem(`${username} 加入了房间`)} 条`,
  )

  // ③ 关掉第二个标签页：人还在（第一个还连着），不该播「离开了房间」
  mainTabTwo.socket.close()
  await sleep(800)
  check(
    '关掉其中一个标签页，不播「离开了房间」',
    countSystem(`${username} 离开了房间`) === 0,
    `实际收到 ${countSystem(`${username} 离开了房间`)} 条`,
  )

  // ④ 关掉最后一条连接 → 这才是真的离开
  mainTabOne.socket.close()
  const left = await waitSystem(`${username} 离开了房间`)
  check('最后一条连接断开时，播了「离开了房间」', left.message.body === `${username} 离开了房间`)

  // ⑤ 持久化：刷新（重新拉历史）之后这几条还在
  const history = await request(`/api/messages?room=${ROOM}`, { jar: mainJar })
  const historyPage = await history.json()
  const stored = historyPage.messages.filter((m) => m.kind === 'system')
  check(
    '系统消息进了历史（刷新之后还在）',
    stored.some((m) => m.body === `${username} 加入了房间`) &&
      stored.some((m) => m.body === `${username} 离开了房间`),
    `历史里 ${stored.length} 条系统消息：${stored.map((m) => m.body).join(' / ')}`,
  )
  check(
    '历史接口也带 kind 字段',
    historyPage.messages.every((m) => typeof m.kind === 'string'),
  )

  /*
   * ⑥ 系统提示不能被撤回。
   *
   * 这里的账号在这之前已经被上一节提成管理员了（`setLocalRole` 写的是库，
   * 一直有效）—— 而管理员**能**撤别人的消息，所以这条 403 只可能是
   * `kind !== 'user'` 那一道挡下来的，不是权限挡的。这正是要验的东西。
   */
  setLocalRole(username, 'admin')
  const noticeId = stored.find((m) => m.body.includes('加入了房间')).id
  const withdrawNotice = await request(`/api/messages/${noticeId}`, { method: 'DELETE', jar: mainJar })
  check(
    '管理员也撤不掉系统提示（403，不是 404/200）',
    withdrawNotice.status === 403,
    `实际 ${withdrawNotice.status}`,
  )
  const afterTry = await request(`/api/messages?room=${ROOM}`, { jar: mainJar })
  const afterTryPage = await afterTry.json()
  check(
    '被拒绝之后那条提示还在',
    afterTryPage.messages.some((m) => m.id === noticeId),
  )

  // ⑦ 撤回自己的消息 → 记一条「XX 撤回了一条消息」
  const doomed = await request('/api/messages', {
    method: 'POST',
    jar: mainJar,
    body: { body: '这条马上会被撤回', room: ROOM },
  })
  const doomedMessage = (await doomed.json()).message
  const selfDelete = await request(`/api/messages/${doomedMessage.id}`, {
    method: 'DELETE',
    jar: mainJar,
  })
  check('撤回自己的消息返回 200', selfDelete.status === 200, `实际 ${selfDelete.status}`)

  const selfNotice = await waitSystem('撤回了一条消息')
  check(
    '撤回之后留下一条「XX 撤回了一条消息」',
    selfNotice.message.body === `${username} 撤回了一条消息`,
    `实际 ${selfNotice.message.body}`,
  )

  // ⑧ 管理员撤回**别人**的消息 → 提示里必须同时出现操作者和作者
  const peerMessage = await request('/api/messages', {
    method: 'POST',
    jar: peerJar,
    body: { body: '同伴说的话', room: ROOM },
  })
  const peerMessageBody = (await peerMessage.json()).message
  const adminDelete = await request(`/api/messages/${peerMessageBody.id}`, {
    method: 'DELETE',
    jar: mainJar,
  })
  check('管理员能撤回别人的消息', adminDelete.status === 200, `实际 ${adminDelete.status}`)

  const adminNotice = await waitSystem('（管理员）撤回')
  check(
    '管理员撤回别人的消息时，提示里写清了是谁撤的、撤的谁的',
    adminNotice.message.body === `${username}（管理员）撤回了 ${peerName} 的一条消息`,
    `实际 ${adminNotice.message.body}`,
  )

  // ⑨ 撤回提示也要落库（刷新之后还在）
  const withWithdraw = await request(`/api/messages?room=${ROOM}`, { jar: mainJar })
  const withWithdrawPage = await withWithdraw.json()
  check(
    '撤回提示同样进了历史',
    withWithdrawPage.messages.some((m) => m.body === `${username} 撤回了一条消息`),
    `历史里没有这条：${withWithdrawPage.messages.map((m) => m.body).join(' / ')}`,
  )

  watch.socket.close()
}

/*
 * ── 管理员的大文件上传 ──
 *
 * 普通用户 16 MB、管理员 100 MB，分界线就是「要不要走流式」：
 * 超过 16 MB 之后不能再 `arrayBuffer()`（100 MB 拷进内存贴着 isolate 的
 * 128 MB 内存和 10 ms CPU 两道墙），改成「嗅探开头几个字节 + 把剩下的流原样
 * 转交 R2」，中间过一层 `FixedLengthStream` 做长度校验。
 *
 * 这一节验的就是那条路真的通了、而且**没有被静默截断**——
 * 流式上传最典型的失败方式就是「接口返回 201，R2 里只有一个零头」。
 */
section('管理员大文件上传（> 16 MB 走流式）')
{
  const BIG_MB = 17
  // 假 PNG：前 8 个字节是真的魔数（嗅探靠它），后面全是零。
  // 这里验的是「大小这条路」，不是解码，所以内容无所谓。
  const big = new Uint8Array(BIG_MB * 1024 * 1024)
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  /*
   * 自己登两个号：一个提成管理员、一个当普通用户。
   *
   * 不复用上一节的 jar —— 那一节结束时把连接都关掉了，而且这里的两个角色
   * 必须泾渭分明（16 MB 那条线就是按 role 分的）。注册限额又要用到，
   * 所以同样先清一次计数。
   */
  resetLocalRateLimits()
  const adminLogin = await request('/auth/login', { method: 'POST', body: { username, password } })
  const adminJar = jarFrom(adminLogin)
  const plainName = `plain${Date.now().toString(36).slice(-5)}`
  const plainPass = 'plain-password-123'
  await request('/auth/register', { method: 'POST', body: { username: plainName, password: plainPass } })
  const plainLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: plainName, password: plainPass },
  })
  const plainJar = jarFrom(plainLogin)
  check(
    '两个账号都登录成功（下面按角色分档的前提）',
    typeof adminJar.access_token === 'string' && typeof plainJar.access_token === 'string',
  )

  setLocalRole(username, 'admin')
  // 库里的 role 是**累积**的：这个脚本跑过几轮之后，别把角色当成默认值。
  setLocalRole(plainName, 'user')
  clearUploadQuota()

  /*
   * ① 管理员：真的发 17 MB，放行，且返回的大小是真实字节数。
   *
   * 这条放在最前面：它是**唯一**必须老老实实发完整字节的用例
   * （后面几条在服务端都是「没读完请求体就回话」的快路径，
   * 会把连接重置，不适合再挂一条大请求在后面）。
   */
  const asAdmin = await uploadRequest('/api/uploads', {
    jar: adminJar,
    contentType: 'image/png',
    filename: 'big.png',
    bytes: big,
  })
  check(`管理员能传 ${BIG_MB} MB（201）`, asAdmin.status === 201, `实际 ${asAdmin.status}`)
  const asset = await asAdmin.json()
  check('返回的大小是真实字节数', asset.size === big.byteLength, `实际 ${asset.size}`)
  check('按魔数识别成 image', asset.kind === 'image', `实际 ${asset.kind}`)

  // ② 读回来核对：**没有被截断**才是真的存进去了。
  //    流式上传最典型的失败方式就是「接口回 201、R2 里只有一个零头」。
  const served = await fetch(asset.url, { headers: { Cookie: cookieHeader(adminJar) } })
  check('上传后能读回来', served.status === 200, `实际 ${served.status}`)
  const roundTrip = await served.arrayBuffer()
  check(
    `R2 里存下来的字节数是完整的 ${BIG_MB} MB（流式没被截断）`,
    roundTrip.byteLength === big.byteLength,
    `实际 ${roundTrip.byteLength}`,
  )

  // ③ 账本记的是真实大小（声明值撒谎也改不了账）
  //
  // `withLocalDb` 不返回回调的返回值（它只管开库/关库），所以结果用外面的变量接。
  let globalBytes
  withLocalDb((db) => {
    globalBytes = db.prepare('SELECT bytes FROM upload_usage WHERE id = ?').get('total:global')
  })
  check(
    '累计字节账本按真实大小记账',
    globalBytes !== undefined && globalBytes.bytes === big.byteLength,
    `实际 ${JSON.stringify(globalBytes)}`,
  )

  /*
   * ④ 普通用户：16 MB 就是天花板。
   *
   * 只**声明** 17 MB、不真的发 —— 大小这一关在读请求体之前就判了，
   * 发过去的字节一个都不会被看。声明 `Content-Length` 而不写满，
   * 正好也覆盖了「声明值就是唯一依据」这件事。
   */
  const asUser = await rawUpload('/api/uploads', {
    jar: plainJar,
    contentType: 'image/png',
    filename: 'big.png',
    declaredLength: big.byteLength,
  })
  check(`普通用户传 ${BIG_MB} MB 被拒（413）`, asUser.status === 413, `实际 ${asUser.status}`)
  let asUserBody = {}
  try {
    asUserBody = JSON.parse(asUser.body)
  } catch {
    // 连接被重置时响应体可能是空的，下面的断言会红并打出原文
  }
  check(
    '拒绝理由里写的是 16 MB',
    typeof asUserBody.error === 'string' && asUserBody.error.includes('16 MB'),
    `实际 ${asUser.body.slice(0, 120)}`,
  )

  /*
   * ⑤ 不带 Content-Length 的上传必须被挡（411）。
   *
   * 这一条守的是「流式」这条路的入口：没有长度就既确认不了大小、也包不出
   * `FixedLengthStream`；而**放它进来**的后果是把整个请求体读进内存
   * （平台允许 100 MB，一次就顶到 isolate 的 128 MB）。以前这条是允许的。
   * 浏览器 `fetch()` 传 Blob / File 一定会带长度，所以这不影响真实前端。
   *
   * 必须写一点再结束，否则 node 会补一个 `Content-Length: 0`，
   * 那就变成了「空请求」（400），测不到分块那条路。
   */
  const noLength = await rawUpload('/api/uploads', {
    jar: adminJar,
    contentType: 'image/png',
    filename: 'nolength.png',
    chunk: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })
  check('不带 Content-Length 的上传被拒（411）', noLength.status === 411, `实际 ${noLength.status}`)

  /*
   * ⑥ 大文件同样受配额约束：全站存储塞满之后，这一档也要被挡住。
   *
   * 同样是「只声明、不发字节」—— 配额检查也在读请求体之前，
   * 所以这条断言验的是「这一档会被配额拦下」，而不是「发了 17 MB 才被拦」。
   */
  forceGlobalBytesQuota()
  const blocked = await rawUpload('/api/uploads', {
    jar: adminJar,
    contentType: 'image/png',
    filename: 'big2.png',
    declaredLength: big.byteLength,
  })
  check('全站存储到顶后，管理员的大文件也被挡（429）', blocked.status === 429, `实际 ${blocked.status}`)
  clearUploadQuota()
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
