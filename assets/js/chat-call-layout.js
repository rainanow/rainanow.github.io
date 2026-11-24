;(function () {
  'use strict'

  const clamp = (value, limit) => Math.max(0, Math.min(limit, value))
  const edge = 8
  const dragThreshold = 6
  const controlsIdleMs = 3000
  const longPressMs = 500
  const touchSlop = 10
  const syntheticClickMs = 1000

  window.createYuloCallLayout = function (panel, options = {}) {
    const room = panel.closest('[data-chat-room]')
    const control = (name) => panel.querySelector('[data-call-' + name + ']')
    const stage = control('stage')
    const remote = control('remote')
    const local = control('local')
    const mainTarget = control('main')
    const mini = control('mini')
    const controls = control('controls')
    const preview = control('preview')
    const composerPanel = control('composer-panel')
    const composer = room.querySelector('[data-chat-composer]')
    const input = composer.querySelector('[data-chat-input]')
    const overlay = control('overlay')
    const playerHint = control('player-hint')
    const compact = window.matchMedia?.('(max-width: 640px), (max-width: 940px) and (max-height: 520px)')
    const viewport = window.visualViewport
    const previews = {
      compose: { opener: control('compose'), content: composerPanel, label: '发消息', focus: () => input },
      quality: {
        opener: control('quality'), content: control('quality-panel'), label: '画质设置',
        focus: () => control('quality-panel')?.querySelector('[data-call-resolution][aria-pressed="true"]'),
      },
      camera: {
        opener: control('camera'), content: control('camera-panel'), label: '摄像头设置',
        focus: () => control('camera-toggle'),
        quickToggle: options.onCameraQuickToggle, onOpen: options.onCameraOpen,
      },
      audio: {
        opener: control('mic'), content: control('audio-panel'), label: '音频设置',
        focus: () => control('mic-toggle'),
        quickToggle: options.onMicQuickToggle, onOpen: options.onAudioOpen,
      },
    }
    let preferredMain = remote
    let fraction = null
    let thumbnail = null
    let bounds = null
    let drag = null
    let suppressClick = false
    let hasPeer = false
    let active = false
    let previewMode = null
    let touchPress = null
    let ignoredClick = null
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
      if (!active || previewMode !== null || (touchPress && touchPress.finishedAt === null)) return
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
      preview.setAttribute('aria-label', mode === null ? '通话预览' : previews[mode].label)
      for (const [key, view] of Object.entries(previews)) {
        if (!view.opener || !view.content) continue
        view.content.hidden = mode !== key
        view.opener.setAttribute('aria-expanded', String(mode === key))
      }
      showControls()
    }

    function togglePreview(mode, view) {
      if (view.opener.hidden || view.opener.disabled) return
      if (previewMode === mode) {
        setPreview(null)
      } else {
        setPreview(mode)
        view.onOpen?.()
        const target = view.focus()
        const focused = target && !target.disabled ? target : view.opener
        focused.focus({ preventScroll: true })
      }
    }

    function ignoreClick(view) {
      ignoredClick = { view, until: Date.now() + syntheticClickMs }
    }

    function finishTouchPress(press, canceled = false) {
      if (!press || press.finishedAt !== null) return
      press.finishedAt = Date.now()
      clearTimeout(press.timer)
      if (press.fired || canceled) ignoreClick(press.view)
      scheduleControlsHide()
    }

    function triggerTouchShortcut(press) {
      const { view } = press
      if (touchPress !== press || press.finishedAt !== null || press.fired) return
      if (!hasPeer || view.opener.hidden || view.opener.disabled) return
      press.fired = true
      clearTimeout(press.timer)
      ignoreClick(view)
      showControls()
      view.quickToggle()
    }

    function bindShortcut(view) {
      const button = view.opener
      button.addEventListener('pointerdown', (event) => {
        if (event.isPrimary === false) return
        finishTouchPress(touchPress, true)
        touchPress = null
        ignoredClick = null
        if (event.pointerType !== 'touch' || event.button !== 0 || !hasPeer || button.hidden || button.disabled) return
        const press = { view, id: event.pointerId, x: event.clientX, y: event.clientY, fired: false, finishedAt: null }
        touchPress = press
        press.timer = setTimeout(() => triggerTouchShortcut(press), longPressMs)
        showControls()
      })
      const matchesPress = (event) => touchPress?.view === view && touchPress.id === event.pointerId
      button.addEventListener('pointermove', (event) => {
        if (!matchesPress(event)) return
        if (Math.hypot(event.clientX - touchPress.x, event.clientY - touchPress.y) > touchSlop) {
          finishTouchPress(touchPress, true)
        }
      })
      button.addEventListener('pointerup', (event) => {
        if (matchesPress(event)) finishTouchPress(touchPress)
      })
      for (const event of ['pointercancel', 'lostpointercapture']) {
        button.addEventListener(event, (pointer) => {
          if (matchesPress(pointer)) finishTouchPress(touchPress, true)
        })
      }
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        if (!hasPeer || button.hidden || button.disabled) return
        const press = touchPress?.view === view ? touchPress : null
        const fromTouch = event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents ||
          (press && (press.finishedAt === null || Date.now() - press.finishedAt < syntheticClickMs))
        if (fromTouch) {
          if (press) triggerTouchShortcut(press)
          return
        }
        ignoreClick(view)
        showControls()
        view.quickToggle()
      })
    }

    mainTarget.addEventListener('click', () => {
      if (previewMode !== null) setPreview(null)
      else showControls()
    })
    for (const [mode, view] of Object.entries(previews)) {
      if (!view.opener || !view.content) continue
      if (view.quickToggle) bindShortcut(view)
      view.opener.addEventListener('click', (event) => {
        if (touchPress?.view === view) finishTouchPress(touchPress)
        const fromPointer = event.detail !== 0 || event.pointerType || event.sourceCapabilities?.firesTouchEvents
        if (fromPointer && ignoredClick?.view === view && Date.now() <= ignoredClick.until) {
          event.preventDefault()
          return
        }
        togglePreview(mode, view)
      })
    }
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || previewMode === null) return
      const { opener } = previews[previewMode]
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
    window.addEventListener('blur', () => finishTouchPress(touchPress, true))
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) finishTouchPress(touchPress, true)
    })

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
      previews.compose.opener.hidden = !active || !expanded
      previews.quality.opener.hidden = !active
      const available = { compose: active && expanded, quality: active, camera: hasPeer, audio: hasPeer }
      if (previewMode !== null && !available[previewMode]) setPreview(null)
      if (!hasPeer) finishTouchPress(touchPress, true)
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
