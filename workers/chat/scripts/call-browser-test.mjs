import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const site = 'http://localhost:1313'
const api = 'http://localhost:8787'
const roomUrl = site + '/chat/'
const publicDir = resolve(process.env.RTC_TEST_PUBLIC ?? fileURLToPath(new URL('../.tmp/rtc-stage2/public', import.meta.url)))
const toolsDir = resolve(process.env.RTC_TEST_TOOLS ?? fileURLToPath(new URL('../.tmp/rtc-stage2/tools', import.meta.url)))
const require = createRequire(resolve(toolsDir, 'package.json'))
const { chromium } = require('playwright-core')
const turnPort = 34788
const turnUrl = 'turn:127.0.0.1:' + turnPort + '?transport=udp'
const executablePath = process.env.RTC_TEST_CHROMIUM

function serve() {
  const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml',
  }
  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, site).pathname)
      if (path.endsWith('/')) path += 'index.html'
      const file = resolve(publicDir, '.' + path)
      assert.ok(file.startsWith(publicDir + sep))
      response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(1313, '127.0.0.1', () => resolveListen(server))
  })
}

async function createUser() {
  const user = { username: 'video' + randomUUID().replaceAll('-', '').slice(0, 10), password: randomUUID() }
  const response = await fetch(api + '/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site },
    body: JSON.stringify(user), redirect: 'error',
  })
  assert.equal(response.status, 201)
  await response.text()
  return user
}

function observeBrowser({ relay }) {
  const audit = { pcs: [], sockets: [], tracks: [], signals: [], readyMessages: new Map(), denyNext: false }
  window.callTest = audit
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    if (audit.blockRemotePlayback && this.matches('[data-call-remote]')) {
      return Promise.reject(new DOMException('Test autoplay block', 'NotAllowedError'))
    }
    return play.call(this)
  }
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (audit.denyNext) {
      audit.denyNext = false
      throw new DOMException('Test permission denial', 'NotAllowedError')
    }
    const stream = await capture(constraints)
    audit.tracks.push(...stream.getTracks())
    return stream
  }
  window.RTCPeerConnection = class extends window.RTCPeerConnection {
    constructor(config) {
      super(relay ? { ...config, iceTransportPolicy: 'relay' } : { ...config, iceServers: [] })
      audit.pcs.push(this)
    }
  }
  window.WebSocket = class extends window.WebSocket {
    constructor(...args) {
      super(...args)
      audit.sockets.push(this)
      this.addEventListener('message', (event) => {
        let payload
        try { payload = JSON.parse(event.data) } catch { return }
        if (payload.type === 'ready' && payload.videoCalls) audit.readyMessages.set(this, payload)
      })
    }

    send(message) {
      if (typeof message === 'string' && message.startsWith('{')) {
        audit.signals.push({ index: audit.sockets.indexOf(this), action: JSON.parse(message).action })
      }
      return super.send(message)
    }
  }
}

async function openPage(browser, user, options, prepareIce) {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1100, height: 780 },
    isMobile: Boolean(options.mobile), hasTouch: Boolean(options.mobile),
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === site || url.origin === api ? route.continue() : route.abort()
  })
  await context.addInitScript(observeBrowser, options)
  const page = await context.newPage()
  page.setDefaultTimeout(18_000)
  if (prepareIce) {
    await page.route(api + '/api/calls/ice-servers', async (route) => {
      const backend = await route.fetch()
      if (backend.ok()) await prepareIce(await backend.json())
      await route.fulfill({ response: backend })
    })
  }
  await page.goto(roomUrl, { waitUntil: 'domcontentloaded' })
  assert.ok(await page.evaluate(() => isSecureContext && !!navigator.mediaDevices))
  await page.locator('[data-chat-username]').fill(user.username)
  await page.locator('[data-chat-password]').fill(user.password)
  await page.locator('[data-chat-submit]').click()
  await page.locator('[data-chat-room]').waitFor({ state: 'visible' })
  return { context, page }
}

function callPanel(page, phase) {
  return page.locator('[data-chat-call]' + (phase ? '[data-phase="' + phase + '"]' : ''))
}

async function showControls(page) {
  await page.locator('[data-call-main]').click({ position: { x: 24, y: 24 } })
  await page.locator('[data-call-controls]:not(.is-idle)').waitFor()
}

async function invite(page, username) {
  const toggle = page.locator('[data-chat-members-toggle]')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.getByRole('button', { name: '呼叫 ' + username, exact: true }).click()
}

