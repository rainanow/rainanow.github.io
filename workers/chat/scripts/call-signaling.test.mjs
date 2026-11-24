import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'

const base = new URL(process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8787')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), '通话测试只在本地运行')
const origin = 'http://localhost:1313'
const disabledRoom = 'call-disabled'

async function createAccount() {
  const username = 'rtc' + randomUUID().replaceAll('-', '').slice(0, 12)
  const body = JSON.stringify({ username, password: randomUUID() })
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body,
    redirect: 'error',
  }
  const register = await fetch(new URL('/auth/register', base), options)
  assert.equal(register.status, 201, '注册测试账号')
  await register.text()
  const login = await fetch(new URL('/auth/login', base), options)
  assert.equal(login.status, 200, '登录测试账号')
  await login.text()
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  const me = await fetch(new URL('/api/me', base), { headers: { Cookie: cookie }, redirect: 'error' })
  assert.equal(me.status, 200)
  return { cookie, id: (await me.json()).id }
}

function iceAccess(account, callId, resumeToken, requestOrigin = origin) {
  const headers = { Origin: requestOrigin, 'Content-Type': 'application/json' }
  if (account) headers.Cookie = account.cookie
  return fetch(new URL('/api/calls/ice-servers', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ room: 'call-test', callId, resumeToken }),
    redirect: 'error',
  })
}

class Client {
  events = []
  pending = []

