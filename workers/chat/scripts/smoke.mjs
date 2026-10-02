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
 * 直接把「上传配额」塞满，用来验证熔断。
 *
 * 不真传 30 个文件是因为那太慢，而且会把本地 R2 撑起来。
 * 反正验的是「额度用完之后接口的态度」，账本怎么来的不重要。
 */
function forceUploadQuota(day) {
  withLocalDb((db) => {
    db.exec('DELETE FROM upload_usage')
    const insert = db.prepare('INSERT INTO upload_usage (id, bytes, count) VALUES (?, ?, ?)')
    insert.run(`global:${day}`, 8 * 1024 * 1024 * 1024, 99999)
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
  await sleep(3400) // 绕开上传间隔限流
  const htmlUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'text/html',
    filename: 'evil.html',
    bytes: new TextEncoder().encode('<html><body>x</body></html>'),
  })
  check('HTML / SVG 这类标记文本被拒', htmlUpload.status === 415, `实际 ${htmlUpload.status}`)

  await sleep(3400)
  const svgUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/svg+xml',
    filename: 'evil.svg',
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  })
  check('SVG 被拒（它能在浏览器里执行脚本）', svgUpload.status === 415, `实际 ${svgUpload.status}`)

  // 撤回要连带删掉媒体对象
  await sleep(2200) // 绕开发言间隔限流
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
  // 配额的日界是北京时间
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

  clearUploadQuota()
  await sleep(3400) // 绕开上传间隔限流
  const before = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-a.png',
    bytes: pngBytes,
  })
  check('额度充足时能正常上传', before.status === 201, `实际 ${before.status}`)

  // 把全站今天的额度填满，模拟被人拿一群小号刷爆
  forceUploadQuota(day)
  await sleep(3400)
  const blocked = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-b.png',
    bytes: pngBytes,
  })
  check('全站额度用完后上传被挡（429）', blocked.status === 429, `实际 ${blocked.status}`)
  const blockedBody = await blocked.json()
  check(
    '回了一句能看懂的原因',
    typeof blockedBody.error === 'string' && blockedBody.error.length > 0,
    `实际 ${JSON.stringify(blockedBody)}`,
  )

  clearUploadQuota()
  await sleep(3400)
  const after = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-c.png',
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

section('撤回限流')
{
  /*
   * 撤回原先完全没有限流，是唯一一条「无限制、每条都写库」的路由。
   * 这里验四件事：
   *   1. 额度用完之前，请求能正常走到「消息不存在」这一层（不会被限流误伤）；
   *   2. 打满之后确实返回 429，而不是无限放行；
   *   3. 429 带 Retry-After，前端/调用方能知道等多久；
   *   4. 撤回的计数器和发言是**分开**的 —— 被撤回限流挡住之后，还能正常发言。
   *      这一条最重要：如果两个计数器共用一个 key，用户连着撤回几条旧消息
   *      就会莫名其妙发不出话。
   *
   * 断言写成「序列里必然出现 429」而不是「第 21 次一定 429」，
   * 这样不依赖本轮之前已经用过几次撤回（上面还有 2 次），也就不会因为
   * 测试顺序调整而变成脆弱的假失败。
   */
  const statuses = []
  let retryAfter = null
  // 31 > 20 的额度，保证一定能打满
  for (let attempt = 0; attempt < 31; attempt += 1) {
    const response = await request('/api/messages/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
      jar,
    })
    statuses.push(response.status)
    if (response.status === 429 && retryAfter === null) {
      retryAfter = response.headers.get('retry-after')
    }
  }

  const firstBlocked = statuses.indexOf(429)
  check('撤回打满额度后返回 429', firstBlocked !== -1, `状态序列：${statuses.join(',')}`)
  check(
    '被限流之前，请求正常走到了业务逻辑（404）',
    firstBlocked > 0 && statuses.slice(0, firstBlocked).every((status) => status === 404),
    `前 ${firstBlocked} 个状态：${statuses.slice(0, firstBlocked).join(',')}`,
  )
  check('429 之后不会再放行', statuses.slice(firstBlocked).every((status) => status === 429))
  check('放行的次数是有限且合理的', firstBlocked > 0 && firstBlocked <= 21, `实际放行 ${firstBlocked} 次`)
  check(
    '429 带 Retry-After',
    retryAfter !== null && Number.parseInt(retryAfter, 10) > 0,
    `实际 ${retryAfter}`,
  )

  // 独立性：被撤回限流挡住之后，发言不该受影响。
  // 等过发言那个 2 秒窗口，否则会撞上发言限流而误判。
  await sleep(2200)
  const stillCanPost = await request('/api/messages', {
    method: 'POST',
    jar,
    body: { body: '撤回被限流之后我还能说话', room: 'general' },
  })
  check(
    '撤回被限流不影响发言（两个计数器是分开的）',
    stillCanPost.status === 201,
    `实际 ${stillCanPost.status}`,
  )
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
    // （20 次/60 秒）。不清的话这里会拿到 429，测试失败跟审计逻辑本身没关系。
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

