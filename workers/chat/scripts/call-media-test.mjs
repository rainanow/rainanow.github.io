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
  const cameraRequests = []
  const microphoneRequests = []
  const devices = [
    { kind: 'videoinput', deviceId: 'front-camera', label: 'Front camera', facing: 'user' },
    { kind: 'videoinput', deviceId: 'back-camera', label: 'Back camera', facing: 'environment' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Built-in microphone' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Built-in speaker' },
  ]
  const applied = []
  const playback = { local: 0, remote: 0 }
  let localFrames = 0
  let visibility = 'visible'
  let denyNext = false
  let busyNext = false
  let sinkId = ''
  let shorten = Boolean(options.shorten)
  const sent = { resume: 0, refresh: 0 }
  Object.defineProperty(window, 'isSecureContext', { value: true })
  Object.defineProperty(window.document, 'visibilityState', { get: () => visibility })
  window.HTMLMediaElement.prototype.play = async function () {
    if (this.hasAttribute('data-call-local')) playback.local++
    if (this.hasAttribute('data-call-remote')) playback.remote++
  }
  window.HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
    return { totalVideoFrames: this.hasAttribute('data-call-local') ? localFrames : 0 }
  }
  if (!options.noAudioRouting) {
    Object.defineProperty(select('[data-call-remote]'), 'sinkId', { get: () => sinkId })
    select('[data-call-remote]').setSinkId = async (id) => {
      if (id && !devices.some((device) => device.kind === 'audiooutput' && device.deviceId === id)) {
        throw new window.DOMException('Missing speaker', 'NotFoundError')
      }
      sinkId = id
    }
  }
  window.MediaStream = rtc.MediaStream

  function captureTrack(source, feed, spacing) {
    const track = source.createTrack()
    tracks.push(track)
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

  const mediaDevices = Object.assign(new window.EventTarget(), {
    getSupportedConstraints: () => ({ facingMode: true }),
    enumerateDevices: async () => devices.map((device) => ({
      ...device,
      getCapabilities: () => device.facing ? { facingMode: [device.facing] } : {},
    })),
    getUserMedia: async ({ audio, video }) => {
      if (denyNext) {
        denyNext = false
        throw new window.DOMException('test denial', 'NotAllowedError')
      }
      const output = []
      if (audio) {
        const deviceId = audio.deviceId?.exact ?? 'mic'
        microphoneRequests.push(deviceId)
        if (!devices.some((device) => device.kind === 'audioinput' && device.deviceId === deviceId)) {
          throw new window.DOMException('Missing microphone', 'NotFoundError')
        }
        const source = new RTCAudioSource()
        const samples = new Int16Array(480)
        for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 15) * 1200
        const track = captureTrack(source, () => source.onData({
          samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480,
        }), 10)
        Object.defineProperty(track, 'getSettings', { value: () => ({ deviceId, channelCount: 1 }) })
        output.push(track)
      }
      if (video) {
        cameraRequests.push(video)
        if (!audio && busyNext) {
          busyNext = false
          throw new window.DOMException('camera still in use', 'NotReadableError')
        }
        const facing = video.facingMode?.exact ?? video.facingMode?.ideal ?? 'user'
        const deviceId = video.deviceId?.exact ?? (facing === 'environment' ? 'back-camera' : 'front-camera')
        const camera = devices.find((device) => device.kind === 'videoinput' && device.deviceId === deviceId)
        if (!camera) throw new window.DOMException('Missing camera', 'OverconstrainedError')
        const source = new RTCVideoSource()
        const width = 160
        const height = 90
        const data = new Uint8ClampedArray(width * height * 1.5).fill(128)
        let frames = 0
        const track = captureTrack(source, () => {
          data.fill(70 + frames++ % 60, 0, width * height)
          source.onFrame({ width, height, data })
        }, 85)
        // The test camera tops out at 720p, regardless of the requested ideal height.
        let settings
        function chooseSettings(constraints) {
          const height = Math.min(720, constraints.height?.ideal ?? 720)
          const ratio = constraints.aspectRatio?.ideal ?? 16 / 9
          settings = { width: Math.round(height * ratio), height, deviceId, facingMode: camera.facing }
        }
        chooseSettings(video)
        Object.defineProperties(track, {
          getSettings: { value: () => settings },
          getCapabilities: { value: () => ({ facingMode: [camera.facing] }) },
          applyConstraints: { value: async (constraints) => {
            applied.push({ track, constraints })
            chooseSettings(constraints)
          } },
        })
        output.push(track)
      }
      return new rtc.MediaStream(output)
    },
  })
  Object.defineProperty(window.navigator, 'mediaDevices', { value: mediaDevices })

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
    select, tracks, sockets, peers, received, signals, sent, errors, cameraRequests, microphoneRequests, applied, playback,
    deny: () => { denyNext = true },
    cameraBusy: () => { busyNext = true },
    changeDevice(node, value) {
      node.value = value
      node.dispatchEvent(new window.Event('change', { bubbles: true }))
    },
    connectHeadset(notify = true) {
      devices.push(
        { kind: 'audioinput', deviceId: 'bt-mic', label: 'Bluetooth microphone' },
        { kind: 'audiooutput', deviceId: 'bt-speaker', label: 'Bluetooth headphones' },
      )
      if (notify) mediaDevices.dispatchEvent(new window.Event('devicechange'))
    },
    disconnectHeadset() {
      for (const id of ['bt-mic', 'bt-speaker']) devices.splice(devices.findIndex((device) => device.deviceId === id), 1)
      mediaDevices.dispatchEvent(new window.Event('devicechange'))
    },
    qualityOption: (setting, value) => select(`[data-call-${setting}="${value}"]`),
    foreground: () => {
      for (visibility of ['hidden', 'visible']) window.document.dispatchEvent(new window.Event('visibilitychange'))
    },
    advanceFrames: () => { localFrames++ },
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

