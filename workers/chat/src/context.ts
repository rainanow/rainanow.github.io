import type { AuthInstance } from '@nanokajs/auth'
import type { Nanoka, NanokaModel } from '@nanokajs/core'

import type { Env } from './env'
import type { messageFields } from './models/message'
import type { roomPurgeFields } from './models/room-purge'
import type { userPurgeFields } from './models/user-purge'
import type { userFields } from './models/user'

export type MessageModel = NanokaModel<typeof messageFields>
export type UserModel = NanokaModel<typeof userFields>
export type RoomPurgeModel = NanokaModel<typeof roomPurgeFields>
export type UserPurgeModel = NanokaModel<typeof userPurgeFields>

/**
 * 由 JWT 中间件验签后填入，使用时收窄 claim 的类型。
 */
export type AppEnv = {
  Bindings: Env
  Variables: { user: Record<string, unknown>; refreshJti?: string }
}

export type ChatApp = Nanoka<AppEnv>

/** 路由注册函数需要的全部依赖，由 app.ts 一次性构建后传下去。 */
export interface ChatContext {
  app: ChatApp
  User: UserModel
  Message: MessageModel
  /** 「清空房间」的审计流水。硬删留不下痕迹，只能靠这张表。 */
  RoomPurge: RoomPurgeModel
  UserPurge: UserPurgeModel
  auth: AuthInstance
}
