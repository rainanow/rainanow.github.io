// 一次性排查脚本：直接读本地 D1 的 SQLite 文件，确认 COLLATE NOCASE 是否真的生效。
// 用法：node scripts/inspect-d1.mjs
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const file = readdirSync(dir).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
if (file === undefined) {
  console.error('找不到本地 D1 数据库文件')
  process.exit(1)
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
