/**
 * 起一个 `STRICT_RATE_LIMIT=true` 的临时 dev server，跑限流测试，然后收摊。
 *
 * ## 为什么需要这个包装
 *
 * 本地 `.dev.vars` 里设了 `RELAX_LOCAL_LIMITS=true`（调试方便，限流阈值放大到 100 万）。
 * 而 `rate-limit-test.mjs` 断言的正是「第 21 次返回 429」这种**真实阈值** ——
 * 开关一开，它必然全红。
 *
 * 三种解法里选了自动起 server：
 *   1. 让用户记得先关掉 .dev.vars 里的开关 —— 靠人记，必然忘；
 *   2. 把限流测试并回 smoke —— smoke 就会在两种模式下表现不同，更难懂；
 *   3. 自己起一个 strict 的 server —— 跑 `npm run rate-limit-test` 就完事，
 *      不依赖开发机当前是什么状态，也不会污染已经在跑的那个 dev server。
 *
 * 端口用 8789（8787 通常是开发时自己起着的那个，别抢）。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.env.RATE_LIMIT_TEST_PORT ?? '8789'
const BASE = `http://127.0.0.1:${PORT}`

/** 轮询等 server 起来，最多 45 秒（本机 wrangler 冷启动通常 15–25 秒）。 */
async function waitForServer(deadlineMs) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${BASE}/api/health`, {
        headers: { Origin: 'https://yulo.top' },
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) return true
    } catch {
      // 还没起来，继续等
    }
    await sleep(1000)
  }
  return false
}

console.log(`起一个 strict 模式的 dev server（端口 ${PORT}，限流强制生效）…`)

/*
 * 刻意不 spawn `npx wrangler`，而是直接跑 wrangler 的 CLI 入口。
 * 原因：`spawn('npx', ...)` 在这台机器上会 ENOENT
 * （Windows 的 npx 是 npx.cmd，child_process 不带 shell 就找不到）。
 * 踩过一次（`nanoka generate` 内部也是这么炸的）。
 */
// 用 fileURLToPath 而不是 .pathname：Windows 上 .pathname 会带着盘符再被拼一次
// （踩过：拼成 'C:////C:////Users////...'，报 MODULE_NOT_FOUND）
const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))

const server = spawn(
  process.execPath,
  [WRANGLER_CLI, 'dev', '--port', PORT, '--var', 'STRICT_RATE_LIMIT:true'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  },
)

let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += String(chunk)
})
server.stderr.on('data', (chunk) => {
  serverLog += String(chunk)
})

let exitCode = 1
try {
  const ready = await waitForServer(45_000)
  if (!ready) {
    console.error('dev server 没能在 45 秒内起来。输出片段：\n' + serverLog.slice(-800))
  } else {
    const result = spawn(process.execPath, ['scripts/rate-limit-test.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, CHAT_BASE_URL: BASE },
    })
    exitCode = await new Promise((resolve) => {
      result.on('exit', (code) => resolve(code ?? 1))
    })
  }
} finally {
  server.kill()
  // 给它一点时间释放端口，否则下次跑会撞 "address already in use"
  await sleep(500)
}

process.exit(exitCode)
