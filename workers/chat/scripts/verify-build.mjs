/**
 * 构建产物归属校验（不需要 dev server，构建完就能跑）。
 *
 * 存在的理由是踩过一次线上事故：PaperMod 的 baseof.html 用
 *   {{ partialCached "footer.html" . .Layout .Kind ... }}
 * 调用 footer，缓存键里**没有页面路径**，于是 /chat/ 和每篇普通文章页共用同一个
 * 缓存条目——谁先渲染谁决定那组页面的内容。当时聊天室的 <script> 写在
 * extend_footer.html 里，本地构建恰好 /chat/ 先渲染所以看起来正常，
 * 上线后 CI 换成别的页面先渲染，/chat/ 就彻底没有 JS 了。
 *
 * 所以这里把这些不变式固定下来，别再靠肉眼抽查：
 *   1. /chat/ 必须加载 chat.js
 *   2. 其它**任何**页面都不许出现 chat.js 或聊天室骨架
 *   3. 页面上输入框的 maxlength 必须等于后端 config.ts 里的 MAX_MESSAGE_LENGTH
 *      （第 3 条是后来加的：那个数字原先在后端两处、前端一处各写一遍，
 *       而常量本身没人 import。现在两边各有一个来源，靠这条检查钉住）
 *
 * 用法：hugo 构建之后 `node scripts/verify-build.mjs`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = process.env.PUBLIC_DIR ?? '../../../public'
const ROOT = fileURLToPath(new URL(PUBLIC_DIR + '/', import.meta.url))

/** 匹配任何指向 /js/chat*.js 的 script src（不管 Hugo 的指纹命名怎么变）。 */
const CHAT_SCRIPT = /<script[^>]*src=["']?[^"'\s>]*\/js\/chat[^"'\s>]*\.js/i
const CHAT_SHELL = /id=["']?chat-app/i

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else if (entry.name.endsWith('.html')) found.push(full)
  }
  return found
}

let pages
try {
  pages = walk(ROOT)
} catch (error) {
  console.error(`读不到构建产物：${error.message}`)
  console.error(`（找的是 ${ROOT} —— 先跑一次 \`hugo\` 再执行本脚本）`)
  process.exit(1)
}

// 统一用相对 public/ 的路径，跟工作目录无关
const rel = (page) => relative(ROOT, page).split('\\').join('/')

let withScript = []
let withShell = []

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  if (CHAT_SCRIPT.test(html)) withScript.push(rel(page))
  if (CHAT_SHELL.test(html)) withShell.push(rel(page))
}

/**
 * 聊天室页面 = /chat/ 本身，以及它下面的房间页 /chat/<房间>/。
 *
 * 早先这里写死成 `path === 'chat/index.html'`，是因为当时只有一个房间；
 * 现在一个房间一个页面，再写死就会把新房间误判成「串页」。
 * 判定标准仍然是「路径在 /chat/ 下」，而不是「必须有聊天室」，所以
 * 万一脚本又漏到 about/ 或文章页上，还是会被抓出来。
 */
const isChatPage = (path) => path === 'chat/index.html' || /^chat\/[^/]+\/index\.html$/.test(path)
const chatPages = pages.map(rel).filter(isChatPage)

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

console.log(`构建产物检查：共 ${pages.length} 个 HTML 文件\n`)

console.log(`聊天室页面（共 ${chatPages.length} 个：${chatPages.join(', ')}）`)
check('存在 /chat/ 页面', chatPages.includes('chat/index.html'))

// 逐个房间页检查，而不是只看 /chat/ —— 新加的房间页漏了脚本同样要拦住
const chatMissingScript = chatPages.filter((path) => !withScript.includes(path))
check(
  '每个聊天室页面都加载了 chat.js',
  chatMissingScript.length === 0,
  chatMissingScript.length > 0 ? `缺脚本：${chatMissingScript.join(', ')}` : '',
)
const chatMissingShell = chatPages.filter((path) => !withShell.includes(path))
check(
  '每个聊天室页面都有聊天室骨架',
  chatMissingShell.length === 0,
  chatMissingShell.length > 0 ? `缺骨架：${chatMissingShell.join(', ')}` : '',
)

console.log('\n其它页面不该带聊天室资源')
const strayScript = withScript.filter((path) => !isChatPage(path))
const strayShell = withShell.filter((path) => !isChatPage(path))
check('没有别的页面加载 chat.js（防 partialCached 串页）', strayScript.length === 0, strayScript.join(', '))
check('没有别的页面出现聊天室骨架', strayShell.length === 0, strayShell.join(', '))

