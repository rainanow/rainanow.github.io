/* Build Hugo first. CHAT_BUILD_DIR can point to a temporary build. */
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const root = resolve(__dirname, '..')
const { JSDOM } = require(require.resolve('jsdom', { paths: [join(root, 'workers/chat')] }))
const build = process.env.CHAT_BUILD_DIR || join(root, 'public')
const html = readFileSync(join(build, 'chat/index.html'), 'utf8')
const source = readFileSync(join(root, 'assets/js/chat-call-layout.js'), 'utf8')

function callPage(t) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const { window } = dom
  t.after(() => window.close())
  const room = window.document.querySelector('[data-chat-room]')
  const panel = room.querySelector('[data-chat-call]')
  room.hidden = false
  panel.hidden = false
  const control = (name) => panel.querySelector('[data-call-' + name + ']')
  const [stage, local, remote, mini] = ['stage', 'local', 'remote', 'mini'].map(control)
  for (const video of [local, remote]) {
    assert.ok(video.hasAttribute('playsinline'))
    assert.ok(video.hasAttribute('disablepictureinpicture'))
    assert.ok(video.hasAttribute('disableremoteplayback'))
    video.srcObject = { feed: video }
    video.hidden = false
  }
  assert.ok(local.hasAttribute('muted'))
  assert.equal(remote.hasAttribute('muted'), false)
  stage.hidden = false

  const mode = Object.assign(new window.EventTarget(), { matches: false })
  const viewport = Object.assign(new window.EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  window.matchMedia = () => mode
  window.visualViewport = viewport
  const size = { width: 700, height: 390 }
  Object.defineProperties(stage, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  })

  function setVideoSize(video, width, height) {
    Object.defineProperties(video, {
      videoWidth: { value: width, configurable: true },
      videoHeight: { value: height, configurable: true },
    })
    video.dispatchEvent(new window.Event('resize'))
  }

  function pointer(type, x, y, pointerId = 1) {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    mini.dispatchEvent(event)
  }

  function thumbnailRect() {
    return Object.fromEntries(['x', 'y', 'width', 'height'].map((name) => [
      name, Number.parseFloat(stage.style.getPropertyValue('--call-mini-' + name)),
    ]))
  }

  window.eval(source)
  return { window, room, control, stage, local, remote, mini, mode, viewport, size,
    setVideoSize, pointer, thumbnailRect, layout: window.createYuloCallLayout(panel) }
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.1, `${actual} should be close to ${expected}`)
}

test('the same feeds swap, drag within the stage and resize with their camera ratio', (t) => {
  const page = callPage(t)
  const { window, stage, local, remote, mini, layout, size, pointer, thumbnailRect } = page
  const [localFeed, remoteFeed] = [local.srcObject, remote.srcObject]
  page.setVideoSize(local, 640, 480)
  page.setVideoSize(remote, 1280, 720)
  layout.update(true, true)
  assert.equal(stage.dataset.main, 'remote')
  assert.ok(local.classList.contains('is-small'))
  const original = thumbnailRect()
  closeTo(original.width / original.height, 4 / 3)
  closeTo(original.x + original.width, size.width - 8)
  closeTo(original.y + original.height, size.height - 8)

  pointer('pointerdown', original.x + 10, original.y + 10)
  pointer('pointermove', -100, -100, 2)
  assert.equal(thumbnailRect().x, original.x, 'a second pointer cannot move the thumbnail')
  pointer('pointermove', -100, -100)
  pointer('pointerup', -100, -100)
  mini.dispatchEvent(new window.MouseEvent('click', { detail: 1 }))
  assert.equal(stage.dataset.main, 'remote', 'dragging must not swap the videos')
  assert.equal(thumbnailRect().x, 8)
  assert.equal(thumbnailRect().y, 8)
  assert.equal(stage.dataset.overlaySide, 'right')

  mini.click()
  assert.equal(stage.dataset.main, 'local')
  assert.ok(remote.classList.contains('is-small'))
  const swapped = thumbnailRect()
  closeTo(swapped.width / swapped.height, 16 / 9)

  Object.assign(size, { width: 828, height: 230 })
  page.setVideoSize(remote, 720, 1280)
  const { x, y, width, height } = thumbnailRect()
  closeTo(width / height, 9 / 16)
  assert.ok(x >= 0 && y >= 0 && x + width <= size.width && y + height <= size.height)
  closeTo(x, 8)
  closeTo(y, 8)
  pointer('pointerdown', x + 10, y + 10)
  pointer('pointercancel', x + 10, y + 10)
  pointer('pointermove', 200, 200)
  assert.equal(thumbnailRect().x, 8)
  mini.click()
  assert.equal(stage.dataset.main, 'remote')
  assert.equal(local.srcObject, localFeed)
  assert.equal(remote.srcObject, remoteFeed)
})

