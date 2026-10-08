/**
 * 限流测试 —— **独立于 smoke.mjs**，因为它要求限流真的生效。
 *
 * ## 为什么必须拆开
 *
 * 本地开发为了调试方便，在 `.dev.vars` 里设了 `RELAX_LOCAL_LIMITS=true`，
 * 把限流阈值放大到 100 万（见 `rate-limit.ts` 的 `effectiveLimit`）。
 * 那个开关一开，凡是指望限流生效的用例都会红一片（把它们搬出来时实测 12 条）。
 *
 * 而「12 条测试红了」这件事极具误导性：人会以为是代码坏了去查错方向，
 * 实际只是本地调试开关的正常后果。所以把它们拆到这个脚本里，
 * 由 `npm run rate-limit-test` 用 `STRICT_RATE_LIMIT=true` 单独跑
 * （见 package.json 里的脚本，它会自己起一个 strict 的 dev server）。
 *
 * ## 判定优先级
 *
 * `STRICT_RATE_LIMIT=true` > `RELAX_LOCAL_LIMITS=true`。
 * 所以本地开着放宽也不影响这个脚本测出真实阈值。
 *
 * ## 线上会不会被削弱
 *
 * 不会：两个开关都只写在 `.dev.vars` 里，而 `wrangler deploy` **不读**它。
 * 生产环境两者恒为 undefined，限流照旧。
 *
 * 用法：`npm run rate-limit-test`（它自己管 dev server 的起停）
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const BASE = process.env.CHAT_BASE_URL ?? 'http://127.0.0.1:8789'
const ORIGIN = 'https://yulo.top'

let passed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

function isLocalTarget() {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)
}

function withLocalDb(work) {
  const dir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  const newest = readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0]
  if (newest === undefined) return
  const db = new DatabaseSync(join(dir, newest.name))
  try {
    work(db)
  } finally {
    db.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

function jarFrom(response) {
  const jar = {}
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? ''
    const at = pair.indexOf('=')
    if (at === -1) continue
    jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return jar
}

async function request(path, { jar, method = 'GET', body, headers: extra } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (jar !== undefined) headers.Cookie = cookieHeader(jar)
  if (extra !== undefined) Object.assign(headers, extra)
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 清掉所有本地限流计数，让每一节从干净状态开始。 */
function resetBuckets(pattern) {
  if (!isLocalTarget()) return
  withLocalDb((db) => db.exec(`DELETE FROM rate_limits WHERE id LIKE '${pattern}'`))
}

const username = `rlt${Date.now().toString(36).slice(-6)}`
const password = 'rate-limit-password-1'

section('准备：确认限流在本进程里真的生效')
{
  // 这一条是整个脚本的前提。如果它失败（本地开了放宽又没开 strict），
  // 后面所有「第 N 次应该 429」的断言都会莫名其妙地红。
  // 与其让人对着满屏红字猜，不如在这里就说清楚。
  const response = await request('/auth/register', {
    method: 'POST',
    body: { username: `${username}probe`, password },
  })
  check(
    '限流处于生效状态（否则本脚本的断言都不成立）',
    response.status === 201 || response.status === 429,
    `注册返回 ${response.status}，说明既没成功也没被拦 —— 环境不对`,
  )
  if (response.status === 201) {
    console.log('    → 环境是「限流已关闭」。请用 `npm run rate-limit-test` 跑（它会起 strict 的 server）。')
  }
}

section('注册限流')
{
  resetBuckets('register:%')
  const results = []
  for (let i = 0; i < 8; i += 1) {
    const name = `${username}r${i}`
    const response = await request('/auth/register', {
      method: 'POST',
      body: { username: name, password },
    })
    results.push(response.status)
  }
  /*
   * 阈值 5 次/小时，但**实际只放行 4 次** —— 这是 `consumeRateLimit` 的 off-by-one：
   * 它是「先记账、再判断」，判定条件是 `hits < limit`（见 rate-limit.ts 的 evaluate）。
   * 所以第 1 次请求记下 hits=1，第 5 次记下 hits=5 时 `5 < 5` 为假 → 被拦。
   *
   * 这个坑踩过一次（README 坑列表第 15 条），这里再写一遍是因为很容易忘：
   * 写断言时按「5 次」想，跑出来是 4 次，第一反应会是「代码算错了」。
   * ——不是代码算错，是限额本来就这么设计的（宁可少放一次，不多放）。
   */
  const allowed = results.filter((s) => s === 201).length
  check('放行 4 次（第 5 次记账时就 hits=5，被拦下）', allowed === 4, `实际放行 ${allowed} 次：${results.join(',')}`)
  check('第 5 次起被限流 429', results.slice(4).every((s) => s === 429), `实际 ${results.slice(4).join(',')}`)
}

