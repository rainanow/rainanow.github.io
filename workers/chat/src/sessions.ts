/** 当前设备会话与 refresh token 的轮换。 */
import type { Env } from './env'

export const CLOSE_SESSION_PATH = '/session/close'

interface StoredSession {
  sessionId: string | null
  rooms: string
}

let loginWrites = 0

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function closeSessionSockets(env: Env, userId: string, revoked: StoredSession[]): Promise<void> {
  await Promise.all(revoked.flatMap(({ sessionId, rooms }) => {
    if (sessionId === null) return []
    const visitedRooms = JSON.parse(rooms) as string[]
    return visitedRooms.map(async (room) => {
      try {
        const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room))
        const response = await stub.fetch('https://chat-room.internal' + CLOSE_SESSION_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, sessionId }),
        })
        if (!response.ok) console.error('关闭已吊销的连接失败', { room, status: response.status })
      } catch (error) {
        console.error('关闭已吊销的连接失败', { room, error })
      }
    })
  }))
}

/** 新登录替换旧会话，选中的设备由数据库事务顺序决定。 */
export async function replaceSession(env: Env, userId: string, jti: string, expiresAt: number): Promise<string | null> {
  const db = env.DB
  const changes = [
    db.prepare('DELETE FROM user_sessions WHERE userId = ?1 RETURNING sessionId, rooms').bind(userId),
    db.prepare(`INSERT INTO user_sessions (jti, userId, expiresAt, sessionId)
      SELECT ?1, id, ?3, ?1 FROM users WHERE id = ?2 RETURNING sessionId, rooms`)
      .bind(jti, userId, expiresAt),
  ]
  if (++loginWrites % 16 === 0) {
    changes.push(db.prepare('DELETE FROM user_sessions WHERE expiresAt < ?1').bind(nowSeconds()))
  }
  const [revoked, inserted] = await db.batch<StoredSession>(changes)
  await closeSessionSockets(env, userId, revoked?.results ?? [])
  return inserted?.results[0]?.sessionId ?? null
}

export async function isSessionActive(db: D1Database, jti: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM user_sessions WHERE jti = ?1 AND expiresAt >= ?2')
    .bind(jti, nowSeconds()).first()
  return row !== null
}

/** 刷新只更新传入令牌对应的现有行，所以并行登录或退出后，旧设备不能重新获得会话。 */
export async function rotateSession(
  db: D1Database,
  userId: string,
  previousJti: string,
  nextJti: string,
  expiresAt: number,
): Promise<string | null> {
  const [rotated] = await db.batch<StoredSession>([
    db.prepare(`UPDATE user_sessions
      SET sessionId = COALESCE(sessionId, jti), jti = ?3, expiresAt = ?4
      WHERE userId = ?1 AND jti = ?2 AND expiresAt >= ?5
        AND EXISTS (SELECT 1 FROM users WHERE id = ?1)
        AND (sessionId IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM user_sessions WHERE userId = ?1 AND sessionId IS NOT NULL
        ))
      RETURNING sessionId, rooms`).bind(userId, previousJti, nextJti, expiresAt, nowSeconds()),
    // 升级前的多条会话中，只保留实际完成刷新的一条。
    db.prepare(`DELETE FROM user_sessions WHERE userId = ?1 AND sessionId IS NULL
      AND EXISTS (SELECT 1 FROM user_sessions WHERE jti = ?2 AND userId = ?1)`).bind(userId, nextJti),
  ])
  return rotated?.results[0]?.sessionId ?? null
}

const ACTIVE_SESSION = `FROM user_sessions AS s JOIN users AS u ON u.id = s.userId
  WHERE s.userId = ?1 AND s.sessionId = ?2 AND s.expiresAt >= ?3`

export async function isAccessActive(db: D1Database, userId: string, sessionId: string): Promise<boolean> {
  return await db.prepare('SELECT 1 ' + ACTIVE_SESSION).bind(userId, sessionId, nowSeconds()).first() !== null
}

/** 记录房间和验证会话在同一事务内进行，避免登录替换时漏掉刚握手的房间。 */
export async function openSessionRoom(
  db: D1Database,
  userId: string,
  sessionId: string,
  room: string,
): Promise<{ username: string } | undefined> {
  const now = nowSeconds()
  const [, members] = await db.batch<{ username: string }>([
    db.prepare(`UPDATE user_sessions SET rooms = json_insert(rooms, '$[#]', ?4)
      WHERE userId = ?1 AND sessionId = ?2 AND expiresAt >= ?3
        AND NOT EXISTS (SELECT 1 FROM json_each(rooms) WHERE value = ?4)`).bind(userId, sessionId, now, room),
    db.prepare('SELECT u.username ' + ACTIVE_SESSION).bind(userId, sessionId, now),
  ])
  return members?.results[0]
}

/** 批量查验房间会话。D1 单条语句的绑定参数有限，按小批次查询。 */
export async function currentSessions(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < userIds.length; offset += 80) {
    const group = userIds.slice(offset, offset + 80)
    const bindings = group.map(() => '?').join(',')
    statements.push(db.prepare(`SELECT s.userId, s.sessionId
      FROM user_sessions AS s JOIN users AS u ON u.id = s.userId
      WHERE s.expiresAt >= ? AND s.sessionId IS NOT NULL AND s.userId IN (${bindings})`)
      .bind(nowSeconds(), ...group))
  }
  if (statements.length === 0) return new Map()
  const results = await db.batch<{ userId: string; sessionId: string }>(statements)
  return new Map(results.flatMap(({ results }) => results.map(({ userId, sessionId }) => [userId, sessionId])))
}

export async function revokeSession(env: Env, userId: string, field: 'sessionId' | 'jti', value: string): Promise<void> {
  const revoked = await env.DB.prepare(`DELETE FROM user_sessions
    WHERE userId = ?1 AND ${field} = ?2 RETURNING sessionId, rooms`).bind(userId, value).all<StoredSession>()
  await closeSessionSockets(env, userId, revoked.results)
}

/** 账号注销或改密码与会话吊销一并提交，再关闭已建立的连接。 */
export async function revokeAllSessions(env: Env, userId: string, updateUser: D1PreparedStatement): Promise<number> {
  const [, revoked] = await env.DB.batch<StoredSession>([
    updateUser,
    env.DB.prepare('DELETE FROM user_sessions WHERE userId = ?1 RETURNING sessionId, rooms').bind(userId),
  ])
  const sessions = revoked?.results ?? []
  await closeSessionSockets(env, userId, sessions)
  return sessions.length
}
