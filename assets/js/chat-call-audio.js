;(function () {
  'use strict'

  function deviceOptions(devices, kind, fallbackLabel) {
    const options = new Map()
    for (const { kind: deviceKind, deviceId, label } of devices) {
      if (deviceKind === kind && deviceId && deviceId !== 'default' && !options.has(deviceId)) {
        options.set(deviceId, { deviceId, label: label || `${fallbackLabel} ${options.size + 1}` })
      }
    }
    return [...options.values()]
  }

  function renderSelect(select, devices, selected, missingLabel) {
    const options = [{ deviceId: '', label: '系统默认' }, ...devices]
    if (selected && !devices.some(({ deviceId }) => deviceId === selected)) {
      options.push({ deviceId: selected, label: missingLabel })
    }
    // Keep the native picker stable when a device refresh returns the same list.
    if (select.options.length !== options.length || options.some(({ deviceId, label }, index) =>
      select.options[index].value !== deviceId || select.options[index].text !== label)) {
      select.replaceChildren(...options.map(({ deviceId, label }) => new Option(label, deviceId)))
    }
    if (select.value !== selected) select.value = selected
  }

  window.createYuloCallAudio = function (panel, { notice, replayRemote }) {
    const control = (name) => panel.querySelector('[data-call-' + name + ']')
    const ui = {
      mic: control('mic'), micToggle: control('mic-toggle'), remote: control('remote'),
      playbackToggle: control('playback-toggle'), input: control('audio-input'),
      output: control('audio-output'), refresh: control('audio-refresh'),
      outputPicker: control('audio-output-picker'), outputHint: control('audio-output-hint'),
    }
    const devices = navigator.mediaDevices
    const canEnumerate = typeof devices.enumerateDevices === 'function'
    const canSetOutput = typeof ui.remote.setSinkId === 'function'
    const canPickOutput = canSetOutput && typeof devices.selectAudioOutput === 'function'
    let current = null
    let changingOutput = false

    function sinkId() {
      return ui.remote.sinkId === 'default' ? '' : ui.remote.sinkId ?? ''
    }

    function missingOutput(state) {
      const selected = sinkId()
      return state.hasDeviceList && !!selected && !state.outputs.some(({ deviceId }) => deviceId === selected)
    }

    function renderToggles(state) {
      const muted = state.inputMuted
      const label = muted ? '音频设置（麦克风已静音）' : '音频设置'
      ui.mic.toggleAttribute('data-media-off', muted)
      ui.mic.title = `${label}，长按或右键切换麦克风`
      ui.mic.setAttribute('aria-label', label)
      ui.micToggle.disabled = !state.sender
      ui.micToggle.toggleAttribute('data-media-off', muted)
      ui.micToggle.setAttribute('aria-pressed', String(muted))
      ui.playbackToggle.toggleAttribute('data-media-off', ui.remote.muted)
      ui.playbackToggle.setAttribute('aria-pressed', String(ui.remote.muted))
    }

    function renderDevices(state) {
      renderSelect(ui.input, state.inputs, state.inputId, '已选麦克风不可用')
      ui.input.disabled = !state.sender || state.changingInput || (!state.inputs.length && !state.inputId)
      const selected = sinkId()
      const unavailable = missingOutput(state)
      renderSelect(ui.output, state.outputs, selected, unavailable ? '已选输出不可用' : '当前输出设备')
      ui.output.disabled = !canSetOutput || changingOutput || (!state.outputs.length && !selected)
      ui.outputPicker.disabled = changingOutput
      const systemRouting = !canSetOutput || (!selected && !state.outputs.length && !canPickOutput)
      const hint = unavailable ? '已选输出不可用，请选择系统默认或其他设备' :
        systemRouting ? '请在系统音频设置切换输出设备' : ''
      if (ui.outputHint.textContent !== hint) ui.outputHint.textContent = hint
      ui.outputHint.hidden = !hint
    }

    function toggleMic() {
      const state = current
      if (!state?.sender) return
      state.inputMuted = !state.inputMuted
      if (state.track) state.track.enabled = !state.inputMuted
      if (state.pendingTrack) state.pendingTrack.enabled = !state.inputMuted
      renderToggles(state)
    }

    async function changeInput(state, deviceId, recovering = false) {
      if (!state?.sender || state.changingInput ||
          (deviceId === state.inputId && state.track?.readyState === 'live')) return
      state.changingInput = true
      renderDevices(state)
      const previous = state.track
      let replaced = false
      try {
        const constraints = deviceId ? { deviceId: { exact: deviceId } } : {}
        const channels = previous?.getSettings?.()?.channelCount
        if (channels > 0) constraints.channelCount = { ideal: channels }
        const stream = await devices.getUserMedia({
          audio: Object.keys(constraints).length ? constraints : true,
          video: false,
        })
        const replacement = stream.getAudioTracks()[0]
        for (const track of stream.getTracks()) {
          if (current !== state || track !== replacement) track.stop()
        }
        if (current !== state) return
        state.pendingTrack = replacement
        if (replacement?.readyState !== 'live') throw new Error('Missing live microphone track')
        replacement.enabled = !state.inputMuted
        await state.sender.replaceTrack(replacement)
        if (current !== state) return
        if (replacement.readyState !== 'live') {
          await state.sender.replaceTrack(previous ?? null)
          throw new Error('Microphone disconnected during selection')
        }

        state.stream.addTrack(replacement)
        state.track = replacement
        state.inputId = deviceId
        state.pendingTrack = null
        replacement.addEventListener?.('ended', refresh)
        if (previous) {
          previous.removeEventListener?.('ended', refresh)
          state.stream.removeTrack(previous)
          previous.stop()
        }
        replaced = true
      } catch {
        if (current === state) notice(recovering ? '无法恢复默认麦克风，请重新选择输入设备' : '无法切换麦克风', 'error')
      } finally {
        state.pendingTrack?.stop()
        state.pendingTrack = null
        state.changingInput = false
        if (current === state) {
          renderDevices(state)
          // A devicechange event may have arrived while the selector was busy.
          if (replaced || !recovering) void refresh()
        }
      }
    }

    async function changeOutput(deviceId, mode = 'select') {
      const state = current
      if (!state || changingOutput || !canSetOutput) return
      let chosen
      changingOutput = true
      renderDevices(state)
      try {
        if (mode === 'picker') {
          chosen = await devices.selectAudioOutput()
          if (current !== state) return
          deviceId = chosen.deviceId
        }
        await ui.remote.setSinkId(deviceId === 'default' ? '' : deviceId)
        if (current !== state || mode === 'recover') return
        if (chosen?.deviceId && chosen.deviceId !== 'default' &&
            !state.outputs.some(({ deviceId }) => deviceId === chosen.deviceId)) {
          state.outputs.push({ deviceId: chosen.deviceId, label: chosen.label || '已选输出设备' })
        }
        replayRemote()
        void refresh()
      } catch (error) {
        // NotAllowedError from the native picker also covers dismissal.
        if (current === state && mode !== 'recover' && !(mode === 'picker' && !chosen && error?.name === 'NotAllowedError')) {
          notice('无法切换音频输出', 'error')
        }
      } finally {
        changingOutput = false
        if (current) renderDevices(current)
      }
    }

    async function refresh() {
      const state = current
      if (!state || panel.ownerDocument.visibilityState === 'hidden') return
      const revision = ++state.deviceRevision
      let available
      if (canEnumerate) {
        try { available = await devices.enumerateDevices() } catch { /* Keep the last known list. */ }
      }
      if (current !== state || revision !== state.deviceRevision) return
      if (available) {
        state.hasDeviceList = true
        state.inputs = deviceOptions(available, 'audioinput', '麦克风')
        state.outputs = canSetOutput ? deviceOptions(available, 'audiooutput', '输出设备') : []
      }
      renderDevices(state)

      const missingInput = state.hasDeviceList && state.inputId &&
        !state.inputs.some(({ deviceId }) => deviceId === state.inputId)
      if (state.track && !state.changingInput && state.fallbackTrack !== state.track &&
          (missingInput || state.track.readyState === 'ended')) {
        state.fallbackTrack = state.track
        void changeInput(state, '', true)
      }
      if (missingOutput(state)) void changeOutput('', 'recover')
    }

    function devicesChanged() {
      if (current) current.fallbackTrack = null
      void refresh()
    }

    function stop() {
      const state = current
      if (!state) return
      current = null
      devices.removeEventListener?.('devicechange', devicesChanged)
      state.track?.removeEventListener?.('ended', refresh)
      state.pendingTrack?.stop()
      state.pendingTrack = null
    }

    function start(stream, sender) {
      stop()
      const track = sender?.track
      const state = {
        stream, sender, track, inputId: '', inputMuted: track?.enabled === false,
        inputs: [], outputs: [], deviceRevision: 0, hasDeviceList: false,
      }
      current = state
      ui.remote.muted = false
      track?.addEventListener?.('ended', refresh)
      devices.addEventListener?.('devicechange', devicesChanged)
      renderToggles(state)
      renderDevices(state)
      void refresh()
    }

    ui.refresh.disabled = !canEnumerate
    ui.outputPicker.hidden = !canPickOutput
    ui.refresh.addEventListener('click', devicesChanged)
    ui.input.addEventListener('change', () => { void changeInput(current, ui.input.value) })
    ui.output.addEventListener('change', () => { void changeOutput(ui.output.value) })
    ui.outputPicker.addEventListener('click', () => { void changeOutput('', 'picker') })
    ui.micToggle.addEventListener('click', toggleMic)
    ui.playbackToggle.addEventListener('click', () => {
      if (!current) return
      ui.remote.muted = !ui.remote.muted
      renderToggles(current)
      replayRemote()
    })

    return { start, stop, refresh, toggleMic }
  }
})()
