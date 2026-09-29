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
 * 所以这里把两个不变式固定下来，别再靠肉眼抽查：
 *   1. /chat/ 必须加载 chat.js
 *   2. 其它**任何**页面都不许出现 chat.js 或聊天室骨架
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

const isChatPage = (path) => path === 'chat/index.html'
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

console.log('聊天室页面')
check('存在 /chat/ 页面', chatPages.length === 1, `实际找到 ${chatPages.length} 个`)
check(
  '/chat/ 加载了 chat.js',
  withScript.some(isChatPage),
  `实际加载 chat.js 的页面：${withScript.join(', ') || '（无）'}`,
)
check('/chat/ 里有聊天室骨架', withShell.some(isChatPage))

console.log('\n其它页面不该带聊天室资源')
const strayScript = withScript.filter((path) => !isChatPage(path))
const strayShell = withShell.filter((path) => !isChatPage(path))
check('没有别的页面加载 chat.js（防 partialCached 串页）', strayScript.length === 0, strayScript.join(', '))
check('没有别的页面出现聊天室骨架', strayShell.length === 0, strayShell.join(', '))

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
