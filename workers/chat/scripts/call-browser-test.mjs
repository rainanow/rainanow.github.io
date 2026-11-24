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

function observeBrowser({ relay, cameraFacings = [] }) {
  const audit = { pcs: [], sockets: [], tracks: [], signals: [], quality: [], readyMessages: new Map(), denyNext: false }
  window.callTest = audit
  const applyConstraints = MediaStreamTrack.prototype.applyConstraints
  MediaStreamTrack.prototype.applyConstraints = async function (requested) {
    const change = { requested }
    audit.quality.push(change)
    try {
      await applyConstraints.call(this, requested)
      const { width, height } = this.getSettings()
      change.applied = { width, height }
    } catch (error) {
      change.error = error.name
      throw error
    }
  }
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    if (audit.blockRemotePlayback && this.matches('[data-call-remote]')) {
      return Promise.reject(new DOMException('Test autoplay block', 'NotAllowedError'))
    }
    return play.call(this)
  }
  const listDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  if (cameraFacings.length) {
    navigator.mediaDevices.enumerateDevices = async () => [
      ...(await listDevices()).filter((device) => device.kind !== 'videoinput'),
      ...cameraFacings.map((facing) => ({
        kind: 'videoinput', deviceId: `test-camera-${facing}`, label: `Camera ${facing}`,
        getCapabilities: () => ({ facingMode: [facing] }),
      })),
    ]
  }
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (audit.denyNext) {
      audit.denyNext = false
      throw new DOMException('Test permission denial', 'NotAllowedError')
    }
    let facing
    if (constraints.video && cameraFacings.length) {
      const { deviceId, facingMode, ...video } = constraints.video
      facing = deviceId?.exact ? deviceId.exact.replace('test-camera-', '')
        : facingMode?.exact ?? facingMode?.ideal ?? cameraFacings[0]
      if (!cameraFacings.includes(facing)) throw new DOMException('Test missing camera', 'OverconstrainedError')
      constraints = { ...constraints, video }
    }
    const stream = await capture(constraints)
    if (facing) {
      const [track] = stream.getVideoTracks()
      const readSettings = track.getSettings.bind(track)
      const readCapabilities = track.getCapabilities.bind(track)
      track.getSettings = () => ({ ...readSettings(), deviceId: `test-camera-${facing}`, facingMode: facing })
      track.getCapabilities = () => ({ ...readCapabilities(), facingMode: [facing] })
    }
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

async function holdTouch(page, button) {
  const box = await button.boundingBox()
  assert.ok(box, '长按目标可见')
  const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints })
    await delay(650)
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await session.detach()
  }
}

async function invite(page) {
  await page.locator('[data-chat-call-invite]').click()
  await callPanel(page, 'outgoing').waitFor()
}

function invitation(page, username) {
  return page.locator('[data-chat-call-cards] .chat__call-card').filter({ hasText: username + ' 发起了视频通话' })
}