async function mediaStats(page, shouldRelay) {
  await page.waitForFunction(async (relay) => {
    const pc = window.callTest.pcs.at(-1)
    if (!pc || pc.connectionState !== 'connected') return false
    const video = document.querySelector('[data-call-remote]')
    if (video.videoWidth === 0) return false
    const reports = await pc.getStats()
    const rows = Array.from(reports.values())
    const audio = rows.some((row) => row.type === 'inbound-rtp' && row.kind === 'audio' && row.bytesReceived > 0)
    const pictures = rows.some((row) => row.type === 'inbound-rtp' && row.kind === 'video' && row.framesDecoded > 0)
    const selected = rows.find((row) => row.type === 'transport' && row.selectedCandidatePairId)
    const pair = reports.get(selected?.selectedCandidatePairId)
    const local = reports.get(pair?.localCandidateId)
    const remote = reports.get(pair?.remoteCandidateId)
    return audio && pictures && !!local && !!remote &&
      (relay ? (local.candidateType === 'relay' && remote.candidateType === 'relay')
        : (local.candidateType !== 'relay' && remote.candidateType !== 'relay'))
  }, shouldRelay, { timeout: 20_000 })
}

async function released(page) {
  await callPanel(page).waitFor({ state: 'hidden' })
  await page.waitForFunction(() => window.callTest.tracks.every((track) => track.readyState === 'ended') &&
    document.querySelector('[data-call-remote]').srcObject === null &&
    document.querySelector('[data-call-local]').srcObject === null)
}

