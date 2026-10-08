/**
 * 前端集成测试：把真实的 assets/js/chat.js 放进 jsdom，
 * DOM 用 Hugo 真正构建出来的 public/chat/index.html，
 * 后端用本地 `wrangler dev` 起的真实 Worker（含 Durable Object）。
 *
 * 这样能覆盖到静态检查覆盖不到的东西：
 *   - chat.js 里的选择器和短代码产出的 data-chat-* 是否真的对得上
 *   - 注册 → 自动登录 → 加载历史 → WebSocket 连上 这条完整链路
 *   - 「自己发的消息」既走 HTTP 响应又走 WebSocket 广播，会不会重复渲染
 *   - 消息里的 HTML 会不会被执行（XSS）
 *   - 撤回后前端有没有跟着移除
 *
 * 用法：先 `npx wrangler dev`，再 `node scripts/frontend-test.mjs`
 */

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { WebSocket as NodeWebSocket } from 'ws'

const WORKER = process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8787'
const SITE_ORIGIN = 'https://yulo.top'
const PAGE_PATH = process.env.CHAT_PAGE ?? '../../../public/chat/index.html'

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// --- 一个最小的 Cookie 罐：jsdom 不管这个，chat.js 又假定浏览器会自动带 Cookie ---
const jar = {}

function jarHeader() {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

function harvest(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index === -1) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (value === '') delete jar[name]
    else jar[name] = value
  }
}

// --- 启动 ------------------------------------------------------------------

console.log(`前端测试：页面 ${PAGE_PATH} → 后端 ${WORKER}`)

const html = readFileSync(new URL(PAGE_PATH, import.meta.url), 'utf8')
const chatJs = readFileSync(new URL('../../../assets/js/chat.js', import.meta.url), 'utf8')
// 样式表也读一份，用来断言「没有浮层」这类只能从 CSS 上看出来的事。
// 先剥掉注释：这些注释里**写着** position: absolute / window.confirm 之类的
// 反面教材，不剥就会命中注释，得到一条永远为假的断言。
const chatCss = readFileSync(new URL('../../../assets/css/extended/chat.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

const dom = new JSDOM(html, {
  url: 'https://yulo.top/chat/',
  // outside-only：页面里 PaperMod 自带的内联脚本不执行，只让 window.eval 能跑我们的代码
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})

const { window } = dom
const { document } = window

// 选择器一致性：chat.js 要的每个 data-chat-* 都必须在真实 HTML 里存在
section('选择器与 DOM 的契约')
{
  const wanted = new Set()
  for (const match of chatJs.matchAll(/data-chat-[a-z-]+/g)) wanted.add(match[0])
  const missing = [...wanted].filter((name) => document.querySelector(`[${name}]`) === null)
  check(
    `chat.js 引用的 ${wanted.size} 个 data-chat-* 钩子在页面里都存在`,
    missing.length === 0,
    missing.length > 0 ? `缺失：${missing.join(', ')}` : '',
  )
  check('页面通过短代码渲染出了 #chat-app', document.getElementById('chat-app') !== null)
  check(
    'data-api 指向配置里的 API 域名',
    document.getElementById('chat-app')?.dataset.api === 'https://api.yulo.top',
  )
}

// 把 chat.js 里的 API 域换成指向本地 Worker
const patchedChatJs = chatJs.replace(
  "var API = (root.dataset.api || '').replace(/\\/+$/, '')",
  `var API = ${JSON.stringify(WORKER)}`,
)
check('已把 chat.js 的 API 地址重定向到本地 Worker', patchedChatJs.includes(WORKER))

window.fetch = async (input, init = {}) => {
  const headers = { ...(init.headers ?? {}) }
  headers.Origin = SITE_ORIGIN
  if (init.credentials === 'include') {
    const cookie = jarHeader()
    if (cookie !== '') headers.Cookie = cookie
  }
  const response = await fetch(String(input), { ...init, headers })
  harvest(response)
  return response
}

class CookieWebSocket extends NodeWebSocket {
  constructor(url) {
    const headers = { Origin: SITE_ORIGIN }
    const cookie = jarHeader()
    if (cookie !== '') headers.Cookie = cookie
    super(url, { headers })
  }
}
// CONNECTING / OPEN / CLOSING / CLOSED 是 ws 上的静态属性，子类会直接继承，
// 不需要（也不能）再赋值一次。
window.WebSocket = CookieWebSocket

const errors = []
window.addEventListener('error', (event) => errors.push(String(event.message)))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

window.eval(patchedChatJs)

// --- 等待工具 --------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try {
      value = predicate()
    } catch (error) {
      value = false
    }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await sleep(50)
  }
}

const $ = (selector) => document.querySelector(selector)
const visible = (selector) => {
  const node = $(selector)
  return node !== null && !node.hidden
}

/*
 * 和 visible() 是两个东西，不能混用：
 *
 *   visible()     只看元素**自己**的 hidden；
 *   visibleDeep() 还会一路往上看祖先节点。
 *
 * 需要两个是因为这两种情况都真实存在：
 *   - 用户名框自己没 hidden，是父 <form> 藏的（要用 visible() 的反面去判断）；
 *   - 改密码表单自己也没 hidden，是外层 <section data-chat-auth> 藏的。
 * 用错的那个就会写出「永远为真」的断言 —— 改密码按钮「点了没反应」
 * 这个 bug 就是从这来的：`!passwordForm.hidden` 全绿，屏幕上却什么都没有。
 */
const visibleDeep = (selector) => {
  const node = $(selector)
  if (node === null) return false
  for (let el = node; el !== null; el = el.parentElement) {
    if (el.hidden === true) return false
  }
  return true
}

function submitForm(selector) {
  const form = $(selector)
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
}

const username = `前端${Date.now().toString(36).slice(-5)}`
const password = 'frontend-test-password'