  constructor(account, room) {
    const url = new URL('/api/ws', base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('room', room)
    this.socket = new WebSocket(url, { headers: { Cookie: account.cookie, Origin: origin } })
    this.socket.on('error', (error) => { this.failure = error })
    this.socket.on('message', (message) => {
      let data
      try { data = JSON.parse(message.toString()) } catch { return }
      this.events.push(data)
      this.pending.push(data)
    })
  }

  send(action, data = {}, type = 'call') {
    this.socket.send(JSON.stringify({ type, action, ...data }))
  }

  async next(predicate, label, timeout = 5_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (this.failure) throw this.failure
      const index = this.pending.findIndex(predicate)
      if (index >= 0) return this.pending.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    assert.fail('等待事件超时：' + label)
  }

  action(action, callId, timeout) {
    return this.next((event) => event.action === action && (callId === undefined || event.callId === callId), action, timeout)
  }

  async ready(enabled = true) {
    const event = await this.next((value) => value.type === 'ready', 'ready')
    assert.equal(event.videoCalls, enabled ? true : undefined)
    if (enabled) assert.ok(event.accessExpiresAt > Date.now())
  }

  async hello() {
    this.send('hello')
    await this.action('available')
  }

  async invite(userId, requestId = randomUUID()) {
    this.send('invite', { userId, requestId })
    return this.next((event) => event.requestId === requestId, 'invite result')
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = once(this.socket, 'close')
    this.socket.close()
    await closed
  }
}

test('本地 Worker 视频通话信令', { timeout: 100_000 }, async (t) => {
  const clients = []
  t.after(() => { for (const client of clients) client.socket.terminate() })
  const open = async (account, room = 'call-test', declare = true) => {
    const client = new Client(account, room)
    clients.push(client)
    await client.ready(room !== disabledRoom)
    if (declare) await client.hello()
    return client
  }

  const [alice, bob, carol] = await Promise.all([createAccount(), createAccount(), createAccount()])
  const [a, b, bTab, c, bOther, disabled] = await Promise.all([
    open(alice),
    open(bob, 'call-test', false),
    open(bob, 'call-test', false),
    open(carol),
    open(bob, 'call-other'),
    open(alice, disabledRoom, false),
  ])
  disabled.send('hello')
  disabled.socket.send('ping')
  await disabled.next((event) => event.type === 'presence', '禁用房间仍可接收文字频道事件')
  assert.equal(disabled.events.some((event) => event.action === 'available'), false)
  assert.equal((await a.invite(bob.id)).code, 'unavailable', '只有声明支持的同房间连接才可振铃')
  await Promise.all([b.hello(), bTab.hello()])

  const requestId = randomUUID()
  const outgoing = await a.invite(bob.id, requestId)
  assert.equal(outgoing.action, 'invited')
  const { callId } = outgoing
  const beforeAccept = await iceAccess(alice, callId, randomUUID())
  assert.equal(beforeAccept.status, 403, '响铃阶段不能领中继凭证')
  await beforeAccept.text()
  const received = await Promise.all([b.action('incoming', callId), bTab.action('incoming', callId)])
  assert.ok(received.every((event) => event.peer.userId === alice.id))
  assert.equal((await a.invite(bob.id, requestId)).callId, callId, '重复 invite 复用结果')
  assert.equal((await c.invite(bob.id)).code, 'busy')

  for (const unrelated of [c, bOther]) unrelated.send('accept', { callId })
  for (const unrelated of [c, bOther]) assert.equal((await unrelated.action('error', callId)).code, 'forbidden')
  a.send('offer', { callId, sdp: 'v=0\r\n' }, 'webrtc')
  assert.equal((await a.action('error', callId)).code, 'invalid-state', '接听前不可交换媒体信令')

  b.send('accept', { callId })
  bTab.send('accept', { callId })
  const results = await Promise.all([b, bTab].map((client) => client.next(
    (event) => event.callId === callId && ['accepted', 'ended'].includes(event.action), '接听竞争',
  )))
  const winner = results.findIndex((event) => event.action === 'accepted')
  assert.notEqual(winner, -1)
  const callee = winner === 0 ? b : bTab
  const losingTab = winner === 0 ? bTab : b
  assert.equal(results[winner === 0 ? 1 : 0].reason, 'answered-elsewhere')
  const accepted = await a.action('accepted', callId)
  assert.notEqual(accepted.resumeToken, results[winner].resumeToken)
  const allowedIce = await iceAccess(alice, callId, accepted.resumeToken)
  assert.equal(allowedIce.status, 200)
  assert.equal(allowedIce.headers.get('Cache-Control'), 'no-store')
  assert.ok(Array.isArray((await allowedIce.json()).iceServers))
  const deniedIce = await Promise.all([
    iceAccess(carol, callId, accepted.resumeToken),
    iceAccess(bob, callId, accepted.resumeToken),
    iceAccess(alice, callId, randomUUID()),
    iceAccess(alice, callId, accepted.resumeToken, 'https://untrusted.example'),
    iceAccess(null, callId, accepted.resumeToken),
  ])
  assert.deepEqual(deniedIce.map((response) => response.status), [403, 403, 403, 403, 401])
  await Promise.all(deniedIce.map((response) => response.text()))
  losingTab.send('hangup', { callId })
  await losingTab.next((event) => event.action === 'error' && event.code === 'forbidden', '其他标签不能挂断')

  a.send('media-ready', { callId })
  callee.send('media-ready', { callId })
  await Promise.all([a.action('negotiate', callId), callee.action('negotiate', callId)])
  const candidate = { candidate: 'candidate:test', sdpMLineIndex: 0 }
  a.send('ice', { callId, candidate }, 'webrtc')
  assert.deepEqual((await callee.action('ice', callId)).candidate, candidate)
  a.send('offer', { callId, sdp: 'v=0\r\n' }, 'webrtc')
  assert.equal((await callee.action('offer', callId)).sdp, 'v=0\r\n')
  callee.send('answer', { callId, sdp: 'v=0\r\ns=test\r\n' }, 'webrtc')
  assert.equal((await a.action('answer', callId)).sdp, 'v=0\r\ns=test\r\n')
  a.send('connected', { callId })
  callee.send('connected', { callId })
  await Promise.all([a.action('active', callId), callee.action('active', callId)])
  assert.equal((await a.invite(bob.id, requestId)).phase, 'active')
  t.diagnostic('三账号隔离、重复邀请、选中唯一接听连接和定向 SDP/ICE 通过')

  const rebound = await open(alice)
  rebound.send('resume', { callId, resumeToken: randomUUID() })
  assert.equal((await rebound.action('error', callId)).code, 'forbidden')
  rebound.send('resume', { callId, resumeToken: accepted.resumeToken })
  assert.equal((await rebound.action('resumed', callId)).phase, 'active')
  assert.equal((await a.invite(bob.id, requestId)).code, 'forbidden', '重绑定后旧连接失去会话读取权限')
  await a.close()
  rebound.send('check', { callId })
  assert.equal((await rebound.action('status', callId)).phase, 'active', '旧连接晚关闭不影响新绑定')
  await rebound.close()
  await callee.next((e) => e.action === 'status' && e.callId === callId && e.peerReconnecting, '对方已断线')
  const again = await open(alice)
  again.send('resume', { callId, resumeToken: accepted.resumeToken })
  await again.action('resumed', callId)
  again.send('hangup', { callId })
  assert.equal((await callee.action('ended', callId)).reason, 'hangup')
  const afterHangup = await iceAccess(alice, callId, accepted.resumeToken)
  assert.equal(afterHangup.status, 403, '通话结束后停止签发')
  await afterHangup.text()
  assert.equal((await again.invite(bob.id, requestId)).action, 'error', '新标签页不可重放旧邀请')
  t.diagnostic('有凭证的重新绑定、断线宽限和挂断通过')

  const [ourInvite, reciprocal] = await Promise.all([again.invite(carol.id), c.invite(alice.id)])
  const outgoingWins = ourInvite.action === 'invited'
  const wins = outgoingWins ? ourInvite : reciprocal
  const loses = outgoingWins ? reciprocal : ourInvite
  const receiver = outgoingWins ? c : again
  const sender = outgoingWins ? again : c
  assert.equal(wins.action, 'invited')
  assert.equal(loses.code, 'busy', '互拨只创建一通')
  await receiver.action('incoming', wins.callId)
  receiver.send('reject', { callId: wins.callId })
  assert.equal((await sender.action('ended', wins.callId)).reason, 'rejected')

  const cancel = await c.invite(bob.id)
  assert.equal(cancel.action, 'invited')
  await callee.action('incoming', cancel.callId)
  c.send('cancel', { callId: cancel.callId })
  assert.equal((await callee.action('ended', cancel.callId)).reason, 'canceled')

  const silence = await callee.invite(carol.id)
  assert.equal(silence.action, 'invited')
  await c.action('incoming', silence.callId)
  assert.equal((await c.action('ended', silence.callId, 40_000)).reason, 'no-answer')
  const afterTimeout = await callee.invite(carol.id)
  assert.equal(afterTimeout.action, 'invited', '超时后双方名额均已释放')
  callee.send('cancel', { callId: afterTimeout.callId })
  await c.action('ended', afterTimeout.callId)
  t.diagnostic('互拨、拒绝、取消、Alarm 无人接听和释放名额通过')

  const cTab = await open(carol)
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => {
    return (i % 2 === 0 ? c : cTab).invite(randomUUID())
  }))
  assert.ok(burst.some((event) => event.code === 'rate-limited'), '同账号多标签页共用邀请限流')

  assert.equal(b.events.filter((e) => e.action === 'incoming' && e.callId === callId).length, 1)
  for (const unrelated of [c, bOther, disabled, losingTab]) {
    assert.equal(unrelated.events.some((e) => e.callId === callId && e.type === 'webrtc'), false)
  }
  for (const ignored of [c, bOther, disabled]) {
    assert.equal(ignored.events.some((e) => e.callId === callId && e.action === 'incoming'), false)
  }
  assert.equal(disabled.events.some((event) => event.action === 'available'), false)
})
