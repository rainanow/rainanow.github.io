/*
 * 聊天室前端。
 *
 * 设计约束（都是刻意的）：
 *  1. **不存任何 token。** access / refresh token 只存在于 HttpOnly Cookie 里，
 *     JS 一个字节都读不到，所以 XSS 也偷不走登录态。代价是所有请求都要
 *     `credentials: 'include'`，并且依赖 api.yulo.top 与站点同属 yulo.top（同站 Cookie）。
 *  2. **绝不用 innerHTML。** 消息内容一律走 createElement + createTextNode，
 *     连行内 markdown 也是自己拼 DOM（见 renderInline），从结构上堵死 XSS
 *     ——不用写转义函数，也不用担心哪一处分心漏掉。
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
  /**
   * 上传文件的公开前缀（R2 直连域名）。
   *
   * 它同时是**安全白名单**：只有这个前缀开头的 URL 才会被渲染成图片/播放器。
   * 不然别人往消息里写一个外站图片地址，就成了一条追踪访问者 IP 的探针。
   * 空字符串表示没配，那就一律不渲染成媒体（只当普通链接）。
   */
  var MEDIA_BASE = (root.dataset.mediaBase || '').replace(/\/+$/, '')
  /** 单文件上限，和后端 MAX_UPLOAD_BYTES 保持一致。 */
  var MAX_UPLOAD_BYTES = 16 * 1024 * 1024
  /** 图片压缩后的最长边。1600 够看清内容，又不至于把手机流量吃光。 */
  var IMAGE_MAX_EDGE = 1600

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
    logout: root.querySelector('[data-chat-logout]'),
    passwordButton: root.querySelector('[data-chat-password-button]'),
    passwordModal: root.querySelector('[data-chat-password-modal]'),
    passwordForm: root.querySelector('[data-chat-password-form]'),
    passwordCurrent: root.querySelector('[data-chat-password-current]'),
    passwordNew: root.querySelector('[data-chat-password-new]'),
    passwordConfirm: root.querySelector('[data-chat-password-confirm]'),
    passwordHint: root.querySelector('[data-chat-password-hint]'),
    passwordCancel: root.querySelector('[data-chat-password-cancel]'),
    membersToggle: root.querySelector('[data-chat-members-toggle]'),
    membersPanel: root.querySelector('[data-chat-members-panel]'),
    membersStatus: root.querySelector('[data-chat-members-status]'),
    onlineList: root.querySelector('[data-chat-online-list]'),
    onlineCount: root.querySelector('[data-chat-online-count]'),
    offlineList: root.querySelector('[data-chat-offline-list]'),
    offlineToggle: root.querySelector('[data-chat-offline-toggle]'),
    offlineCount: root.querySelector('[data-chat-offline-count]'),
    roomsToggle: root.querySelector('[data-chat-rooms-toggle]'),
    roomsPanel: root.querySelector('[data-chat-rooms-panel]'),
    exportButton: root.querySelector('[data-chat-export]'),
    purgeButton: root.querySelector('[data-chat-purge]'),
    upload: root.querySelector('[data-chat-upload]'),
    file: root.querySelector('[data-chat-file]'),
    lightbox: root.querySelector('[data-chat-lightbox]'),
    lightboxImage: root.querySelector('[data-chat-lightbox-image]')
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
  /** 本次连接是不是重连连上的。重连成功后要补拉一次历史，见 catchUp()。 */
  var pendingCatchUp = false
  var membersLoading = false
  var membersRefreshTimer = null
  /**
   * 上一次拉到的**全量**成员名单。
   *
   * 存在的原因：presence 刷新走的是 `scope=online`（不读 D1），
   * 那边只回「此刻谁在线」，给不出离线名单。要画出「在线 / 离线」两组，
   * 就得拿这份缓存当底子 —— 在线的人标 online，其余的都算离线。
   */
  var memberCache = []

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
  /**
   * 刷新会话。返回三态而不是布尔：
   *
   *   - 'ok'      拿到了新 access token，可以继续
   *   - 'expired' refresh token 真的无效（被吊销/改密码/登出）—— 该回登录页
   *   - 'retry'   被**限流**（429）。**这不是登录失效**，是刚才刷得太勤。
   *               多个标签页同时 401、或刚改完密码都会撞上。
   *               调用方绝不能因此把人登出 —— 否则密码是对的、
   *               会话也是好的，用户却被弹回登录页，看起来像账号出了问题。
   */
  function refreshSession() {
    if (refreshInFlight === null) {
      refreshInFlight = fetch(API + '/auth/refresh', {
        method: 'POST',
        credentials: 'include'
      })
        .then(function (response) {
          if (response.status === 429) return 'retry'
          return response.ok ? 'ok' : 'expired'
        })
        .catch(function () {
          // 网络错误也没法判断，当成可重试 —— 宁可让用户等，不要误登出
          return 'retry'
        })
        .then(function (state) {
          refreshInFlight = null
          return state
        })
    }
    return refreshInFlight
  }

  /**
   * 带自动续期的请求封装。
   *
   * 401 时先刷新再重试一次。三态处理（见 refreshSession）：
   *   - 'ok'      重试
   *   - 'expired' 退回登录面板
   *   - 'retry'   只是被限流了，**不登出**，把 401 原样还给调用方
   *
   * 最后这条是重点：被限流时如果一律 `handleSignedOut()`，就会出现
   * 「密码明明是对的、账号却是登录状态异常」—— 限流是「等一会」，
   * 不是「会话没了」。让调用方看到 401 自己决定怎么办。
   */
  function api(path, options, allowRetry) {
    var init = options || {}
    init.credentials = 'include'
    return fetch(API + path, init).then(function (response) {
      if (response.status !== 401 || allowRetry === false || me === null) return response
      return refreshSession().then(function (state) {
        if (state === 'ok') return api(path, options, false)
        if (state === 'expired') handleSignedOut()
        return response
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
    // 空状态提示要一起复位：它被 insertMessage() 隐藏过之后就一直是 hidden，
    // 不清回来的话，退出登录再进一个真的没人的房间，消息区会是一片纯空白
    // （连「还没有人说话」都没有），看起来像页面坏了。
    if (el.empty !== null) el.empty.hidden = false
  }

  function updateMoreButton() {
    if (el.more === null) return
    el.more.hidden = !hasMore
  }

  function findByID(id) {
    if (el.messages === null) return null
    return el.messages.querySelector('.chat__message[data-id="' + id + '"]')
  }

  /*
   * 行内 markdown：**粗体** / *斜体* / ~~删除线~~ / `代码` / [文字](链接)。就这五种。
   *
   * 为什么自己写而不引 marked、markdown-it：
   *   1. 不用往博客里塞第三方脚本，也不用动 Hugo 的构建流程；
   *   2. 更重要的——保住本文件开头那条底线：**永远不碰 innerHTML**。
   *      这里全程 createElement + createTextNode，用户输入没有任何一条路径会被当成
   *      HTML 解析，`<img onerror=...>` 在这儿只是一串普通字符。
   *      引第三方库就得再配一层 sanitizer（DOMPurify 之类），那才叫真的麻烦。
   *
   * 不认识的一律按纯文本落下，所以未闭合的 `**`、半截的链接都不会把版面搞乱。
   */
  var INLINE_RULES = [
    { pattern: /^\*\*([^\n]+?)\*\*/, tag: 'strong' },
    { pattern: /^\*([^\n*]+?)\*/, tag: 'em' },
    { pattern: /^~~([^\n]+?)~~/, tag: 'del' },
    { pattern: /^`([^`\n]+)`/, tag: 'code' },
    // 图片要排在链接前面：虽然 `!` 前缀本身能区分，但顺序错了读起来容易岔
    { pattern: /^!\[([^\]\n]*)\]\(([^)\s]+)\)/, tag: 'img' },
    { pattern: /^\[([^\]\n]+)\]\(([^)\s]+)\)/, tag: 'a' }
  ]

  /** 按扩展名决定一个媒体 URL 该怎么展示。 */
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
  var VIDEO_EXT = /\.(mp4|webm)$/i
  var AUDIO_EXT = /\.(m4a|mp3|ogg|wav|flac)$/i

  /** 只放行这几种协议，其它（javascript:、data:、vbscript: …）一律降级成纯文本。 */
  function safeHref(raw) {
    var value = String(raw).trim()
    return /^(https?:\/\/|mailto:)/i.test(value) ? value : null
  }

  /**
   * 是不是本站上传的媒体？是就返回那个 URL，否则 null。
   *
   * 这是媒体渲染的**唯一入口**：不在白名单里的东西，永远不会被塞进
   * `<img>` / `<video>` / `<audio>`。否则别人往消息里写一个外站图片地址，
   * 就成了一条追踪访问者 IP 的探针。
   */
  function ownMediaUrl(raw) {
    if (MEDIA_BASE === '') return null
    var value = String(raw).trim()
    return value.indexOf(MEDIA_BASE + '/') === 0 ? value : null
  }

  /** 外链一律新开窗口并断开 referrer。 */
  function externalLink(href, text) {
    var link = document.createElement('a')
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer nofollow'
    link.textContent = text
    return link
  }

  /** 视频/音频就地播放。preload 用 metadata：只取时长和首帧，不预下载整个文件。 */
  function mediaPlayer(tag, src) {
    var player = document.createElement(tag)
    player.src = src
    // 同样用 setAttribute：属性反射在 jsdom 里不一定生效
    player.setAttribute('controls', '')
    player.setAttribute('preload', 'metadata')
    player.className = 'chat__player'
    return player
  }

  /** 文档/压缩包：一个带文件名的下载条目（R2 那边响应头已经带了 attachment）。 */
  function fileLink(src, text) {
    var link = document.createElement('a')
    link.href = src
    link.rel = 'noopener noreferrer'
    link.className = 'chat__file-link'
    link.textContent = text.length > 0 ? text : '下载文件'
    return link
  }

  /** 点图放大：把 src 丢进那块全屏遮罩里。 */
  function openLightbox(event) {
    if (el.lightbox === null || el.lightboxImage === null) return
    var src = event.currentTarget.getAttribute('src')
    if (src === null || src === '') return
    el.lightboxImage.src = src
    el.lightbox.hidden = false
  }

  function closeLightbox() {
    if (el.lightbox === null) return
    el.lightbox.hidden = true
    if (el.lightboxImage !== null) el.lightboxImage.src = ''
  }

  /** 把一段文本按上面的规则塞进 parent，全程不经过 innerHTML。 */
  function renderInline(parent, text) {
    var rest = String(text)

    while (rest.length > 0) {
      var consumed = 0

      for (var i = 0; i < INLINE_RULES.length; i += 1) {
        var rule = INLINE_RULES[i]
        var matched = rule.pattern.exec(rest)
        if (matched === null) continue

        if (rule.tag === 'img') {
          var imageSrc = ownMediaUrl(matched[2])
          // 不是自家媒体、或者扩展名看着不像图片 —— 退回纯文本，绝不渲染
          if (imageSrc === null || !IMAGE_EXT.test(matched[2])) break
          var image = document.createElement('img')
          image.src = imageSrc
          image.alt = matched[1]
          // 用 setAttribute 而不是 .loading = ：属性反射在部分环境（比如 jsdom）里不生效，
          // 用 setAttribute 能保证属性真的落到 DOM 上，测试也才验得到
          image.setAttribute('loading', 'lazy')
          image.setAttribute('decoding', 'async')
          image.addEventListener('click', openLightbox)
          parent.appendChild(image)
        } else if (rule.tag === 'a') {
          var media = ownMediaUrl(matched[2])
          if (media !== null) {
            // 自家的媒体对象：按扩展名分派成播放器或下载条目
            if (VIDEO_EXT.test(media)) parent.appendChild(mediaPlayer('video', media))
            else if (AUDIO_EXT.test(media)) parent.appendChild(mediaPlayer('audio', media))
            else parent.appendChild(fileLink(media, matched[1]))
          } else {
            var href = safeHref(matched[2])
            // 协议不合法（javascript: 之类）就不当链接，让这段按普通字符落下去
            if (href === null) break
            parent.appendChild(externalLink(href, matched[1]))
          }
        } else {
          var node = document.createElement(rule.tag)
          node.textContent = matched[1]
          parent.appendChild(node)
        }

        rest = rest.slice(matched[0].length)
        consumed = 1
        break
      }

      if (consumed === 1) continue

      // 没匹配上任何语法：一直吃到下一个「可能是标记起点」的字符为止。
      // 至少吞掉一个字符，保证 while 不会原地打转。
      // 注意 `!` 也在这个集合里 —— 不然 `![图](url)` 会被拆开，`!` 当文本、剩下的当链接。
      var next = 1
      while (next < rest.length && '*`~!['.indexOf(rest.charAt(next)) === -1) next += 1
      parent.appendChild(document.createTextNode(rest.slice(0, next)))
      rest = rest.slice(next)
    }
  }

  /**
   * 是不是「纯媒体」消息 —— 整条内容就是图片/视频/文件，没有夹别的文字。
   *
   * 这种消息不套气泡（渲染时加 `.is-media`，由 CSS 去掉底色和内边距）：
   * 图片自己就是主体，外面再包一层灰底反而把画面框小了，看着也笨重。
   * 把媒体标记整体抠掉、剩下只有空白，就算纯媒体。
   */
  var MEDIA_MARKUP = /!?\[[^\]]*\]\([^)\s]+\)/g

  function isMediaOnly(body) {
    return body.replace(MEDIA_MARKUP, '').trim() === ''
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
    // 尖括号由 CSS 的 ::before / ::after 拼，这里只放用户名本身
    author.textContent = message.username

    var time = document.createElement('time')
    time.className = 'chat__time'
    time.dateTime = new Date(message.createdAt).toISOString()
    time.textContent = formatTime(message.createdAt)

    // 撤回按钮每条消息都渲染、一直可见；能不能点由权限决定：
    // 自己发的、以及管理员的可以点，其余置成 disabled 灰掉。
    // 前端这道只是「别让人白点」，真正的判定在后端（不是作者又不是 admin 会拿到 403）。
    var canDelete = me !== null && (message.userId === me.id || me.role === 'admin')
    var remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chat__delete'
    remove.textContent = '\u00d7'
    remove.disabled = !canDelete
    remove.title = canDelete ? '撤回这条消息' : '只能撤回自己的消息'
    remove.setAttribute('aria-label', remove.title)
    if (canDelete) {
      remove.addEventListener('click', function () {
        deleteMessage(message.id)
      })
    }

    // 顺序决定视觉：用户名、时间靠左，撤回按钮靠 margin-left:auto 顶到最右
    head.appendChild(author)
    head.appendChild(time)
    head.appendChild(remove)

    var body = document.createElement('p')
    body.className = 'chat__body'
    if (isMediaOnly(message.body)) body.classList.add('is-media')
    renderInline(body, message.body)

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

  /**
   * 进房间时加载第一页历史。
   *
   * 之前这里有个 `stickToBottom` 变量恒为 true，然后 `if (stickToBottom) scrollToBottom()`。
   * 那是「以后可能要按条件决定滚不滚到底」留下的钩子，但它从来没被改成过 false，
   * 读代码的人只能停下来确认一遍「是不是哪里会改它」——已经删掉，直接滚。
   */
  function loadInitialHistory() {
    return loadHistory(null).then(function (page) {
      clearMessages()
      page.messages.forEach(function (message) {
        insertMessage(message)
      })
      hasMore = page.hasMore === true
      updateMoreButton()
      scrollToBottom()
    })
  }

  /**
   * 重连之后补一次历史。
   *
   * 消息只有两个来源：进房间时的一次性历史，和 WebSocket 广播。
   * 断线期间你不在连接上，广播收不到，而重连成功只收到一个 ready 事件
   * （里面只有在线人数）—— 如果不主动补拉，断线那段时间别人发的消息
   * 就永远不会出现在这个页面上，而且没有任何提示，用户只会以为「没人说话」。
   *
   * 这里拉最新一页再交给 insertMessage 合并：它按 id 去重、按 createdAt 定位，
   * 所以已加载的旧消息不受影响，也不会和实时广播撞车重复渲染。
   * 代价是断线极久、漏掉的消息多于一页（50 条）时仍会漏更早的，
   * 那种情况刷新页面即可，不值得为它单独加一个增量接口。
   */
  function catchUp() {
    var shouldStick = nearBottom()
    loadHistory(null)
      .then(function (page) {
        page.messages.forEach(function (message) {
          insertMessage(message)
        })
        // 不更新 hasMore：它是「还有没有更早的」的判断，跟着 oldestCreatedAt 走，
        // 补拉的是更新的消息，不该动摇翻页游标。
        if (shouldStick) scrollToBottom()
      })
      .catch(function () {
        // 补拉失败不打断用户，下一次重连还会再试一遍。
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
        // 走 insertMessage 而不是自己拼 DOM：插入位置按 createdAt 定位（结果一样），
        // 而且它**会更新 oldestCreatedAt**。
        // 之前这里自己 renderMessage + insertBefore，唯独漏了更新游标，
        // 于是第二次翻页请求的还是同一个 before，服务端原样返回同一页，
        // 消息全部已存在被跳过 —— 表现就是「按钮还在，点了没反应」。
        page.messages.forEach(function (message) {
          insertMessage(message)
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

  /**
   * 撤回一条消息。
   *
   * 失败时要读响应体里的 `error` —— 后端加了撤回限流之后，429 会带上
   * 「撤回得太频繁了，N 秒后再试」这种**可以直接给用户看**的中文说明，
   * 只显示「撤回失败（429）」等于把最有用的信息丢掉了。
   * 响应体不是 JSON（比如网关返回的 HTML 错误页）时退回状态码，不抛错。
   */
  function deleteMessage(id) {
    api('/api/messages/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null
          })
          .then(function (payload) {
            if (!response.ok) {
              throw new Error((payload && payload.error) || '撤回失败（' + response.status + '）')
            }
          })
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
  }

  /**
   * 发送一条消息。
   *
   * 不传参数 = 发输入框里的内容（用户手打）。
   * 传参数 = 发这个字符串（上传文件后直接把 `![文件名](url)` 发出去，不经过输入框）。
   */
  function sendMessage(presetBody) {
    if (el.input === null) return
    var fromInput = presetBody === undefined
    var body = (fromInput ? el.input.value : String(presetBody)).trim()
    if (body === '') return

    if (fromInput) el.input.value = ''
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
        // 手打的内容发失败就还回输入框，别让人白打一遍。
        // 上传发出的内容不还 —— 还回去是一串 markdown，看着莫名其妙。
        if (fromInput) el.input.value = body
      })
      .then(function () {
        el.send.disabled = false
        el.input.focus()
      })
  }

  // --- 上传 -----------------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  /**
   * 图片压缩：最长边缩到 1600，再按 0.85 质量重新编码。
   *
   * 为什么必须在浏览器里做：Workers 免费套餐 CPU 上限 10ms，
   * 服务端光是解码一张手机原图就要几十 ms，必超。所以压完再传。
   *
   * 三种情况直接放过：GIF（canvas 重绘会丢动画）、本来就不大的图、
   * 以及压完反而更大的（直接比大小，不猜）。PNG 保持 PNG，免得丢透明通道。
   */
  function shrinkImage(file) {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg' && file.type !== 'image/webp') {
      return Promise.resolve(file)
    }
    if (file.size <= 300 * 1024) return Promise.resolve(file)

    return new Promise(function (resolve) {
      var objectUrl = URL.createObjectURL(file)
      var image = new Image()

      image.onload = function () {
        URL.revokeObjectURL(objectUrl)
        var scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(image.width, image.height))
        if (scale === 1 && file.type === 'image/jpeg') {
          resolve(file)
          return
        }

        var canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))

        var context = canvas.getContext('2d')
        if (context === null) {
          resolve(file)
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)

        canvas.toBlob(
          function (blob) {
            resolve(blob !== null && blob.size < file.size ? blob : file)
          },
          file.type === 'image/png' ? 'image/png' : 'image/jpeg',
          0.85,
        )
      }

      image.onerror = function () {
        URL.revokeObjectURL(objectUrl)
        resolve(file)
      }

      image.src = objectUrl
    })
  }

  /**
   * 把文件传上去，然后把它作为一条消息发出来。
   *
   * 请求体是文件的原始字节（不是 multipart），文件名放在 X-Filename 头里 ——
   * 只传一个文件，没必要为它引入 multipart 解析。
   */
  function uploadFile(file) {
    if (me === null) return

    if (file.size > MAX_UPLOAD_BYTES) {
      notice('文件超过 16 MB，先压缩或裁剪一下再传', 'error')
      return
    }

    if (el.upload !== null) el.upload.disabled = true
    notice('正在处理 ' + file.name + ' …')

    shrinkImage(file)
      .then(function (blob) {
        notice('正在上传（' + formatBytes(blob.size) + '）…')
        return api('/api/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name || 'file'),
          },
          body: blob,
        })
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null
          })
          .then(function (payload) {
            if (!response.ok) {
              throw new Error((payload && payload.error) || '上传失败（' + response.status + '）')
            }
            return payload
          })
      })
      .then(function (payload) {
        notice('')
        // 图片用 markdown 图片语法（内联展开），其它用链接（渲染成下载条目）
        var line =
          payload.kind === 'image'
            ? '![' + payload.filename + '](' + payload.url + ')'
            : '[' + payload.filename + '](' + payload.url + ')'
        return sendMessage(line)
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
      .then(function () {
        if (el.upload !== null) el.upload.disabled = false
      })
  }

  // --- 成员名单 -------------------------------------------------------------

  /** 名单拉回来之前先给个状态，别让面板空着 */
  function setMembersStatus(text, kind) {
    if (el.membersStatus === null) return
    if (!text) {
      el.membersStatus.hidden = true
      el.membersStatus.textContent = ''
      return
    }
    el.membersStatus.hidden = false
    el.membersStatus.textContent = text
    if (kind) el.membersStatus.dataset.kind = kind
    else delete el.membersStatus.dataset.kind
  }

  /**
   * 「上次在线」的中文描述。
   *
   * 分档而不是精确到分秒，因为这个数字的作用是让人判断「这人还活跃吗」，
   * 「3 分钟前」和「47 秒前」对这个问题没有区别。
   *
   * 超过 30 天直接说「很久没上线了」而不是继续数到几年几月 ——
   * 后者读起来像在数轴上找位置，前者才是结论。
   */
  function lastSeenText(lastSeenAt) {
    if (lastSeenAt === null || lastSeenAt === undefined) return '未知'
    var elapsed = Date.now() - lastSeenAt
    if (elapsed < 0) return '刚刚'
    var minute = 60 * 1000
    var hour = 60 * minute
    var day = 24 * hour
    if (elapsed < minute) return '刚刚'
    if (elapsed < hour) return Math.floor(elapsed / minute) + ' 分钟前'
    if (elapsed < day) return Math.floor(elapsed / hour) + ' 小时前'
    var days = Math.floor(elapsed / day)
    if (days <= 30) return days + ' 天前'
    return '很久没上线了'
  }

  /** 禁言到什么时候的中文描述。已过期的算「未禁言」。 */
  function mutedText(mutedUntil) {
    if (mutedUntil === null || mutedUntil === undefined) return null
    var left = mutedUntil - Date.now()
    if (left <= 0) return null
    var minute = 60 * 1000
    var hour = 60 * minute
    var day = 24 * hour
    if (left < hour) return '禁言 ' + Math.max(1, Math.ceil(left / minute)) + ' 分钟'
    if (left < day) return '禁言 ' + Math.ceil(left / hour) + ' 小时'
    return '禁言 ' + Math.ceil(left / day) + ' 天'
  }

  /**
   * 禁言 / 解除禁言。
   *
   * 时长用 `prompt` 问而不是做成一排按钮：档位不好定（5 分钟？1 小时？1 天？），
   * 而 `prompt` 里可以填任意分钟数。确定后再走接口。
   *
   * 失败只提示不刷新名单 —— 服务端状态没变，刷新了也是一样的。
   */
  function toggleMute(member, button) {
    var currentlyMuted = mutedText(member.mutedUntil) !== null
    if (currentlyMuted) {
      if (!window.confirm('解除对「' + member.username + '」的禁言？')) return
      applyMute(member, null, button, '已解除禁言')
      return
    }

    var input = window.prompt(
      '禁言「' + member.username + '」多少分钟？\n填 0 表示不禁言。',
      '60',
    )
    if (input === null) return
    var minutes = Number.parseInt(input, 10)
    if (!Number.isFinite(minutes) || minutes < 0) {
      notice('请填一个非负的整数', 'error')
      return
    }
    if (minutes === 0) {
      notice('那就不禁言了')
      return
    }
    applyMute(member, minutes, button, '已禁言 ' + member.username)
  }

  function applyMute(member, minutes, button, doneText) {
    button.disabled = true
    api('/api/users/' + encodeURIComponent(member.id) + '/mute', {
      method: 'POST',
      body: { minutes: minutes },
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null
          })
          .then(function (payload) {
            if (!response.ok) {
              throw new Error((payload && payload.error) || '操作失败（' + response.status + '）')
            }
            return payload
          })
      })
      .then(function (payload) {
        notice(doneText + (payload && payload.mutedUntil ? '，到期时间已显示在名单里' : ''))
        // 重新拉全量：禁言状态变了，但成员行上的标签要走服务端才算得准
        // （前端那个 mutedUntil 是旧数据，自己改会和 DB 漂移）。
        loadMembers(false)
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
      .then(function () {
        button.disabled = false
      })
  }

  /**
   * 注销用户。
   *
   * **两次确认**：第一次问「要不要删」，第二次要求打��账号名。
   * 这个操作不可逆（D1 没有备份，被删的人回不来），而它长得就像旁边那个
   * 小垃圾桶图标 —— 一次误点的代价太大。第二次要求打名字让意图变得明确。
   */
  function confirmDeleteMember(member, button) {
    if (!window.confirm('注销「' + member.username + '」？\n\n' +
        '他的账号会被删除，所有登录状态会失效，\n' +
        '他发过的消息会保留，但作者名会改成「已注销」。\n\n' +
        '这一步不可撤销。')) {
      return
    }
    var typed = window.prompt('请输入「' + member.username + '」以确认注销：')
    if (typed === null) return
    if (typed.trim() !== member.username) {
      notice('输入不匹配，已取消', 'error')
      return
    }

    button.disabled = true
    api('/api/users/' + encodeURIComponent(member.id), { method: 'DELETE' })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null
          })
          .then(function (payload) {
            if (!response.ok) {
              throw new Error((payload && payload.error) || '注销失败（' + response.status + '）')
            }
            return payload
          })
      })
      .then(function (payload) {
        notice(
          '已注销 ' + member.username +
            (payload && payload.renamedMessages ? '，保留了 ' + payload.renamedMessages + ' 条消息' : ''),
        )
        loadMembers(false)
      })
      .catch(function (error) {
        notice(error.message, 'error')
        button.disabled = false
      })
  }

  function memberNode(member) {
    var item = document.createElement('li')
    item.className = 'chat__member'
    if (member.online === true) item.classList.add('is-online')
    if (me !== null && member.id === me.id) item.classList.add('is-me')

    var name = document.createElement('span')
    name.className = 'chat__member-name'
    // 用户名照旧走 textContent，不经过 HTML 解析
    name.textContent = member.username
    item.appendChild(name)

    // 次要信息：只给离线的人显示「上次在线」——在线的人这个信息没有意义。
    // 紧贴名字右边（DOM 顺序就是视觉顺序），颜色更淡、字号更小。
    if (member.online !== true) {
      var seen = document.createElement('span')
      seen.className = 'chat__member-seen'
      seen.textContent = lastSeenText(member.lastSeenAt)
      item.appendChild(seen)
    }

    var muted = mutedText(member.mutedUntil)
    if (muted !== null) {
      var tag = document.createElement('span')
      tag.className = 'chat__member-muted'
      tag.textContent = muted
      item.appendChild(tag)
    }

    // 管理员操作按钮靠右（margin-left:auto），所以「不显示」时名字和
    // 次要信息自然贴左——不能给它留空占位，那样普通用户看着会莫名多一段空白。
    if (me !== null && me.role === 'admin' && member.id !== me.id) {
      item.appendChild(moderationButtons(member))
    }
    return item
  }

  /**
   * 造一个 SVG 图标。
   *
   * 不用 innerHTML 拼字符串：成员列表里的用户名是用户输入，
   * 这里虽然不直接拼它，但「所有用户数据都走 textContent」这条规矩值得守住 ——
   * 靠 createElementNS 就不存在「万一有个名字带尖括号」的可能。
   *
   * 图形用 path 的 d 属性，都是 16x16 视口的极简形状。
   */
  function moderationIcon(kind) {
    var NS = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '13')
    svg.setAttribute('height', '13')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')

    var path = document.createElementNS(NS, 'path')
    path.setAttribute('fill', 'currentColor')
    path.setAttribute(
      'd',
      // 喇叭：禁言。斜杠是单独一条 path，这样能画成「斜杠盖在喇叭上」。
      kind === 'mute'
        ? 'M8 2.5 4.8 5H2.5v6h2.3L8 13.5z M10.5 6l1 1 1-1 .8.8-1 1 1 1-.8.8-1-1-1 1-.8-.8 1-1-1-1z'
        // 垃圾桶：注销。
        : 'M6 1.5h4l.6 1H14v1.5H2V2.5h3.4z M3.5 5h9l-.7 9.2a1 1 0 0 1-1 .8H5.2a1 1 0 0 1-1-.8z',
    )
    svg.appendChild(path)
    return svg
  }

  /** 管理员专属的两个小图标：禁言、注销。
   *
   * 用 textContent 画图标字符而不是 innerHTML/svg —— 成员名是用户输入，
   * 这里虽然不直接拼它，但保持「所有用户数据都走 textContent」这条规矩不破。
   * 真正的 SVG 图标在 `moderationIcon()` 里用 createElementNS 构造。
   */
  function moderationButtons(member) {
    var wrap = document.createElement('span')
    wrap.className = 'chat__member-actions'

    var muteButton = document.createElement('button')
    muteButton.type = 'button'
    muteButton.className = 'chat__member-action'
    muteButton.title = mutedText(member.mutedUntil) === null ? '禁言' : '解除禁言'
    muteButton.setAttribute('aria-label', muteButton.title)
    muteButton.appendChild(moderationIcon('mute'))
    muteButton.addEventListener('click', function (event) {
      event.stopPropagation()
      toggleMute(member, muteButton)
    })

    var deleteButton = document.createElement('button')
    deleteButton.type = 'button'
    deleteButton.className = 'chat__member-action chat__member-action--danger'
    deleteButton.title = '注销该用户'
    deleteButton.setAttribute('aria-label', '注销 ' + member.username)
    deleteButton.appendChild(moderationIcon('trash'))
    deleteButton.addEventListener('click', function (event) {
      event.stopPropagation()
      confirmDeleteMember(member, deleteButton)
    })

    wrap.appendChild(muteButton)
    wrap.appendChild(deleteButton)
    return wrap
  }

  function fillMemberList(list, members) {
    if (list === null) return
    list.textContent = ''
    if (members.length === 0) {
      var none = document.createElement('li')
      none.className = 'chat__member chat__member--none'
      none.textContent = '（暂无）'
      list.appendChild(none)
      return
    }
    members.forEach(function (member) {
      list.appendChild(memberNode(member))
    })
  }

  function renderMembers(members) {
    var online = members.filter(function (member) {
      return member.online === true
    })
    var offline = members.filter(function (member) {
      return member.online !== true
    })

    fillMemberList(el.onlineList, online)
    fillMemberList(el.offlineList, offline)

    if (el.onlineCount !== null) el.onlineCount.textContent = String(online.length)
    if (el.offlineCount !== null) el.offlineCount.textContent = String(offline.length)

    setMembersStatus('')
  }

  /**
   * 拉成员名单。
   *
   * onlineOnly = true 时走 `scope=online`：名单数据由 Durable Object 提供，
   * 后端不再去读 users 表全表（仍有一次按主键查自己确认账号在，忽略不计）。
   * 这是为了省 D1 的读取行数 —— 全量名单一次最多 500 行，
   * 而有人进出（presence）就要刷一次，累积起来是这笔额度里最冤的一块。
   *
   * 代价是这种请求只回「谁在线」，所以离线名单要靠 memberCache 补：
   * 缓存里的人，在线集合里有就算在线，没有就算离线。
   */
  function loadMembers(onlineOnly) {
    if (membersLoading) return
    membersLoading = true
    setMembersStatus('正在加载…')

    var query = '/api/members?room=' + encodeURIComponent(ROOM)
    if (onlineOnly) query += '&scope=online'

    api(query)
      .then(function (response) {
        if (!response.ok) throw new Error('加载成员失败（' + response.status + '）')
        return response.json()
      })
      .then(function (payload) {
        var members = Array.isArray(payload.members) ? payload.members : []

        if (!onlineOnly) {
          // 全量：直接替换缓存
          memberCache = members
          renderMembers(memberCache)
          return
        }

        // 只在线：拿在线集合去更新缓存里每个人的 online 标记
        var onlineIds = {}
        members.forEach(function (member) {
          onlineIds[member.id] = true
          // 在线但不在缓存里（比如我们上次全量之后才注册的账号），补进去
          var known = memberCache.some(function (cached) {
            return cached.id === member.id
          })
          if (!known) memberCache.push(member)
        })
        memberCache.forEach(function (member) {
          member.online = onlineIds[member.id] === true
        })
        renderMembers(memberCache)
      })
      .catch(function (error) {
        setMembersStatus(error.message, 'error')
      })
      .then(function () {
        membersLoading = false
      })
  }

  /**
   * 有人进出时刷新名单。
   *
   * 两道节流叠在一起，都是为了少读 D1：
   *   1. 攒 800ms —— 同一瞬间可能连着来好几条（一个人断线重连就是 leave+join）；
   *   2. 走 `scope=online` —— 这类刷新压根不查 users 表，只问 DO。
   *      全量名单只在首次展开面板时拉一次（见 setMembersExpanded）。
   *
   * 面板收着的时候直接跳过——看不到的东西不用查。
   */
  function scheduleMembersRefresh() {
    if (el.membersPanel === null || el.membersPanel.hidden) return
    if (membersRefreshTimer !== null) return
    membersRefreshTimer = setTimeout(function () {
      membersRefreshTimer = null
      loadMembers(true)
    }, 800)
  }

  /**
   * 房间菜单。列表本身是 Hugo 构建时就生成好的静态 HTML，
   * 这里只负责开合——点房间是普通链接跳转，不归 JS 管。
   */
  function setRoomsExpanded(expanded) {
    if (el.roomsPanel === null) return
    el.roomsPanel.hidden = !expanded
    if (el.roomsToggle !== null) {
      el.roomsToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    }
  }

  function setMembersExpanded(expanded) {
    if (el.membersPanel === null) return
    el.membersPanel.hidden = !expanded
    if (el.membersToggle !== null) {
      el.membersToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      // 按钮里只有一个三角，文字提示得跟着开合状态走
      var label = expanded ? '收起成员列表' : '展开成员列表'
      el.membersToggle.setAttribute('aria-label', label)
      el.membersToggle.title = label
    }
    if (expanded) {
      // 两个面板占的是同一块位置，一次只留一个开着
      setRoomsExpanded(false)
      // 展开时拉**全量**（不带 onlineOnly）：这是建 memberCache 的地方，
      // 之后的 presence 刷新才能只拉 scope=online 靠这份缓存补离线名单。
      loadMembers(false)
    }
  }

  function resetMembers() {
    fillMemberList(el.onlineList, [])
    fillMemberList(el.offlineList, [])
    if (el.onlineCount !== null) el.onlineCount.textContent = '0'
    if (el.offlineCount !== null) el.offlineCount.textContent = '0'
    setMembersStatus('')
    // 缓存也要清：它是「上一个账号看到的名单」，留着下一个账号会看到别人的名字。
    memberCache = []
  }

  // --- 管理员操作：导出 / 清空 ----------------------------------------------

  /** 导出文件里用的时间戳要带日期，不像界面上只显示时分。 */
  function formatStamp(ms) {
    var date = new Date(ms)
    var pad = function (value) {
      return value < 10 ? '0' + value : String(value)
    }
    return (
      date.getFullYear() +
      '-' + pad(date.getMonth() + 1) +
      '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) +
      ':' + pad(date.getMinutes())
    )
  }

  /** 走 Blob + 一个临时 `<a>` 把文本存成文件。 */
  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    var url = URL.createObjectURL(blob)
    var link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    // 立刻 revoke 有可能把正在进行的下载掐断，挪到下一个事件循环再释放
    setTimeout(function () {
      URL.revokeObjectURL(url)
    }, 0)
  }

  /** 把当前房间的全部消息导出成一份 markdown 存到本地。 */
  function exportRoom() {
    if (me === null) return
    if (el.exportButton !== null) el.exportButton.disabled = true
    notice('正在导出…')

    api('/api/rooms/' + encodeURIComponent(ROOM) + '/export')
      .then(function (response) {
        if (!response.ok) throw new Error('导出失败（' + response.status + '）')
        return response.json()
      })
      .then(function (payload) {
        var lines = [
          '# 聊天室记录 · ' + payload.room,
          '',
          '> 导出时间：' + formatStamp(Date.now()) + ' ｜ 共 ' + payload.count + ' 条',
          '',
        ]
        if (payload.truncated) {
          lines.push('> 注意：消息太多，这次只导出了最早的 ' + payload.count + ' 条。', '')
        }

        payload.messages.forEach(function (message) {
          lines.push('**' + message.username + '** ' + formatStamp(message.createdAt))
          lines.push('')
          lines.push(message.body)
          lines.push('')
        })

        downloadText(
          'chat-' + payload.room + '-' + new Date().toISOString().slice(0, 10) + '.md',
          lines.join('\n'),
        )
        // 截断要在界面上说清楚。以前上限是 5000 条，撞到截断的概率很低，
        // 只写进导出文件里也够；现在是 1000 条（为了躲开 CPU 10ms 上限），
        // 稍大一点的房间就会撞上，用户得知道「这不是全部」。
        notice(
          payload.truncated
            ? '房间太大，这次只导出了最早的 ' + payload.count + ' 条（还有更早的没导出）'
            : '已导出 ' + payload.count + ' 条消息',
        )
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
      .then(function () {
        if (el.exportButton !== null) el.exportButton.disabled = false
      })
  }

  /**
   * 清空整个房间。服务端是**硬删**，所以这里必须二次确认 —— 点下去没有撤销。
   */
  function purgeRoom() {
    if (me === null) return

    var confirmed = window.confirm(
      '确定清空「' + ROOM + '」房间的全部消息吗？\n\n' +
        '消息里的图片和文件会一起删除，无法恢复。',
    )
    if (!confirmed) return

    if (el.purgeButton !== null) el.purgeButton.disabled = true
    notice('正在清空…')

    api('/api/rooms/' + encodeURIComponent(ROOM), { method: 'DELETE' })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null
          })
          .then(function (payload) {
            if (!response.ok) {
              throw new Error((payload && payload.error) || '清空失败（' + response.status + '）')
            }
            return payload
          })
      })
      .then(function (payload) {
        clearMessages()
        notice('已清空 ' + payload.removedMessages + ' 条消息、' + payload.removedMedia + ' 个文件')
      })
      .catch(function (error) {
        notice(error.message, 'error')
      })
      .then(function () {
        if (el.purgeButton !== null) el.purgeButton.disabled = false
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
      // 连上了是重连连上的话，补一次历史，把断线期间漏掉的消息找回来。
      if (pendingCatchUp) {
        pendingCatchUp = false
        catchUp()
      }
      return
    }
    if (event.type === 'presence') {
      setStatus('已连接 · 在线 ' + event.online + ' 人', 'online')
      // 有人进/出，名单里那两组的归属要跟着变
      scheduleMembersRefresh()
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
    if (event.type === 'purged') {
      // 管理员清空了房间，别人那边也得跟着清，否则他们手上还留着已删除的内容
      clearMessages()
      notice('房间内容已被清空')
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
      //
      // 只有 'expired' 才登出：被限流（429）说明刷新得太勤、稍后重试即可，
      // 那时把人踢回登录页纯属自伤 —— 密码是对的，会话也是好的。
      refreshSession().then(function (state) {
        if (state === 'expired') {
          handleSignedOut()
          return
        }
        // 'retry' 也照常连：可能 access token 其实还有效（只是 refresh 被限流了），
        // 连一下就知道。真正连不上 scheduleReconnect 会再排下一次。
        if (me !== null) connect(true)
      })
    }, delay)
  }

  /** isReconnect：这次连接是不是断线/切后台之后重新连上的。是的话连上后要补历史。 */
  function connect(isReconnect) {
    if (me === null) return
    pendingCatchUp = isReconnect === true
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
    // 未登录只留登录/注册面板，消息区和「成员列表」开关一起收起来
    if (el.auth !== null) el.auth.hidden = false
    if (el.room !== null) el.room.hidden = true
    if (el.membersToggle !== null) el.membersToggle.hidden = true
    if (el.me !== null) el.me.hidden = true
    if (el.logout !== null) el.logout.hidden = true
    if (el.passwordButton !== null) el.passwordButton.hidden = true
    if (el.exportButton !== null) el.exportButton.hidden = true
    if (el.purgeButton !== null) el.purgeButton.hidden = true
    setStatus('未登录')
  }

  function enterRoom() {
    // 登录成功：藏掉登录/注册面板，露出消息区和成员名单
    if (el.auth !== null) el.auth.hidden = true
    if (el.room !== null) el.room.hidden = false
    if (el.membersToggle !== null) el.membersToggle.hidden = false
    if (el.me !== null) {
      el.me.hidden = false
      el.me.textContent = me.username
    }
    if (el.logout !== null) el.logout.hidden = false
    if (el.passwordButton !== null) el.passwordButton.hidden = false

    // 导出 / 清空只有管理员看得见。
    // 藏按钮只是「别让人白点」，真正的门禁在服务端（非 admin 会拿到 403）。
    var isAdmin = me.role === 'admin'
    if (el.exportButton !== null) el.exportButton.hidden = !isAdmin
    if (el.purgeButton !== null) el.purgeButton.hidden = !isAdmin

    // 每次进房间都把成员面板收回收起态（默认折叠），要用再点开
    setMembersExpanded(false)

    loadInitialHistory().catch(function (error) {
      notice(error.message, 'error')
    })
    connect()
    startHeartbeat()
  }

  /**
   * 清空本地登录态、回到登录面板（不发通知）。
   *
   * 从 `handleSignedOut` 拆出来，因为**有两个调用方、但只有一个该报错**：
   *   - 会话真的过期了 → 该提示「登录已过期」（用户不明就里，需要解释）；
   *   - 改密码成功后主动登出 → 该提示「请用新密码重新登录」。
   * 之前两种情况都走同一个函数，改完密码会先弹红色「登录已过期」
   * 再弹「密码已修改」，看起来像出了故障 —— 其实什么都没坏。
   */
  function resetToAuthPanel() {
    me = null
    closeSocket()
    clearMessages()
    // 名单也要清掉：消息是上一个账号看到的，成员名单同理
    resetMembers()
    showAuth()
  }

  function handleSignedOut() {
    resetToAuthPanel()
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
        return refreshSession().then(function (state) {
          if (state === 'retry') {
            // 被限流：既不能断定登录态坏了，也不能当成已登录。
            // 最诚实的说法是「稍后重试」—— 用户看到的是服务端在限流，
            // 而不是「你的登录状态异常」。
            setStatus('刷新太频繁，请稍后重试', 'connecting')
            notice('刷新太频繁，请稍后重试', 'error')
            showAuth()
            return
          }
          if (state === 'expired') {
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

  // 「成员」按钮：点一下在折叠 / 展开之间切换（展开时顺手拉一次名单）
  if (el.membersToggle !== null) {
    el.membersToggle.addEventListener('click', function () {
      if (el.membersPanel === null) return
      setMembersExpanded(el.membersPanel.hidden)
    })
  }

  // 「房间」菜单：和成员面板互斥，展开一个就把另一个收起来
  if (el.roomsToggle !== null) {
    el.roomsToggle.addEventListener('click', function () {
      if (el.roomsPanel === null) return
      var expanded = el.roomsPanel.hidden
      if (expanded) setMembersExpanded(false)
      setRoomsExpanded(expanded)
    })
  }

  // 「离线」那一行本身也是折叠按钮，展开方向朝下
  if (el.offlineToggle !== null) {
    el.offlineToggle.addEventListener('click', function () {
      if (el.offlineList === null) return
      var expanded = el.offlineList.hidden
      el.offlineList.hidden = !expanded
      el.offlineToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    })
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

  /* --- 修改密码 ------------------------------------------------------- */

  /**
   * 改完密码之后前端该怎么办。
   *
   * 后端在改密码成功时会**吊销这个账号的全部会话**（含当前这个），
   * 所以此刻起这个页面的 access token 虽然还没过期，但 refresh 已经换不出新的了。
   * 与其留在一个「能用一阵、然后突然 401」的半死状态，不如直接回登录页 ——
   * 用户改密码的场景通常就是「我发现别人能登录我的号」，让他重新登进去是正确行为。
   */
  function handlePasswordChanged() {
    closePasswordModal()
    // 走 resetToAuthPanel 而不是 handleSignedOut：后者会弹红色「登录已过期」，
    // 和「密码已修改」叠在一起像出了故障。这里该说的是下面这句。
    resetToAuthPanel()
    notice('密码已修改，请用新密码重新登录')
  }

  function openPasswordModal() {
    if (el.passwordModal === null || el.passwordForm === null) return
    el.passwordForm.reset()
    if (el.passwordHint !== null) {
      el.passwordHint.textContent = ''
      el.passwordHint.className = 'chat__hint'
    }
    el.passwordModal.hidden = false
    if (el.passwordCurrent !== null) el.passwordCurrent.focus()
  }

  function closePasswordModal() {
    if (el.passwordModal !== null) el.passwordModal.hidden = true
    if (el.passwordForm !== null) el.passwordForm.reset()
  }

  if (el.passwordButton !== null) {
    el.passwordButton.addEventListener('click', openPasswordModal)
  }
  if (el.passwordCancel !== null) {
    el.passwordCancel.addEventListener('click', closePasswordModal)
  }
  // 点遮罩空白处关闭。keyup 是为了键盘操作：Esc 应该关掉这个模态，
  // 否则 Tab 进去以后没有键盘出口。
  if (el.passwordModal !== null) {
    el.passwordModal.addEventListener('click', function (event) {
      if (event.target === el.passwordModal) closePasswordModal()
    })
  }
  document.addEventListener('keyup', function (event) {
    if (event.key === 'Escape' && el.passwordModal !== null && !el.passwordModal.hidden) {
      closePasswordModal()
    }
  })

  if (el.passwordForm !== null) {
    el.passwordForm.addEventListener('submit', function (event) {
      event.preventDefault()

      var currentPassword = el.passwordCurrent !== null ? el.passwordCurrent.value : ''
      var newPassword = el.passwordNew !== null ? el.passwordNew.value : ''
      var confirmPassword = el.passwordConfirm !== null ? el.passwordConfirm.value : ''

      function fail(message) {
        if (el.passwordHint === null) notice(message, 'error')
        else {
          el.passwordHint.textContent = message
          el.passwordHint.className = 'chat__hint is-error'
        }
      }

      if (newPassword !== confirmPassword) {
        fail('两次输入的新密码不一致')
        return
      }
      if (newPassword.length < 8) {
        fail('新密码至少 8 位')
        return
      }

      api('/api/me/password', {
        method: 'POST',
        body: { currentPassword: currentPassword, newPassword: newPassword },
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return null
            })
            .then(function (payload) {
              if (!response.ok) {
                throw new Error((payload && payload.error) || '修改失败（' + response.status + '）')
              }
              return payload
            })
        })
        .then(handlePasswordChanged)
        .catch(function (error) {
          fail(error.message)
        })
    })
  }

  // 「+」只是去戳那个藏起来的 file input —— 原生 input 的样式改不动，不如藏起来自己画
  if (el.upload !== null && el.file !== null) {
    el.upload.addEventListener('click', function () {
      el.file.click()
    })

    el.file.addEventListener('change', function () {
      var picked = el.file.files !== null && el.file.files.length > 0 ? el.file.files[0] : null
      // 立刻清空：否则连着选同一个文件不会再触发 change
      el.file.value = ''
      if (picked !== null) uploadFile(picked)
    })
  }

  // 管理员那两个图标按钮（未登录时是 hidden 的，但绑上无害）
  if (el.exportButton !== null) {
    el.exportButton.addEventListener('click', exportRoom)
  }

  if (el.purgeButton !== null) {
    el.purgeButton.addEventListener('click', purgeRoom)
  }

  // 点遮罩的任意位置关掉大图
  if (el.lightbox !== null) {
    el.lightbox.addEventListener('click', closeLightbox)
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && el.lightbox !== null && !el.lightbox.hidden) closeLightbox()
  })

  // 从后台切回前台时，如果连接已经掉了就立刻重连，不用等退避计时器
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || me === null) return
    // 从后台切回来也当作重连处理：休眠期间连接可能已经悄悄断了。
    if (socket === null && reconnectTimer === null) connect(true)
  })

  setMode('login')
  boot()
})()
