import { defineConfig } from 'drizzle-kit'

/**
 * 只用 `drizzle-kit generate` 产出 SQL，应用交给 `wrangler d1 migrations apply`。
 *
 * 这里刻意不写 `driver: 'd1-http'`：那个驱动是给 `drizzle-kit push/studio` 直连远端 D1 用的，
 * 需要 accountId / databaseId / API token。生成 SQL 阶段用不到，写上反而多一层鉴权依赖。
 */
export default defineConfig({
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
})