async function join(page, username) {
  await invitation(page, username).getByRole('button', { name: '加入通话', exact: true }).click()
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

async function videoBitrateLimit(page, mbps) {
  await page.waitForFunction((bps) => {
    const sender = window.callTest.pcs.at(-1)?.getSenders().find((entry) => entry.track?.kind === 'video')
    return sender?.getParameters().encodings[0]?.maxBitrate === bps
  }, mbps * 1_000_000, { timeout: 7000 })
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
  const [alice, bob, spectator] = await Promise.all([createUser(), createUser(), createUser()])
  const a = await openPage(browser, alice, { relay: false })
  const b = await openPage(browser, bob, { relay: false, mobile: true, cameraFacings: ['user', 'environment'] })
  const viewer = await openPage(browser, spectator, { relay: false })
  for (const { page } of [a, b, viewer]) page.on('pageerror', (error) => errors.push(error.message))
  await a.page.evaluate(() => { window.callTest.denyNext = true })
  await invite(a.page)
  await invitation(viewer.page, alice.username).waitFor()
  assert.equal(await a.page.evaluate(() => window.callTest.tracks.length), 0, '公开邀请尚未打开摄像头')
  assert.equal(await b.page.evaluate(() => window.callTest.tracks.length), 0, '收到邀请尚未打开摄像头')
  await join(b.page, alice.username)
  await a.page.getByText('请允许使用摄像头和麦克风后重试').waitFor()
  await Promise.all([released(a.page), released(b.page)])
  await delay(4100)
  await invite(a.page)
  await invitation(b.page, alice.username).waitFor()
  await a.page.locator('[data-call-hangup]').click()
  await invitation(viewer.page, alice.username).waitFor({ state: 'hidden' })
  await released(a.page)
  await delay(4100)
  await invite(a.page)
  await b.page.evaluate(() => { window.callTest.blockRemotePlayback = true })
  await join(b.page, alice.username)
  await Promise.all([callPanel(a.page, 'active').waitFor(), callPanel(b.page, 'active').waitFor()])
  await b.page.locator('[data-chat-notice]').waitFor({ state: 'hidden' })
  await b.page.locator('[data-call-play-hint]').waitFor()
  await b.page.evaluate(() => { window.callTest.blockRemotePlayback = false })
  await showControls(b.page)
  await b.page.locator('[data-call-play-hint]').waitFor({ state: 'hidden' })
  await Promise.all([mediaStats(a.page, false), mediaStats(b.page, false)])
  const activeStrip = viewer.page.locator('[data-chat-active-calls]')
  await activeStrip.filter({ hasText: alice.username + '、' + bob.username + '正在视频通话' }).waitFor()
  assert.equal(await invitation(viewer.page, alice.username).getByRole('button', { name: '加入通话' }).count(), 0)
  const mobilePanel = await callPanel(b.page).boundingBox()
  assert.ok(mobilePanel.width <= 390 && mobilePanel.x + mobilePanel.width <= 391)
  const mobileStage = await b.page.locator('[data-call-stage]').boundingBox()
  const mobileMini = await b.page.locator('[data-call-mini]').boundingBox()
  assert.ok(mobileStage.height >= 844 * 0.68)
  assert.ok(Math.abs(mobileMini.y - mobileStage.y - 8) <= 1)
  assert.ok(Math.abs(mobileStage.x + mobileStage.width - mobileMini.x - mobileMini.width - 8) <= 1)
  assert.equal(await b.page.locator('[data-call-controls] button:not([hidden]) svg').count(), 5)
  assert.equal(await a.page.locator('[data-call-controls] button:not([hidden]) svg').count(), 4)
  await a.page.locator('[data-chat-input]').waitFor({ state: 'visible' })
  await a.page.locator('[data-chat-send]').waitFor({ state: 'visible' })
  await b.page.locator('[data-call-controls].is-idle').waitFor()
  await showControls(b.page)
  await b.page.locator('[data-call-mini]').tap()
  assert.equal(await b.page.locator('[data-call-stage]').getAttribute('data-main'), 'local')
  await b.page.locator('[data-chat-input]').waitFor({ state: 'hidden' })
  await b.page.locator('[data-call-compose]').click()
  const mobileInput = b.page.locator('[data-call-preview] [data-chat-input]')
  await mobileInput.waitFor()
  await b.page.locator('[data-call-preview] [data-chat-send]').waitFor({ state: 'hidden' })
  assert.equal(await b.page.locator('[data-call-preview]').evaluate((preview) =>
    getComputedStyle(preview).backgroundColor), 'rgba(0, 0, 0, 0)')
  assert.equal(await mobileInput.getAttribute('placeholder'), '说点什么')
  assert.equal(await mobileInput.getAttribute('enterkeyhint'), 'send')
  const screenshots = process.env.RTC_TEST_SCREENSHOTS
  const caption = '通话预览消息' + randomUUID().slice(0, 6)
  await mobileInput.fill(caption)
  await mobileInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  assert.equal(await mobileInput.inputValue(), caption)
  await mobileInput.press('Shift+Enter')
  assert.equal(await mobileInput.inputValue(), caption + '\n')
  if (screenshots) await b.page.screenshot({ path: resolve(screenshots, 'mobile-message.png') })
  await mobileInput.press('Enter')
  await a.page.locator('[data-call-overlay]').filter({ hasText: caption }).waitFor()
  const imeCaption = '输入法发送' + randomUUID().slice(0, 6)
  await mobileInput.fill(imeCaption)
  assert.equal(await mobileInput.evaluate((input) => input.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertLineBreak', bubbles: true, cancelable: true,
  }))), false)
  await a.page.locator('[data-call-overlay]').filter({ hasText: imeCaption }).waitFor()
  await showControls(b.page)
  await b.page.locator('[data-call-quality]').click()
  const resolution = b.page.getByRole('group', { name: '画质', exact: true }).getByRole('button', { name: '480p' })
  const ratio = b.page.locator('[data-call-ratio="4:3"]')
  try {
    await resolution.click()
    await b.page.waitForFunction(() => window.callTest.quality.some(({ requested, applied }) =>
      requested.height?.ideal === 480 && requested.width?.ideal === 854 && applied?.width > 0 && applied?.height > 0),
      null, { timeout: 7000 })
    await ratio.click()
    await b.page.waitForFunction(() => window.callTest.quality.some(({ requested, applied }) =>
      requested.width?.ideal === 640 && Math.abs(requested.aspectRatio?.ideal - 4 / 3) < 0.001 && applied?.height > 0),
      null, { timeout: 7000 })
    assert.equal(await resolution.getAttribute('aria-pressed'), 'true')
    assert.equal(await ratio.getAttribute('aria-pressed'), 'true')
    assert.equal(await b.page.locator('[data-call-quality-panel] button[aria-pressed="true"]').count(), 2)
    const bitrate = b.page.locator('[data-call-bitrate]')
    await videoBitrateLimit(b.page, 2)
    await bitrate.filter({ hasText: '2M' }).waitFor()
    for (const limit of [3, 4, 5, 1, 2]) {
      await bitrate.tap()
      await bitrate.filter({ hasText: `${limit}M` }).waitFor()
      await videoBitrateLimit(b.page, limit)
    }
    if (screenshots) await b.page.screenshot({ path: resolve(screenshots, 'mobile-quality.png') })
    await b.page.evaluate(() => {
      const sender = window.callTest.pcs.at(-1).getSenders().find((entry) => entry.track?.kind === 'video')
      sender.setParameters = () => {
        delete sender.setParameters
        return Promise.reject(new DOMException('Test bitrate rejection', 'OperationError'))
      }
    })
    await bitrate.tap()
    await b.page.locator('[data-chat-notice]').filter({ hasText: '无法调整视频发送码率' }).waitFor()
    assert.equal(await bitrate.textContent(), '2M')
    await videoBitrateLimit(b.page, 2)
  } catch (error) {
    t.diagnostic(JSON.stringify(await b.page.evaluate(() => ({
      quality: window.callTest.quality,
      bitrate: document.querySelector('[data-call-bitrate]')?.textContent,
      resolution: document.querySelector('[data-call-resolution][aria-pressed="true"]')?.dataset.callResolution,
      ratio: document.querySelector('[data-call-ratio][aria-pressed="true"]')?.dataset.callRatio,
      phase: document.querySelector('[data-chat-call]').dataset.phase,
    }))))
    throw error
  }
  await showControls(b.page)
  await b.page.locator('[data-call-preview]').waitFor({ state: 'hidden' })
  if (screenshots) {
    await Promise.all([showControls(a.page), showControls(b.page)])
    await Promise.all([
      callPanel(a.page).screenshot({ path: resolve(screenshots, 'desktop.png') }),
      b.page.screenshot({ path: resolve(screenshots, 'mobile.png') }),
    ])
  }

  await showControls(a.page)
  await a.page.locator('[data-call-quality]').click()
  await a.page.locator('[data-call-bitrate]').click()
  await videoBitrateLimit(a.page, 3)
  await showControls(a.page)
  const desktopMic = a.page.locator('[data-call-mic]')
  const desktopAudio = a.page.locator('[data-call-audio-panel]')
  await desktopMic.press('Space')
  await desktopAudio.waitFor()
  assert.equal(await a.page.evaluate(() =>
    document.querySelector('[data-call-local]').srcObject.getAudioTracks()[0].enabled), true)
  await a.page.keyboard.press('Escape')
  await desktopAudio.waitFor({ state: 'hidden' })
  assert.ok(await desktopMic.evaluate((button) => button === document.activeElement))
  await desktopMic.click({ button: 'right' })
  assert.equal(await a.page.evaluate(() =>
    document.querySelector('[data-call-local]').srcObject.getAudioTracks()[0].enabled), false)
  await desktopAudio.waitFor({ state: 'hidden' })
  await desktopMic.click()
  await a.page.locator('[data-call-mic-toggle]').click()
  assert.equal(await a.page.evaluate(() =>
    document.querySelector('[data-call-local]').srcObject.getAudioTracks()[0].enabled), true)
  await a.page.locator('[data-call-camera]').click()
  await desktopAudio.waitFor({ state: 'hidden' })
  assert.ok(await a.page.locator('[data-call-camera-facing]').isDisabled(), '单摄相机切换灰显')
  await a.page.locator('[data-call-camera-toggle]').click()
  await a.page.waitForFunction(() => window.callTest.tracks
    .filter((track) => track.kind === 'video').every((track) => track.readyState === 'ended'))
  await a.page.locator('[data-call-camera-toggle]').click()
  await a.page.waitForFunction(() =>
    document.querySelector('[data-call-local]').srcObject.getVideoTracks().length === 1)
  await videoBitrateLimit(a.page, 3)
  const priorCaptureCount = await a.page.evaluate(() => {
    document.querySelector('[data-call-local]').srcObject.getVideoTracks()[0].stop()
    document.dispatchEvent(new Event('visibilitychange'))
    return window.callTest.tracks.length
  })
  await a.page.waitForFunction((previous) => window.callTest.tracks.length > previous &&
    document.querySelector('[data-call-local]').srcObject.getVideoTracks().some((track) => track.readyState === 'live'), priorCaptureCount)
  await videoBitrateLimit(a.page, 3)
  assert.equal(await a.page.evaluate(() => window.callTest.pcs.length), 1)

  await b.page.setViewportSize({ width: 320, height: 720 })
  await showControls(b.page)
  const mobileMic = b.page.locator('[data-call-mic]')
  const mobileAudio = b.page.locator('[data-call-audio-panel]')
  await holdTouch(b.page, mobileMic)
  assert.equal(await mobileMic.getAttribute('data-media-off') !== null, true, '长按只切换一次闭麦')
  await mobileAudio.waitFor({ state: 'hidden' })
  await mobileMic.tap()
  await mobileAudio.waitFor()
  await delay(3100)
  assert.ok(await b.page.locator('[data-call-controls]:not(.is-idle)').isVisible(), '设备面板展开时暂停控制条消隐')
  const audioBox = await mobileAudio.boundingBox()
  assert.ok(audioBox.x >= 0 && audioBox.x + audioBox.width <= 321)
  assert.ok(await b.page.locator('[data-call-audio-input]').isVisible())
  assert.ok(await b.page.locator('[data-call-audio-output]').isVisible())
  if (screenshots) await b.page.screenshot({ path: resolve(screenshots, 'mobile-audio.png') })
  await b.page.locator('[data-call-mic-toggle]').tap()
  assert.equal(await mobileMic.getAttribute('data-media-off'), null)

  await b.page.locator('[data-call-camera]').tap()
  await mobileAudio.waitFor({ state: 'hidden' })
  const cameraPanel = b.page.locator('[data-call-camera-panel]')
  const mirrorToggle = b.page.locator('[data-call-camera-mirror]')
  const facingToggle = b.page.locator('[data-call-camera-facing]')
  await cameraPanel.waitFor()
  const firstRow = await cameraPanel.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().top))
  assert.equal(firstRow.length, 3)
  assert.ok(firstRow.every((top) => top === firstRow[0]), '320px 视口三项相机控制在同一行')
  if (screenshots) await b.page.screenshot({ path: resolve(screenshots, 'mobile-camera.png') })
  await mirrorToggle.tap()
  await b.page.locator('[data-call-local].is-mirrored').waitFor()
  await a.page.locator('[data-call-remote].is-mirrored').waitFor()
  assert.match(await a.page.locator('[data-call-remote]').evaluate((video) => getComputedStyle(video).transform),
    /^matrix\(-1, 0, 0, 1, 0, 0\)$/)
  const ownView = b.page.locator('[data-call-local]')
  const wasSmall = await ownView.evaluate((video) => video.classList.contains('is-small'))
  await b.page.locator('[data-call-mini]').tap()
  assert.notEqual(await ownView.evaluate((video) => video.classList.contains('is-small')), wasSmall)
  assert.ok(await ownView.evaluate((video) => video.classList.contains('is-mirrored')))
  await facingToggle.tap()
  await b.page.waitForFunction(() => document.querySelector('[data-call-local]').srcObject.getVideoTracks()[0]
    ?.getSettings().facingMode === 'environment')
  await a.page.locator('[data-call-remote].is-mirrored').waitFor({ state: 'hidden' })
  await facingToggle.tap()
  await a.page.locator('[data-call-remote].is-mirrored').waitFor()
  assert.equal(await b.page.evaluate(() => window.callTest.pcs.length), 1)
  assert.equal(await a.page.evaluate(() => window.callTest.signals.filter(({ action }) => action === 'offer').length), 1)
  assert.equal(await b.page.evaluate(() => window.callTest.signals.filter(({ action }) => action === 'answer').length), 1)

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
  await activeStrip.waitFor({ state: 'hidden' })
  await Promise.all([a.context.close(), b.context.close(), viewer.context.close()])
  t.diagnostic('公开邀请、全房间通话状态、预览消息和画质、后台媒体恢复、直连和释放通过')

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
  await invite(c.page)
  await join(d.page, carol.username)
  await Promise.all([callPanel(c.page, 'active').waitFor(), callPanel(d.page, 'active').waitFor()])
  assert.equal(signed, 2)
  await Promise.all([mediaStats(c.page, true), mediaStats(d.page, true)])
  await videoBitrateLimit(c.page, 2)
  await showControls(c.page)
  await c.page.locator('[data-call-quality]').click()
  await c.page.locator('[data-call-bitrate]').click()
  await videoBitrateLimit(c.page, 3)
  t.diagnostic('临时凭证签名和 TURN UDP 双向音视频通过')

  const originalSocket = await c.page.evaluate(() => {
    const { sockets, signals, readyMessages } = window.callTest
    const { index } = signals.findLast((frame) => frame.action === 'invite-room')
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
  await videoBitrateLimit(c.page, 3)
  assert.equal(await c.page.evaluate(() => window.callTest.pcs.length), 1)
  await d.page.close()
  await released(c.page)
  assert.deepEqual(errors, [])
  t.diagnostic('主动续期保留媒体及关闭标签页后对端释放通过')
})