test('a compact call starts with the thumbnail at the upper right and keeps the composer', (t) => {
  const { window, room, control, layout, mode, viewport, size, thumbnailRect } = callPage(t)
  const overlay = control('overlay')
  const composer = room.querySelector('[data-chat-composer]')
  const add = (id, body) => layout.addMessage({ id, username: 'Alice', body })
  add('pre-call', 'before connecting')
  Object.assign(size, { width: 374, height: 600 })
  mode.matches = true
  layout.update(true, true)
  assert.ok(room.classList.contains('is-call-expanded'))
  assert.equal(composer.parentElement, control('composer-panel'))
  assert.equal(control('preview').hidden, true)
  const thumbnail = thumbnailRect()
  closeTo(thumbnail.x + thumbnail.width, size.width - 8)
  closeTo(thumbnail.y, 8)
  Object.assign(viewport, { height: 430, offsetTop: 16 })
  viewport.dispatchEvent(new window.Event('resize'))
  assert.equal(room.style.getPropertyValue('--call-viewport-height'), '430px')
  assert.equal(room.style.getPropertyValue('--call-viewport-top'), '16px')
  mode.matches = false
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(room.classList.contains('is-call-expanded'), false)
  assert.equal(room.style.getPropertyValue('--call-viewport-height'), '')
  assert.equal(composer.parentElement, room)
  mode.matches = true
  mode.dispatchEvent(new window.Event('change'))
  assert.ok(room.classList.contains('is-call-expanded'))

  assert.equal(overlay.children.length, 0)
  add('one', 'first')
  add('two', 'second')
  add('three', 'third')
  add('three', 'duplicate')
  add('four', '  <img>   文本  ')
  assert.deepEqual(Array.from(overlay.children, (line) => line.textContent), [
    'Alice second', 'Alice third', 'Alice <img> 文本',
  ])
  assert.equal(overlay.querySelector('img'), null)
  layout.removeMessage('three')
  assert.equal(overlay.children.length, 2)
  layout.reset()
  assert.equal(overlay.children.length, 0)
  assert.equal(room.classList.contains('is-call-expanded'), false)
  assert.equal(composer.parentElement, room)
})