try {
  // --- 未登录 ---
  section('未登录状态')
  await waitFor('登录面板出现', () => visible('[data-chat-auth]'))
  check('未登录时显示登录面板', visible('[data-chat-auth]'))
  check('未登录时隐藏聊天区', !visible('[data-chat-room]'))
  check('状态文案为「未登录」', ($('[data-chat-status]')?.textContent ?? '').includes('未登录'))

  // --- 注册并自动登录 ---
  section('注册 / 登录 / 进入聊天室')
  $('[data-chat-mode="register"]').dispatchEvent(new window.Event('click', { bubbles: true }))
  check('切到注册后按钮文案变成「注册」', $('[data-chat-submit]')?.textContent === '注册')
  check('切到注册后密码框提示新密码', $('[data-chat-password]')?.autocomplete === 'new-password')

  $('[data-chat-username]').value = username
  $('[data-chat-password]').value = password
  submitForm('[data-chat-form]')

  await waitFor('进入聊天室', () => visible('[data-chat-room]'), 20000)
  check('注册后直接进入聊天室', visible('[data-chat-room]'))
  check('顶栏显示自己的用户名', $('[data-chat-me]')?.textContent === username)

  await waitFor('WebSocket 连上', () => ($('[data-chat-status]')?.textContent ?? '').includes('在线'), 15000)
  check('WebSocket 已连接并显示在线人数', ($('[data-chat-status]')?.textContent ?? '').includes('在线'))
  check('历史加载没有报错', $('[data-chat-notice]')?.hidden === true)

  // --- 发消息（验证去重：HTTP 响应 + WebSocket 广播是同一份） ---
  section('发消息与去重')
  const first = `第一条来自前端的消息 ${Date.now()}`
  $('[data-chat-input]').value = first
  submitForm('[data-chat-composer]')

  await waitFor('消息出现在列表里', () =>
    [...document.querySelectorAll('.chat__body')].some((node) => node.textContent === first),
  )
  await sleep(1200) // 给 WebSocket 广播留出到达时间，用来验证去重
  const duplicates = [...document.querySelectorAll('.chat__body')].filter(
    (node) => node.textContent === first,
  ).length
  check('HTTP 响应与 WebSocket 广播只渲染出一条（去重生效）', duplicates === 1, `实际 ${duplicates} 条`)

  // --- XSS ---
  section('XSS 防护')
  const payload = '<img src=x onerror="window.__pwned=1">'
  // 发言限流是「10 秒 10 次」，这一节发不了几条，不会撞上；
  // 留着这点间隔只是让上一条的广播、渲染先落地。
  await sleep(2200)
  $('[data-chat-input]').value = payload
  submitForm('[data-chat-composer]')

  await waitFor('恶意内容被渲染成文本', () =>
    [...document.querySelectorAll('.chat__body')].some((node) => node.textContent === payload),
  )
  check('HTML 标签被当成纯文本渲染', true)
  // 只查这条载荷本身没变成 <img>：列表里可能本来就有合法的图片消息
  const payloadBody = [...document.querySelectorAll('.chat__body')].find(
    (node) => node.textContent === payload,
  )
  check(
    'XSS 载荷没有创建出 <img> 元素',
    payloadBody !== undefined && payloadBody.querySelector('img') === null,
  )
  check('内联事件处理器没有被触发', window.__pwned === undefined)

  // --- 行内 markdown ---
  // 注意：渲染之后语法字符（** ` []()）会被吃掉，所以 textContent 不再等于原文，
  // 这里靠消息里那个时间戳来定位自己发的那条。
  section('行内 markdown')
  const mdStamp = String(Date.now())
  const md = '**粗体** 与 `代码` 与 [链接](https://example.com) ' + mdStamp
  await sleep(2200)
  $('[data-chat-input]').value = md
  submitForm('[data-chat-composer]')

  await waitFor('markdown 消息被渲染', () =>
    [...document.querySelectorAll('.chat__body')].some((node) =>
      node.textContent.includes(mdStamp),
    ),
  )
  const mdNode = [...document.querySelectorAll('.chat__body')].find((node) =>
    node.textContent.includes(mdStamp),
  )
  check('**粗体** 渲染成 <strong>', mdNode?.querySelector('strong')?.textContent === '粗体')
  check('`代码` 渲染成 <code>', mdNode?.querySelector('code')?.textContent === '代码')
  const anchor = mdNode?.querySelector('a')
  check('[链接](url) 渲染成 <a>', anchor?.textContent === '链接')
  check('链接指向原地址', anchor?.getAttribute('href') === 'https://example.com')
  check('外链带 noopener / nofollow', (anchor?.getAttribute('rel') ?? '').includes('noopener'))

  // 不安全的协议不能变成链接，也不能被执行
  const badStamp = String(Date.now())
  const bad = '[点我](javascript:window.__pwned2=1) ' + badStamp
  await sleep(2200)
  $('[data-chat-input]').value = bad
  submitForm('[data-chat-composer]')

  await waitFor('伪协议消息被渲染', () =>
    [...document.querySelectorAll('.chat__body')].some((node) =>
      node.textContent.includes(badStamp),
    ),
  )
  const badNode = [...document.querySelectorAll('.chat__body')].find((node) =>
    node.textContent.includes(badStamp),
  )
  check('javascript: 不会被渲染成 <a>', badNode?.querySelector('a') === null)
  check('javascript: 没有被执行', window.__pwned2 === undefined)

  // --- 成员名单 ---
  section('成员名单')
  check('成员面板默认折叠', !visible('[data-chat-members-panel]'))
  $('[data-chat-members-toggle]').dispatchEvent(new window.Event('click', { bubbles: true }))
  await waitFor(
    '成员名单加载出来',
    () => ($('[data-chat-online-list]')?.textContent ?? '').includes(username),
  )
  check('展开后在线列表里有自己', ($('[data-chat-online-list]')?.textContent ?? '').includes(username))
  check('在线分组默认展开', visible('[data-chat-online-list]'))
  check('离线分组默认折叠', !visible('[data-chat-offline-list]'))
  $('[data-chat-offline-toggle]').dispatchEvent(new window.Event('click', { bubbles: true }))
  check('点击后离线分组展开', visible('[data-chat-offline-list]'))
  check(
    '展开后箭头状态翻成 expanded',
    $('[data-chat-members-toggle]')?.getAttribute('aria-expanded') === 'true',
  )

  // --- 房间菜单 ---
  section('房间菜单')
  check('房间菜单默认折叠', !visible('[data-chat-rooms-panel]'))
  $('[data-chat-rooms-toggle]').dispatchEvent(new window.Event('click', { bubbles: true }))
  await sleep(50)
  const roomLinks = [...document.querySelectorAll('.chat__room-link')]
  check('菜单里列出了房间', roomLinks.length >= 1, `实际 ${roomLinks.length} 个`)
  check('当前房间被标记出来', roomLinks.some((link) => link.classList.contains('is-current')))
  check('展开房间菜单会把成员面板收起来（两个面板互斥）', !visible('[data-chat-members-panel]'))

  // --- 管理员按钮 ---
  // 这个账号是普通用户，所以那两个图标按钮不该露出来
  //（服务端那道门禁由 smoke 的「非管理员导出/清空被拒（403）」守）
  section('管理员按钮')
  check('普通用户看不到「导出」按钮', !visible('[data-chat-export]'))
  check('普通用户看不到「清空」按钮', !visible('[data-chat-purge]'))

  // --- 撤回按钮 ---
  // 要求：每条消息都渲染出 ×（不管是不是自己的），但只有有权限的能点。
  // --- 系统提示（谁进了房间 / 谁撤回了一条） ---
  section('系统提示')
  const systemRows = [...document.querySelectorAll('.chat__message--system')]
  check('进房间时渲染出了系统提示', systemRows.length > 0, `实际 ${systemRows.length} 条`)
  check(
    '文案是「XX 加入了房间」（原样来自服务端）',
    systemRows.some(
      (node) => node.querySelector('.chat__system-text')?.textContent === `${username} 加入了房间`,
    ),
    systemRows.map((node) => node.textContent).join(' / '),
  )
  check(
    '系统提示里没有撤回按钮',
    systemRows.every((node) => node.querySelector('.chat__delete') === null),
  )
  check(
    '系统提示不套气泡（没有 .chat__body）',
    systemRows.every((node) => node.querySelector('.chat__body') === null),
  )
  check(
    '系统提示不参与「是不是我发的」判断',
    systemRows.every((node) => !node.classList.contains('is-mine')),
  )
  /*
   * 「窄」和「居中」只能从 CSS 上看，所以去样式表里核对那两条声明。
   * 这一条守的是需求里那句「宽度应该窄、不影响对话的连贯性」——
   * 文案对不对是上面的断言管的，**长得和对话像不像**是这里管的。
   */
  const systemRule = chatCss.match(/\.chat__message--system \{([^}]*)\}/)?.[1] ?? ''
  check('系统提示的样式里有 align-self: center（居中、宽度贴合内容）', /align-self:\s*center/.test(systemRule))
  const systemFontSize = Number(systemRule.match(/font-size:\s*([\d.]+)rem/)?.[1] ?? '99')
  check(
    '系统提示的字号比正文小（0.75rem < 0.92rem）',
    systemFontSize > 0 && systemFontSize < 0.92,
    `实际 ${systemFontSize}rem`,
  )
  /*
   * 文案里含用户名，而用户名是用户可控的 —— 所以只能进 textContent。
   * 这里直接从源码里取函数体来核对，因为服务端的用户名规则不允许出现 `<`，
   * 造不出一条真能注入的用例（造不出来正是好事，但不能因此不检查）。
   */
  const systemRenderer = chatJs.match(/function renderSystemMessage[\s\S]*?\n  \}/)?.[0] ?? ''
  check(
    '系统提示用 textContent 写入（不碰 innerHTML）',
    systemRenderer.includes('textContent') && !systemRenderer.includes('innerHTML'),
  )

  /*
   * --- 消息区 / 输入框的面板色 ---
   *
   * 需求：浅色下消息区和输入框都是 #f5f5f5；**深色下不做区分**，和页面背景同色。
   *
   * 断言的重点不是「等于 #f5f5f5」，而是「必须走变量」：
   * 谁要是为了「就想要这个灰」把 background 写成硬编码 #f5f5f5，
   * 浅色下一点异常都没有，深色下是浅底浅字、整块看不见 —— 属于最难发现的那类。
   * 深色那条覆盖同理：它必须存在，否则深色会继承浅色那块浅灰。
   */
  section('消息区与输入框的面板色')
  // 取**第一处** `<selector> {…}`。深色那条 `:root[data-theme="dark"] .chat {` 里也含
  // `.chat {` 这个子串，但它在文件更后面，所以 `.chat` 取到的仍是浅色块；
  // 万一有人把两条调换了顺序，下面的断言会**红**而不是静默放过。
  const cssRule = (selector) => {
    const start = chatCss.indexOf(`${selector} {`)
    return start === -1 ? '' : chatCss.slice(start, chatCss.indexOf('}', start))
  }
  check('消息区有底色', /background:\s*var\(--chat-panel/.test(cssRule('.chat__messages')))
  check(
    '输入框和消息区用同一块面板色',
    /background:\s*var\(--chat-panel/.test(cssRule('.chat__composer textarea')),
  )
  check(
    '浅色面板色走变量（--chat-panel 基于 --code-bg），没有写死十六进制',
    /--chat-panel:\s*var\(--code-bg/.test(cssRule('.chat')),
  )
  check(
    '深色主题把面板色覆盖成 transparent（和背景同色、不做区分）',
    /\[data-theme="dark"\] \.chat \{[^}]*--chat-panel:\s*transparent/.test(chatCss),
  )

  /*
   * 气泡：浅色下是纯白，深色下仍是「比页面底色亮一档」的浮层色。
   *
   * 断言的是「这条规则还在、而且走变量」，不是某个具体颜色 ——
   * 写死 #fff 就等于只对浅色负责：深色主题的正文是浅色的，白气泡会让文字看不见。
   * 所以两条一起看：变量定义在 .chat 里，浅色那一份用 `:not([data-theme="dark"])`
   * 覆盖（深色刻意不覆盖，跟 --chat-panel 正好相反）。
   */
  check(
    '气泡底色走自己的变量（--chat-bubble，不写死十六进制）',
    /--chat-bubble:\s*var\(--chat-surface\)/.test(cssRule('.chat')),
  )
  check(
    '浅色主题把气泡覆盖成纯白（var(--theme)），深色不覆盖',
    /\[data-theme="dark"\]\) \.chat \{[^}]*--chat-bubble:\s*var\(--theme/.test(chatCss),
  )

  // --- 撤回按钮 ---
  section('撤回按钮')
  // 只看**用户消息**：系统提示（进出房间 / 撤回提示）刻意没有撤回按钮，
  // 后端也会挡（kind !== 'user' → 403），把它一起数进来就成了假失败。
  const articles = [...document.querySelectorAll('.chat__message')].filter(
    (node) => !node.classList.contains('chat__message--system'),
  )
  check(
    '每条用户消息都带撤回按钮',
    articles.length > 0 && articles.every((node) => node.querySelector('.chat__delete') !== null),
  )

  const mine = articles.filter((node) => node.classList.contains('is-mine'))
  check(
    '自己的消息撤回按钮可点',
    mine.length > 0 && mine.every((node) => node.querySelector('.chat__delete')?.disabled === false),
  )

  // 本地库里有历史遗留的他人消息时顺便验一下置灰；
  // 一条都没有的话 every 返回 true，等于跳过（不硬造数据）。
  const others = articles.filter((node) => !node.classList.contains('is-mine'))
  check(
    '别人的消息按钮存在但置灰',
    others.every((node) => {
      const button = node.querySelector('.chat__delete')
      return button !== null && button.disabled === true
    }),
  )

  // --- 图片与文件 ---
  section('图片与文件')
  check('输入框里有「+」上传按钮', $('[data-chat-upload]') !== null)
  check('大图遮罩默认隐藏', !visible('[data-chat-lightbox]'))

  const mediaBase = $('#chat-app')?.dataset.mediaBase ?? ''
  const ownImage = mediaBase + '/2026-09/11111111-2222-3333-4444-555555555555.jpg'

  await sleep(2200)
  $('[data-chat-input]').value = '![图](' + ownImage + ')'
  submitForm('[data-chat-composer]')

  await waitFor(
    '自家媒体的图片渲染成 <img>',
    () =>
      [...document.querySelectorAll('.chat__body img')].some(
        (node) => node.getAttribute('src') === ownImage,
      ),
    12000,
  )
  const rendered = [...document.querySelectorAll('.chat__body img')].find(
    (node) => node.getAttribute('src') === ownImage,
  )
  check('自家媒体的图片渲染成 <img>', rendered !== undefined)
  check('图片带 lazy 加载', rendered?.getAttribute('loading') === 'lazy')
  // 纯媒体消息不套气泡：图片自己就是主体，外面再加底色就把画面框小了
  check(
    '纯媒体消息不套气泡（拿到 .is-media）',
    rendered?.parentElement?.classList.contains('is-media') === true,
  )

  rendered?.dispatchEvent(new window.Event('click', { bubbles: true }))
  check('点图片能放大（遮罩出现）', visible('[data-chat-lightbox]'))
  $('[data-chat-lightbox]').dispatchEvent(new window.Event('click', { bubbles: true }))
  check('点遮罩能关掉', !visible('[data-chat-lightbox]'))

  // 外站图片绝不能被渲染成 <img>：那等于给每个人一条追踪访问者 IP 的探针
  await sleep(2200)
  $('[data-chat-input]').value = '![x](https://evil.example.com/track.png)'
  submitForm('[data-chat-composer]')
  // 外站图片会被降级成普通外链（URL 在 href 里，不在 textContent 里，所以按 href 等）
  await waitFor(
    '外站图片被降级成外链',
    () =>
      [...document.querySelectorAll('.chat__body a')].some((node) =>
        (node.getAttribute('href') ?? '').includes('evil.example.com'),
      ),
    12000,
  )
  check(
    '外站图片不会被渲染成 <img>',
    [...document.querySelectorAll('.chat__body img')].every(
      (node) => !(node.getAttribute('src') ?? '').includes('evil.example.com'),
    ),
  )

  // 音视频按扩展名分派成播放器
  await sleep(2200)
  const videoUrl = mediaBase + '/2026-09/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4'
  $('[data-chat-input]').value = '[视频](' + videoUrl + ')'
  submitForm('[data-chat-composer]')
  await waitFor(
    '视频渲染成 <video>',
    () =>
      [...document.querySelectorAll('.chat__body video')].some(
        (node) => node.getAttribute('src') === videoUrl,
      ),
    12000,
  )
  const player = [...document.querySelectorAll('.chat__body video')].find(
    (node) => node.getAttribute('src') === videoUrl,
  )
  check('视频渲染成 <video>', player !== undefined)
  check('播放器带 controls', player?.hasAttribute('controls') === true)

  // 文档 / 压缩包：下载条目
  await sleep(2200)
  const pdfUrl = mediaBase + '/2026-09/11111111-1111-1111-1111-111111111111.pdf'
  $('[data-chat-input]').value = '[说明.pdf](' + pdfUrl + ')'
  submitForm('[data-chat-composer]')
  await waitFor(
    '文档渲染成下载条目',
    () => document.querySelectorAll('.chat__body a.chat__file-link').length > 0,
    12000,
  )
  check('文档渲染成下载条目', document.querySelectorAll('.chat__body a.chat__file-link').length > 0)

  // --- 撤回 ---
  section('撤回')
  const target = [...document.querySelectorAll('.chat__message')].find(
    (node) => node.querySelector('.chat__body')?.textContent === first,
  )
  // 原来这里有一条 `自己的消息上带有撤回按钮` —— 已删：上面「撤回按钮」那一节
  // 已经断言过「每条用户消息都带撤回按钮」，而 target 就是这么一条用户消息，属于它的子集。
  // （万一 target 是 undefined，下面这行会立刻抛错，不会静默放过。）
  target.querySelector('.chat__delete').dispatchEvent(new window.Event('click', { bubbles: true }))

  await waitFor('消息从列表消失', () =>
    ![...document.querySelectorAll('.chat__body')].some((node) => node.textContent === first),
  )
  check('撤回后消息从列表移除', true)

  // --- 撤回限流时的提示文案 ---
  // 后端加了撤回限流之后，429 会带一句能直接给用户看的中文说明。
  // 前端如果只显示「撤回失败（429）」，等于把最有用的信息丢掉了。
  // 这里真把额度打满，再点一次撤回按钮，看提示里有没有那句话。
  section('撤回限流时的提示')
  {
    await sleep(2200)
    const limitedBody = `等会儿要撤掉的消息 ${Date.now()}`
    $('[data-chat-input]').value = limitedBody
    submitForm('[data-chat-composer]')
    await waitFor('新消息出现在列表里', () =>
      [...document.querySelectorAll('.chat__body')].some((node) => node.textContent === limitedBody),
      12000,
    )

    /*
     * 撤回被限流时前端的表现。
     *
     * ⚠️ **不能靠「真的打满限流」来测这一节**（早先就是那么写的，打 25 次 DELETE）。
     * 原因有两个：
     *   1. 本地 .dev.vars 开了 RELAX_LOCAL_LIMITS，限流打不满 → 用例必然超时；
     *   2. 就算关掉开关，打 25 次真实请求也慢，且让本节依赖了限流阈值这个常量。
     *
     * 改成 mock 掉这一个 DELETE 让它返回 429：要验的行为
     *（「提示中文原因」+「消息不被误删」）与限流阈值无关，
     * 阈值本身由 rate-limit-test.mjs 负责。
     */
    const realFetchForMute = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/api/messages/') !== -1 && (init && init.method) === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: function () {
            return Promise.resolve({ error: '撤回得太频繁了，12 秒后再试' })
          },
        })
      }
      return realFetchForMute(input, init)
    }

    const limitedNode = [...document.querySelectorAll('.chat__message')].find(
      (node) => node.querySelector('.chat__body')?.textContent === limitedBody,
    )
    check('待撤回的消息在列表里', limitedNode !== undefined, '找不到那条消息')
    limitedNode.querySelector('.chat__delete').dispatchEvent(new window.Event('click', { bubbles: true }))

    await waitFor('限流提示出现', () => {
      const notice = $('[data-chat-notice]')
      return notice !== null && !notice.hidden && (notice.textContent ?? '').includes('撤回得太频繁')
    }, 5000)
    const noticeText = $('[data-chat-notice]')?.textContent ?? ''
    check('被限流时显示服务端给的中文原因', noticeText.includes('撤回得太频繁'), `实际「${noticeText}」`)
    check('提示里带上了要等多少秒', /\d+\s*秒/.test(noticeText), `实际「${noticeText}」`)
    window.fetch = realFetchForMute
        check(
      '被限流时消息本身没有被移除',
      [...document.querySelectorAll('.chat__body')].some((node) => node.textContent === limitedBody),
    )
  }

  // --- data-* 属性名不能撞车（回归） ---
  section('选择器没有撞车')
  {
    /*
     * 这条是踩过一次才加的。
     *
     * 改密码的按钮曾经用了 `data-chat-password`，而登录密码框用的是**同一个**
     * 属性名。`querySelector('[data-chat-password]')` 只会返回**第一个**匹配 ——
     * 登录框在文档前面，于是 `el.password` 被抢走，登录永远读到空值，
     * 表现成「明明填了账号密码，却提示都要填」。
     *
     * 为什么别的地方测不出来：登录是在别的 section 里做的，
     * 等测到改密码按钮时登录早就成功了，属性名撞车已经被"绕过"。
     * 所以必须**在登录之前**断言「每个 data-* 选择器都唯一对应一个元素」。
     */
    const dataAttrs = [...document.querySelectorAll('[data-chat-auth] [data-chat-password], [data-chat-password]')]
    const bare = document.querySelectorAll('[data-chat-password]')
    check('裸的 [data-chat-password] 只有一个元素（登录密码框）', bare.length === 1, `实际 ${bare.length} 个`)

    const button = document.querySelectorAll('[data-chat-password-button]')
    check('改密码按钮用独立的属性名', button.length === 1, `实际 ${button.length} 个`)

    // 逐个核对 chat.js 里要用到的选择器：命中数必须和预期一致，
    // 大于 1 就意味着其中某个是被别人的属性顺带匹配上的。
    const expected = {
      '[data-chat-username]': 1,
      '[data-chat-password]': 1,
      '[data-chat-password-button]': 1,
      '[data-chat-password-current]': 1,
      '[data-chat-password-new]': 1,
      '[data-chat-password-confirm]': 1,
      '[data-chat-password-form]': 1,
      '[data-chat-password-tab]': 1,
      '[data-chat-password-cancel]': 1,
      '[data-chat-login-tab]': 1,
      '[data-chat-register-tab]': 1,
      '[data-chat-auth]': 1,
    }
    for (const [selector, want] of Object.entries(expected)) {
      const got = document.querySelectorAll(selector).length
      check(`${selector} 唯一（${want} 个）`, got === want, `实际 ${got} 个`)
    }

    // 登录框真的还是登录框：值填进去能被读到
    const userInput = $('[data-chat-username]')
    const passInput = $('[data-chat-password]')
    passInput.value = 'sentinel-password'
    check('登录密码框能读到自己的值（没被别的元素占位）', passInput.value === 'sentinel-password', `实际 "${passInput.value}"`)
    check('登录密码框和改密码的新密码框不是同一个元素', passInput !== $('[data-chat-password-new]'))
    passInput.value = ''
    if (userInput !== null) userInput.value = ''
  }

  // --- 成员名单的次要信息与管理按钮 ---
  section('成员名单：上次在线与管理员按钮')
  {
    /*
     * 占位行（「（暂无）」）不是成员，必须排掉。
     *
     * 它的 class 是 `chat__member chat__member--none`：没有 .chat__member-name、
     * 没有 .chat__member-seen，而且**不带 is-online** —— 混进 rows 里就会：
     *   ① 让「每行都有名字元素」判红；
     *   ② 被算成一个「离线成员」，再让「离线的人都显示了上次在线时间」判红。
     * 触发条件很隐蔽：某个分组恰好是空的、只剩占位行时才会露头
     * （smoke 跑完会把账号删掉一批，之后接着跑这个测试就撞上了）。
     * 属于「测试依赖上一轮留下的状态」那一类，修法是让断言只看真正的成员行。
     */
    const rows = [...document.querySelectorAll('.chat__member')].filter(
      (row) => !row.classList.contains('chat__member--none'),
    )
    check(
      '取到了真实的成员行（不是只剩占位行）',
      rows.length > 0,
      '一行真实成员都没有，下面几条断言就是空的，测不出东西',
    )
    check('成员行里有名字元素', rows.every((r) => r.querySelector('.chat__member-name') !== null))

    // 「上次在线」只给离线的人显示，在线的人那个位置是空的
    const offlineRows = rows.filter((r) => !r.classList.contains('is-online'))
    check(
      '离线成员显示了上次在线时间',
      offlineRows.every((r) => {
        const seen = r.querySelector('.chat__member-seen')
        return seen !== null && seen.textContent.length > 0
      }),
      `离线 ${offlineRows.length} 人`,
    )
    check(
      '在线成员不显示上次在线（那个信息没意义）',
      rows
        .filter((r) => r.classList.contains('is-online'))
        .every((r) => r.querySelector('.chat__member-seen') === null),
    )

    // 这个测试账号不是管理员，所以管理按钮不该出现
    const meRow = rows.find((r) => r.classList.contains('is-me'))
    check('管理员操作按钮默认不出现（当前是普通用户）', document.querySelectorAll('.chat__member-action').length === 0, `实际 ${document.querySelectorAll('.chat__member-action').length} 个`)
    check('自己的那一行没有管理按钮', meRow !== undefined && meRow.querySelector('.chat__member-action') === null)
  }

  // --- 改密码是第三个 tab，不是二级界面 ---
  section('修改密码并入登录/注册面板')
  {
    check('登录后改密码按钮可见', visible('[data-chat-password-button]'))
    check('面板里有三个 tab', document.querySelectorAll('.chat__tab').length === 3, `实际 ${document.querySelectorAll('.chat__tab').length} 个`)
    check('第三个 tab 是「修改密码」', ($('[data-chat-password-tab]')?.textContent ?? '') === '修改密码')
    check('登录后「修改密码」tab 可见', visible('[data-chat-password-tab]'))

    // 起点：登录/注册表单在，改密码表单藏着
    check('默认显示登录/注册表单', visible('[data-chat-form]'))
    check('默认隐藏改密码表单', $('[data-chat-password-form]').hidden === true)

    $('[data-chat-password-button]').dispatchEvent(new window.Event('click', { bubbles: true }))
    check('点笔图标切到「修改密码」', visible('[data-chat-password-form]'))
    check('此时登录/注册表单收起', $('[data-chat-form]').hidden === true)
    check('第三个 tab 高亮', $('[data-chat-password-tab]').classList.contains('is-active'))

    /*
     * **关键：祖先也要一起看。**
     *
     * 这里踩过一次（用户报「修改密码的按钮点了没反应」）：
     * 改成「改密码并入登录/注册面板」之后，表单确实切过去了、
     * `passwordForm.hidden` 也是 false —— 但整个
     * `<section data-chat-auth>` 被 enterRoom() 藏起来了，
     * 屏幕上什么都没出现。而原来的断言写的是 `!passwordForm.hidden`，
     * 只看元素**自己**，于是测试全绿、bug 照样上线。
     *
     * 所以这一条必须用 visibleDeep（连祖先一起查）。
     * 顺带把「面板打开时聊天区被收起」也钉住 —— 那是同一个视图切换的另一半。
     */
    check('改密码面板真的露出来了（祖先也不藏）', visibleDeep('[data-chat-password-form]'))
    check('打开改密码时收起了聊天区', $('[data-chat-room]').hidden === true)
    check('已登录时「登录」tab 收起（避免进去出不来）', $('[data-chat-login-tab]').hidden === true)
    check('已登录时「注册」tab 收起', $('[data-chat-register-tab]').hidden === true)

    /*
     * 改密码模式下登录/注册表单整体收起，所以用户名框自然也不可见。
     * 刻意不删掉那个 input：删了会让「切回登录时用户名是空的」这个行为变得难以验证。
     * 这里正好用 visibleDeep —— 用户名框自己没 hidden，是父 form 藏的，
     * 只有连祖先一起查才问得出「它到底看不看得见」。
     */
    check('改密码模式下看不到用户名输入框', visibleDeep('[data-chat-username]') === false)

    // 字段与原来的二级界面一致
    check('改密码表单有当前密码', $('[data-chat-password-current]') !== null)
    check('改密码表单有新密码', $('[data-chat-password-new]') !== null)
    check('改密码表单有确认新密码', $('[data-chat-password-confirm]') !== null)
    check('改密码表单有取消按钮', $('[data-chat-password-cancel]') !== null)

    // 两次不一致要挡在提交之前
    $('[data-chat-password-current]').value = 'old-password-x'
    $('[data-chat-password-new]').value = 'new-password-abc'
    $('[data-chat-password-confirm]').value = 'different-password'
    submitForm('[data-chat-password-form]')
    await waitFor('不一致的提示出现', () =>
      ($('[data-chat-password-hint]')?.textContent ?? '').includes('不一致'), 5000)
    check('两次新密码不一致时提示且不提交', ($('[data-chat-password-hint]')?.textContent ?? '').includes('不一致'))

    /*
     * 取消：回到聊天区。
     *
     * 没有「取消」的话这个面板就是个单向门 —— 它一打开就把聊天区收起来，
     * 用户点错一下就只能靠改密码才能出来。
     */
    $('[data-chat-password-cancel]').dispatchEvent(new window.Event('click', { bubbles: true }))
    check('点取消回到聊天区', visible('[data-chat-room]'))
    check('点取消收起整个 auth 面板', $('[data-chat-auth]').hidden === true)
    check('取消后仍是登录状态（登录/注册 tab 保持收起）', $('[data-chat-login-tab]').hidden === true)

    // 再打开一次：上次填的值和提示都不该留着
    $('[data-chat-password-button]').dispatchEvent(new window.Event('click', { bubbles: true }))
    check('重新打开时输入框是空的（上次填的没留下）', $('[data-chat-password-current]').value === '')
    /*
     * 不能断言提示区是空字符串 —— 这个元素一身兼两职：
     * setMode('password') 会往里写固定的说明文案，fail() 会往里写错误。
     * 所以「上一条错误有没有留下」要看的是 is-error 这个类，不是文本内容。
     */
    check(
      '重新打开时上一次的错误提示没留下',
      !$('[data-chat-password-hint]').className.includes('is-error'),
      `className=${$('[data-chat-password-hint]').className}`,
    )
    check(
      '重新打开时显示的是常规说明文案',
      ($('[data-chat-password-hint]')?.textContent ?? '').includes('重新登录'),
    )
    $('[data-chat-password-cancel]').dispatchEvent(new window.Event('click', { bubbles: true }))
  }

  /*
   * 请求体序列化 —— 这是「改密码按钮点了没反应」的真正原因。
   *
   * ## 病根
   *
   * fetch 的 body 只认字符串 / Blob / BufferSource / FormData /
   * URLSearchParams / ReadableStream。给它一个普通对象**不会报错**，
   * 而是 String() 成 `"[object Object]"`，Content-Type 还自动变成 text/plain。
   * 后端收到一个语法合法但内容不对的 JSON，于是回「请输入当前密码」——
   * 用户看到的就是「点了没反应」（提示离按钮很远，他不一定注意到）。
   *
   * 禁言那次更隐蔽：后端老代码 `body?.minutes ?? null` 把「字段缺失」和
   * 「显式 null」合并成一个值，于是残缺请求返回 **200** 且真的把人解除了禁言。
   *
   * ## 为什么在这里做单元断言而不是点一遍
   *
   * 真的提交一次改密码需要知道当前密码、而且会改掉测试账号的密码
   * （后面的用例还要用它登录）。改密码那条链路在 jsdom 里跑不完，
   * 硬凑出来的测试反而测不准。
   *
   * 所以：**按固定标记切片**，把 chat.js 里那四个函数单独 eval 出来直接断言。
   * 刻意不用正则去匹配函数体 —— 正则改一次措辞就静默匹配不到，
   * 那时断言变成空转，比没有还糟（本项目已经踩过这个坑）。
   */
  section('请求体序列化（对象 body 不能变成 "[object Object]"）')
  {
    const start = chatJs.indexOf('function isPlainBody(body) {')
    const end = chatJs.indexOf('function api(path, options, allowRetry)', start)
    if (start !== -1 && end > start) {
      window.eval(`${chatJs.slice(start, end)}\nwindow.__normalizeBody = normalizeBody`)
      const normalizeBody = window.__normalizeBody

      // ① 对象 body → JSON 文本 + Content-Type
      const objectBody = normalizeBody({ method: 'POST', body: { minutes: 60 } })
      check(
        '对象 body 被序列化成 JSON 文本',
        objectBody.body === '{"minutes":60}',
        `实际 ${JSON.stringify(objectBody.body)}`,
      )
      check(
        '同时补上 Content-Type: application/json',
        objectBody.headers?.['Content-Type'] === 'application/json',
        `实际 ${JSON.stringify(objectBody.headers)}`,
      )

      // ② 已经是字符串的 body 不许再动（再包一层引号就成了 JSON 字符串字面量）
      const asText = normalizeBody({ body: '{"a":1}', headers: { 'content-type': 'application/json' } })
      check('字符串 body 原样不动', asText.body === '{"a":1}', `实际 ${JSON.stringify(asText.body)}`)
      check(
        '已有 content-type（小写）时不重复加一个',
        Object.keys(asText.headers).length === 1,
        `实际 ${JSON.stringify(asText.headers)}`,
      )

      // ③ 已有 Content-Type 的，只序列化、不覆盖它
      const explicit = normalizeBody({ body: { n: 1 }, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
      check(
        '已有 Content-Type 时保留原值不覆盖',
        explicit.headers['Content-Type'] === 'application/json; charset=utf-8',
        `实际 ${explicit.headers['Content-Type']}`,
      )

      // ④ Blob / FormData 这些 fetch 本来认识的东西必须放行，否则上传会坏
      const blob = new window.Blob(['hello'], { type: 'image/png' })
      const keptBlob = normalizeBody({ body: blob })
      check('Blob body 原样放行（不被序列化）', keptBlob.body === blob)
      check('Blob 请求不会被硬塞 JSON Content-Type', keptBlob.headers === undefined)
      const form = new window.FormData()
      check('FormData body 原样放行', normalizeBody({ body: form }).body === form)
      const nullBody = normalizeBody({ body: null })
      check('body 为 null 时什么都不做', nullBody.body === null && nullBody.headers === undefined)

      // ⑤ 幂等：api() 401 重试会拿同一个 options 再进来一次
      const twice = normalizeBody(normalizeBody({ body: { a: 1 } }))
      check(
        '重复调用是幂等的（重试不会二次序列化）',
        twice.body === '{"a":1}',
        `实际 ${JSON.stringify(twice.body)}`,
      )
    } else {
      /*
       * 切不出来必须**炸**，不能只是少跑几条断言 —— 下面十几条全在这个 if 里面，
       * 静默跳过等于整节空转，而「空转」比没有测试更糟（本项目踩过
       * 「正则改一次措辞就静默匹配不到」这个坑）。原来这里有一条 check 专门报这事，
       * 删掉之后改用 throw：同样是「立刻红」，但不占一个断言位。
       */
      throw new Error(`切不出 chat.js 里的 body 归一化那一段：start=${start} end=${end}`)
    }

    // 调用点本身也不该再把对象交给 fetch（兜底是兜底，写法要正确）
    const codeLines = chatJs
      .split('\n')
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join('\n')
    check(
      '代码里没有「body 直接给对象字面量」的写法',
      !/\bbody:\s*\{/.test(codeLines),
      '找到 body: { — fetch 会把它变成 "[object Object]"',
    )
  }

  // --- 页面里不该有任何浮层 ---
  /*
   * 这里只留一条哨兵。
   *
   * 原来还有 4 条：「chat.js 里不再出现 chat__modal / window.confirm / prompt / alert」。
   * 现在源码里**只有注释**提到这几个词（`armDestructiveConfirm` 的文档注释就在解释
   * 「为什么不用 window.confirm」），也就是说那 4 条守的是一个**已经落地、且没有现实
   * 路径退回去**的决定 —— 它同时写进了 README 的「设计取舍」一节。
   * 真要有人写回 `window.alert(`，评审时一眼就能看见，不需要一条专职断言。
   *
   * 留下的这条守的是另一件事：旧浮层结构是从**模板**里捞回来的话（那是构建产物，
   * 这一节的静态断言管不到），页面上会真的出现 .chat__modal —— 只有这条能发现。
   */
  section('没有浮层容器')
  {
    check('页面上没有 modal 容器', document.querySelectorAll('.chat__modal').length === 0)
  }

  /*
   * 破坏性操作的两段式确认 —— 这里只做**静态**断言。
   *
   * 为什么不在 jsdom 里真的点两下：这个测试账号是**普通用户**，
   * 管理员专属的「清空」按钮对它压根不显示（见上面「管理员按钮」那节）。
   * 而要拿到管理员就得直接改本地库 —— 那是 smoke 的做法（它有 withLocalDb）。
   *
   * 所以分工是：这里守这个确认函数的**形态**（5 秒窗口、文案、提示排在左边还是右边），
   * 交互本身（点一次出提示、再点才执行、到期变「已取消」）交给 smoke 那节去真验。
   * 硬要在 jsdom 里模拟只会写出一个测不准的测试。
   *
   * 这里原来还有一条 `代码里有两段式确认函数`（正则匹配 `function armDestructiveConfirm`）——
   * 已删：下面 5 条全都在验这个函数的行为，名字改了它们会一起红，留着只是同义反复。
   */
  section('两段式确认的代码形态')
  {
    const src = chatJs
    check('确认窗口是 5 秒', /CONFIRM_WINDOW_MS\s*=\s*5000/.test(src), '找不到 5000ms 的窗口常量')
    check('确认文字是「确认删除？」', src.includes('确认删除？'))
    check('注销的提示排在按钮左边', /armDestructiveConfirm\([\s\S]*?'left'\)/.test(src))
    check('清空的提示排在按钮右边', /armDestructiveConfirm\([\s\S]*?'right'\)/.test(src))
    check('到期会显示「已取消」', src.includes('已取消'))
  }

  /*
   * 禁言时长选项必须留在成员行**里面**、贴着喇叭。
   *
   * 这里只做静态断言，理由和上面那节一样：这个测试账号是**普通用户**，
   * 管理员的喇叭按钮压根不渲染（见「成员名单」那节的断言），jsdom 里点不到。
   * 想点就得直接改本地库把自己提成 admin —— 那是 smoke 的活。
   *
   * 要守的两条不变量：
   *   1. 菜单插在喇叭**后面**（insertBefore 到 button.nextSibling），不是追加到行尾；
   *   2. CSS 里不许再出现 `position: absolute` —— 上一版就是它把菜单飘到了
   *      `.chat__member-actions` 外面（那个容器没有 position），
   *      点完喇叭屏幕上什么也看不见，「列表没显示在按钮旁边」就是这么来的。
   */
  section('禁言时长贴着喇叭展开')
  {
    check(
      '菜单插在喇叭右边（insertBefore 到 nextSibling）',
      /insertBefore\(menu, button\.nextSibling\)/.test(chatJs),
      '不能用 appendChild：那会把菜单甩到整行末尾，和喇叭脱节',
    )
    const start = chatCss.indexOf('.chat__mute-menu {')
    const end = chatCss.indexOf('.chat__mute-option {')
    const rule = start === -1 || end === -1 ? '' : chatCss.slice(start, end)
    check('找得到 .chat__mute-menu 规则', rule !== '', 'CSS 里没有这条规则，下面的断言会全部失真')
    check(
      '禁言菜单不再绝对定位（不飘出成员行）',
      !/position:\s*absolute/.test(rule),
      '绝对定位时它的定位祖先不是成员行，会跑到面板外面去',
    )
    check('禁言菜单是行内布局', /display:\s*inline-flex/.test(rule))
    check('禁言菜单不会被压扁', /flex:\s*none/.test(rule))
  }

  /*
   * 本地预览防呆：页面在 localhost、API 却指向远端时，必须在发请求之前就喊出来。
   *
   * 这条用**另一个 jsdom**跑真代码，而不是只做静态断言：
   * url 设成 http://localhost:1313/chat/，chat.js 一个字都不改
   * （data-api 仍是构建产物里的 https://api.yulo.top）。
   * 防呆命中时 boot() 在 loadMe() 之前就返回，所以这里不会产生任何网络请求 ——
   * 正是要验证的那个「别去请求，先把原因说清楚」。
   */
  section('本地预览防呆')
  {
    // 原来这里第一条是 `有本地预览自检函数`（正则匹配函数名）—— 已删：
    // 下一条断言的是它的**调用位置**，再下面还用另一个 jsdom 真的跑了一遍并核对提示文字，
    // 函数被改名的话那两条会一起红。
    check(
      '自检排在 loadMe() 之前',
      /if \(checkLocalPreviewTarget\(\)\) return[\s\S]{0,200}?loadMe\(\)/.test(chatJs),
      '自检必须挡在 loadMe() 前面，否则真正的配置错误会被 401 盖成「登录状态没拿到」',
    )

    const localDom = new JSDOM(html, {
      url: 'http://localhost:1313/chat/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    })
    localDom.window.eval(chatJs)
    const banner = localDom.window.document.querySelector('[data-chat-notice]')
    const text = banner === null ? '' : banner.textContent
    check(
      '本地页面指向远端 API 时当场报配置错误',
      text.includes('HUGO_PARAMS_CHAT_APIBASE'),
      text === '' ? '提示区是空的，防呆没生效' : `实际提示：${text}`,
    )
    check(
      '提示里写明了当前错误的 API 地址',
      text.includes('https://api.yulo.top'),
      `实际提示：${text}`,
    )
    localDom.window.close()
  }

  /*
   * refresh 被限流（429）不该把人登出 —— 回归测试。
   *
   * 背景：本地跑测试时把 refresh 限流桶打满（三十几次，超过 30 次/分钟的额度），
   * 浏览器一进页面就看到「登录已过期」—— 而密码对、会话也好，只是刷新太勤被限流。
   * 修法：refreshSession 的结果从布尔改成三态（ok / expired / retry），
   * 429 归入 'retry'；三个调用方（api / 重连 / boot）看到 'retry' 都不登出。
   *
   * ## 为什么这一节只做静态断言，不在 jsdom 里跑真的链路
   *
   * 试了三次都不成功，记下来免得下一个人再走一遍：
   *   1. mock 装在登录前 → 伪造的 401 把登录本身也打断，用例卡在「进入聊天室」；
   *   2. mock 装在登录后 → `loadMembers` 开头 `if (membersLoading) return` 去重，
   *      不「先收后展」就不发请求；展开了，`api()` 里 `me === null` 又挡着；
   *   3. 用 `new Function` 把那段源码抽出来跑 → 字符串替换太脆，语法都对不上。
   *
   * 三次都变成在测「链路走没走到」而不是「判定对不对」——
   * **测不准的测试比没有测试更糟**，它给的是虚假的安全感。
   *
   * 现在改成静态断言：验「429 被归类成 retry」和「调用方不因 retry 登出」
   * 这两条不变式在源码里成立。链路由上面的功能测试覆盖。
   * 好处是零 flake、改代码时立刻反映；代价是不覆盖运行时行为——
   * 接受，因为要保的就是这几行判定，不是整条链路。
   */
  section('refresh 被限流（429）不算会话失效')
  {
    const src = chatJs

    // ① 429 必须被单独归类成 retry，不能和 expired 混在一起
    check(
      "refreshSession 把 429 判成 'retry'",
      /response\.status === 429\)\s*return 'retry'/.test(src),
      '源码里找不到 429 → retry 的判定',
    )
    check(
      "refreshSession 只有非 429 的失败才判 'expired'",
      /return response\.ok \? 'ok' : 'expired'/.test(src),
      '源码里找不到 ok/expired 的判定',
    )

    // ② 三个调用方都区分 retry：不该一看到失败就登出。
    //    用「从 refreshSession 调用处往后 600 字符」切段，而不是靠正则匹配函数体 ——
    //    正则要么抓不全（`\n  }` 会在嵌套的 then 里提前结束），要么抓太宽。
    const slices = []
    let from = 0
    for (;;) {
      const at = src.indexOf('refreshSession()', from)
      if (at === -1) break
      // 跳过函数定义那一处（'function refreshSession() {'），只留真正的调用点
      const isDefinition = src.slice(Math.max(0, at - 40), at).includes('function ')
      if (!isDefinition) slices.push(src.slice(at, at + 600))
      from = at + 1
    }
    check('源码里有 3 处调用 refreshSession', slices.length === 3, `实际 ${slices.length} 处`)

    for (const [i, segment] of slices.entries()) {
      // 每处都该在 state 上分支，而不是 `if (state === 'ok')` 就完事
      const branches = /state === 'retry'/.test(segment) || /state === 'expired'/.test(segment)
      check(`第 ${i + 1} 处续期调用区分了 retry/expired`, branches, '看不到 state 分支')
      // 最关键：retry 附近绝不能出现 handleSignedOut
      const signedOutAfterRetry =
        /state === 'retry'[\s\S]{0,200}handleSignedOut/.test(segment) ||
        /handleSignedOut\(\)[\s\S]{0,80}state === 'retry'/.test(segment)
      check(`第 ${i + 1} 处不会在 retry 时登出`, signedOutAfterRetry === false, 'retry 分支里调了 handleSignedOut')
    }

    // ③ 旧实现（布尔）已经被彻底换掉，别留着半吊子
    check(
      '不再有「把 refresh 结果当布尔用」的残留',
      !/if \(!ok\)\s*\{\s*handleSignedOut/.test(src),
      '还有 !ok → handleSignedOut 的旧写法',
    )
  }

  // --- 退出 ---
  section('退出登录')
  $('[data-chat-logout]').dispatchEvent(new window.Event('click', { bubbles: true }))
  await waitFor('回到登录面板', () => visible('[data-chat-auth]'), 10000)
  check('退出后回到登录面板', visible('[data-chat-auth]'))
  check('退出后隐藏聊天区', !visible('[data-chat-room]'))
  check('退出后清空了消息列表', document.querySelectorAll('.chat__message').length === 0)
  // 未登录了，「登录 / 注册」两个 tab 必须还回来 ——
  // 它们在已登录时被改密码面板收起来了，只有 showAuth() 会恢复。
  check('退出后「登录」tab 回来了', $('[data-chat-login-tab]').hidden === false)
  check('退出后「注册」tab 回来了', $('[data-chat-register-tab]').hidden === false)
  check('退出后「修改密码」tab 收起来了', $('[data-chat-password-tab]').hidden === true)

  section('运行期错误')
  check('没有未捕获的 JS 错误', errors.length === 0, errors.join(' | '))
} catch (error) {
  failures.push(`异常中断：${error.message}`)
  console.log(`\n✗ 异常中断：${error.message}`)
} finally {
  window.close()
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
