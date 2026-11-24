import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import WebSocket from 'ws'

const site = 'http://localhost:1313'
const api = 'http://127.0.0.1:8787'
const roomPath = '/chat/'
const root = fileURLToPath(new URL('../.tmp/rtc-stage2/', import.meta.url))
const publicDir = resolve(process.env.RTC_TEST_PUBLIC ?? resolve(root, 'public'))
const requireFrom = (folder) => createRequire(resolve(folder, 'package.json'))
const rtc = requireFrom(process.env.RTC_TEST_NATIVE ?? resolve(root, 'native'))('@roamhq/wrtc')
const { RTCVideoSource, RTCAudioSource, RTCVideoSink, RTCAudioSink } = rtc.nonstandard
const html = await readFile(resolve(publicDir, '.' + roomPath, 'index.html'), 'utf8')
const buildPage = new JSDOM(html)
assert.equal(buildPage.window.document.getElementById('chat-app')?.dataset.room, 'general')
const bundle = buildPage.window.document.querySelector('script[src*="/js/chat-bundle."]')
assert.ok(bundle, 'Hugo 构建产物应加载通话与聊天脚本')
const script = await readFile(resolve(publicDir, '.' + new URL(bundle.getAttribute('src'), site).pathname), 'utf8')
buildPage.window.close()

function cookiesFrom(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0]
    const boundary = pair.indexOf('=')
    jar.set(pair.slice(0, boundary), pair.slice(boundary + 1))
  }
}

function cookieHeader(jar) {
  return Array.from(jar, ([name, value]) => name + '=' + value).join('; ')
}

async function account() {
  const username = 'rtcm' + randomUUID().replaceAll('-', '').slice(0, 11)
  const init = {
    method: 'POST',
    headers: { Origin: site, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: randomUUID() }),
    redirect: 'error',
  }
  const register = await fetch(api + '/auth/register', init)
  assert.equal(register.status, 201)
  await register.text()
  const login = await fetch(api + '/auth/login', init)
  assert.equal(login.status, 200)
  await login.text()
  const jar = new Map()
  cookiesFrom(jar, login)
  return { username, jar }
}

async function waitFor(condition, message, timeout = 15000) {
  const end = Date.now() + timeout
  do {
    const result = await condition()
    if (result) return result
    await delay(70)
  } while (Date.now() < end)
  assert.fail(message)
}

