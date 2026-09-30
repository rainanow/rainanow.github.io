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
  await sleep(3200) // 绕开上传间隔限流
  const htmlUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'text/html',
    filename: 'evil.html',
    bytes: new TextEncoder().encode('<html><body>x</body></html>'),
  })
  check('HTML / SVG 这类标记文本被拒', htmlUpload.status === 415, `实际 ${htmlUpload.status}`)

  await sleep(3200)
  const svgUpload = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/svg+xml',
    filename: 'evil.svg',
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  })
  check('SVG 被拒（它能在浏览器里执行脚本）', svgUpload.status === 415, `实际 ${svgUpload.status}`)

  // 撤回要连带删掉媒体对象
  await sleep(1600) // 绕开发言间隔限流
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
  await sleep(3200) // 绕开上传间隔限流
  const before = await uploadRequest('/api/uploads', {
    jar,
    contentType: 'image/png',
    filename: 'quota-a.png',
    bytes: pngBytes,
  })
  check('额度充足时能正常上传', before.status === 201, `实际 ${before.status}`)

  // 把全站今天的额度填满，模拟被人拿一群小号刷爆
  forceUploadQuota(day)
  await sleep(3200)
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
  await sleep(3200)
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
  await sleep(1600)
  await request('/api/messages', { method: 'POST', jar, body: { body: '会被清掉的消息一', room: probeRoom } })
  await sleep(1600)
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

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