test('本地聊天室 Chromium 音视频直连与 TURN 中继', { timeout: 150_000 }, async (t) => {
  if (process.env.RTC_TEST_USE_RUNNING_SITE !== '1') {
    const server = await serve()
    t.after(() => server.close())
  }
  const browser = await chromium.launch({
    executablePath,
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection',
    ],
  })
  t.after(() => browser.close())
  const errors = []
  const [alice, bob] = await Promise.all([createUser(), createUser()])
  const a = await openPage(browser, alice, { relay: false })
  const b = await openPage(browser, bob, { relay: false, mobile: true })
  for (const { page } of [a, b]) page.on('pageerror', (error) => errors.push(error.message))
  await a.page.evaluate(() => { window.callTest.denyNext = true })
  await invite(a.page, bob.username)
  await a.page.getByText('请允许使用摄像头和麦克风后重试').waitFor()
  await released(a.page)
  assert.equal(await b.page.evaluate(() => window.callTest.tracks.length), 0)

  await invite(a.page, bob.username)
  await callPanel(b.page, 'incoming').waitFor()
  assert.equal(await b.page.evaluate(() => window.callTest.tracks.length), 0, '响铃不启用被叫的设备')
  await b.page.getByRole('button', { name: '拒绝通话', exact: true }).click()
  await a.page.getByText('对方拒绝了通话').waitFor()
  await released(a.page)
  await delay(4100)
  await invite(a.page, bob.username)
  await callPanel(b.page, 'incoming').waitFor()
  await b.page.evaluate(() => { window.callTest.blockRemotePlayback = true })
  await b.page.locator('[data-call-accept]').click()
  await Promise.all([callPanel(a.page, 'active').waitFor(), callPanel(b.page, 'active').waitFor()])
  await b.page.locator('[data-chat-notice]').waitFor({ state: 'hidden' })
  await b.page.locator('[data-call-play-hint]').waitFor()
  await b.page.evaluate(() => { window.callTest.blockRemotePlayback = false })
  await showControls(b.page)
  await b.page.locator('[data-call-play-hint]').waitFor({ state: 'hidden' })
  await Promise.all([mediaStats(a.page, false), mediaStats(b.page, false)])
  const mobilePanel = await callPanel(b.page).boundingBox()
  assert.ok(mobilePanel.width <= 390 && mobilePanel.x + mobilePanel.width <= 391)
  const mobileStage = await b.page.locator('[data-call-stage]').boundingBox()
  const mobileMini = await b.page.locator('[data-call-mini]').boundingBox()
  assert.ok(mobileStage.height >= 844 * 0.68)
  assert.ok(Math.abs(mobileMini.y - mobileStage.y - 8) <= 1)
  assert.ok(Math.abs(mobileStage.x + mobileStage.width - mobileMini.x - mobileMini.width - 8) <= 1)
  assert.equal(await b.page.locator('[data-call-controls] button:not([hidden]) svg').count(), 3)
  await b.page.locator('[data-call-controls].is-idle').waitFor()
  await showControls(b.page)
  await b.page.locator('[data-call-mini]').tap()
  assert.equal(await b.page.locator('[data-call-stage]').getAttribute('data-main'), 'local')
  await b.page.locator('[data-chat-input]').waitFor({ state: 'visible' })
  const screenshots = process.env.RTC_TEST_SCREENSHOTS
  if (screenshots) {
    await Promise.all([showControls(a.page), showControls(b.page)])
    await Promise.all([
      callPanel(a.page).screenshot({ path: resolve(screenshots, 'desktop.png') }),
      b.page.screenshot({ path: resolve(screenshots, 'mobile.png') }),
    ])
  }

  await showControls(a.page)
  await a.page.locator('[data-call-mic]').click()
  assert.equal(await a.page.evaluate(() =>
    document.querySelector('[data-call-local]').srcObject.getAudioTracks()[0].enabled), false)
  await a.page.locator('[data-call-mic]').click()
  assert.equal(await a.page.evaluate(() =>
    document.querySelector('[data-call-local]').srcObject.getAudioTracks()[0].enabled), true)
  await a.page.locator('[data-call-camera]').click()
  await a.page.waitForFunction(() => window.callTest.tracks
    .filter((track) => track.kind === 'video').every((track) => track.readyState === 'ended'))
  await a.page.locator('[data-call-camera][aria-pressed="true"]').click()
  await a.page.waitForFunction(() =>
    document.querySelector('[data-call-local]').srcObject.getVideoTracks().length === 1)

  const previousSocket = await a.page.evaluate(() => {
    const { sockets } = window.callTest
    const index = sockets.findLastIndex((socket) => socket.readyState === WebSocket.OPEN)
    sockets[index].close(4000, 'local test')
    return index
  })
  await a.page.waitForFunction((index) => window.callTest.signals.some((frame) =>
    frame.index > index && frame.action === 'resume'), previousSocket)
  await a.page.locator('[data-call-status]').filter({ hasText: '通话中' }).waitFor()
  assert.equal(await a.page.evaluate(() => window.callTest.pcs.length), 1)
  await showControls(b.page)
  await b.page.locator('[data-call-hangup]').click()
  await Promise.all([released(a.page), released(b.page)])
  await Promise.all([a.context.close(), b.context.close()])
  t.diagnostic('直连双向音视频、主画面恢复播放和唤出控制、手机小窗互换、设备开关及重连释放通过')

  const turnSecretPath = process.env.RTC_TEST_TURN_KEY
  if (!turnSecretPath) {
    assert.deepEqual(errors, [])
    t.diagnostic('设置 RTC_TEST_TURN_KEY 后运行中继测试')
    return
  }
  const Turn = require('node-turn')
  const turn = new Turn({
    listeningPort: turnPort, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'],
    minPort: 53100, maxPort: 53139, authMech: 'long-term', debug: () => {},
  })
  turn.start()
  t.after(() => turn.stop())
  const secret = (await readFile(turnSecretPath, 'utf8')).trim()
  let signed = 0
  const prepareIce = (config) => {
    assert.ok(config.expiresAt > Date.now() && config.expiresAt - Date.now() <= 3600_000)
    const relay = config.iceServers.find((entry) => entry.urls.includes(turnUrl))
    assert.ok(relay, 'Worker 返回本地测试中继')
    assert.ok(/^\d+:[a-zA-Z0-9_-]+$/.test(relay.username))
    const expected = createHmac('sha1', secret).update(relay.username).digest('base64')
    assert.ok(relay.credential === expected, 'TURN 临时凭证签名符合 coturn 规范')
    turn.addUser(relay.username, expected)
    signed++
  }
  const [carol, dan] = await Promise.all([createUser(), createUser()])
  const c = await openPage(browser, carol, { relay: true }, prepareIce)
  const d = await openPage(browser, dan, { relay: true }, prepareIce)
  for (const { page } of [c, d]) page.on('pageerror', (error) => errors.push(error.message))
  await invite(c.page, dan.username)
  await callPanel(d.page, 'incoming').waitFor()
  await d.page.locator('[data-call-accept]').click()
  await Promise.all([callPanel(c.page, 'active').waitFor(), callPanel(d.page, 'active').waitFor()])
  assert.equal(signed, 2)
  await Promise.all([mediaStats(c.page, true), mediaStats(d.page, true)])
  t.diagnostic('临时凭证签名和 TURN UDP 双向音视频通过')

  const originalSocket = await c.page.evaluate(() => {
    const { sockets, signals, readyMessages } = window.callTest
    const { index } = signals.findLast((frame) => frame.action === 'invite')
    const socket = sockets[index]
    const ready = readyMessages.get(socket)
    if (!ready) throw new Error('The active socket does not have a ready message')
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ ...ready, accessExpiresAt: Date.now() + 50_000 }),
    }))
    return index
  })
  await c.page.waitForFunction((index) => window.callTest.sockets[index].readyState === WebSocket.CLOSED &&
    window.callTest.signals.some((frame) => frame.index > index && frame.action === 'resume'), originalSocket)
  assert.equal(await c.page.evaluate(() => window.callTest.pcs.length), 1)
  await d.page.close()
  await released(c.page)
  assert.deepEqual(errors, [])
  t.diagnostic('主动续期保留媒体及关闭标签页后对端释放通过')
})