function fixture(user, options) {
  const errors = []
  const console = new VirtualConsole()
  console.on('jsdomError', (error) => errors.push(error.message))
  const dom = new JSDOM(html, { url: site + roomPath, runScripts: 'outside-only', virtualConsole: console })
  const { window } = dom
  const select = (selector) => window.document.querySelector(selector)
  select('#chat-app').dataset.api = api
  const tracks = []
  const sockets = []
  const peers = []
  const signals = []
  const sinks = []
  const timers = new Set()
  const received = { audio: 0, video: 0 }
  let denyNext = false
  let shorten = Boolean(options.shorten)
  const sent = { resume: 0, refresh: 0 }
  Object.defineProperty(window, 'isSecureContext', { value: true })
  window.HTMLMediaElement.prototype.play = async () => {}
  window.MediaStream = rtc.MediaStream

  function captureTrack(source, feed, spacing, facingMode) {
    const track = source.createTrack()
    tracks.push(track)
    if (facingMode) Object.defineProperty(track, 'getSettings', { value: () => ({ facingMode }) })
    const timer = setInterval(() => {
      if (track.readyState === 'live') {
        feed()
      } else {
        clearInterval(timer)
        timers.delete(timer)
      }
    }, spacing)
    timers.add(timer)
    return track
  }

  Object.defineProperty(window.navigator, 'mediaDevices', { value: {
    enumerateDevices: async () => [{ kind: 'videoinput' }, { kind: 'videoinput' }],
    getUserMedia: async ({ audio, video }) => {
      if (denyNext) {
        denyNext = false
        throw new window.DOMException('test denial', 'NotAllowedError')
      }
      const output = []
      if (audio) {
        const source = new RTCAudioSource()
        const samples = new Int16Array(480)
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 15) * 1200
        output.push(captureTrack(source, () => source.onData({
          samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480,
        }), 10))
      }
      if (video) {
        const source = new RTCVideoSource()
        const width = 160
        const height = 90
        const data = new Uint8ClampedArray(width * height * 1.5).fill(128)
        let frames = 0
        const facing = video.facingMode?.exact ?? video.facingMode?.ideal ?? 'user'
        output.push(captureTrack(source, () => {
          data.fill(70 + frames++ % 60, 0, width * height)
          source.onFrame({ width, height, data })
        }, 85, facing))
      }
      return new rtc.MediaStream(output)
    },
  } })

  window.RTCPeerConnection = class extends rtc.RTCPeerConnection {
    constructor(config) {
      super(options.relay ? { iceTransportPolicy: 'relay', iceServers: config.iceServers }
        : { iceServers: [] })
      peers.push(this)
      this.addEventListener('track', ({ track }) => {
        if (track.kind === 'audio') {
          const sink = new RTCAudioSink(track)
          sink.ondata = ({ samples }) => { received.audio += samples.length }
          sinks.push(sink)
        } else if (track.kind === 'video') {
          const sink = new RTCVideoSink(track)
          sink.onframe = (event) => { if (event.frame.width > 0) received.video++ }
          sinks.push(sink)
        }
      })
    }
  }

  window.WebSocket = class extends window.EventTarget {
    static OPEN = WebSocket.OPEN
    constructor(url) {
      super()
      assert.equal(new URL(url).origin, api.replace(/^http/, 'ws'))
      const transport = new WebSocket(url, { headers: { Cookie: cookieHeader(user.jar), Origin: site } })
      this.transport = transport
      sockets.push(this)
      transport.on('open', () => this.dispatchEvent(new window.Event('open')))
      transport.on('error', () => this.dispatchEvent(new window.Event('error')))
      transport.on('close', () => this.dispatchEvent(new window.Event('close')))
      transport.on('message', (bytes) => {
        let data = String(bytes)
        if (shorten && data.startsWith('{')) {
          const frame = JSON.parse(data)
          if (frame.type === 'ready' && frame.videoCalls) {
            shorten = false
            data = JSON.stringify({ ...frame, accessExpiresAt: Date.now() + 50_000 })
          }
        }
        this.dispatchEvent(new window.MessageEvent('message', { data }))
      })
    }

    get readyState() { return this.transport.readyState }
    close(code, reason) { this.transport.close(code, reason) }
    send(data) {
      if (data.startsWith('{')) {
        const { action } = JSON.parse(data)
        signals.push(action)
        if (action === 'resume') sent.resume++
      }
      this.transport.send(data)
    }
  }

  window.fetch = async (url, init = {}) => {
    const target = new URL(url, api)
    assert.equal(target.origin, api)
    const headers = new Headers(init.headers)
    headers.set('Cookie', cookieHeader(user.jar))
    headers.set('Origin', site)
    const response = await fetch(target, { ...init, headers, redirect: 'error' })
    cookiesFrom(user.jar, response)
    if (target.pathname === '/auth/refresh') sent.refresh++
    if (target.pathname === '/api/calls/ice-servers' && options.prepareIce && response.ok) {
      options.prepareIce(await response.clone().json())
    }
    return response
  }
  window.addEventListener('error', (event) => errors.push(event.message))
  window.eval(script)

  return {
    select, tracks, sockets, peers, received, signals, sent, errors,
    deny: () => { denyNext = true },
    pageHide: () => window.dispatchEvent(new window.Event('pagehide')),
    close: () => {
      window.dispatchEvent(new window.Event('pagehide'))
      for (const sink of sinks) sink.stop()
      for (const peer of peers) peer.close()
      for (const track of tracks) if (track.readyState === 'live') track.stop()
      for (const timer of timers) clearInterval(timer)
      for (const socket of sockets) socket.transport.terminate()
      window.close()
    },
  }
}

function phase(page, state) {
  return waitFor(() => page.select('[data-chat-call]').dataset.phase === state, '通话状态 ' + state)
}

async function invite(page, name) {
  const toggle = await waitFor(() => {
    const node = page.select('[data-chat-members-toggle]')
    return node && !node.hidden && node
  }, '成员列表入口')
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
  const button = await waitFor(() => page.select('[aria-label="呼叫 ' + name + '"]'), '视频呼叫按钮')
  button.click()
}

function released(page) {
  return waitFor(() => page.select('[data-chat-call]').hidden &&
    page.tracks.every((track) => track.readyState === 'ended') &&
    page.select('[data-call-local]').srcObject === null &&
    page.select('[data-call-remote]').srcObject === null, '已释放通话媒体')
}

