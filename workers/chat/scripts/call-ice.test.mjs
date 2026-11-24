import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { issueIceServers } from '../src/calls/ice.ts'

const cloudflare = {
  RTC_TURN_PROVIDER: 'cloudflare',
  RTC_CLOUDFLARE_TURN_KEY_ID: '0123456789abcdef0123456789abcdef',
  RTC_CLOUDFLARE_TURN_TOKEN: 'test-turn-key-bearer',
}
const stun = 'stun:stun.cloudflare.com:3478'
const relay = 'turn:turn.cloudflare.com:3478?transport=udp'
const tls = 'turns:turn.cloudflare.com:443?transport=tcp'

function providerReply(iceServers) {
  return Response.json({ iceServers }, { status: 201 })
}

test('默认仍支持直连和原有 coturn 凭证', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('本地中继无需请求签发服务'))
  assert.deepEqual(await issueIceServers({}, 'alice'), { iceServers: [] })

  const turn = 'turn:127.0.0.1:34788?transport=udp'
  const key = 'local-test-secret-is-at-least-32-characters'
  const config = await issueIceServers({ RTC_STUN_URLS: stun, RTC_TURN_URLS: turn, RTC_TURN_SECRET: key }, 'alice')
  const [stunServer, turnServer] = config.iceServers
  assert.deepEqual(stunServer, { urls: [stun] })
  assert.deepEqual(turnServer.urls, [turn])
  assert.equal(turnServer.username, config.expiresAt / 1000 + ':alice')
  assert.equal(turnServer.credential, createHmac('sha1', key).update(turnServer.username).digest('base64'))
  assert.equal(fetch.mock.callCount(), 0)
})

test('Cloudflare 签发临时凭证并保留 UDP 和 TLS，过滤浏览器阻止的端口', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/' + cloudflare.RTC_CLOUDFLARE_TURN_KEY_ID + '/credentials/generate-ice-servers')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer ' + cloudflare.RTC_CLOUDFLARE_TURN_TOKEN)
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.redirect, 'manual')
    assert.ok(options.signal instanceof AbortSignal)
    assert.deepEqual(JSON.parse(options.body), { ttl: 3600 })
    return providerReply([
      { urls: ['stun:stun.cloudflare.com:53'] },
      { urls: [stun] },
      { urls: [relay, 'turn:turn.cloudflare.com:53?transport=tcp', tls], username: 'temporary', credential: 'short-lived', ignored: true },
    ])
  })

  const start = Date.now()
  const config = await issueIceServers(cloudflare, 'alice')
  assert.ok(config.expiresAt >= start + 3600_000 && config.expiresAt <= Date.now() + 3600_000)
  assert.deepEqual(config.iceServers, [
    { urls: [stun] },
    { urls: [relay, tls], username: 'temporary', credential: 'short-lived' },
  ])
  assert.equal(fetch.mock.callCount(), 1)
})

test('配置缺失或供应商非法时不发出请求', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('验证配置后才可请求签发'))
  t.mock.method(console, 'warn', () => {})
  assert.equal(await issueIceServers({ RTC_TURN_PROVIDER: 'cloudflare' }, 'alice'), undefined)
  assert.equal(await issueIceServers({ ...cloudflare, RTC_CLOUDFLARE_TURN_KEY_ID: '../x' }, 'alice'), undefined)
  assert.equal(await issueIceServers({ ...cloudflare, RTC_TURN_PROVIDER: 'unknown' }, 'alice'), undefined)
  assert.equal(fetch.mock.callCount(), 0)
})

test('服务异常时拒绝无效凭证配置，故障日志只记录原因', async (t) => {
  for (const [name, getReply, reason, status] of [
    ['上游拒绝', () => new Response('credential rejected', { status: 401 }), 'http', 401],
    ['上游重定向', () => new Response(null, { status: 302, headers: { Location: 'https://example.test' } }), 'http', 302],
    ['上游断开', () => { throw new Error('connection reset') }, 'network'],
    ['上游超时', () => { throw new DOMException('deadline expired', 'TimeoutError') }, 'timeout'],
    ['返回非 JSON', () => new Response('not-json'), 'response'],
    ['返回错误协议', () => providerReply([{ urls: ['https://example.test'] }]), 'response'],
    ['缺少中继凭证', () => providerReply([{ urls: [tls], username: 'temporary' }]), 'response'],
    ['只返回受限端口', () => providerReply([{ urls: ['turn:turn.cloudflare.com:53'], username: 'temporary', credential: 'short-lived' }]), 'response'],
  ]) {
    await t.test(name, async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', async () => getReply())
      const warn = subtest.mock.method(console, 'warn', () => {})
      assert.equal(await issueIceServers(cloudflare, 'alice'), undefined)
      const expected = { event: 'video_call_ice_failed', provider: 'cloudflare', reason }
      if (status) expected.status = status
      assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [[expected]])
      assert.equal(fetch.mock.callCount(), 1)
    })
  }
})
