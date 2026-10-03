/**
 * 逐环节计时 —— 找出「哪一步慢」和「哪一步贵」。
 *
 * 动机：这次改动量很大，人工感觉「慢、耗得多」，但说不清慢在哪。
 * 于是把它拆成可测的环节：每个环节单独计时，再跑三遍取中位数
 * （单次会被磁盘缓存、CPU 抢占干扰，三遍才看得出稳定值）。
 *
 * 顺带统计 **scrypt 的 CPU 开销** —— 登录和改密码都跑 scrypt，
 * 它是这个 Worker 里唯一「故意很慢」的东西，值得单独量。
 *
 * 用法：node scripts/profile.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const PORT = '8790'
const BASE = `http://127.0.0.1:${PORT}`
const REPEATS = 3

/**
 * 跑一条命令，三遍取中位数。
 *
 * 用**异步** spawn 而不是 spawnSync：后者在这台机器上会 `EBUSY`
 * （同步起 cmd.exe 被沙箱拦了），而异步 spawn 没问题 ——
 * 同理 `wrangler dev` 也必须用 run_in_background 起。
 * 踩过之后记在这里，免得下一个人又写回 spawnSync 然后对着「2ms、退出码 null」纳闷。
 */
async function run(label, args, cwd) {
  const samples = []
  let last = { code: 0, lines: 0, error: null }
  for (let i = 0; i < REPEATS; i += 1) {
    const started = performance.now()
    last = await runOnce(args, cwd)
    samples.push(performance.now() - started)
  }
  return { label, ms: Math.round(median(samples)), ...last }
}

function runOnce(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { cwd, shell: true })
    let output = ''
    let error = null
    child.stdout?.on('data', (c) => { output += c })
    child.stderr?.on('data', (c) => { output += c })
    child.on('error', (e) => { error = String(e.message ?? e) })
    child.on('exit', (code) => {
      resolve({ code, lines: output.split('\n').length, error })
    })
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 计时一个异步操作，成功返回毫秒数，失败抛错。 */
async function timeIt(fn) {
  const started = performance.now()
  await fn()
  return performance.now() - started
}

async function waitForServer(deadlineMs) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const r = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://yulo.top' }, signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
    } catch { /* 继续等 */ }
    await sleep(1000)
  }
  return false
}

const rows = []
function record(阶段, 环节, ms, note = '') {
  rows.push({ 阶段, 环节, ms: Math.round(ms), note })
  // 实时回显：这个脚本整体要跑两三分钟，中途没有任何输出会让人以为卡死。
  console.log(`      ${环节} → ${Math.round(ms)}ms`)
}

console.log(`起 dev server（端口 ${PORT}）…`)
const server = spawn(process.execPath, [WRANGLER_CLI, 'dev', '--port', PORT, '--var', 'RELAX_LOCAL_LIMITS:true'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
})
let log = ''
server.stdout.on('data', (c) => { log += c })
server.stderr.on('data', (c) => { log += c })

