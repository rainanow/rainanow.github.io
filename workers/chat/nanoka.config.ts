import { defineConfig } from '@nanokajs/core/config'

import { authBlacklistFields, authBlacklistTableName } from './src/models/auth-blacklist'
import { messageFields, messageTableName } from './src/models/message'
import { rateLimitFields, rateLimitTableName } from './src/models/rate-limit'
import { roomPurgeFields, roomPurgeTableName } from './src/models/room-purge'
import { uploadUsageFields, uploadUsageTableName } from './src/models/upload-usage'
import { userFields, userTableName } from './src/models/user'

/**
 * nanoka 的模型注册表：`npx nanoka generate` 读这里，产出 drizzle/schema.ts。
 * 注意 nanoka 只生成 Drizzle schema 代码，SQL 由 drizzle-kit 生成、由 wrangler 应用。
 */
export default defineConfig({
  models: [
    { name: userTableName, fields: userFields },
    { name: messageTableName, fields: messageFields },
    { name: authBlacklistTableName, fields: authBlacklistFields },
    { name: rateLimitTableName, fields: rateLimitFields },
    { name: uploadUsageTableName, fields: uploadUsageFields },
    { name: roomPurgeTableName, fields: roomPurgeFields },
  ],
  output: './drizzle/schema.ts',
})
