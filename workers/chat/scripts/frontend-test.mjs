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
  await sleep(1600) // 绕开发言间隔限制
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
  await sleep(1600) // 绕开发言间隔限制
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
  await sleep(1600)
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

  // --- 撤回按钮 ---
  // 要求：每条消息都渲染出 ×（不管是不是自己的），但只有有权限的能点。
  section('撤回按钮')
  const articles = [...document.querySelectorAll('.chat__message')]
  check(
    '每条消息都带撤回按钮',
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

  await sleep(1600)
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

  rendered?.dispatchEvent(new window.Event('click', { bubbles: true }))
  check('点图片能放大（遮罩出现）', visible('[data-chat-lightbox]'))
  $('[data-chat-lightbox]').dispatchEvent(new window.Event('click', { bubbles: true }))
  check('点遮罩能关掉', !visible('[data-chat-lightbox]'))

  // 外站图片绝不能被渲染成 <img>：那等于给每个人一条追踪访问者 IP 的探针
  await sleep(1600)
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
  await sleep(1600)
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
  await sleep(1600)
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
  check('自己的消息上带有撤回按钮', target?.querySelector('.chat__delete') !== null)
  target.querySelector('.chat__delete').dispatchEvent(new window.Event('click', { bubbles: true }))

  await waitFor('消息从列表消失', () =>
    ![...document.querySelectorAll('.chat__body')].some((node) => node.textContent === first),
  )
  check('撤回后消息从列表移除', true)

  // --- 退出 ---
  section('退出登录')
  $('[data-chat-logout]').dispatchEvent(new window.Event('click', { bubbles: true }))
  await waitFor('回到登录面板', () => visible('[data-chat-auth]'), 10000)
  check('退出后回到登录面板', visible('[data-chat-auth]'))
  check('退出后隐藏聊天区', !visible('[data-chat-room]'))
  check('退出后清空了消息列表', document.querySelectorAll('.chat__message').length === 0)

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