/**
 * 消息长度上限：前端和后端各有一个来源，这里是它们之间的焊缝。
 *
 *  - 后端：`workers/chat/src/config.ts` 的 `MAX_MESSAGE_LENGTH`（校验 + 表约束都读它）
 *  - 前端：`hugo.toml` 的 `params.chat.maxMessageLength`（渲染成输入框的 maxlength）
 *
 * 以前这个数字在三处各写一遍、常量本身没人 import，改一处就不同步。
 * 现在两侧各有单一来源，但「它们相等」这件事仍然需要有人检查——
 * 不然就会出现「前端让输 800 字、后端 400」。
 *
 * 做法：从源码里正则抠出常量值，再从构建产物里抠出 maxlength，两边比。
 * 用正则而不是 import，是因为这个脚本刻意保持零第三方依赖、且要能在
 * 没有 npm install 的 CI 环境里跑（CI 里就是这样直接 node 跑的）。
 */
console.log('\n消息长度上限：前后端是否一致')
{
  const configPath = fileURLToPath(new URL('../src/config.ts', import.meta.url))
  let backendLimit = null
  try {
    const source = readFileSync(configPath, 'utf8')
    const matched = /export const MAX_MESSAGE_LENGTH\s*=\s*(\d+)/.exec(source)
    if (matched !== null) backendLimit = Number.parseInt(matched[1], 10)
  } catch (error) {
    console.log(`  （读不到 ${configPath}：${error.message}）`)
  }

  check(
    '能从 config.ts 里读出 MAX_MESSAGE_LENGTH',
    backendLimit !== null && Number.isFinite(backendLimit),
    `实际 ${backendLimit}`,
  )

  if (backendLimit !== null) {
    const chatIndexPath = join(ROOT, 'chat/index.html')
    let frontendLimit = null
    try {
      const html = readFileSync(chatIndexPath, 'utf8')
      const matched = /<textarea[^>]*maxlength=["']?(\d+)/i.exec(html)
      if (matched !== null) frontendLimit = Number.parseInt(matched[1], 10)
    } catch {
      // 上面已经检查过 /chat/ 存在，这里读不到就让它以 null 落下去报错
    }

    check(
      `/chat/ 的输入框带上了 maxlength`,
      frontendLimit !== null,
      `没在 ${chatIndexPath} 里找到 maxlength`,
    )
    check(
      `前后端消息长度上限一致（后端 ${backendLimit}）`,
      frontendLimit === backendLimit,
      `前端 ${frontendLimit} ≠ 后端 ${backendLimit} —— 改 hugo.toml 的 params.chat.maxMessageLength`,
    )
  }
}

/**
 * 后端源码不变量。
 *
 * ## 为什么这一类只能做静态断言
 *
 * 下面每一条讲的都是「某个东西必须出现在另一条语句的**前面/里面**」——
 * 位置、包含关系、顺序。这些没法用 HTTP 断言出来：
 *
 *   - 「会话校验排在限流之后」：要证明它，得拿一个已吊销的令牌打满一个窗口，
 *     再断言第 N 次是 429 —— 而本地限流被放宽了，那条断言在开发机上永远绿。
 *   - 「广播失败不抛给调用方」：要证明它，得让 Durable Object 在测试中途挂掉。
 *
 * 所以这里退一步，直接检查源码结构。**这比没有强，但要知道它弱在哪**：
 * 它拦得住「有人把这段逻辑挪走/删掉」，拦不住「逻辑还在、但写错了」。
 * 真正跑得起来的那部分交给 smoke 和 frontend-test。
 *
 * 断言一律先确认「锚点字符串还在」，再比位置。反过来写的话，一次改名会让
 * `indexOf` 返回 -1、比较结果碰巧为真 —— 断言变成空转，那还不如不写。
 */
console.log('\n后端源码不变量（顺序 / 包含关系这类没法用 HTTP 断言的）')
{
  const readSource = (relativePath) => {
    try {
      return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
    } catch (error) {
      console.log(`  （读不到 ${relativePath}：${error.message}）`)
      return ''
    }
  }

  const authSource = readSource('../src/routes/auth.ts')
  const roomSource = readSource('../src/room.ts')
  const typesSource = readSource('../src/types.ts')
  const moderationSource = readSource('../src/moderation.ts')
  const chatSource = readSource('../src/routes/chat.ts')

  // ① refresh：会话校验必须在限流之后。
  // 放在前面等于给「已吊销但仍验签通过的令牌」开了一条无限可打的免费路径。
  const throttleAnchor = authSource.indexOf('const refreshThrottle')
  const consumeAnchor = authSource.indexOf('await consumeRateLimit', throttleAnchor)
  const sessionAnchor = authSource.indexOf('isSessionActive(c.env.DB, pendingJti)', consumeAnchor)
  check('auth.ts 里能找到 refreshThrottle 的限流调用', consumeAnchor !== -1, `位置 ${consumeAnchor}`)
  check(
    'refresh 的会话校验排在限流之后（否则被吊销的令牌可无限打）',
    sessionAnchor !== -1 && consumeAnchor !== -1 && sessionAnchor > consumeAnchor,
    `限流在 ${consumeAnchor}，会话校验在 ${sessionAnchor}`,
  )

  // ② 登出：必须有独立限流（它每次都要往 auth_blacklist 写一行）
  check(
    '/auth/logout 挂了限流中间件',
    /app\.post\(\s*'\/auth\/logout'\s*,\s*logoutThrottle/.test(authSource),
    '找不到 logoutThrottle —— 登出会变成一条无门槛的 D1 写路径',
  )

  // ③ 广播：必须内部吞掉异常。
  // 判定用「try 出现在 await stub.fetch 之前」，而不是简单找 try/catch ——
  // 后者在函数里随便哪里有个 try 都会为真。
  const broadcastStart = chatSource.indexOf('async function broadcast')
  const broadcastEnd = chatSource.indexOf('export function registerChatRoutes')
  const broadcastBody =
    broadcastStart === -1 || broadcastEnd <= broadcastStart
      ? ''
      : chatSource.slice(broadcastStart, broadcastEnd)
  check('能在 chat.ts 里切出 broadcast 函数体', broadcastBody.length > 0)
  const tryAt = broadcastBody.indexOf('try {')
  const fetchAt = broadcastBody.indexOf('await stub.fetch')
  check(
    'broadcast 里的 stub.fetch 包在 try 里（广播失败不能报成写入失败）',
    tryAt !== -1 && fetchAt !== -1 && tryAt < fetchAt,
    `try 在 ${tryAt}，fetch 在 ${fetchAt}`,
  )

  // ④ WebSocket 的寿命上限：exp 记进 attachment，广播前踢掉过期的
  check('SocketAttachment 带上了令牌到期时间 exp', /exp:\s*number/.test(typesSource))
  check('握手时确认这个人还有活着的会话', /FROM user_sessions WHERE userId = u\.id/.test(roomSource))
  check('广播前会踢掉已过期的连接', /evictIfExpired\(ws\)/.test(roomSource))

  // ⑤ 禁言：必须区分「字段缺失」（400）与「显式 null」（解除禁言）
  check(
    '禁言区分了「没有 minutes 字段」和「minutes 是 null」',
    /'minutes'\s+in\s+body/.test(moderationSource),
    "少了这条，一个残缺请求会被当成「解除禁言」并返回 200",
  )

  /*
   * ⑥ 配额键名：quota.ts 造键、smoke.mjs 直接往 D1 里塞账本，两边必须一致。
   *
   * 这是**唯一**能让这条测试静默失效的地方：键名对不上不会报错，
   * smoke 只会表现成「额度明明塞满了却还能传」—— 一个看起来像 bug、
   * 实际是测试自己写错的现象。和 MAX_MESSAGE_LENGTH 那条同一个性质：
   * 跨文件共享的字符串常量，只能靠一条自动检查钉住。
   */
  const quotaSource = readSource('../src/quota.ts')
  const smokeSource = readSource('./smoke.mjs')
  const quotaKey = (pattern, label) => {
    check(`${label}（quota.ts 里有构造函数）`, pattern.test(quotaSource), '找不到这个键的构造')
  }
  quotaKey(/`daily:user:\$\{userId\}:\$\{day\}`/, '每日·按用户')
  quotaKey(/`daily:global:\$\{day\}`/, '每日·全站')
  quotaKey(/`total:user:\$\{userId\}`/, '累计·按用户')
  quotaKey(/'total:global'/, '累计·全站')
  check(
    'smoke.mjs 塞账本用的键与之一致',
    smokeSource.includes("'total:global'") && /daily:global:\$\{day\}/.test(smokeSource),
    'smoke 里塞的键和 quota.ts 不一致 —— 这条一旦漂移，配额测试会变成空转',
  )

  /*
   * ⑦ 全站请求熔断必须挂在 CORS **之后**。
   *
   * 挂在前面的话，被熔断时的 429 不带 CORS 头，浏览器把它显示成跨域错误，
   * 前端那句「今天到上限了」永远到不了用户眼前 —— 和登出限流那次是同一类坑。
   */
  const appSource = readSource('../src/app.ts')
  const corsAnchor = appSource.indexOf('cors({')
  const breakerAnchor = appSource.indexOf("app.use('*', globalRequestLimit)")
  check('app.ts 里挂了全站请求熔断', breakerAnchor !== -1, `位置 ${breakerAnchor}`)
  check(
    '熔断挂在 CORS 之后（否则 429 响应没有 CORS 头）',
    corsAnchor !== -1 && breakerAnchor !== -1 && breakerAnchor > corsAnchor,
    `CORS 在 ${corsAnchor}，熔断在 ${breakerAnchor}`,
  )

  /*
   * ⑧ 上传上限：前端那份数字必须等于后端那份。
   *
   * 和 `MAX_MESSAGE_LENGTH` 完全同一个性质 —— 跨构建共享的常量只能靠一条
   * 自动检查钉住。上限在**前端**是「提前拦住 + 提示文案里的数字」，
   * 在**后端**是真正的门禁；两边漂了不会报任何错，只会变成
   * 「文案说 16 MB、后端其实放行 100 MB」（或者反过来，前端拦住了后端允许的文件）。
   *
   * 读源码而不是构建产物：chat.js 会被 Hugo 指纹化 + 压缩，
   * 而这两个数字在源码里本来就是明文常量。
   *
   * 只认**声明行**（`export const X = …` / `var X = …`）：
   * 两个文件里都有大段注释在解释这两个常量，不限定形式就会命中注释。
   */
  const chatJsSource = readSource('../../../assets/js/chat.js')
  const configSource = readSource('../src/config.ts')
  const readNumber = (source, name) => {
    const pattern = new RegExp(
      `(?:export\\s+const|var)\\s+${name}\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)`,
    )
    const matched = pattern.exec(source)
    if (matched === null) return null
    return matched[1]
      .split('*')
      .reduce((total, piece) => total * Number.parseInt(piece.trim().replace(/_/g, ''), 10), 1)
  }

  for (const name of ['MAX_UPLOAD_BYTES', 'MAX_UPLOAD_BYTES_ADMIN']) {
    const frontendValue = readNumber(chatJsSource, name)
    const backendValue = readNumber(configSource, name)
    check(
      `能读出前后端的 ${name}`,
      frontendValue !== null && backendValue !== null,
      `前端 ${frontendValue} / 后端 ${backendValue}`,
    )
    check(
      `${name} 前后端一致`,
      frontendValue !== null && frontendValue === backendValue,
      `前端 ${frontendValue} ≠ 后端 ${backendValue} —— 改 config.ts 时要一起改 chat.js`,
    )
  }

  /*
   * ⑨ 大文件必须走流式。
   *
   * 这一条**本地测不出来**：把 100 MB `arrayBuffer()` 进内存，在开发机上
   * 只是慢一点，只有线上才会撞 128 MB 内存 / 10 ms CPU 那两道墙
   * （表现是 1102，请求被运行时掐掉）。所以这里退一步，把「实现方式」
   * 钉在源码上：有人哪天图省事把它改回「读进内存再传」，这条会红。
   */
  const mediaSource = readSource('../src/routes/media.ts')
  check(
    '大文件那一档用 FixedLengthStream 包流（R2 只收长度已知的流）',
    /new FixedLengthStream\(/.test(mediaSource),
    'R2 的 put 会抛「Provided readable stream must have a known length」',
  )
  check(
    '流式之前只嗅探开头几个字节（不能整份读进内存）',
    /await readHead\(/.test(mediaSource),
  )
  check(
    '只有超过普通用户上限时才走流式',
    /if \(declared > MAX_UPLOAD_BYTES\)/.test(mediaSource),
  )
  check(
    '没有 Content-Length 就拒掉（否则 chunked 那条路会把请求体全读进内存）',
    /411/.test(mediaSource),
  )
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
