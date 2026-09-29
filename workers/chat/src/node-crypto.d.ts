/**
 * 只为 `node:crypto` 的 scrypt 声明我们真正用到的那一小片类型。
 *
 * 为什么不直接装 `@types/node`：那会把整套 Node 全局（`fetch` / `Request` / `Response` /
 * `WebSocket` / `crypto` / `Buffer` …）一起塞进全局作用域，和 `@cloudflare/workers-types`
 * 正面冲突。Nanoka 的文档也专门提醒过别把 Node 全局混进 Workers 项目。
 * 这里按需声明，语义明确、零副作用。
 *
 * 运行时的可用性前提：wrangler.jsonc 里开了 `nodejs_compat`。
 */
declare module 'node:crypto' {
  export interface ScryptOptions {
    /** CPU/内存代价，必须是大于 1 的 2 的幂。 */
    N: number
    /** 块大小。 */
    r: number
    /** 并行度。 */
    p: number
    /** 内存上限；Node 要求至少是 128 * N * r。 */
    maxmem?: number
  }

  /**
   * 异步 scrypt。原生实现、走线程池，不在 isolate 主线程上跑——
   * 这正是它能在 Workers 免费套餐 10ms CPU 预算里活下来的原因。
   */
  export function scrypt(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void
}
