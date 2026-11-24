;(function () {
  'use strict'

  const clamp = (value, limit) => Math.max(0, Math.min(limit, value))
  const edge = 8
  const dragThreshold = 6
  const controlsIdleMs = 3000

  window.createYuloCallLayout = function (panel) {
    const room = panel.closest('[data-chat-room]')
    const control = (name) => panel.querySelector('[data-call-' + name + ']')
    const stage = control('stage')
    const remote = control('remote')
    const local = control('local')
    const mainTarget = control('main')
    const mini = control('mini')
    const controls = control('controls')
    const preview = control('preview')
    const qualityButton = control('quality')
    const qualityPanel = control('quality-panel')
    const composeButton = control('compose')
    const composerPanel = control('composer-panel')
    const composer = room.querySelector('[data-chat-composer]')
    const input = composer.querySelector('[data-chat-input]')
    const overlay = control('overlay')
    const playerHint = control('player-hint')
    const compact = window.matchMedia?.('(max-width: 640px), (max-width: 940px) and (max-height: 520px)')
    const viewport = window.visualViewport
    let preferredMain = remote
    let fraction = null
    let thumbnail = null
    let bounds = null
    let drag = null
    let suppressClick = false
    let hasPeer = false
    let active = false
    let previewMode = null
    let controlsTimer
    let hintTimer
    const messages = new Map()
    const seen = new Set()

    function controlsHaveKeyboardFocus() {
      const focused = document.activeElement
      return controls.contains(focused) && focused.matches(':focus-visible')
    }

    function showControls() {
      controls.classList.remove('is-idle')
      mainTarget.setAttribute('aria-expanded', 'true')
      scheduleControlsHide()
    }

    function scheduleControlsHide() {
      clearTimeout(controlsTimer)
      if (!active || previewMode !== null) return
      controlsTimer = setTimeout(() => {
        if (controlsHaveKeyboardFocus()) return
        controls.classList.add('is-idle')
        mainTarget.setAttribute('aria-expanded', 'false')
      }, controlsIdleMs)
    }

    function setPreview(mode) {
      if (previewMode === mode) return
      previewMode = mode
      preview.hidden = mode === null
      preview.classList.toggle('chat__call-preview--compose', mode === 'compose')
      preview.setAttribute('aria-label', mode === 'compose' ? '发消息' : '画质设置')
      composerPanel.hidden = mode !== 'compose'
      qualityPanel.hidden = mode !== 'quality'
      composeButton.setAttribute('aria-expanded', String(mode === 'compose'))
      qualityButton.setAttribute('aria-expanded', String(mode === 'quality'))
      showControls()
    }

    function togglePreview(mode, focusTarget) {
      if (previewMode === mode) {
        setPreview(null)
      } else {
        setPreview(mode)
        focusTarget.focus({ preventScroll: true })
      }
    }

    mainTarget.addEventListener('click', () => {
      if (previewMode !== null) setPreview(null)
      else showControls()
    })
    composeButton.addEventListener('click', () => {
      if (!composeButton.hidden) togglePreview('compose', input)
    })
    qualityButton.addEventListener('click', () => {
      if (qualityButton.hidden) return
      const selected = qualityPanel.querySelector('[data-call-resolution][aria-pressed="true"]')
      togglePreview('quality', selected)
    })
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || previewMode === null) return
      const opener = previewMode === 'compose' ? composeButton : qualityButton
      event.preventDefault()
      event.stopPropagation()
      setPreview(null)
      opener.focus({ preventScroll: true })
    })
    controls.addEventListener('click', showControls)
    controls.addEventListener('focusin', () => {
      if (controlsHaveKeyboardFocus()) showControls()
    })
    controls.addEventListener('focusout', scheduleControlsHide)

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
      const heightLimit = compact?.matches ? 224 : 160
      const maxHeight = Math.min(height - 2 * margin, Math.max(48, Math.min(heightLimit, height * 0.38)))
      const miniWidth = Math.min(maxWidth, maxHeight * aspect)
      const miniHeight = miniWidth / aspect
      const travelX = Math.max(0, width - 2 * margin - miniWidth)
      const travelY = Math.max(0, height - 2 * margin - miniHeight)
      const x = margin + (fraction?.x ?? 1) * travelX
      const y = margin + (fraction?.y ?? (compact?.matches ? 0 : 1)) * travelY
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
      mainTarget.hidden = !hasPeer
      const expanded = hasPeer && !!compact?.matches
      room.classList.toggle('is-call-expanded', expanded)
      composeButton.hidden = !active || !expanded
      qualityButton.hidden = !active
      if (!active || (!expanded && previewMode === 'compose')) setPreview(null)
      const composerParent = expanded ? composerPanel : room
      if (composer.parentElement !== composerParent) {
        composerParent.append(composer)
        if (expanded) input.setAttribute('enterkeyhint', 'send')
        else input.removeAttribute('enterkeyhint')
      }
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
      fraction = {
        x: travelX ? clamp(drag.start.x + dx - margin, travelX) / travelX : fraction?.x,
        y: travelY ? clamp(drag.start.y + dy - margin, travelY) / travelY : fraction?.y,
      }
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
      if (!active || seen.has(id)) return
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

    return {
      update(peerPresent, callActive) {
        const phaseChanged = hasPeer !== peerPresent || active !== callActive
        hasPeer = peerPresent
        active = callActive
        if (phaseChanged) showControls()
        sync()
      },
      reset() {
        hasPeer = false
        active = false
        showControls()
        preferredMain = remote
        fraction = null
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
