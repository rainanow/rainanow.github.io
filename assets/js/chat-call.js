;(function () {
  'use strict'

  const endText = {
    rejected: '对方拒绝了通话',
    canceled: '对方已取消呼叫',
    'answered-elsewhere': '已在其他标签页接听',
    'no-answer': '对方未接听',
    'connection-timeout': '连接超时，请重拨',
    disconnected: '通话连接已断开',
    hangup: '通话已结束',
    'device-error': '对方无法使用摄像头或麦克风',
    'media-error': '音视频连接失败，请重拨',
    disabled: '当前房间的通话功能已关闭'
  }

  const errorText = {
    busy: '对方或你的其他标签页正在通话',
    unavailable: '对方暂时无法接听',
    'rate-limited': '呼叫过于频繁，请稍后再试',
    disabled: endText.disabled,
    ended: endText.hangup
  }

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach((track) => track.stop())
  }

  function captureError(error) {
    if (error?.name === 'NotAllowedError') return '请允许使用摄像头和麦克风后重试'
    if (error?.name === 'NotFoundError') return '找不到可用的摄像头或麦克风'
    if (error?.name === 'NotReadableError') return '摄像头或麦克风可能被其他应用占用'
    return '无法打开摄像头或麦克风'
  }

  window.createYuloCallController = function (root, options) {
    const panel = root.querySelector('[data-chat-call]')
    if (!panel || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection !== 'function' || typeof window.createYuloCallLayout !== 'function') return null

    const layout = window.createYuloCallLayout(panel)
    const control = (name) => panel.querySelector('[data-call-' + name + ']')
    const ui = {
      peer: control('peer'), status: control('status'), stage: control('stage'),
      local: control('local'), remote: control('remote'), accept: control('accept'),
      reject: control('reject'), hangup: control('hangup'), mic: control('mic'),
      camera: control('camera'), switchCamera: control('switch'), play: control('play'),
    }
    let available = false
    let call = null
    let accessExpiresAt = 0
    const discardedInvites = new Set()
    const discardedAccepts = new Set()

    function send(action, fields = {}, type = 'call') {
      return options.send({ type, action, ...fields })
    }

    function setAvailable(value) {
      if (available === value) return
      available = value
      options.availabilityChanged()
    }

    function state(peer, phase, id = null) {
      return {
        peer, phase, id, signalQueue: Promise.resolve(), earlyIce: [],
        facing: 'user', lastStatus: Date.now(), renewAfter: 0,
      }
    }

    function render() {
      panel.hidden = call === null
      if (call === null) {
        delete panel.dataset.phase
        ui.stage.hidden = true
        ui.local.hidden = true
        ui.remote.hidden = true
        ui.play.hidden = true
        layout.reset()
        return
      }
      panel.dataset.phase = call.phase
      ui.peer.textContent = call.peer.username
      const labels = {
        preparing: '正在打开摄像头和麦克风…',
        inviting: '正在发起呼叫…',
        outgoing: '正在等待对方接听…',
        incoming: '视频来电',
        accepting: '正在接听…',
        connecting: '正在连接音视频…',
        active: '通话中',
      }
      ui.status.textContent = call.localReconnecting ? '正在重新连接…'
        : call.peerReconnecting ? '对方正在重新连接…'
          : call.mediaInterrupted ? '音视频连接正在恢复…' : labels[call.phase]
      const inMedia = call.pc != null
      const videoOn = call.local?.getVideoTracks().some((track) => track.readyState === 'live')
      const audioOn = call.local?.getAudioTracks().some((track) => track.enabled)
      ui.stage.hidden = !call.local && !inMedia
      ui.local.hidden = !videoOn
      ui.remote.hidden = !inMedia
      ui.accept.hidden = call.phase !== 'incoming'
      ui.reject.hidden = call.phase !== 'incoming'
      ui.hangup.hidden = call.phase === 'incoming'
      ui.hangup.textContent = inMedia || call.phase === 'active' ? '挂断' : '取消'
      ui.mic.hidden = !inMedia
      ui.mic.textContent = audioOn ? '静音' : '取消静音'
      ui.mic.setAttribute('aria-pressed', String(!audioOn))
      ui.camera.hidden = !inMedia
      ui.camera.disabled = !!call.changingCamera
      ui.camera.textContent = videoOn ? '关闭摄像头' : '开启摄像头'
      ui.switchCamera.hidden = !inMedia || !call.canSwitchCamera
      ui.switchCamera.disabled = !!call.changingCamera || !videoOn
      layout.update(inMedia, call.phase === 'active')
    }

    function remember(set, key) {
      if (!key) return
      if (set.size >= 8) set.delete(set.values().next().value)
      set.add(key)
    }

    function finish(current, message, kind) {
      if (call !== current) return
      // 撤销拨号和接听的响应可能在界面关闭后才到，收到后补发结束信令。
      if (current.phase === 'inviting') remember(discardedInvites, current.requestId)
      if (current.phase === 'accepting') remember(discardedAccepts, current.id)
      call = null
      clearTimeout(current.deadline)
      clearTimeout(current.mediaTimer)
      clearTimeout(current.reconnectTimer)
      clearInterval(current.monitor)
      if (current.pc) current.pc.close()
      stopTracks(current.local)
      ui.local.srcObject = null
      ui.remote.srcObject = null
      render()
      if (message) options.notice(message, kind)
    }

    function endCurrent(message) {
      const current = call
      if (!current) return
      if (current.id) {
        const action = current.phase === 'incoming' || current.phase === 'accepting' ? 'reject'
          : current.phase === 'outgoing' ? 'cancel' : 'hangup'
        send(action, { callId: current.id })
      }
      finish(current, message)
    }

    function deadline(current, expiresAt, message, limit) {
      clearTimeout(current.deadline)
      const delay = Math.max(1000, Math.min(limit, expiresAt - Date.now() + 1000))
      current.deadline = setTimeout(() => {
        if (call === current) endCurrent(message)
      }, delay)
    }

    async function capture(current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true, video: { facingMode: { ideal: 'user' } },
        })
        if (call !== current) {
          stopTracks(stream)
          return null
        }
        current.local = stream
        current.facing = stream.getVideoTracks()[0]?.getSettings().facingMode ?? 'user'
        ui.local.srcObject = stream
        render()
        navigator.mediaDevices.enumerateDevices?.().then((devices) => {
          if (call !== current) return
          current.canSwitchCamera = devices.filter((device) => device.kind === 'videoinput').length > 1
          render()
        }).catch(() => {})
        return stream
      } catch (error) {
        current.captureError = captureError(error)
        return null
      }
    }

    async function invite(member) {
      if (!available) return
      if (call) return options.notice('请先结束当前通话')
      const current = state({ userId: member.id, username: member.username }, 'preparing')
      call = current
      render()
      current.media = capture(current)
      const stream = await current.media
      if (call !== current) return
      if (!stream) return finish(current, current.captureError, 'error')
      current.requestId = crypto.randomUUID()
      current.phase = 'inviting'
      if (!send('invite', { userId: member.id, requestId: current.requestId })) {
        return finish(current, '连接已断开，请稍后重拨', 'error')
      }
      deadline(current, Date.now() + 8000, '呼叫未得到响应，请重试', 9000)
      render()
    }

    function accept() {
      const current = call
      if (!current || current.phase !== 'incoming') return
      current.phase = 'accepting'
      if (!send('accept', { callId: current.id })) return finish(current, endText.disconnected)
      current.media = capture(current)
      render()
    }

    function failMedia(current, text, reason = 'media-error') {
      if (call !== current) return
      send('hangup', { callId: current.id, reason })
      finish(current, text, 'error')
    }

    function playRemote(current) {
      if (call !== current) return
      ui.remote.play().then(() => {
        if (call === current) ui.play.hidden = true
      }).catch(() => {
        if (call === current) ui.play.hidden = false
      })
    }

    function reportConnected(current) {
      if (call !== current || current.pc.connectionState !== 'connected' ||
          !current.descriptionSent || current.connectedSent) return
      current.connectedSent = send('connected', { callId: current.id })
    }

    function connectionChanged(current) {
      if (call !== current) return
      const status = current.pc.connectionState
      if (status === 'connected') {
        clearTimeout(current.mediaTimer)
        current.mediaTimer = undefined
        current.mediaInterrupted = false
        reportConnected(current)
        render()
      } else if (status === 'failed') {
        failMedia(current, endText['media-error'])
      } else if (status === 'disconnected' && current.mediaTimer === undefined) {
        current.mediaInterrupted = true
        render()
        current.mediaTimer = setTimeout(() => failMedia(current, endText['media-error']), 10_000)
      }
    }

    async function connectMedia(current) {
      try {
        const stream = await current.media
        if (call !== current) return
        if (!stream) return failMedia(current, current.captureError, 'device-error')
        const response = await options.api('/api/calls/ice-servers', {
          method: 'POST',
          body: { room: options.room, callId: current.id, resumeToken: current.resumeToken }
        })
        if (call !== current) return
        const config = await response.json().catch(() => ({}))
        if (call !== current) return
        if (!response.ok || !Array.isArray(config.iceServers)) {
          return failMedia(current, config.error || '无法获取音视频连接配置')
        }
        const pc = new RTCPeerConnection({ iceServers: config.iceServers })
        current.pc = pc
        const remote = new MediaStream()
        ui.remote.srcObject = remote
        pc.ontrack = (event) => {
          if (call !== current) return
          remote.addTrack(event.track)
          playRemote(current)
        }
        pc.onicecandidate = (event) => {
          if (call === current && event.candidate?.candidate) {
            send('ice', { callId: current.id, candidate: event.candidate.toJSON() }, 'webrtc')
          }
        }
        pc.onconnectionstatechange = () => connectionChanged(current)
        for (const track of stream.getTracks()) {
          const sender = pc.addTrack(track, stream)
          if (track.kind === 'video') current.videoSender = sender
        }
        if (!send('media-ready', { callId: current.id })) {
          return failMedia(current, endText.disconnected)
        }
        render()
      } catch {
        failMedia(current, '无法建立音视频连接，请重试')
      }
    }

    function queueSignal(current, operation) {
      current.signalQueue = current.signalQueue.then(async () => {
        if (call === current) await operation()
      }).catch(() => failMedia(current, endText['media-error']))
    }

    async function localDescription(current, action) {
      const pc = current.pc
      const description = action === 'offer' ? await pc.createOffer() : await pc.createAnswer()
      if (call !== current) return
      await pc.setLocalDescription(description)
      if (call !== current) return
      if (!send(action, { callId: current.id, sdp: pc.localDescription.sdp }, 'webrtc')) {
        throw new Error('signaling unavailable')
      }
      current.descriptionSent = true
      reportConnected(current)
    }

    function remoteSignal(current, event) {
      if (!current.pc) return
      queueSignal(current, async () => {
        const pc = current.pc
        if (event.action === 'ice') {
          if (pc.remoteDescription) await pc.addIceCandidate(event.candidate)
          else if (current.earlyIce.length < 96) current.earlyIce.push(event.candidate)
          return
        }
        await pc.setRemoteDescription({ type: event.action, sdp: event.sdp })
        for (const candidate of current.earlyIce.splice(0)) {
          if (call !== current) return
          await pc.addIceCandidate(candidate)
        }
        if (call === current && event.action === 'offer') await localDescription(current, 'answer')
      })
    }

    function status(event) {
      if (!call || event.callId !== call.id) return
      call.lastStatus = Date.now()
      call.peerReconnecting = event.peerReconnecting
      if (event.action === 'resumed') {
        call.localReconnecting = false
        clearTimeout(call.reconnectTimer)
      }
      render()
    }

    function check() {
      const current = call
      if (!current || current.phase !== 'active' || current.localReconnecting) return
      const now = Date.now()
      if (now - current.lastStatus > 12_000 || !send('check', { callId: current.id })) {
        options.reconnect()
        return
      }
      if (accessExpiresAt > 0 && accessExpiresAt - now < 60_000 && now >= current.renewAfter) {
        current.renewAfter = now + 10_000
        options.renew({ type: 'call', action: 'resume', callId: current.id, resumeToken: current.resumeToken })
      }
    }

    function disconnected() {
      setAvailable(false)
      accessExpiresAt = 0
      const current = call
      if (!current) return
      if (current.phase !== 'active') return finish(current, '连接已断开，请重拨')
      if (current.localReconnecting) return
      current.localReconnecting = true
      current.reconnectTimer = setTimeout(() => finish(current, '重连超时，通话已结束'), 15_000)
      render()
    }

    function ready(event) {
      accessExpiresAt = event.accessExpiresAt || 0
      setAvailable(false)
      if (event.videoCalls) send('hello')
      else if (call) finish(call, endText.disabled)
    }

    function handle(event) {
      const current = call
      if (event.type === 'webrtc') {
        if (current && event.callId === current.id) remoteSignal(current, event)
        return
      }
      if (event.action === 'available') {
        setAvailable(true)
        if (current?.localReconnecting) {
          send('resume', { callId: current.id, resumeToken: current.resumeToken })
        }
        return
      }
      if (event.action === 'incoming') {
        // 同时拨号时以服务端已建立的来电为准。
        if (current?.id) return
        if (current) finish(current)
        call = state(event.peer, 'incoming', event.callId)
        deadline(call, event.expiresAt, endText['no-answer'], 31_000)
        render()
        return
      }
      if (event.action === 'invited') {
        if (discardedInvites.delete(event.requestId)) {
          send('cancel', { callId: event.callId })
        } else if (current?.phase === 'inviting' && current.requestId === event.requestId) {
          current.id = event.callId
          current.phase = 'outgoing'
          deadline(current, event.expiresAt, endText['no-answer'], 31_000)
          render()
        }
        return
      }
      if (event.action === 'accepted' && discardedAccepts.delete(event.callId)) {
        send('hangup', { callId: event.callId })
        return
      }
      if (event.action === 'error') {
        if (current?.phase === 'inviting' && current.requestId === event.requestId ||
            current?.id && current.id === event.callId) {
          if (event.code === 'invalid-state' && current.phase === 'active') return
          finish(current, errorText[event.code] || '通话请求失败，请重试', 'error')
        }
        return
      }
      if (!current || current.id !== event.callId) return
      switch (event.action) {
        case 'accepted':
          current.phase = 'connecting'
          current.role = event.role
          current.resumeToken = event.resumeToken
          deadline(current, event.expiresAt, endText['connection-timeout'], 46_000)
          render()
          connectMedia(current)
          break
        case 'negotiate':
          if (current.role === 'caller') queueSignal(current, () => localDescription(current, 'offer'))
          break
        case 'active':
          current.phase = 'active'
          current.lastStatus = Date.now()
          clearTimeout(current.deadline)
          clearInterval(current.monitor)
          current.monitor = setInterval(check, 5000)
          render()
          break
        case 'status':
        case 'resumed':
          status(event)
          break
        case 'ended':
          finish(current, endText[event.reason] || endText.hangup)
          break
      }
    }

    async function camera(switching) {
      const current = call
      if (!current?.videoSender || current.changingCamera) return
      current.changingCamera = true
      let replacement = null
      try {
        const track = current.local.getVideoTracks()[0]
        if (track) {
          current.local.removeTrack(track)
          track.stop()
          await current.videoSender.replaceTrack(null)
        }
        if (call !== current || (track && !switching)) return
        const facing = switching ? (current.facing === 'environment' ? 'user' : 'environment') : current.facing
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false, video: { facingMode: switching ? { exact: facing } : { ideal: facing } },
        })
        replacement = stream.getVideoTracks()[0]
        if (!replacement) return
        if (call !== current) return
        await current.videoSender.replaceTrack(replacement)
        if (call === current) {
          current.local.addTrack(replacement)
          current.facing = replacement.getSettings().facingMode ?? facing
          replacement = null
        }
      } catch {
        if (call === current) options.notice(switching ? '无法切换摄像头' : '无法开启摄像头', 'error')
      } finally {
        replacement?.stop()
        current.changingCamera = false
        if (call === current) render()
      }
    }

    ui.accept.addEventListener('click', accept)
    ui.reject.addEventListener('click', () => endCurrent('已拒绝通话'))
    ui.hangup.addEventListener('click', () => {
      endCurrent(call?.phase === 'active' || call?.pc ? '通话已结束' : '已取消呼叫')
    })
    ui.mic.addEventListener('click', () => {
      const tracks = call?.local?.getAudioTracks() || []
      tracks.forEach((track) => { track.enabled = !track.enabled })
      render()
    })
    ui.camera.addEventListener('click', () => camera(false))
    ui.switchCamera.addEventListener('click', () => camera(true))
    ui.play.addEventListener('click', () => playRemote(call))

    return {
      canInvite: () => available,
      owns: (callId) => call?.phase === 'active' && call.id === callId,
      invite, ready, handle, disconnected, check,
      addMessage: layout.addMessage,
      removeMessage: layout.removeMessage,
      clearMessages: layout.clearMessages,
      replaced: (readyEvent, resumeEvent) => {
        accessExpiresAt = readyEvent.accessExpiresAt || 0
        setAvailable(true)
        status(resumeEvent)
      },
      leave: () => {
        endCurrent()
        setAvailable(false)
        accessExpiresAt = 0
        discardedInvites.clear()
        discardedAccepts.clear()
      }
    }
  }
})()
