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
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const BASE = process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8787'
const ORIGIN = 'https://yulo.top'

/**
 * 跑之前清掉本地限流计数。
 *
 * 注册限额是「同一 IP 每小时 5 次」，而这个脚本一轮就要用掉 3 次
 * （成功 1 次 + 非法输入 1 次 + 重名 1 次），连跑两遍必然撞 429 ——
 * 表现成一片红，很容易被误判成代码坏了。
 *
 * 只在本机地址上动手，指向远端时直接跳过，绝不会去清生产环境的数据。
 */
function resetLocalRateLimits() {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)) return

  try {
    const dir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
    // 本地库文件名按 database_id 派生，改过 id 会留下旧文件，所以要挑最新的那个
    const newest = readdirSync(dir)
      .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime)[0]

    if (newest === undefined) return
    const db = new DatabaseSync(join(dir, newest.name))
    db.exec('DELETE FROM rate_limits')
    db.close()
    console.log('（已清空本地限流计数）')
  } catch (error) {
    console.log(`（跳过清理本地限流计数：${error.message}）`)
  }
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

function request(path, { jar, method = 'GET', body, origin } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (jar !== undefined) headers['Cookie'] = cookieHeader(jar)
  if (origin !== undefined) headers['Origin'] = origin
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

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

  return { socket, next, opened }
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

section('CORS 预检')
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

  // 连点保护
  const tooFast = await request('/api/messages', { method: 'POST', jar, body: { body: '抢跑' } })
  check('1.5 秒内的第二条被限流 429', tooFast.status === 429, `实际 ${tooFast.status}`)

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

  client.socket.close()
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

section('登录限流')
{
  // 用一个不存在的用户名，避免把上面那个账号锁掉
  let lastStatus = 0
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await request('/auth/login', {
      method: 'POST',
      body: { username: 'ghost-who-does-not-exist', password: 'whatever-long-enough' },
    })
    lastStatus = response.status
  }
  check('连续失败 11 次后返回 429', lastStatus === 429, `实际 ${lastStatus}`)
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