section('refresh 限流')
{
  /*
   * refresh 开着 rotation，每次成功都会往 auth_blacklist 写一行。
   * 不限流就等于把「D1 写额度」挂在一个匿名可用的接口上。
   *
   * 这里验两件事：
   *   1. 有效 token 打满额度后返回 429（不是无限放行）；
   *   2. **废 token 也会被限住**。这条是防「解不出 sub 就跳过限流」那个洞 ——
   *      实现里解不开 token 时退回按 IP 记账，而不是放行。
   *
   * 桶键不同（refresh:<userId> vs refresh-ip:<ip>），所以先测哪个都不影响另一个。
   */
  const relogin = await request('/auth/login', { method: 'POST', body: { username, password } })
  const freshJar = jarFrom(relogin)

  const statuses = []
  let retryAfter = null
  for (let i = 0; i < 26; i += 1) {
    const response = await request('/auth/refresh', { method: 'POST', jar: freshJar })
    statuses.push(response.status)
    if (response.status === 429 && retryAfter === null) {
      retryAfter = response.headers.get('retry-after')
    }
    // refresh 成功后 token 会轮换，下一次必须带上新的，
    // 否则就是在重放旧 token（那走的是 401 分支，测不到「成功刷新被限」）
    const rotated = jarFrom(response)
    if (typeof rotated.refresh_token === 'string') freshJar.refresh_token = rotated.refresh_token
  }

  const firstBlocked = statuses.indexOf(429)
  check('有效 token：refresh 打满额度后返回 429', firstBlocked !== -1, `状态序列：${statuses.join(',')}`)
  check(
    '被限流之前 refresh 是成功的（200）',
    firstBlocked > 0 && statuses.slice(0, firstBlocked).every((status) => status === 200),
    `前 ${firstBlocked} 个状态：${statuses.slice(0, firstBlocked).join(',')}`,
  )
  check('refresh 的 429 带 Retry-After', retryAfter !== null && Number.parseInt(retryAfter, 10) > 0, `实际 ${retryAfter}`)

  // 废 token 分支：解不出 sub，应当退回按 IP 记账、而不是被放过。
  //
  // 这里必须自己发请求带上一个**独有的** X-Forwarded-For，原因很实在：
  // 本地请求的 clientIp() 一律落到 'unknown'，也就是所有测试共用同一个 IP 桶。
  // 不走这步的话，上面几轮跑测试留下的计数还在桶里，断言会「碰巧」通过 ——
  // 它验的是上一轮的结果，不是这一轮的。给一个本轮独有的 IP 才能真验。
  const uniqueIp = `203.0.113.${1 + (Date.now() % 250)}`
  const junkStatuses = []
  for (let i = 0; i < 26; i += 1) {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: 'refresh_token=not-a-real-token', 'X-Forwarded-For': uniqueIp },
    })
    junkStatuses.push(response.status)
  }
  const junkFirstBlocked = junkStatuses.indexOf(429)
  check(
    '废 token 也会被限住（不是绕过限流的后门）',
    junkFirstBlocked !== -1,
    `状态序列：${junkStatuses.join(',')}`,
  )
  check(
    '废 token 先正常返回 401，打满后才 429（不是一上来就被挡）',
    junkFirstBlocked > 0 && junkStatuses.slice(0, junkFirstBlocked).every((s) => s === 401),
    `前 ${junkFirstBlocked} 个状态：${junkStatuses.slice(0, junkFirstBlocked).join(',')}`,
  )
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