test('the call preview switches between mobile messages and quality without losing the composer', (t) => {
  const { window, room, control, layout, mode } = callPage(t)
  const composer = room.querySelector('[data-chat-composer]')
  const input = composer.querySelector('[data-chat-input]')
  const send = composer.querySelector('[data-chat-send]')
  const invite = composer.querySelector('[data-chat-call-invite]')
  const upload = composer.querySelector('[data-chat-upload]')
  const preview = control('preview')
  const compose = control('compose')
  const quality = control('quality')
  const qualityPanel = control('quality-panel')
  const resolution = qualityPanel.querySelector('button[data-call-resolution][aria-pressed="true"]')
  assert.equal(input.placeholder, '说点什么')
  assert.equal(invite.nextElementSibling, upload)
  assert.ok(invite.querySelector('svg'))
  assert.equal(compose.nextElementSibling, control('mic'))
  assert.equal(control('camera').nextElementSibling, quality)
  assert.equal(qualityPanel.querySelector('select'), null)
  assert.deepEqual(Array.from(qualityPanel.querySelectorAll('button[data-call-resolution]'),
    (button) => button.dataset.callResolution), ['1080p', '720p', '480p'])
  assert.deepEqual(Array.from(qualityPanel.querySelectorAll('button[data-call-ratio]'),
    (button) => button.dataset.callRatio), ['16:9', '4:3'])
  assert.equal(resolution.dataset.callResolution, '720p')
  const bitrate = control('bitrate')
  assert.equal(bitrate.tagName, 'BUTTON')
  assert.equal(bitrate.type, 'button')
  assert.equal(bitrate.previousElementSibling, qualityPanel.querySelector('[data-call-ratio="4:3"]'))
  assert.equal(bitrate.nextElementSibling, null)

  let submitted = 0
  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    submitted += 1
  })
  layout.update(true, true)
  assert.equal(compose.hidden, true)
  assert.equal(quality.hidden, false)
  assert.equal(composer.parentElement, room)
  assert.equal(input.hasAttribute('enterkeyhint'), false)
  input.value = '电脑端的消息'
  send.click()
  assert.equal(submitted, 1)
  quality.click()
  assert.equal(preview.hidden, false)
  assert.equal(control('quality-panel').hidden, false)
  assert.equal(window.document.activeElement, resolution)
  assert.equal(quality.getAttribute('aria-expanded'), 'true')
  resolution.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(preview.hidden, true)
  assert.equal(window.document.activeElement, quality)

  mode.matches = true
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(compose.hidden, false)
  assert.equal(composer.parentElement, control('composer-panel'))
  assert.equal(input.getAttribute('enterkeyhint'), 'send')
  compose.click()
  assert.equal(window.document.activeElement, input)
  assert.equal(control('composer-panel').hidden, false)
  assert.ok(preview.classList.contains('chat__call-preview--compose'))
  input.value = '未发送的草稿'
  quality.click()
  assert.equal(control('composer-panel').hidden, true)
  assert.equal(control('quality-panel').hidden, false)
  assert.equal(preview.classList.contains('chat__call-preview--compose'), false)
  assert.equal(compose.getAttribute('aria-expanded'), 'false')
  assert.equal(quality.getAttribute('aria-expanded'), 'true')
  compose.click()
  assert.equal(control('quality-panel').hidden, true)
  assert.equal(input.value, '未发送的草稿')
  control('main').click()
  assert.equal(preview.hidden, true)

  compose.click()
  mode.matches = false
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(preview.hidden, true)
  assert.equal(composer.parentElement, room)
  assert.equal(input.value, '未发送的草稿')
  assert.equal(input.hasAttribute('enterkeyhint'), false)
  assert.equal(compose.hidden, true)
  quality.click()
  layout.reset()
  assert.equal(preview.hidden, true)
  assert.equal(quality.hidden, true)
})

test('controls hide after idle, reappear from the main video, and stay on screen with keyboard focus', (t) => {
  const { window, control, layout } = callPage(t)
  const controls = control('controls')
  const main = control('main')
  const hangup = control('hangup')
  t.mock.method(hangup, 'matches', (selector) => selector === ':focus-visible' && window.document.activeElement === hangup)
  const timers = new Map()
  let sequence = 0
  window.setTimeout = (callback, delay) => {
    timers.set(++sequence, { callback, delay })
    return sequence
  }
  window.clearTimeout = (id) => timers.delete(id)
  function runIdleDelay() {
    assert.equal(timers.size, 1)
    const [[id, { callback, delay }]] = timers
    assert.equal(delay, 3000)
    timers.delete(id)
    callback()
  }

  layout.update(true, false)
  assert.equal(timers.size, 0)
  layout.update(true, true)
  assert.equal(main.getAttribute('aria-expanded'), 'true')
  runIdleDelay()
  assert.ok(controls.classList.contains('is-idle'))
  assert.equal(main.getAttribute('aria-expanded'), 'false')
  layout.update(true, true)
  assert.equal(timers.size, 0)

  main.click()
  assert.equal(controls.classList.contains('is-idle'), false)
  control('quality').click()
  assert.equal(timers.size, 0)
  control('main').click()
  assert.equal(timers.size, 1)
  hangup.hidden = false
  hangup.focus()
  assert.equal(window.document.activeElement, hangup)
  runIdleDelay()
  assert.equal(controls.classList.contains('is-idle'), false)
  main.focus()
  runIdleDelay()
  assert.ok(controls.classList.contains('is-idle'))

  main.click()
  assert.equal(timers.size, 1)
  layout.reset()
  assert.equal(timers.size, 0)
  assert.equal(main.hidden, true)
})
