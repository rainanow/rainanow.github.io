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
    ended: endText.hangup,
    'invalid-state': '这条邀请已有人加入或已结束',
  }

  const resolutions = new Map([['1080p', 1080], ['720p', 720], ['480p', 480]])
  const aspectRatios = new Map([['16:9', 16 / 9], ['4:3', 4 / 3]])
  const defaultQuality = { resolution: '720p', ratio: '16:9' }
  const minBitrateMbps = 1
  const maxBitrateMbps = 5
  const defaultBitrateMbps = 2
  const foregroundDelay = 900
  const cameraRetryDelay = 400

  function cameraConstraints(current) {
    const height = resolutions.get(current.quality.resolution)
    const ratio = aspectRatios.get(current.quality.ratio)
    // Request even landscape dimensions. The camera can report them rotated.
    const constraints = {
      facingMode: { ideal: current.facing },
      width: { ideal: Math.round(height * ratio / 2) * 2 },
      height: { ideal: height },
      aspectRatio: { ideal: ratio },
    }
    if (navigator.mediaDevices.getSupportedConstraints?.()?.resizeMode) {
      constraints.resizeMode = { ideal: 'crop-and-scale' }
    }
    return constraints
  }

  function supportsBitrate(sender) {
    return typeof sender?.getParameters === 'function' && typeof sender.setParameters === 'function'
  }

  async function applyBitrate(sender, mbps) {
    try {
      const parameters = sender.getParameters()
      const encoding = parameters.encodings?.[0]
      if (!encoding) return false
      const maxBitrate = mbps * 1_000_000
      encoding.maxBitrate = maxBitrate
      await sender.setParameters(parameters)
      return sender.getParameters().encodings?.[0]?.maxBitrate === maxBitrate
    } catch {
      return false
    }
  }

  function videoFrames(video) {
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames
    return Number.isFinite(frames) ? frames : null
  }

  function videoStalled(video, track, frames) {
    return track.readyState !== 'live' || track.muted || frames === null || videoFrames(video) <= frames
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
    const qualityOptions = panel.querySelectorAll('[data-call-resolution], [data-call-ratio]')
    const ui = {
      peer: control('peer'), status: control('status'), stage: control('stage'),
      local: control('local'), remote: control('remote'), accept: control('accept'),
      hangup: control('hangup'), mic: control('mic'), camera: control('camera'),
      main: control('main'), playHint: control('play-hint'),
      bitrate: control('bitrate'),
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

    function state(peer, phase, id = null, publicInvite = false) {
      return {
        peer, phase, id, publicInvite, signalQueue: Promise.resolve(), earlyIce: [],
        facing: 'user', lastStatus: Date.now(), renewAfter: 0,
        cameraEnabled: true, quality: defaultQuality,
      }
    }

    function setPlaybackBlocked(blocked) {
      ui.playHint.hidden = !blocked
      ui.main.setAttribute('aria-label', blocked ? '播放通话并显示控制' : '显示通话控制')
    }

    function render() {
      panel.hidden = call === null
      if (call === null) {
        delete panel.dataset.phase
        ui.stage.hidden = true
        ui.local.hidden = true
        ui.remote.hidden = true
        setPlaybackBlocked(false)
        layout.reset()
        return
      }
      panel.dataset.phase = call.phase
      ui.peer.textContent = call.peer?.username ?? '视频邀请'
      const labels = {
        preparing: '正在打开摄像头和麦克风…',
        inviting: call.publicInvite ? '正在发送视频邀请…' : '正在发起呼叫…',
        outgoing: call.publicInvite ? '等待房间成员加入…' : '正在等待对方接听…',
        incoming: '视频来电',
        accepting: '正在接听…',
        joining: '正在加入通话…',
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
      const hangupLabel = call.phase === 'incoming' ? '拒绝通话' : inMedia ? '挂断' : '取消呼叫'
      ui.hangup.hidden = false
      ui.hangup.title = hangupLabel
      ui.hangup.setAttribute('aria-label', hangupLabel)
      ui.mic.hidden = !inMedia
      ui.mic.title = audioOn ? '静音' : '取消静音'
      ui.mic.setAttribute('aria-pressed', String(!audioOn))
      ui.camera.hidden = !inMedia
      ui.camera.disabled = !!call.changingCamera
      ui.camera.title = videoOn ? '关闭摄像头' : '开启摄像头'
      ui.camera.setAttribute('aria-pressed', String(!videoOn))
      renderQuality(call)
      layout.update(inMedia, call.phase === 'active')
    }

    function renderQuality(current) {
      for (const button of qualityOptions) {
        const { callResolution, callRatio } = button.dataset
        const selected = callResolution === current.quality.resolution || callRatio === current.quality.ratio
        button.setAttribute('aria-pressed', String(selected))
        button.setAttribute('aria-disabled', String(!!current.changingCamera))
      }
      renderBitrate(current)
    }

    function renderBitrate(current) {
      const mbps = current.bitrateMbps
      const value = mbps === undefined ? '—' : `${mbps}M`
      if (ui.bitrate.textContent !== value) {
        ui.bitrate.textContent = value
        ui.bitrate.setAttribute('aria-label', mbps === undefined ? '切换视频发送码率上限'
          : `视频发送码率上限 ${mbps} Mbps，点按切换`)
      }
      const disabled = !supportsBitrate(current.videoSender) || !!current.bitrateUpdate || !!current.changingCamera
      ui.bitrate.setAttribute('aria-disabled', String(disabled))
    }

    async function setBitrate(current, mbps, manual = false) {
      if (current.bitrateUpdate || !supportsBitrate(current.videoSender)) return
      current.bitrateUpdate = applyBitrate(current.videoSender, mbps)
      renderBitrate(current)
      const applied = await current.bitrateUpdate
      current.bitrateUpdate = null
      if (call !== current) return
      if (applied) current.bitrateMbps = mbps
      else if (manual) options.notice('无法调整视频发送码率', 'error')
      renderBitrate(current)
    }

    function cycleBitrate() {
      const current = call
      if (current?.phase !== 'active' || current.changingCamera) return
      const mbps = current.bitrateMbps ?? (defaultBitrateMbps - 1)
      const next = mbps === maxBitrateMbps ? minBitrateMbps : mbps + 1
      void setBitrate(current, next, true)
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
      if (current.phase === 'accepting' || current.phase === 'joining') remember(discardedAccepts, current.id)
      call = null
      clearTimeout(current.deadline)
      clearTimeout(current.mediaTimer)
      clearTimeout(current.reconnectTimer)
      clearTimeout(current.foregroundTimer)
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
      if (current.id && current.phase !== 'joining') {
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
          audio: true, video: cameraConstraints(current),
        })
        if (call !== current) {
          stopTracks(stream)
          return null
        }
        current.local = stream
        current.facing = stream.getVideoTracks()[0]?.getSettings?.()?.facingMode ?? current.facing
        ui.local.srcObject = stream
        render()
        return stream
      } catch (error) {
        current.captureError = captureError(error)
        return null
      }
    }

    function beginCall(peer, phase, id, publicInvite) {
      if (!available) return null
      if (call) {
        options.notice('请先结束当前通话')
        return null
      }
      const current = state(peer, phase, id, publicInvite)
      options.notice('')
      call = current
      render()
      return current
    }

    function sendInvite(current, action, fields = {}) {
      current.requestId = crypto.randomUUID()
      current.phase = 'inviting'
      if (!send(action, { ...fields, requestId: current.requestId })) {
        return finish(current, '连接已断开，请稍后重拨', 'error')
      }
      deadline(current, Date.now() + 8000, '呼叫未得到响应，请重试', 9000)
      render()
    }

    async function invite(member) {
      const current = beginCall({ userId: member.id, username: member.username }, 'preparing')
      if (!current) return
      current.media = capture(current)
      const stream = await current.media
      if (call !== current) return
      if (!stream) return finish(current, current.captureError, 'error')
      sendInvite(current, 'invite', { userId: member.id })
    }

    function inviteRoom() {
      const current = beginCall(null, 'inviting', null, true)
      if (current) sendInvite(current, 'invite-room')
    }

    function joinRoomCall(card) {
      if (!card?.publicInvite || card.phase !== 'ringing') return
      const current = beginCall(card.caller, 'joining', card.callId, true)
      if (!current) return
      if (!send('join', { callId: current.id })) return finish(current, endText.disconnected, 'error')
      deadline(current, Date.now() + 8000, '加入通话未得到响应，请重试', 9000)
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

    async function playLocal(current) {
      if (call !== current || !current.cameraEnabled) return
      try { await ui.local.play() } catch { /* The preview might still be waiting for video. */ }
    }

    async function playRemote(current) {
      if (!current?.pc || call !== current) return
      const attempt = (current.playAttempt ?? 0) + 1
      current.playAttempt = attempt
      try {
        await ui.remote.play()
        if (call === current && current.playAttempt === attempt) setPlaybackBlocked(false)
      } catch {
        if (call === current && current.playAttempt === attempt) setPlaybackBlocked(true)
      }
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
        if (document.visibilityState === 'hidden') return
        current.mediaTimer = setTimeout(() => {
          current.mediaTimer = undefined
          if (document.visibilityState !== 'hidden' && current.pc.connectionState === 'disconnected') {
            failMedia(current, endText['media-error'])
          }
        }, 10_000)
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

    function foreground() {
      check()
      const current = call
      if (current?.phase !== 'active' || document.visibilityState === 'hidden') return
      if (current.pc.connectionState === 'disconnected') {
        clearTimeout(current.mediaTimer)
        current.mediaTimer = undefined
        connectionChanged(current)
      }
      const localTrack = current.local.getVideoTracks()[0]
      const remoteStream = ui.remote.srcObject
      const remoteTrack = remoteStream?.getVideoTracks()[0]
      const localFrames = videoFrames(ui.local)
      const remoteFrames = videoFrames(ui.remote)
      void playLocal(current)
      void playRemote(current)

      // Some WebViews resume playback without unfreezing the camera. Wait for frames
      // before replacing the sender's video track, and leave the audio track untouched.
      clearTimeout(current.foregroundTimer)
      current.foregroundTimer = setTimeout(() => {
        if (call !== current || document.visibilityState === 'hidden') return
        if (remoteTrack?.readyState === 'live' && ui.remote.srcObject === remoteStream &&
            videoStalled(ui.remote, remoteTrack, remoteFrames)) {
          ui.remote.srcObject = null
          ui.remote.srcObject = remoteStream
          void playRemote(current)
        }
        if (current.cameraEnabled && current.local.getVideoTracks()[0] === localTrack &&
            (!localTrack || videoStalled(ui.local, localTrack, localFrames))) {
          void changeCamera(current, true, true)
        }
      }, foregroundDelay)
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
        options.notice('')
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
          deadline(current, event.expiresAt, current.publicInvite ? '视频邀请已过期' : endText['no-answer'], 31_000)
          render()
        }
        return
      }
      if (event.action === 'accepted' && discardedAccepts.delete(event.callId) && current?.id !== event.callId) {
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
          if (current.phase === 'connecting' || current.phase === 'active') break
          if (event.peer) current.peer = event.peer
          current.phase = 'connecting'
          current.role = event.role
          current.resumeToken = event.resumeToken
          deadline(current, event.expiresAt, endText['connection-timeout'], 46_000)
          current.media ??= capture(current)
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
          // Some browsers expose a writable encoding only after offer/answer.
          if (current.bitrateMbps === undefined) void setBitrate(current, defaultBitrateMbps)
          break
        case 'status':
        case 'resumed':
          status(event)
          break
        case 'ended':
          finish(current, current.publicInvite && event.reason === 'no-answer' ? '视频邀请已过期'
            : endText[event.reason] || endText.hangup)
          break
      }
    }

    async function captureVideo(current, recovering) {
      if (recovering && document.visibilityState === 'hidden') return null
      const constraints = { audio: false, video: cameraConstraints(current) }
      try {
        return await navigator.mediaDevices.getUserMedia(constraints)
      } catch (error) {
        if (!recovering || error?.name !== 'NotReadableError') throw error
        // Android can still hold the old camera briefly after the tab becomes visible.
        await new Promise((resolve) => setTimeout(resolve, cameraRetryDelay))
        if (call !== current || document.visibilityState === 'hidden') return null
        return navigator.mediaDevices.getUserMedia(constraints)
      }
    }

    async function changeCamera(current, enabled, recovering = false) {
      if (call !== current || !current?.videoSender || current.changingCamera) return
      current.changingCamera = true
      current.cameraEnabled = enabled
      render()
      const track = current.local.getVideoTracks()[0]
      let replacement = null
      try {
        if (current.bitrateUpdate) await current.bitrateUpdate
        if (call !== current) return
        if (track) {
          current.local.removeTrack(track)
          track.stop()
          await current.videoSender.replaceTrack(null)
        }
        if (!enabled || call !== current) return
        const stream = await captureVideo(current, recovering)
        if (!stream) return
        replacement = stream.getVideoTracks()[0]
        if (!replacement) throw new Error('Missing camera track')
        if (call !== current || (recovering && document.visibilityState === 'hidden')) return
        await current.videoSender.replaceTrack(replacement)
        if (call !== current) return
        current.local.addTrack(replacement)
        current.facing = replacement.getSettings?.()?.facingMode ?? current.facing
        replacement = null
        ui.local.srcObject = null
        ui.local.srcObject = current.local
        void playLocal(current)
      } catch {
        current.cameraEnabled = false
        if (call === current) {
          const failure = recovering ? '无法恢复摄像头，请重新开启' : enabled ? '无法开启摄像头' : '无法关闭摄像头'
          options.notice(failure, 'error')
        }
      } finally {
        replacement?.stop()
        current.changingCamera = false
        if (call === current) render()
      }
    }

    function toggleCamera() {
      const current = call
      if (!current?.videoSender || current.changingCamera) return
      const enabled = !current.local.getVideoTracks().some((track) => track.readyState === 'live')
      void changeCamera(current, enabled)
    }

    async function changeQuality(event) {
      const current = call
      if (current?.phase !== 'active' || current.changingCamera) return
      const previous = current.quality
      const { callResolution, callRatio } = event.currentTarget.dataset
      const next = { resolution: callResolution ?? previous.resolution, ratio: callRatio ?? previous.ratio }
      if (!resolutions.has(next.resolution) || !aspectRatios.has(next.ratio)) return
      if (next.resolution === previous.resolution && next.ratio === previous.ratio) return

      current.quality = next
      const track = current.local.getVideoTracks()[0]
      if (!current.cameraEnabled || track?.readyState !== 'live') return renderQuality(current)

      current.changingCamera = true
      render()
      try {
        await track.applyConstraints(cameraConstraints(current))
      } catch {
        current.quality = previous
      } finally {
        current.changingCamera = false
        if (call === current) render()
      }
    }

    ui.accept.addEventListener('click', accept)
    ui.hangup.addEventListener('click', () => {
      if (!call) return
      const message = call.phase === 'incoming' ? '已拒绝通话' : call.pc ? '通话已结束' : '已取消呼叫'
      endCurrent(message)
    })
    ui.mic.addEventListener('click', () => {
      const tracks = call?.local?.getAudioTracks() || []
      tracks.forEach((track) => { track.enabled = !track.enabled })
      render()
    })
    ui.camera.addEventListener('click', toggleCamera)
    for (const button of qualityOptions) button.addEventListener('click', changeQuality)
    ui.bitrate.addEventListener('click', cycleBitrate)
    ui.main.addEventListener('click', () => {
      if (!ui.playHint.hidden) playRemote(call)
    })

    return {
      canInvite: () => available,
      owns: (callId) => call?.phase === 'active' && call.id === callId,
      invite, inviteRoom, joinRoomCall, ready, handle, disconnected, check, foreground,
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
