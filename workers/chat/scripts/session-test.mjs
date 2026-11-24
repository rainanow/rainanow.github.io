import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const origin = 'http://localhost:1313'
const base = new URL(process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8787')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), '会话测试只运行在本地')
const state = resolve(process.env.CHAT_TEST_PERSIST_TO ?? '.tmp/rtc-stage2/device-preview-state')

function api(path, { method = 'GET', cookie, body } = {}) {
  const headers = { Origin: origin }
  if (cookie) headers.Cookie = cookie
  if (body) headers['Content-Type'] = 'application/json'
  return fetch(new URL(path, base), {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
}

function cookies(response) {
  return response.headers.getSetCookie().map((line) => line.split(';', 1)[0]).join('; ')
}

async function account() {
  const body = { username: 'sid' + randomUUID().slice(0, 8), password: randomUUID() + '_password' }
  const registration = await api('/auth/register', { method: 'POST', body })
  assert.equal(registration.status, 201)
  return { body, id: (await registration.json()).id }
}

async function login({ body }) {
  const response = await api('/auth/login', { method: 'POST', body })
  assert.equal(response.status, 200)
  const cookie = cookies(response)
  assert.equal(response.headers.getSetCookie().length, 2)
  await response.text()
  return cookie
}

function promote(id) {
  assert.match(id, /^[a-f0-9-]{36}$/)
  execFileSync(process.execPath, [
    'node_modules/wrangler/wrangler-dist/cli.js', 'd1', 'execute', 'yulo-chat', '--local',
    '--persist-to', state, '--command', "UPDATE users SET role='admin' WHERE id='" + id + "'",
  ], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
}

async function waitFor(select) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const result = select()
    if (result) return result
    await delay(25)
  }
  assert.fail('未收到预期的 WebSocket 事件')
}

async function open(t, cookie, room) {
  const url = new URL('/api/ws', base)
  url.protocol = 'ws:'
  url.searchParams.set('room', room)
  const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } })
  const events = []
  let failure
  const closed = new Promise((done) => socket.once('close', done))
  socket.on('error', (error) => { failure = error })
  socket.on('message', (message) => { events.push(JSON.parse(message.toString())) })
  t.after(() => socket.terminate())
  const ready = await waitFor(() => {
    if (failure) throw failure
    return events.find((event) => event.type === 'ready')
  })
  return { socket, closed, events, ready }
}

async function status(path, expected, options) {
  const response = await api(path, options)
  assert.equal(response.status, expected, path)
  return response
}

test('设备换登录、刷新、跨房间注销及计数', { timeout: 60000 }, async (t) => {
  const [member, admin] = await Promise.all([account(), account()])
  promote(admin.id)
  const observer = await login(admin)
  const prior = await login(member)
  const suffix = randomUUID().slice(0, 7)
  const rooms = ['session-a-' + suffix, 'session-b-' + suffix]
  const watchers = await Promise.all(rooms.map((room) => open(t, observer, room)))
  const oldSockets = await Promise.all(rooms.map((room) => open(t, prior, room)))
  assert.ok(oldSockets.every(({ ready }) => ready.online === 2))

  const replacement = await login(member)
  await Promise.all(oldSockets.map(({ events }) => waitFor(() => events.some((event) => event.type === 'session-revoked'))))
  assert.deepEqual(await Promise.all(oldSockets.map(({ closed }) => closed)), [4403, 4403])
  await status('/api/me', 401, { cookie: prior })
  await status('/auth/refresh', 401, { method: 'POST', cookie: prior })
  await status('/auth/logout', 200, { method: 'POST', cookie: prior })
  await status('/api/me', 200, { cookie: replacement })

  const live = await Promise.all(rooms.map((room) => open(t, replacement, room)))
  const extraTab = await open(t, replacement, rooms[0])
  assert.equal(extraTab.ready.online, 2)
  extraTab.socket.close()
  await waitFor(() => extraTab.socket.readyState === WebSocket.CLOSED)
  assert.ok([1000, 1005].includes(await extraTab.closed))

  const refresh = await status('/auth/refresh', 200, { method: 'POST', cookie: replacement })
  await status('/api/me', 200, { cookie: cookies(refresh) })
  assert.ok(live.every(({ socket }) => socket.readyState === WebSocket.OPEN))
  const lastEvents = watchers.map(({ events }) => events.length)
  const purge = await status('/api/users/' + member.id, 200, { method: 'DELETE', cookie: observer })
  assert.equal((await purge.json()).ok, true)
  assert.deepEqual(await Promise.all(live.map(({ closed }) => closed)), [4403, 4403])
  for (const [index, room] of rooms.entries()) {
    await waitFor(() => watchers[index].events.slice(lastEvents[index]).find((event) =>
      event.type === 'presence' && event.online === 1))
    const response = await status('/api/members?scope=online&room=' + room, 200, { cookie: observer })
    const list = await response.json()
    assert.equal(list.total, 1)
    assert.deepEqual(list.members.map(({ id }) => id), [admin.id])
  }
  await status('/api/me', 401, { cookie: cookies(refresh) })
  await status('/auth/refresh', 401, { method: 'POST', cookie: cookies(refresh) })
})

test('并行登录只留下一个设备，失败的旧刷新不覆盖新 Cookie', { timeout: 18000 }, async () => {
  const member = await account()
  const initial = await login(member)
  const [a, b] = await Promise.all([login(member), login(member)])
  const verified = await Promise.all([a, b].map((cookie) => api('/api/me', { cookie })))
  assert.deepEqual(verified.map((response) => response.status).sort(), [200, 401])
  const alive = verified[0].ok ? a : b
  const stale = await status('/auth/refresh', 401, { method: 'POST', cookie: initial })
  assert.deepEqual(stale.headers.getSetCookie(), [])
  await status('/api/me', 200, { cookie: alive })
})