section('登录限流')
{
  // ⚠️ 每一节开头都清注册桶：上一节（注册限流）会打满额度，
  // 那样这里的注册会直接 429 → 账号建不出来 → 登录当然是 401。
  // 之前没清，一连两轮都是「登录 401」，第一反应还会以为登录功能坏了。
  resetBuckets('register:%')
  resetBuckets('login:%')

  // 先建一个真实账号，用来确认「密码对的时候不会被限流误伤」
  const reg = await request('/auth/register', {
    method: 'POST',
    body: { username: `${username}ok`, password },
  })
  check('前置：账号建出来了', reg.status === 201, `注册返回 ${reg.status}`)

  const good = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}ok`, password },
  })
  check('密码正确时登录成功（限流只记失败）', good.status === 200, `实际 ${good.status}`)

  resetBuckets('login:%')
  const ghost = `${username}ghost`
  const results = []
  for (let i = 0; i < 12; i += 1) {
    const response = await request('/auth/login', {
      method: 'POST',
      body: { username: ghost, password: 'wrong-password-here' },
    })
    results.push(response.status)
  }
  // 阈值 10 次/1 小时：前 10 次 401，第 11 次起 429
  check('前 10 次是 401（凭据错误）', results.slice(0, 10).every((s) => s === 401), `实际 ${results.slice(0, 10).join(',')}`)
  check('第 11 次起返回 429', results.slice(10).every((s) => s === 429), `实际 ${results.slice(10).join(',')}`)
}

section('撤回限流')
{
  resetBuckets('register:%')
  resetBuckets('%')
  await request('/auth/register', { method: 'POST', body: { username: `${username}d`, password } })
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}d`, password },
  })
  const jar = jarFrom(login)
  const me = await (await request('/api/me', { jar })).json()

  // 删一个不存在的消息 id：每次都会记账，但业务上是 404。
  // 这样不用先发消息、也不用等撤回的媒体清理，是最省时间的探针。
  const missing = '00000000-0000-4000-8000-000000000000'
  const results = []
  for (let i = 0; i < 34; i += 1) {
    const response = await request(`/api/messages/${missing}`, { method: 'DELETE', jar })
    results.push(response.status)
  }
  // 阈值 30 次/60 秒：前 30 次 404，第 31 次起 429
  check('前 30 次走到业务逻辑（404）', results.slice(0, 30).every((s) => s === 404), `实际 ${results.slice(0, 30).join(',')}`)
  check('第 31 次起返回 429', results.slice(30).every((s) => s === 429), `实际 ${results.slice(30).join(',')}`)

  const limited = await request(`/api/messages/${missing}`, { method: 'DELETE', jar })
  check('429 之后不会偶尔再放行一次', limited.status === 429, `实际 ${limited.status}`)
  check('429 带 Retry-After', limited.headers.get('Retry-After') !== null, `实际 ${limited.headers.get('Retry-After')}`)

  // 限流桶是按 userId 分的，换个账号不该受影响 —— 这条守着
  // 「别把桶键写成全局」这个容易犯的错
  resetBuckets('register:%')
  await request('/auth/register', { method: 'POST', body: { username: `${username}e`, password } })
  const otherLogin = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}e`, password },
  })
  const otherJar = jarFrom(otherLogin)
  const other = await request(`/api/messages/${missing}`, { method: 'DELETE', jar: otherJar })
  check('限流是按账号算的，换个人不受影响', other.status === 404, `实际 ${other.status}`)
  void me
}

section('发言限流')
{
  // 这条断言原先内嵌在 smoke 的「实时收发」一节里，因为按 section 拆分时被漏掉了。
  // 教训：搬断言要按**断言内容**找，不能只看它属于哪个 section ——
  // 一条限流断言完全可以藏在普通功能节里。
  resetBuckets('register:%')
  resetBuckets('%')
  await request('/auth/register', { method: 'POST', body: { username: `${username}m`, password } })
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}m`, password },
  })
  const jar = jarFrom(login)

  /*
   * 阈值是「10 秒 10 次」，所以**前 10 条必须全部成功**，第 11 条才是 429。
   *
   * ⚠️ 这里不能用「连发两条、第二条被拦」来测 —— 那是旧的「最小间隔 1 条」语义。
   * 额度制的意思正是「连发几句是允许的」（一口气补两句话是常见操作，不该失败），
   * 断言方向写反会把正常行为测成 bug。
   */
  const results = []
  for (let i = 0; i < 12; i += 1) {
    const response = await request('/api/messages', {
      method: 'POST', jar, body: { body: `连发第 ${i + 1} 条`, room: 'rlprobe' },
    })
    results.push(response.status)
  }
  check(
    '前 10 条都发得出去（201）',
    results.slice(0, 10).every((s) => s === 201),
    `实际 ${results.slice(0, 10).join(',')}`,
  )
  check('第 11 条起被限流 429', results.slice(10).every((s) => s === 429), `实际 ${results.slice(10).join(',')}`)

  const tooFast = await request('/api/messages', {
    method: 'POST', jar, body: { body: '再来一条', room: 'rlprobe' },
  })
  check('429 带 Retry-After', tooFast.headers.get('Retry-After') !== null, '缺 Retry-After 头')
}

