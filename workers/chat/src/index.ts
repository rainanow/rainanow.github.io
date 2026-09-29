import { getChatApp } from './app'
import type { Env } from './env'

// Durable Object 类必须从入口文件导出，wrangler 才能把它和
// wrangler.jsonc 里 `durable_objects.bindings` 的 class_name 对上。
export { ChatRoom } from './room'

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const { app } = getChatApp(env)
    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