async function invite(page) {
  const button = await waitFor(() => {
    const node = page.select('[data-chat-call-invite]')
    return node && !node.hidden && node
  }, '视频邀请入口')
  button.click()
  await phase(page, 'outgoing')
}

function invitation(page, name) {
  const cards = page.select('[data-chat-call-cards]').querySelectorAll('.chat__call-card')
  return Array.from(cards).find((card) => card.querySelector('.chat__call-card-title').textContent.startsWith(name + ' '))
}

async function join(page, name) {
  const button = await waitFor(() => invitation(page, name)?.querySelector('.chat__call-card-action'), '可加入的视频邀请卡片')
  button.click()
}

function released(page, timeout) {
  return waitFor(() => page.select('[data-chat-call]').hidden &&
    page.tracks.every((track) => track.readyState === 'ended') &&
    page.select('[data-call-local]').srcObject === null &&
    page.select('[data-call-remote]').srcObject === null, '已释放通话媒体', timeout)
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

function mirrors(page, feed) {
  return page.select('[data-call-' + feed + ']').classList.contains('is-mirrored')
}

function available(button) {
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true'
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
    const b = fixture(right, { ...options, shorten: false, noAudioRouting: true })
    pages.push(a, b)
    await Promise.all([a, b].map((page) => waitFor(() =>
      page.signals.includes('hello') && !page.select('[data-chat-room]').hidden, '房间已连接')))
    return { a, b, caller: left.username }
  }

  try {
    const direct = await two({})
    const { a, b, caller } = direct
    await invite(a)
    await waitFor(() => invitation(b, caller), '房间收到邀请卡片')
    assert.equal(a.tracks.length, 0, '公开邀请发送时未启用设备')
    assert.equal(b.tracks.length, 0, '看到邀请卡片时未启用设备')
    a.select('[data-call-hangup]').click()
    await released(a)
    await waitFor(() => !invitation(b, caller), '取消后移除邀请卡片')

    a.deny()
    await invite(a)
    await join(b, caller)
    await waitFor(() => a.select('[data-chat-notice]').textContent.includes('请允许使用'), '设备权限拒绝')
    await Promise.all([released(a), released(b)])
    await invite(a)
    await join(b, caller)
    await Promise.all([phase(a, 'active'), phase(b, 'active')])
    t.diagnostic('直连收发 ' + JSON.stringify(await Promise.all([mediaPath(a, false), mediaPath(b, false)])))

    const local = a.select('[data-call-local]').srcObject
    const remote = a.select('[data-call-remote]').srcObject
    const callButtons = Array.from(a.select('[data-call-controls]').querySelectorAll('button:not([hidden])'))
    assert.equal(callButtons.length, 4)
    for (const [index, name] of ['mic', 'hangup', 'camera', 'quality'].entries()) {
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

    const video = local.getVideoTracks()[0]
    const audio = local.getAudioTracks()[0]
    assert.equal(a.cameraRequests[0].height.ideal, 720)
    assert.equal(a.cameraRequests[0].aspectRatio.ideal, 16 / 9)
    a.select('[data-call-quality]').click()
    const fullHd = a.qualityOption('resolution', '1080p')
    fullHd.click()
    await waitFor(() => fullHd.getAttribute('aria-disabled') === 'false', '应用 1080p')
    assert.equal(fullHd.getAttribute('aria-pressed'), 'true')
    assert.equal(video.getSettings().height, 720, '模拟摄像头的实际采集上限是 720p')
    const fourThree = a.qualityOption('ratio', '4:3')
    fourThree.click()
    await waitFor(() => fourThree.getAttribute('aria-disabled') === 'false', '应用 4:3')
    assert.equal(local.getVideoTracks()[0], video)
    assert.equal(a.applied.at(-1).track, video)
    assert.equal(a.applied.at(-1).constraints.width.ideal, 1440)
    assert.equal(a.applied.at(-1).constraints.height.ideal, 1080)
    assert.equal(a.applied.at(-1).constraints.aspectRatio.ideal, 4 / 3)
    assert.equal(video.getSettings().width, 960)
    a.select('[data-call-main]').click()

    a.select('[data-call-mic]').click()
    assert.equal(audio.enabled, true, '点按麦克风仅展开菜单')
    a.select('[data-call-mic-toggle]').click()
    assert.equal(audio.enabled, false)
    assert.ok(a.select('[data-call-mic]').hasAttribute('data-media-off'))
    a.foreground()
    a.advanceFrames()
    await delay(1100)
    assert.equal(local.getVideoTracks()[0], video, '已恢复帧时保留当前摄像头轨道')
    const playbackCount = { ...a.playback }
    const captureCount = a.cameraRequests.length
    a.cameraBusy()
    a.foreground()
    await waitFor(() => local.getVideoTracks()[0] && local.getVideoTracks()[0] !== video, '回到前台时恢复停滞摄像头')
    assert.equal(video.readyState, 'ended')
    assert.ok(a.playback.local > playbackCount.local && a.playback.remote > playbackCount.remote)
    assert.equal(local.getAudioTracks()[0], audio)
    assert.equal(audio.enabled, false)
    assert.equal(a.peers.length, 1)
    assert.equal(a.cameraRequests.length, captureCount + 2, '设备短暂占用时延迟重试一次')
    assert.equal(a.cameraRequests.at(-1).height.ideal, 1080)
    assert.equal(a.cameraRequests.at(-1).aspectRatio.ideal, 4 / 3)
    const peerFrames = b.received.video
    await waitFor(() => b.received.video > peerFrames + 1, '前台恢复后对方继续收视频')

    a.select('[data-call-camera]').click()
    const cameraFacing = a.select('[data-call-camera-facing]')
    const mirror = a.select('[data-call-camera-mirror]')
    const cameraToggle = a.select('[data-call-camera-toggle]')
    await waitFor(() => available(cameraFacing) && available(mirror), '双摄与双端镜像可用')
    assert.equal(mirrors(a, 'local'), false, '前摄默认正向')
    assert.equal(mirrors(b, 'remote'), false)
    const videoSender = a.peers[0].getSenders().find((sender) => sender.track?.kind === 'video')
    mirror.click()
    await waitFor(() => mirrors(a, 'local') && mirrors(b, 'remote'), '双方前摄镜像')
    assert.equal(mirrors(a, 'remote'), false)
    assert.equal(mirrors(b, 'local'), false)
    assert.equal(videoSender.track, local.getVideoTracks()[0], '打开镜像沿用相机轨道')
    const frontTrack = videoSender.track
    cameraFacing.click()
    await waitFor(() => videoSender.track?.getSettings().facingMode === 'environment' &&
      !mirrors(a, 'local') && !mirrors(b, 'remote'), '后摄切换并同步正向画面')
    assert.equal(frontTrack.readyState, 'ended')
    assert.equal(local.getVideoTracks()[0], videoSender.track)
    assert.equal(videoSender.track.getSettings().width, 960)
    assert.equal(local.getAudioTracks()[0], audio)
    assert.equal(audio.enabled, false)
    assert.ok(!available(mirror))
    const rearTrack = videoSender.track
    a.deny()
    cameraFacing.click()
    await waitFor(() => videoSender.track !== rearTrack &&
      videoSender.track?.getSettings().facingMode === 'environment' && available(cameraFacing), '切换失败后恢复原摄像头')
    assert.equal(rearTrack.readyState, 'ended')
    cameraFacing.click()
    await waitFor(() => videoSender.track?.getSettings().facingMode === 'user' &&
      mirrors(a, 'local') && mirrors(b, 'remote'), '切回前摄恢复镜像偏好')
    assert.equal(a.signals.filter((action) => action === 'offer').length, 1)
    assert.equal(b.signals.filter((action) => action === 'answer').length, 1)

    cameraToggle.click()
    await waitFor(() => local.getVideoTracks().length === 0 &&
      a.select('[data-call-camera]').hasAttribute('data-media-off') && !mirrors(b, 'remote'), '关闭摄像头')
    assert.ok(!available(cameraFacing) && !available(mirror))
    a.select('[data-call-quality]').click()
    a.qualityOption('resolution', '480p').click()
    a.qualityOption('ratio', '16:9').click()
    const captures = a.cameraRequests.length
    a.foreground()
    await delay(1100)
    assert.equal(a.cameraRequests.length, captures, '切回前台不重开手动关掉的摄像头')
    assert.equal(local.getVideoTracks().length, 0)
    a.select('[data-call-camera]').click()
    cameraToggle.click()
    await waitFor(() => local.getVideoTracks().length === 1 &&
      !a.select('[data-call-camera]').hasAttribute('data-media-off') && mirrors(b, 'remote'), '恢复摄像头和镜像')
    assert.equal(a.cameraRequests.at(-1).width.ideal, 854)
    assert.equal(a.cameraRequests.at(-1).height.ideal, 480)
    assert.equal(local.getVideoTracks()[0].getSettings().height, 480)
    assert.equal(audio.enabled, false)

    a.select('[data-call-mic]').click()
    const inputDevice = a.select('[data-call-audio-input]')
    const outputDevice = a.select('[data-call-audio-output]')
    const playbackToggle = a.select('[data-call-playback-toggle]')
    const remoteVideo = a.select('[data-call-remote]')
    const audioSender = a.peers[0].getSenders().find((sender) => sender.track?.kind === 'audio')
    assert.equal(audioSender.track, audio)
    assert.equal(a.select('[data-call-camera-panel]').hidden, true)
    playbackToggle.click()
    assert.equal(remoteVideo.muted, true)
    assert.equal(audio.enabled, false)
    await waitFor(() => inputDevice.querySelector('[value="mic"]'), '音频面板已刷新内置设备')
    a.connectHeadset(false)
    assert.equal(inputDevice.querySelector('[value="bt-mic"]'), null)
    a.select('[data-call-audio-refresh]').click()
    await waitFor(() => inputDevice.querySelector('[value="bt-mic"]') &&
      outputDevice.querySelector('[value="bt-speaker"]'), '手动刷新发现新接入的蓝牙设备')
    assert.equal(audioSender.track, audio, '新设备接入时保留当前麦克风')
    a.deny()
    a.changeDevice(inputDevice, 'bt-mic')
    await waitFor(() => available(inputDevice) && inputDevice.value !== 'bt-mic', '麦克风授权失败时还原选择')
    assert.equal(audioSender.track, audio)
    assert.equal(audio.readyState, 'live')
    a.changeDevice(inputDevice, 'bt-mic')
    await waitFor(() => audioSender.track?.getSettings().deviceId === 'bt-mic' && audio.readyState === 'ended', '切换蓝牙麦克风')
    const bluetooth = audioSender.track
    assert.equal(bluetooth, local.getAudioTracks()[0])
    assert.equal(bluetooth.enabled, false)
    a.changeDevice(outputDevice, 'bt-speaker')
    await waitFor(() => remoteVideo.sinkId === 'bt-speaker', '切换蓝牙输出')
    assert.equal(remoteVideo.muted, true)
    playbackToggle.click()
    assert.equal(remoteVideo.muted, false)
    a.select('[data-call-mini]').click()
    assert.equal(remoteVideo.sinkId, 'bt-speaker')
    a.disconnectHeadset()
    await waitFor(() => audioSender.track?.getSettings().deviceId === 'mic' && bluetooth.readyState === 'ended' &&
      remoteVideo.sinkId === '', '蓝牙断开后输入和输出回到系统默认')
    assert.equal(audioSender.track.enabled, false)
    assert.deepEqual(a.microphoneRequests, ['mic', 'bt-mic', 'mic'])
    const priorAudio = b.received.audio
    a.select('[data-call-mic-toggle]').click()
    assert.equal(audioSender.track.enabled, true)
    await waitFor(() => b.received.audio > priorAudio, '换麦后对方继续收音频')
    b.select('[data-call-mic]').click()
    assert.ok(!available(b.select('[data-call-audio-output]')), '不支持切换时由系统选择输出')
    b.select('[data-call-playback-toggle]').click()
    assert.equal(b.select('[data-call-remote]').muted, true)

    a.select('[data-call-quality]').click()
    const hd = a.qualityOption('resolution', '720p')
    hd.click()
    await waitFor(() => hd.getAttribute('aria-disabled') === 'false', '切换到 720p')
    assert.equal(a.applied.at(-1).constraints.height.ideal, 720)
    assert.equal(local.getVideoTracks()[0].getSettings().height, 720)
    a.sockets[0].close(4000, 'local test')
    await waitFor(() => a.sent.resume > 0 && a.select('[data-call-status]').textContent === '通话中', '认证重连')
    assert.equal(a.peers.length, 1)
    assert.ok(a.sent.refresh > 0)
    assert.equal(mirrors(b, 'remote'), true)
    b.select('[data-call-hangup]').click()
    await Promise.all([released(a), released(b)])
    t.diagnostic('双端镜像、切摄回退、前台恢复、蓝牙输入输出热插拔、重连和挂断通过')

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
      await invite(relay.a)
      await join(relay.b, relay.caller)
      await Promise.all([phase(relay.a, 'active'), phase(relay.b, 'active')])
      assert.equal(signed, 2)
      t.diagnostic('中继收发 ' + JSON.stringify(await Promise.all([mediaPath(relay.a, true), mediaPath(relay.b, true)])))
      relay.b.select('[data-call-camera]').click()
      const relayMirror = relay.b.select('[data-call-camera-mirror]')
      await waitFor(() => available(relayMirror), '中继通话镜像可用')
      relayMirror.click()
      await waitFor(() => mirrors(relay.b, 'local') && mirrors(relay.a, 'remote'), '中继通话同步接听端镜像')
      await waitFor(() => relay.a.sent.resume > 0 && relay.a.sent.refresh > 0 &&
        relay.a.sockets[0].readyState === WebSocket.CLOSED, '客户端主动续期')
      assert.equal(relay.a.peers.length, 1)
      relay.b.pageHide()
      // The page can close before its hangup is dispatched. Allow the server's 15s resume grace.
      await Promise.all([released(relay.a, 25_000), released(relay.b)])
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
