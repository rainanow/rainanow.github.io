import type { AuthInstance } from '@nanokajs/auth'
import type { Nanoka, NanokaModel } from '@nanokajs/core'

import type { Env } from './env'
import type { messageFields } from './models/message'
import type { roomPurgeFields } from './models/room-purge'
import type { userFields } from './models/user'

export type MessageModel = NanokaModel<typeof messageFields>
export type UserModel = NanokaModel<typeof userFields>
export type RoomPurgeModel = NanokaModel<typeof roomPurgeFields>

/**
 * access token 里只有 `sub` 和 `type`（`@nanokajs/auth` 就是这么签的），
 * 所以这里按 `Record<string, unknown>` 接，用到时再逐个做运行时收窄。
 */
export type AppEnv = {
  Bindings: Env
  Variables: { user: Record<string, unknown> }
}

export type ChatApp = Nanoka<AppEnv>

/** 路由注册函数需要的全部依赖，由 app.ts 一次性构建后传下去。 */
export interface ChatContext {
  app: ChatApp
  User: UserModel
  Message: MessageModel
  /** 「清空房间」的审计流水。硬删留不下痕迹，只能靠这张表。 */
  RoomPurge: RoomPurgeModel
  auth: AuthInstance
}
