;(function () {
  'use strict'

  const clamp = (value, limit) => Math.max(0, Math.min(limit, value))
  const edge = 8
  const dragThreshold = 6

  window.createYuloCallLayout = function (panel) {
    const room = panel.closest('[data-chat-room]')
    const control = (name) => panel.querySelector('[data-call-' + name + ']')
    const stage = control('stage')
    const remote = control('remote')
    const local = control('local')
    const mini = control('mini')
    const swap = control('swap')
    const expand = control('expand')
    const overlay = control('overlay')
    const overlayToggle = control('overlay-toggle')
    const playerHint = control('player-hint')
    const compact = window.matchMedia?.('(max-width: 640px), (max-width: 940px) and (max-height: 520px)')
    const viewport = window.visualViewport
    let preferredMain = remote
    let fraction = { x: 1, y: 1 }
    let thumbnail = null
    let bounds = null
    let drag = null
    let suppressClick = false
    let hasPeer = false
    let active = false
    let expandedChoice = null
    let showMessages = true
    let hintTimer
    const messages = new Map()
    const seen = new Set()

    function pixels(name, value) {
      stage.style.setProperty(name, value + 'px')
    }

    function placeThumbnail() {
      const width = stage.clientWidth
      const height = stage.clientHeight
      if (!thumbnail || stage.hidden || !width || !height) {
        if (drag) endDrag(drag.id)
        mini.hidden = true
        bounds = null
        delete stage.dataset.overlaySide
        stage.style.removeProperty('--call-overlay-width')
        return
      }
      const aspect = thumbnail.videoWidth > 0 && thumbnail.videoHeight > 0
        ? thumbnail.videoWidth / thumbnail.videoHeight : 4 / 3
      const margin = Math.min(edge, width / 4, height / 4)
      const maxWidth = Math.min(width * 0.36, 184)
      const maxHeight = Math.min(height - 2 * margin, Math.max(48, Math.min(160, height * 0.38)))
      const miniWidth = Math.min(maxWidth, maxHeight * aspect)
      const miniHeight = miniWidth / aspect
      const travelX = Math.max(0, width - 2 * margin - miniWidth)
      const travelY = Math.max(0, height - 2 * margin - miniHeight)
      const x = margin + fraction.x * travelX
      const y = margin + fraction.y * travelY
      bounds = { x, y, margin, travelX, travelY }
      pixels('--call-mini-x', x)
      pixels('--call-mini-y', y)
      pixels('--call-mini-width', miniWidth)
      pixels('--call-mini-height', miniHeight)

      // 浮动消息使用小窗旁边较宽的一侧，小窗拖动时不压住文字。
      const left = x - 2 * margin
      const right = width - x - miniWidth - 2 * margin
      stage.dataset.overlaySide = right > left ? 'right' : 'left'
      pixels('--call-overlay-width', Math.max(0, Math.min(width * 0.7, 360, Math.max(left, right))))
      mini.hidden = false
    }

    function fitViewport() {
      // 手机软键盘可能只缩小可视视口。让下方输入框随可见区域一起上移。
      if (room.classList.contains('is-call-expanded') && viewport?.height > 0 && viewport.scale === 1) {
        room.style.setProperty('--call-viewport-top', viewport.offsetTop + 'px')
        room.style.setProperty('--call-viewport-height', viewport.height + 'px')
      } else {
        room.style.removeProperty('--call-viewport-top')
        room.style.removeProperty('--call-viewport-height')
      }
      placeThumbnail()
    }

    function sync() {
      const both = !local.hidden && !remote.hidden
      const main = preferredMain.hidden ? (local.hidden ? remote : local) : preferredMain
      thumbnail = both ? (main === remote ? local : remote) : null
      stage.dataset.main = main === local ? 'local' : 'remote'
      local.classList.toggle('is-small', thumbnail === local)
      remote.classList.toggle('is-small', thumbnail === remote)
      swap.hidden = !both
      const expanded = hasPeer && (expandedChoice ?? compact?.matches ?? false)
      room.classList.toggle('is-call-expanded', expanded)
      expand.hidden = !hasPeer
      expand.textContent = expanded ? '收起' : '放大'
      expand.setAttribute('aria-pressed', String(expanded))
      overlayToggle.hidden = !active
      overlayToggle.setAttribute('aria-pressed', String(showMessages))
      fitViewport()
    }

    function swapFeeds() {
      if (!thumbnail) return
      preferredMain = thumbnail
      sync()
    }

    function endDrag(pointerId) {
      if (!drag || drag.id !== pointerId) return
      suppressClick = drag.moved
      drag = null
      mini.classList.remove('is-dragging')
      if (mini.hasPointerCapture?.(pointerId)) mini.releasePointerCapture(pointerId)
    }

    mini.addEventListener('pointerdown', (event) => {
      if (!bounds || drag || event.isPrimary === false || event.button !== 0) return
      suppressClick = false
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: bounds, moved: false }
      mini.setPointerCapture?.(event.pointerId)
    })

    mini.addEventListener('pointermove', (event) => {
      if (!bounds || !drag || drag.id !== event.pointerId) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return
      drag.moved = true
      mini.classList.add('is-dragging')
      const { margin, travelX, travelY } = bounds
      if (travelX) fraction.x = clamp(drag.start.x + dx - margin, travelX) / travelX
      if (travelY) fraction.y = clamp(drag.start.y + dy - margin, travelY) / travelY
      placeThumbnail()
    })

    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      mini.addEventListener(event, (pointer) => endDrag(pointer.pointerId))
    }
    mini.addEventListener('click', (event) => {
      const ignore = suppressClick && event.detail !== 0
      suppressClick = false
      if (!ignore) swapFeeds()
    })
    swap.addEventListener('click', swapFeeds)
    expand.addEventListener('click', () => {
      expandedChoice = !room.classList.contains('is-call-expanded')
      sync()
    })
    compact?.addEventListener?.('change', sync)
    window.addEventListener('resize', fitViewport)
    viewport?.addEventListener('resize', fitViewport)
    viewport?.addEventListener('scroll', fitViewport)
    if (typeof ResizeObserver === 'function') new ResizeObserver(placeThumbnail).observe(stage)

    function hintAboutNativePlayer() {
      if (!hasPeer) return
      playerHint.hidden = false
      clearTimeout(hintTimer)
      hintTimer = setTimeout(() => { playerHint.hidden = true }, 6500)
    }

    for (const video of [local, remote]) {
      for (const event of ['loadedmetadata', 'resize']) video.addEventListener(event, placeThumbnail)
      // 一些播放器有回到页面的事件。只提示用户，播放状态交给浏览器处理。
      for (const event of ['webkitendfullscreen', 'leavepictureinpicture']) {
        video.addEventListener(event, hintAboutNativePlayer)
      }
    }

    function removeMessage(id) {
      const item = messages.get(id)
      if (!item) return
      clearTimeout(item.timer)
      item.line.remove()
      messages.delete(id)
    }

    function clearMessages() {
      for (const id of messages.keys()) removeMessage(id)
    }

    function addMessage({ id, username, body }) {
      if (!active || !showMessages || seen.has(id)) return
      const text = body.replace(/\s+/g, ' ').trim()
      if (!text) return
      if (seen.size >= 64) seen.delete(seen.values().next().value)
      seen.add(id)
      if (messages.size >= 3) removeMessage(messages.keys().next().value)
      const line = document.createElement('p')
      const preview = Array.from(text)
      line.textContent = username + ' ' + (preview.length > 120 ? preview.slice(0, 120).join('') + '…' : text)
      overlay.appendChild(line)
      messages.set(id, { line, timer: setTimeout(() => removeMessage(id), 5500) })
    }

    overlayToggle.addEventListener('click', () => {
      showMessages = !showMessages
      if (!showMessages) clearMessages()
      sync()
    })

    return {
      update(peerPresent, callActive) {
        hasPeer = peerPresent
        active = callActive
        sync()
      },
      reset() {
        hasPeer = false
        active = false
        expandedChoice = null
        preferredMain = remote
        fraction = { x: 1, y: 1 }
        if (drag) endDrag(drag.id)
        suppressClick = false
        seen.clear()
        clearMessages()
        clearTimeout(hintTimer)
        playerHint.hidden = true
        sync()
      },
      addMessage, removeMessage, clearMessages
    }
  }
})()