section('refresh 限流')
{
  resetBuckets('register:%')
  resetBuckets('%')
  await request('/auth/register', { method: 'POST', body: { username: `${username}f`, password } })
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}f`, password },
  })
  const jar = jarFrom(login)

  // 有效 token 打满额度：每次成功都会轮换出新 token，所以要一路跟着换 cookie
  const valid = []
  for (let i = 0; i < 34; i += 1) {
    const response = await request('/auth/refresh', { method: 'POST', jar })
    valid.push(response.status)
    // jarFrom 只会覆盖已有的 key；refresh 换了新 token 也要更新
    const next = jarFrom(response)
    for (const [k, v] of Object.entries(next)) jar[k] = v
  }
  check('前 30 次 refresh 成功', valid.slice(0, 30).every((s) => s === 200), `实际 ${valid.slice(0, 30).join(',')}`)
  check('第 31 次起返回 429', valid.slice(30).every((s) => s === 429), `实际 ${valid.slice(30).join(',')}`)

  // 废 token 也必须被限住 —— 否则「限流」就是个摆设，
  // 攻击者拿一堆无效 token 打 refresh 不受任何约束（它照样写 D1）
  resetBuckets('refresh%')
  const junk = []
  for (let i = 0; i < 33; i += 1) {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: 'refresh_token=definitely-not-a-real-token' },
    })
    junk.push(response.status)
  }
  check('废 token 先正常返回 401，不是上来就挡', junk.slice(0, 30).every((s) => s === 401), `实际 ${junk.slice(0, 30).join(',')}`)
  check('废 token 打满后也被 429 限住（不是绕过限流的后门）', junk.slice(30).every((s) => s === 429), `实际 ${junk.slice(30).join(',')}`)
}

section('上传限流')
{
  /*
   * 上传是**唯一一条「限流值写死在调用点」的路由**：它原先传的是字面量 2，
   * 改阈值时很容易漏掉（这次就漏过一次，是靠人肉读代码才发现的）。
   * 所以这里补上覆盖 —— 断言方向同样是「前 10 个必须成功」，
   * 不能用「第二个就被拦」去测（那是旧的「3 秒 1 个」语义）。
   */
  resetBuckets('register:%')
  resetBuckets('%')
  await request('/auth/register', { method: 'POST', body: { username: `${username}u`, password } })
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: `${username}u`, password },
  })
  const jar = jarFrom(login)

  // 最小 PNG：8 字节魔数 + 4 字节，足够让类型嗅探认出它是图片
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const upload = () =>
    fetch(`${BASE}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'x-filename': 'rl.png', Cookie: cookieHeader(jar) },
      body: png,
    })

  const results = []
  for (let i = 0; i < 12; i += 1) {
    results.push((await upload()).status)
  }
  check('前 10 个文件传得上去（201）', results.slice(0, 10).every((s) => s === 201), `实际 ${results.slice(0, 10).join(',')}`)
  check('第 11 个起被限流 429', results.slice(10).every((s) => s === 429), `实际 ${results.slice(10).join(',')}`)

  const limited = await upload()
  check('429 带 Retry-After', limited.headers.get('Retry-After') !== null, '缺 Retry-After 头')
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