try {
  if (!(await waitForServer(50_000))) {
    console.error('server 没起来：\n' + log.slice(-600))
    process.exit(1)
  }
  console.log('server ready，开始测量\n')

  const jar = {}
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const harvest = (r) => {
    for (const l of r.headers.getSetCookie?.() ?? []) {
      const p = l.split(';')[0] ?? ''
      const i = p.indexOf('=')
      if (i === -1) continue
      jar[p.slice(0, i).trim()] = p.slice(i + 1).trim()
    }
  }
  const req = (path, o = {}) =>
    fetch(BASE + path, {
      method: o.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: cookie() },
      body: o.body ? JSON.stringify(o.body) : undefined,
    }).then((r) => { harvest(r); return r })

  // --- 阶段 1：构建 ---
  console.log('阶段 1：构建')
  {
    const r = await run('hugo build', ['hugo --minify --baseURL https://yulo.top/ --destination public'], '../..')
    record('构建', 'hugo build', r.ms, `退出码 ${r.code}`)
  }

  // --- 阶段 2：类型检查 ---
  console.log('阶段 2：类型检查')
  {
    const r = await run('tsc --noEmit', ['node node_modules/typescript/bin/tsc --noEmit'], '.')
    record('类型检查', 'tsc --noEmit', r.ms, `退出码 ${r.code}`)
  }

  // --- 阶段 3：scrypt（CPU 大头）---
  console.log('阶段 3：scrypt 密码哈希（CPU 大头）')
  const u = 'p' + Date.now().toString(36).slice(-6)
  for (let i = 0; i < REPEATS; i += 1) {
    await req('/auth/register', { method: 'POST', body: { username: `${u}c${i}`, password: 'profile-password-1' } })
    const ms = await timeIt(() =>
      req('/auth/login', { method: 'POST', body: { username: `${u}c${i}`, password: 'profile-password-1' } }),
    )
    record('scrypt', '注册（1 次 hash）', ms)
  }
  // 登录 = 1 次 verify（比 hash 便宜一点）
  {
    await req('/auth/register', { method: 'POST', body: { username: `${u}lv`, password: 'profile-password-1' } })
    const ms = await timeIt(() => req('/auth/login', { method: 'POST', body: { username: `${u}lv`, password: 'profile-password-1' } }))
    record('scrypt', '登录（1 次 verify）', ms)
  }

  // --- 阶段 4：改密码（2 次 scrypt：verify + hash）---
  console.log('阶段 4：改密码（最重的写接口）')
  {
    await req('/auth/register', { method: 'POST', body: { username: `${u}pw`, password: 'profile-password-1' } })
    const lg = await req('/auth/login', { method: 'POST', body: { username: `${u}pw`, password: 'profile-password-1' } })
    const jar2 = {}
    for (const l of lg.headers.getSetCookie?.() ?? []) {
      const p = l.split(';')[0] ?? ''
      const i = p.indexOf('=')
      if (i !== -1) jar2[p.slice(0, i).trim()] = p.slice(i + 1).trim()
    }
    const ms = await timeIt(() =>
      fetch(`${BASE}/api/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar2).map(([k, v]) => `${k}=${v}`).join('; ') },
        body: JSON.stringify({ currentPassword: 'profile-password-1', newPassword: 'profile-password-2' }),
      }),
    )
    record('scrypt', '改密码（verify + hash 各 1 次）', ms)
  }

  // --- 阶段 5：常用接口 ---
  console.log('阶段 5：常用接口')
  await req('/auth/register', { method: 'POST', body: { username: `${u}api`, password: 'profile-password-1' } })
  await req('/auth/login', { method: 'POST', body: { username: `${u}api`, password: 'profile-password-1' } })
  {
    const ms = await timeIt(() => req('/api/me'))
    record('接口', 'GET /api/me', ms)
  }
  {
    const ms = await timeIt(() => req('/api/messages?room=general'))
    record('接口', 'GET /api/messages（历史一页）', ms)
  }
  {
    const ms = await timeIt(() => req('/api/members'))
    record('接口', 'GET /api/members（500 行上限）', ms)
  }
  {
    const ms = await timeIt(() => req('/api/members?scope=online'))
    record('接口', 'GET /api/members?scope=online', ms, '不读 users 表')
  }
  {
    const ms = await timeIt(() => req('/api/members?room=nonexistent'))
    record('接口', 'GET /api/members（空房间，DO 查询）', ms)
  }
  {
    const ms = await timeIt(() =>
      req('/api/messages', { method: 'POST', body: { body: '计时用消息', room: 'general' } }),
    )
    record('接口', 'POST /api/messages（发一条）', ms)
  }
  await sleep(2200)
  {
    const ms = await timeIt(() => req('/api/messages/00000000-0000-4000-8000-000000000000', { method: 'DELETE' }))
    record('接口', 'DELETE /api/messages/:id（不存在）', ms, '只走限流 + 一次查库')
  }

  // --- 阶段 6：测试套件 ---
  console.log('阶段 6：测试套件（最长的几项）')
  for (const [name, args] of [
    ['verify-build', ['scripts/verify-build.mjs']],
    ['purge-test', ['scripts/purge-test.mjs']],
    ['smoke', ['scripts/smoke.mjs']],
    ['frontend-test', ['scripts/frontend-test.mjs']],
  ]) {
    const r = await run(name, ['node ' + args.join(' ')], '.')
    record('测试套件', name, r.ms, `退出码 ${r.code}，输出 ${r.lines} 行`)
  }
} finally {
  server.kill()
  await sleep(400)
}

// --- 输出表格 ---
console.log('\n' + '='.repeat(78))
console.log('逐环节计时（三遍取中位数，单位毫秒）')
console.log('='.repeat(78))
console.log('阶段'.padEnd(12) + '环节'.padEnd(34) + '耗时'.padStart(8) + '  备注')
console.log('-'.repeat(78))
let lastStage = ''
for (const r of rows) {
  const stage = r.阶段 === lastStage ? '' : r.阶段
  lastStage = r.阶段
  console.log(
    stage.padEnd(12) +
    r.环节.padEnd(34) +
    String(r.ms).padStart(8) +
    '  ' +
    r.note,
  )
}
console.log('-'.repeat(78))
const total = rows.reduce((sum, r) => sum + r.ms, 0)
console.log('合计'.padEnd(46) + String(total).padStart(8) + '  （含重复跑的，真实一轮只跑一次）')
