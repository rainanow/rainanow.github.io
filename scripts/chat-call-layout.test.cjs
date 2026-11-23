/* Build Hugo first. CHAT_BUILD_DIR can point to a temporary build. */
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const root = resolve(__dirname, '..')
const { JSDOM } = require(require.resolve('jsdom', { paths: [join(root, 'workers/chat')] }))
const build = process.env.CHAT_BUILD_DIR || join(root, 'public')
const html = readFileSync(join(build, 'chat/tech/index.html'), 'utf8')
const source = readFileSync(join(root, 'assets/js/chat-call-layout.js'), 'utf8')

function callPage(t) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const { window } = dom
  t.after(() => window.close())
  const room = window.document.querySelector('[data-chat-room]')
  const panel = room.querySelector('[data-chat-call]')
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
  const { window, stage, local, remote, mini, control, layout, size, pointer, thumbnailRect } = page
  const [localFeed, remoteFeed] = [local.srcObject, remote.srcObject]
  page.setVideoSize(local, 640, 480)
  page.setVideoSize(remote, 1280, 720)
  layout.update(true, true)
  assert.equal(stage.dataset.main, 'remote')
  assert.ok(local.classList.contains('is-small'))
  const original = thumbnailRect()
  closeTo(original.width / original.height, 4 / 3)

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

  control('swap').click()
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

test('a compact call keeps the composer and shows recent text only while enabled', (t) => {
  const { window, room, control, layout, mode, viewport, size } = callPage(t)
  const overlay = control('overlay')
  const add = (id, body) => layout.addMessage({ id, username: 'Alice', body })
  add('pre-call', 'before connecting')
  Object.assign(size, { width: 374, height: 600 })
  mode.matches = true
  layout.update(true, true)
  assert.ok(room.classList.contains('is-call-expanded'))
  assert.ok(room.querySelector('[data-chat-composer]'))
  Object.assign(viewport, { height: 430, offsetTop: 16 })
  viewport.dispatchEvent(new window.Event('resize'))
  assert.equal(room.style.getPropertyValue('--call-viewport-height'), '430px')
  assert.equal(room.style.getPropertyValue('--call-viewport-top'), '16px')
  control('expand').click()
  assert.equal(room.classList.contains('is-call-expanded'), false)
  assert.equal(room.style.getPropertyValue('--call-viewport-height'), '')
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(room.classList.contains('is-call-expanded'), false)
  control('expand').click()
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
  control('overlay-toggle').click()
  add('five', 'hidden')
  assert.equal(overlay.children.length, 0)
  control('overlay-toggle').click()
  add('six', 'visible')
  assert.equal(overlay.children.length, 1)
  layout.reset()
  assert.equal(overlay.children.length, 0)
  assert.equal(room.classList.contains('is-call-expanded'), false)
})
