/*
 * 聊天室前端。
 *
 * 设计约束（都是刻意的）：
 *  1. **不存任何 token。** access / refresh token 只存在于 HttpOnly Cookie 里，
 *     JS 一个字节都读不到，所以 XSS 也偷不走登录态。代价是所有请求都要
 *     `credentials: 'include'`，并且依赖 api.yulo.top 与站点同属 yulo.top（同站 Cookie）。
 *  2. **渲染只用 textContent。** 消息内容永远走 textContent / createElement，
 *     绝不用 innerHTML，从结构上堵死 XSS——不需要自己写转义函数再担心漏掉某处。
 *  3. **access token 过期不弹窗。** 任何请求拿到 401 就静默 /auth/refresh 一次再重试，
 *     刷新失败才退回登录面板。WebSocket 重连前也会先刷新，否则握手会一直 401。
 */
;(function () {
  'use strict'

  // 同一页面被引入两次时只初始化一次。
  // 脚本现在由 chat 短代码输出，正常只出现一次；这层保护是防短代码被误用两次，
  // 或者将来有人又把这个脚本挪回 <head> 里加载——重复执行会让事件监听器绑两遍，
  // 表现为「点一次发两条」这种很难查的问题。
  if (window.__yuloChatBooted === true) return
  window.__yuloChatBooted = true

  var root = document.getElementById('chat-app')
  if (root === null) return

  var API = (root.dataset.api || '').replace(/\/+$/, '')
  var ROOM = root.dataset.room || 'general'
  var HEARTBEAT_MS = 45000

  var el = {
    status: root.querySelector('[data-chat-status]'),
    notice: root.querySelector('[data-chat-notice]'),
    auth: root.querySelector('[data-chat-auth]'),
    room: root.querySelector('[data-chat-room]'),
    messages: root.querySelector('[data-chat-messages]'),
    more: root.querySelector('[data-chat-more]'),
    empty: root.querySelector('[data-chat-empty]'),
    form: root.querySelector('[data-chat-form]'),
    username: root.querySelector('[data-chat-username]'),
    password: root.querySelector('[data-chat-password]'),
    submit: root.querySelector('[data-chat-submit]'),
    tabs: root.querySelectorAll('[data-chat-mode]'),
    hint: root.querySelector('[data-chat-hint]'),
    composer: root.querySelector('[data-chat-composer]'),
    input: root.querySelector('[data-chat-input]'),
    send: root.querySelector('[data-chat-send]'),
    me: root.querySelector('[data-chat-me]'),
    logout: root.querySelector('[data-chat-logout]')
  }

  if (API === '') {
    setStatus('未配置 API 地址（hugo.toml 里的 params.chat.apiBase）', 'offline')
    return
  }

  var me = null
  var socket = null
  var heartbeatTimer = null
  var reconnectTimer = null
  var reconnectDelay = 1000
  var refreshInFlight = null
  var mode = 'login'
  var oldestCreatedAt = null
  var hasMore = false

  // --- 小工具 ---------------------------------------------------------------

  function setStatus(text, state) {
    if (el.status === null) return
    el.status.textContent = text
    if (state) el.status.dataset.state = state
    else delete el.status.dataset.state
  }

  function notice(text, kind) {
    if (el.notice === null) return
    if (!text) {
      el.notice.hidden = true
      el.notice.textContent = ''
      return
    }
    el.notice.hidden = false
    el.notice.textContent = text
    el.notice.dataset.kind = kind || 'info'
  }

  function formatTime(ms) {
    var date = new Date(ms)
    var now = new Date()
    var clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (date.toDateString() === now.toDateString()) return clock
    return date.getMonth() + 1 + '月' + date.getDate() + '日 ' + clock
  }

  function jsonHeaders() {
    return { 'Content-Type': 'application/json' }
  }

  // --- 网络层 ---------------------------------------------------------------

  /** 单飞的 refresh：多个请求同时撞 401 时只发一次刷新。 */
  function refreshSession() {
    if (refreshInFlight === null) {
      refreshInFlight = fetch(API + '/auth/refresh', {
        method: 'POST',
        credentials: 'include'
      })
        .then(function (response) {
          return response.ok
        })
        .catch(function () {
          return false
        })
        .then(function (ok) {
          refreshInFlight = null
          return ok
        })
    }
    return refreshInFlight
  }

  /**
   * 带自动续期的请求封装。
   * 401 时先刷新再重试一次；刷新也失败就当作掉线，退回登录面板。
   */
  function api(path, options, allowRetry) {
    var init = options || {}
    init.credentials = 'include'
    return fetch(API + path, init).then(function (response) {
      if (response.status !== 401 || allowRetry === false || me === null) return response
      return refreshSession().then(function (ok) {
        if (!ok) {
          handleSignedOut()
          return response
        }
        return api(path, options, false)
      })
    })
  }

  // --- 渲染 -----------------------------------------------------------------

  function clearMessages() {
    if (el.messages === null) return
    Array.prototype.slice.call(el.messages.querySelectorAll('.chat__message')).forEach(function (node) {
      node.remove()
    })
    oldestCreatedAt = null
    hasMore = false
    updateMoreButton()
  }

  function updateMoreButton() {
    if (el.more === null) return
    el.more.hidden = !hasMore
  }

  function findByID(id) {
    if (el.messages === null) return null
    return el.messages.querySelector('.chat__message[data-id="' + id + '"]')
  }

  function renderMessage(message) {
    var article = document.createElement('article')
    article.className = 'chat__message'
    article.dataset.id = message.id
    if (me !== null && message.userId === me.id) article.classList.add('is-mine')

    var head = document.createElement('div')
    head.className = 'chat__message-head'

    var author = document.createElement('span')
    author.className = 'chat__author'
    author.textContent = message.username

    var time = document.createElement('time')
    time.className = 'chat__time'
    time.dateTime = new Date(message.createdAt).toISOString()
    time.textContent = formatTime(message.createdAt)

    head.appendChild(author)
    head.appendChild(time)

    if (me !== null && (message.userId === me.id || me.role === 'admin')) {
      var remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'chat__delete'
      remove.title = '撤回这条消息'
      remove.setAttribute('aria-label', '撤回这条消息')
      remove.textContent = '\u00d7'
      remove.addEventListener('click', function () {
        deleteMessage(message.id)
      })
      head.appendChild(remove)
    }

    var body = document.createElement('p')
    body.className = 'chat__body'
    // 关键：textContent。用户输入永远不被当成 HTML 解析。
    body.textContent = message.body

    article.appendChild(head)
    article.appendChild(body)
    return article
  }

  function sortKey(node) {
    return Number(node.dataset.createdAt || '0')
  }

  /** 按 createdAt 插入，保证「自己发的 HTTP 响应」和「WebSocket 广播」乱序到达时顺序依然正确。 */
  function insertMessage(message) {
    if (el.messages === null || findByID(message.id) !== null) return
    var node = renderMessage(message)
    node.dataset.createdAt = String(message.createdAt)

    if (oldestCreatedAt === null || message.createdAt < oldestCreatedAt) {
      oldestCreatedAt = message.createdAt
    }

    var existing = el.messages.querySelectorAll('.chat__message')
    var placed = false
    for (var i = existing.length - 1; i >= 0; i -= 1) {
      if (sortKey(existing[i]) <= message.createdAt) {
        existing[i].insertAdjacentElement('afterend', node)
        placed = true
        break
      }
    }
    if (!placed) el.messages.insertBefore(node, el.messages.firstChild)

    if (el.empty !== null) el.empty.hidden = true
  }

  function nearBottom() {
    if (el.messages === null) return true
    return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80
  }

  function scrollToBottom() {
    if (el.messages !== null) el.messages.scrollTop = el.messages.scrollHeight
  }

  // --- 业务动作 -------------------------------------------------------------

  function loadHistory(before) {
    var query = '?room=' + encodeURIComponent(ROOM)
    if (before !== null && before !== undefined) query += '&before=' + encodeURIComponent(String(before))

    return api('/api/messages' + query).then(function (response) {
      if (!response.ok) throw new Error('加载历史消息失败（' + response.status + '）')
      return response.json()
    })
  }

  function loadInitialHistory() {
    var stickToBottom = true
    return loadHistory(null).then(function (page) {
      clearMessages()
      page.messages.forEach(function (message) {
        insertMessage(message)
      })
      hasMore = page.hasMore === true
      updateMoreButton()
      if (stickToBottom) scrollToBottom()
    })
  }

  function loadOlder() {
    if (el.messages === null || !hasMore || oldestCreatedAt === null) return
    var container = el.messages
    var previousHeight = container.scrollHeight
    var previousTop = container.scrollTop
    el.more.disabled = true

    loadHistory(oldestCreatedAt)
      .then(function (page) {
        var anchor = container.querySelector('.chat__message')
        page.messages.forEach(function (message) {
          if (findByID(message.id) !== null) return
          var node = renderMessage(message)
          node.dataset.createdAt = String(message.createdAt)
          container.insertBefore(node, anchor)
        })
        hasMore = page.hasMore === true
        updateMoreButton()
        // 保持视觉位置：补进来的内容有多高，就把滚动位置往下推多少
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight)
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
      .then(function () {
        el.more.disabled = false
      })
  }

  function deleteMessage(id) {
    api('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (response) {
        if (!response.ok) throw new Error('撤回失败（' + response.status + '）')
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
  }

  function sendMessage() {
    if (el.input === null) return
    var body = el.input.value.trim()
    if (body === '') return

    el.input.value = ''
    el.send.disabled = true
    notice('')

    api('/api/messages', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ body: body, room: ROOM })
    })
      .then(function (response) {
        return response.json().catch(function () {
          return null
        }).then(function (payload) {
          if (!response.ok) throw new Error((payload && payload.error) || '发送失败（' + response.status + '）')
          return payload
        })
      })
      .then(function (payload) {
        if (payload && payload.message) {
          var shouldStick = nearBottom()
          insertMessage(payload.message)
          if (shouldStick) scrollToBottom()
        }
      })
      .catch(function (error) {
        notice(error.message, 'error')
        // 发失败就把内容还给用户，别让人白打一遍
        el.input.value = body
      })
      .then(function () {
        el.send.disabled = false
        el.input.focus()
      })
  }

  // --- WebSocket ------------------------------------------------------------

  function closeSocket() {
    if (socket !== null) {
      var closing = socket
      socket = null
      try {
        closing.close()
      } catch (error) {
        /* 已经关了 */
      }
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function handleEvent(event) {
    if (event.type === 'ready') {
      setStatus('已连接 · 在线 ' + event.online + ' 人', 'online')
      return
    }
    if (event.type === 'presence') {
      setStatus('已连接 · 在线 ' + event.online + ' 人', 'online')
      return
    }
    if (event.type === 'message') {
      var shouldStick = nearBottom()
      insertMessage(event.message)
      if (shouldStick) scrollToBottom()
      return
    }
    if (event.type === 'deleted') {
      var node = findByID(event.id)
      if (node !== null) node.remove()
    }
  }

  function scheduleReconnect() {
    if (me === null || reconnectTimer !== null) return
    var delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, 15000)

    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      if (me === null) return
      // 握手是 DO 直接拿 Cookie 校验的，access token 过期会 401。
      // 所以重连之前先换一张新的，否则会一直连不上。
      refreshSession().then(function () {
        if (me !== null) connect()
      })
    }, delay)
  }

  function connect() {
    if (me === null) return
    closeSocket()

    var url = API.replace(/^http/, 'ws') + '/api/ws?room=' + encodeURIComponent(ROOM)
    setStatus('正在连接…', 'connecting')

    var ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      setStatus('无法建立连接', 'offline')
      scheduleReconnect()
      return
    }
    socket = ws

    ws.addEventListener('open', function () {
      reconnectDelay = 1000
    })

    ws.addEventListener('message', function (messageEvent) {
      var event
      try {
        event = JSON.parse(messageEvent.data)
      } catch (error) {
        return
      }
      handleEvent(event)
    })

    ws.addEventListener('close', function () {
      if (socket !== ws) return
      socket = null
      setStatus('连接已断开，正在重连…', 'connecting')
      scheduleReconnect()
    })

    ws.addEventListener('error', function () {
      // error 之后一定会跟一个 close，重连逻辑统一放在 close 里
    })
  }

  function startHeartbeat() {
    if (heartbeatTimer !== null) return
    heartbeatTimer = setInterval(function () {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send('ping')
    }, HEARTBEAT_MS)
  }

  // --- 登录态切换 -----------------------------------------------------------

  function showAuth() {
    if (el.auth !== null) el.auth.hidden = false
    if (el.room !== null) el.room.hidden = true
    if (el.me !== null) el.me.hidden = true
    if (el.logout !== null) el.logout.hidden = true
    setStatus('未登录')
  }

  function enterRoom() {
    if (el.auth !== null) el.auth.hidden = true
    if (el.room !== null) el.room.hidden = false
    if (el.me !== null) {
      el.me.hidden = false
      el.me.textContent = me.username
    }
    if (el.logout !== null) el.logout.hidden = false

    loadInitialHistory().catch(function (error) {
      notice(error.message, 'error')
    })
    connect()
    startHeartbeat()
  }

  function handleSignedOut() {
    me = null
    closeSocket()
    clearMessages()
    showAuth()
    notice('登录已过期，请重新登录', 'error')
  }

  function loadMe() {
    return api('/api/me', {}, false).then(function (response) {
      if (!response.ok) return null
      return response.json()
    })
  }

  function boot() {
    setStatus('正在检查登录状态…', 'connecting')
    notice('')

    loadMe()
      .then(function (profile) {
        if (profile !== null) {
          me = profile
          enterRoom()
          return
        }
        // 可能只是 access token 过期，refresh 一次还有救
        return refreshSession().then(function (ok) {
          if (!ok) {
            showAuth()
            return
          }
          return loadMe().then(function (retried) {
            if (retried === null) {
              showAuth()
              return
            }
            me = retried
            enterRoom()
          })
        })
      })
      .catch(function (error) {
        setStatus('连不上后端', 'offline')
        notice('连不上后端：' + error.message, 'error')
      })
  }

  // --- 事件绑定 -------------------------------------------------------------

  function setMode(next) {
    mode = next
    Array.prototype.forEach.call(el.tabs, function (tab) {
      tab.classList.toggle('is-active', tab.dataset.chatMode === next)
    })
    if (el.submit !== null) el.submit.textContent = next === 'login' ? '登录' : '注册'
    if (el.hint !== null) {
      el.hint.textContent =
        next === 'login'
          ? '还没有账号？切到「注册」创建一个，用户名 2-20 位，密码至少 8 位。'
          : '用户名 2-20 位（中文、字母、数字、下划线），密码至少 8 位。'
    }
    if (el.password !== null) el.password.autocomplete = next === 'login' ? 'current-password' : 'new-password'
    notice('')
  }

  Array.prototype.forEach.call(el.tabs, function (tab) {
    tab.addEventListener('click', function () {
      setMode(tab.dataset.chatMode)
    })
  })

  if (el.form !== null) {
    el.form.addEventListener('submit', function (event) {
      event.preventDefault()
      var username = el.username.value.trim()
      var password = el.password.value
      if (username === '' || password === '') {
        notice('用户名和密码都要填', 'error')
        return
      }

      el.submit.disabled = true
      notice(mode === 'login' ? '正在登录…' : '正在注册…')

      var path = mode === 'login' ? '/auth/login' : '/auth/register'
      fetch(API + path, {
        method: 'POST',
        credentials: 'include',
        headers: jsonHeaders(),
        body: JSON.stringify({ username: username, password: password })
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return null
            })
            .then(function (payload) {
              if (response.ok) return payload
              var fallback = mode === 'login' ? '用户名或密码不对' : '注册失败（' + response.status + '）'
              throw new Error((payload && payload.error) || fallback)
            })
        })
        .then(function () {
          if (mode === 'register') {
            // 注册接口只建账号、不发令牌，所以顺手登录一次，体验连贯
            return fetch(API + '/auth/login', {
              method: 'POST',
              credentials: 'include',
              headers: jsonHeaders(),
              body: JSON.stringify({ username: username, password: password })
            }).then(function (response) {
              if (!response.ok) throw new Error('注册成功了，但自动登录失败，请手动登录一次')
            })
          }
          return null
        })
        .then(function () {
          el.password.value = ''
          return loadMe()
        })
        .then(function (profile) {
          if (profile === null) {
            notice('登录状态没拿到，请再试一次', 'error')
            return
          }
          me = profile
          notice('')
          enterRoom()
        })
        .catch(function (error) {
          notice(error.message, 'error')
        })
        .then(function () {
          el.submit.disabled = false
        })
    })
  }

  if (el.composer !== null) {
    el.composer.addEventListener('submit', function (event) {
      event.preventDefault()
      sendMessage()
    })
  }

  if (el.input !== null) {
    el.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        sendMessage()
      }
    })
  }

  if (el.more !== null) {
    el.more.addEventListener('click', loadOlder)
  }

  if (el.logout !== null) {
    el.logout.addEventListener('click', function () {
      el.logout.disabled = true
      fetch(API + '/auth/logout', { method: 'POST', credentials: 'include' })
        .catch(function () {
          return null
        })
        .then(function () {
          el.logout.disabled = false
          handleSignedOut()
          notice('已退出登录')
        })
    })
  }

  // 从后台切回前台时，如果连接已经掉了就立刻重连，不用等退避计时器
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || me === null) return
    if (socket === null && reconnectTimer === null) connect()
  })

  setMode('login')
  boot()
})()
