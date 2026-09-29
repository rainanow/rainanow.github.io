// 排查脚本：直接读本地 D1 的 SQLite 文件。
// 用法：node scripts/inspect-d1.mjs
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')

// Miniflare 的本地 D1 文件名是按 database_id 派生的，所以**改了 wrangler.jsonc 里的
// database_id 之后会多出一个新的空库，旧文件仍然躺在那里**。
// 因此这里必须挑「最近修改过的那个」，否则会对着一个没人用的旧库报告，白排查半天。
const candidates = readdirSync(dir)
  .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
  .sort((left, right) => right.mtime - left.mtime)

const file = candidates[0]?.name
if (file === undefined) {
  console.error('找不到本地 D1 数据库文件')
  process.exit(1)
}
if (candidates.length > 1) {
  console.log(`（发现 ${candidates.length} 个本地库文件，读取最近修改的 ${file}）`)
  console.log('  通常意味着改过 wrangler.jsonc 的 database_id；旧文件是历史遗留，可忽略。')
}

const db = new DatabaseSync(join(dir, file), { readOnly: true })

console.log('=== users 表定义 ===')
for (const row of db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").all()) {
  console.log(row.sql)
}

console.log('\n=== users 表里的账号 ===')
const users = db.prepare('SELECT id, username, role FROM users').all()
console.log(users)

if (users.length > 0) {
  const sample = users[users.length - 1].username
  const upper = String(sample).toUpperCase()
  console.log(`\n=== 用 "${upper}" 去查（原样是 "${sample}"）===`)
  console.log(
    '不带 COLLATE:',
    db.prepare('SELECT id FROM users WHERE username = ?').all(upper).length,
  )
  console.log(
    '带 COLLATE NOCASE:',
    db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').all(upper).length,
  )
}

console.log('\n=== rate_limits ===')
console.log(db.prepare('SELECT id, hits, windowStart FROM rate_limits').all())

console.log('\n=== auth_blacklist ===')
console.log(db.prepare('SELECT id, subject, expiresAt FROM auth_blacklist').all())
