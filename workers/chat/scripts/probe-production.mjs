// 线上诊断：直接探 api.yulo.top，区分「后端没起来」和「前端/浏览器侧问题」。
// 用法：node scripts/probe-production.mjs
const API = process.env.CHAT_API ?? 'https://api.yulo.top'
const SITE = process.env.CHAT_SITE ?? 'https://yulo.top'
const ORIGIN = SITE

async function probe(label, url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const elapsed = Date.now() - started
    // 只读一次 body：Response 的 body 是一次性的，读第二遍会抛
    // "Body is unusable"。之前这里读了一遍又把 response 返回给调用方再读一遍，
    // 结果页面上所有检查都因为拿到空字符串而报 false。
    const body = await response.text()
    console.log(`\n[${label}] ${response.status} (${elapsed}ms)`)
    for (const key of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-headers',
      'content-type',
      'server',
      'cf-ray',
    ]) {
      const value = response.headers.get(key)
      if (value !== null) console.log(`    ${key}: ${value}`)
    }
    console.log(`    body: ${body.replace(/\s+/g, ' ').trim().slice(0, 200) || '(空)'}`)
    return { response, body }
  } catch (error) {
    console.log(`\n[${label}] 失败 (${Date.now() - started}ms): ${error.name} ${error.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

console.log(`探测目标：API=${API}  SITE=${SITE}`)

await probe('API 存活探针', `${API}/api/health`, { headers: { Origin: ORIGIN } })

await probe('CORS 预检 (按浏览器的方式)', `${API}/auth/register`, {
  method: 'OPTIONS',
  headers: {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
})

// 故意发一个不合法的注册请求：走完 CORS + 路由 + 校验，但不会真的建账号
await probe('注册路由（非法入参，不会建号）', `${API}/auth/register`, {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'x', password: 'short' }),
})

await probe('登录路由（不存在的账号）', `${API}/auth/login`, {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'definitely-not-a-real-user-xyz', password: 'whatever-long' }),
})

const page = await probe('博客 /chat/ 页面', `${SITE}/chat/`)
if (page !== null) {
  const html = page.body
  console.log(`    页面里有聊天室骨架: ${/id=["']?chat-app/.test(html)}`)
  const api = /data-api=["']?([^"'\s>]+)/.exec(html)
  console.log(`    页面 data-api: ${api ? api[1] : '(没找到)'}`)
  const script = /src=["']?([^"'\s>]*chat[^"'\s>]*\.js)/.exec(html)
  console.log(`    页面 chat.js: ${script ? script[1] : '❌ 没找到 —— 页面上不会有任何交互'}`)
}