async function mediaPath(page, relay) {
  return waitFor(async () => {
    const pc = page.peers.at(-1)
    if (!pc || page.received.audio === 0 || page.received.video === 0) return
    const stats = await pc.getStats()
    const transport = Array.from(stats.values()).find((row) => row.type === 'transport' && row.selectedCandidatePairId)
    const pair = stats.get(transport?.selectedCandidatePairId)
    const local = stats.get(pair?.localCandidateId)
    const remote = stats.get(pair?.remoteCandidateId)
    if (!local || !remote) return
    if (relay ? local.candidateType !== 'relay' || remote.candidateType !== 'relay'
      : local.candidateType === 'relay' || remote.candidateType === 'relay') return
    return {
      audioSamples: page.received.audio, videoFrames: page.received.video,
      candidates: [local.candidateType, remote.candidateType],
    }
  }, relay ? '双向 TURN 音视频路径' : '双向直连音视频路径', 20000)
}

test('主聊天室完成一对一通话生命周期', { timeout: 135000 }, async (t) => {
  const pages = []
  let turn
  t.after(() => {
    for (const page of pages) page.close()
    turn?.stop()
  })
  async function two(options) {
    const [left, right] = await Promise.all([account(), account()])
    const a = fixture(left, options)
    const b = fixture(right, { ...options, shorten: false })
    pages.push(a, b)
    await Promise.all([a, b].map((page) => waitFor(() =>
      page.signals.includes('hello') && !page.select('[data-chat-room]').hidden, '房间已连接')))
    return { a, b, receiver: right.username }
  }

  try {
    const direct = await two({})
    const { a, b, receiver } = direct
    a.deny()
    await invite(a, receiver)
    await waitFor(() => a.select('[data-chat-notice]').textContent.includes('请允许使用'), '设备权限拒绝')
    await released(a)
    assert.equal(b.tracks.length, 0)
    await invite(a, receiver)
    await phase(b, 'incoming')
    assert.equal(b.tracks.length, 0, '被叫响铃期间未启用设备')
    assert.equal(b.select('[data-call-hangup]').getAttribute('aria-label'), '拒绝通话')
    b.select('[data-call-hangup]').click()
    await released(a)
    await delay(4100)
    await invite(a, receiver)
    await phase(b, 'incoming')
    b.select('[data-call-accept]').click()
    await Promise.all([phase(a, 'active'), phase(b, 'active')])
    t.diagnostic('直连收发 ' + JSON.stringify(await Promise.all([mediaPath(a, false), mediaPath(b, false)])))

    const local = a.select('[data-call-local]').srcObject
    const remote = a.select('[data-call-remote]').srcObject
    const callButtons = Array.from(a.select('[data-call-controls]').querySelectorAll('button:not([hidden])'))
    assert.equal(callButtons.length, 3)
    for (const [index, name] of ['mic', 'hangup', 'camera'].entries()) {
      const button = callButtons[index]
      assert.equal(button, a.select('[data-call-' + name + ']'))
      assert.ok(button.querySelector('svg'))
      assert.equal(button.textContent.trim(), '')
    }
    const videoFrames = a.received.video
    a.select('[data-call-mini]').click()
    assert.equal(a.select('[data-call-stage]').dataset.main, 'local')
    assert.equal(a.select('[data-call-local]').srcObject, local)
    assert.equal(a.select('[data-call-remote]').srcObject, remote)
    assert.equal(a.peers.length, 1)
    await waitFor(() => a.received.video > videoFrames, '交换主副画面后继续收视频')

    const caption = '通话浮动测试 ' + randomUUID()
    a.select('[data-chat-input]').value = caption
    a.select('[data-chat-send]').click()
    await Promise.all([a, b].map((page) => waitFor(() =>
      page.select('[data-call-overlay]').textContent.includes(caption) &&
      page.select('[data-chat-messages]').textContent.includes(caption), '新房间消息浮在视频上且保留在聊天记录中')))
    const floating = Array.from(a.select('[data-call-overlay]').children)
    assert.equal(floating.filter((line) => line.textContent.includes(caption)).length, 1, '自己的消息只浮动一次')
    const row = Array.from(a.select('[data-chat-messages]').querySelectorAll('.chat__message'))
      .find((message) => message.textContent.includes(caption))
    row.querySelector('.chat__delete').click()
    await Promise.all([a, b].map((page) => waitFor(() =>
      !page.select('[data-call-overlay]').textContent.includes(caption) &&
      !page.select('[data-chat-messages]').textContent.includes(caption), '撤回同步移除浮动消息与聊天记录')))
    t.diagnostic('互换画面保持媒体流，浮动消息同步发送和撤回')

    a.select('[data-call-mic]').click()
    assert.equal(local.getAudioTracks()[0].enabled, false)
    assert.equal(a.select('[data-call-mic]').getAttribute('aria-pressed'), 'true')
    a.select('[data-call-mic]').click()
    assert.equal(local.getAudioTracks()[0].enabled, true)
    a.select('[data-call-camera]').click()
    await waitFor(() => local.getVideoTracks().length === 0 &&
      a.select('[data-call-camera]').getAttribute('aria-pressed') === 'true', '关闭摄像头')
    a.select('[data-call-camera]').click()
    await waitFor(() => local.getVideoTracks().length === 1 &&
      a.select('[data-call-camera]').getAttribute('aria-pressed') === 'false', '恢复摄像头')
    a.sockets[0].close(4000, 'local test')
    await waitFor(() => a.sent.resume > 0 && a.select('[data-call-status]').textContent === '通话中', '认证重连')
    assert.equal(a.peers.length, 1)
    assert.ok(a.sent.refresh > 0)
    b.select('[data-call-hangup]').click()
    await Promise.all([released(a), released(b)])
    t.diagnostic('权限拒绝、拒接、麦克风与视频轨道控制、重连和挂断通过')

    const secretPath = process.env.RTC_TEST_TURN_KEY
    if (secretPath) {
      const Turn = requireFrom(process.env.RTC_TEST_TOOLS ?? resolve(root, 'tools'))('node-turn')
      const secret = (await readFile(secretPath, 'utf8')).trim()
      turn = new Turn({
        listeningPort: 34788, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'],
        minPort: 53100, maxPort: 53139, authMech: 'long-term', debug: () => {},
      })
      turn.start()
      let signed = 0
      function prepareIce(config) {
        assert.ok(config.expiresAt > Date.now() && config.expiresAt - Date.now() <= 3600000)
        const relay = config.iceServers.find((entry) => entry.urls.includes('turn:127.0.0.1:34788?transport=udp'))
        assert.ok(relay)
        assert.match(relay.username, /^\d+:[a-zA-Z0-9_-]+$/)
        const expected = createHmac('sha1', secret).update(relay.username).digest('base64')
        assert.ok(expected === relay.credential, 'Worker 临时凭证签名')
        turn.addUser(relay.username, expected)
        signed++
      }
      const relay = await two({ relay: true, shorten: true, prepareIce })
      await invite(relay.a, relay.receiver)
      await phase(relay.b, 'incoming')
      relay.b.select('[data-call-accept]').click()
      await Promise.all([phase(relay.a, 'active'), phase(relay.b, 'active')])
      assert.equal(signed, 2)
      t.diagnostic('中继收发 ' + JSON.stringify(await Promise.all([mediaPath(relay.a, true), mediaPath(relay.b, true)])))
      await waitFor(() => relay.a.sent.resume > 0 && relay.a.sent.refresh > 0 &&
        relay.a.sockets[0].readyState === WebSocket.CLOSED, '客户端主动续期')
      assert.equal(relay.a.peers.length, 1)
      relay.b.pageHide()
      await Promise.all([released(relay.a), released(relay.b)])
      t.diagnostic('TURN 凭证、主动续期和离页释放通过')
    } else {
      t.diagnostic('设置 RTC_TEST_TURN_KEY 以运行中继测试')
    }
    assert.deepEqual(pages.flatMap((page) => page.errors), [])
  } catch (error) {
    t.diagnostic(JSON.stringify(pages.map((page) => ({
      phase: page.select('[data-chat-call]').dataset.phase, notice: page.select('[data-chat-notice]').textContent,
      signals: page.signals, peerStates: page.peers.map((peer) => [peer.connectionState, peer.iceConnectionState]),
      socketStates: page.sockets.map((socket) => socket.readyState), sent: page.sent,
      received: page.received, errors: page.errors,
    }))))
    throw error
  }
})
