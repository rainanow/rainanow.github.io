import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'

import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_ADMIN,
  UPLOAD_ALLOWED_PER_WINDOW,
  UPLOAD_WINDOW_SECONDS,
} from '../config'
import type { AppEnv, ChatContext } from '../context'
import { buildMediaKey, detectMedia, isMediaKey, sanitizeFilename } from '../media'
import { cookieAuthBridge } from '../middleware'
import { checkUploadQuota, markUpload, quotaDay } from '../quota'
import { isMuted, mutedRemaining } from '../moderation'
import { consumeRateLimit, effectiveLimit } from '../rate-limit'

function requireSubject(c: Context<AppEnv>): string {
  const sub = c.get('user')['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new HTTPException(401, { message: '未登录' })
  }
  return sub
}

/*
 * 上传频率限制也搬到了 D1（`consumeRateLimit`），理由和发言限流一样：
 * isolate 内存计数换个接入点就绕过去了。这条路径本来就有「读用户 + 写 R2」，
 * 再多一次 D1 写不算负担，而防刷的意义比省这一次写大得多。
 */

/** `detectMedia` 至少要 8 个字节才能判出类型（见 media.ts）。 */
const SNIFF_BYTES = 8

/**
 * 从请求体里读出一小段用于魔数嗅探，**并把读锁留给调用方**。
 *
 * 为什么不读完再 releaseLock 让调用方重新 getReader()：那是「解锁 → 重新加锁」，
 * 中间那一步在规范里能work，但这里没有任何好处，反而多一个「锁离开了但流还在推进」
 * 的中间状态。直接把 reader 交出去，后面的泵接着读剩下的字节，一次加锁读完。
 */
async function readHead(
  stream: ReadableStream<Uint8Array>,
  minBytes: number,
): Promise<{ head: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < minBytes) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined && value.byteLength > 0) {
      chunks.push(value)
      total += value.byteLength
    }
  }

  const head = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    head.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { head, reader }
}

/**
 * 把「已经读过一小段的请求体」搬进 R2。
 *
 * ## 为什么必须过 `FixedLengthStream`
 *
 * R2 的 `put()` 虽然收 `ReadableStream`，但**只收长度已知的流**，否则直接抛
 * `TypeError: Provided readable stream must have a known length
 * (request/response body or readable half of FixedLengthStream)`。
 * 我们手上这个流既不是 request body（头已经被嗅探读掉了）、也没有长度，
 * 所以只能用 `FixedLengthStream` 包一层 —— 它同时还是个**长度校验器**：
 * 实写字节数多于或少于声明值都会让流报错，这一档的记账因此是精确的
 * （否则「声明 16 MB 实传 100 MB」能把配额账本整个骗过去）。
 *
 * ## 为什么是「先写头、再泵剩下的」而不是 `pipeTo`
 *
 * `pipeTo` 要求可写端此时没有被别的写者持锁，而头那一段必须先写进去。
 * 写成「write 头 → releaseLock → pipeTo」也能跑，但一旦 put 失败，
 * 谁负责 abort 可写端就得再想一遍。这里显式握着 writer，失败路径一眼看得清。
 *
 * ## 为什么这个 promise 不能 await 在 put 之前
 *
 * `FixedLengthStream` 只是根管子、不囤数据：可读端没人消费时，`writer.write()`
 * 会一直等下去。而消费它的正是 R2 —— 也就是那个还没被调用的 `put()`。
 * 先 await 泵再 await put 就是**死锁**。所以是「先把泵挂起来跑，
 * 再把可读端交给 put」。调用方拿到 `done` 之后必须 await 它，
 * 否则会留下一个悬着的 promise（表现为日志里的 unhandled rejection）。
 */
function pumpToR2(
  length: number,
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): { readable: ReadableStream<Uint8Array>; done: Promise<void> } {
  const { readable, writable } = new FixedLengthStream(length)
  const writer = writable.getWriter()

  const done = (async () => {
    try {
      await writer.write(head)
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value !== undefined && chunk.value.byteLength > 0) {
          await writer.write(chunk.value)
        }
      }
      await writer.close()
    } catch (error) {
      // abort 而不是 close：字节数不对（FixedLengthStream 会报错）或客户端中途断开时，
      // 必须让可读端也变成错误态，否则 R2 那边会以为上传正常结束、存下一个被截断的对象。
      await writer.abort(error).catch(() => {
        // 已经坏掉了
      })
      throw error
    }
  })()

  return { readable, done }
}

export function registerMediaRoutes({ app, User, auth }: ChatContext): void {
  /**
   * 上传一个文件，返回它的公开 URL。
   *
   * 请求体就是**文件的原始字节**（不是 multipart），文件名放在 `x-filename` 头里。
   * 这么做是因为 curl / fetch 两端都最省事，而且反正只传一个文件，
   * 没必要为它引入 multipart 解析。
   *
   * 存到 R2 之后由 R2 直连对外提供（不走 Worker），所以这里不做读取接口 —— 
   * 视频拖动进度条要靠 HTTP Range，R2 原生支持，Worker 代理反而得自己实现。
   */
  app.post('/api/uploads', cookieAuthBridge, auth.middleware(), async (c) => {
    const sub = requireSubject(c)
    const user = await User.findOne(sub)
    if (user === null) throw new HTTPException(401, { message: '账号不存在' })

    // `+1` 的理由同发言限流：`consumeRateLimit` 记账在先，传 N 表示窗口里的
    // 第 N 次被拦 —— 想放行 10 次就得传 11。数字只能来自常量，不要在这里写死。
    const attempt = await consumeRateLimit(
      c.env.DB,
      `upload:${sub}`,
      effectiveLimit(c.env, UPLOAD_ALLOWED_PER_WINDOW + 1),
      UPLOAD_WINDOW_SECONDS,
    )
    if (attempt.blocked) {
      c.header('Retry-After', String(attempt.retryAfterSeconds))
      return c.json({ error: `上传太频繁了，${attempt.retryAfterSeconds} 秒后再试` }, 429)
    }

    // 禁言的人不许上传。**这一处不能漏**：禁言的意图是「让他别在这儿活动」，
    // 只挡发言而放着上传，等于他还能继续占 R2 存储和上传配额。
    if (isMuted(user)) {
      return c.json({ error: `你已被禁言，还剩 ${mutedRemaining(user.mutedUntil!)}` }, 403)
    }

    /*
     * 上限按角色分档：普通用户 16 MB，管理员 100 MB（理由见 config.ts 里
     * `MAX_UPLOAD_BYTES_ADMIN` 的注释：100 MB 是平台的请求体硬上限，再往上没有意义）。
     */
    const limit = user.role === 'admin' ? MAX_UPLOAD_BYTES_ADMIN : MAX_UPLOAD_BYTES
    const limitMB = Math.round(limit / 1024 / 1024)
    const tooLarge = { error: `文件不能超过 ${limitMB} MB` }

    /*
     * 先看声明的长度：不然一个超大的 body 会被整个读进内存，
     * Workers 免费版只有 128MB，很容易被打爆。
     *
     * ## `Content-Length` 从「最好有」变成了「必须有」
     *
     * 以前缺这个头是允许的（读进来再量），但那条路有个洞：客户端用
     * `Transfer-Encoding: chunked` 不带长度，我们就会把整个请求体读进内存
     * —— 而平台允许的请求体上限是 100 MB，一次就能顶到 isolate 的 128 MB。
     * 现在两头都要求它：**没有长度就没法确认大小，也没法流式写**。
     *
     * 这不影响正常客户端：浏览器 `fetch()` 传 File / Blob / ArrayBuffer 时
     * 一定带 Content-Length（只有自己造 ReadableStream 当 body 才会退化成 chunked，
     * 而前端不是那么用的）。
     */
    const declared = Number.parseInt(c.req.header('content-length') ?? '', 10)
    if (!Number.isFinite(declared)) {
      return c.json({ error: '上传缺少 Content-Length，无法确认文件大小' }, 411)
    }
    if (declared <= 0) {
      return c.json({ error: '没有收到文件内容' }, 400)
    }
    if (declared > limit) {
      return c.json(tooLarge, 413)
    }

    /*
     * 配额检查放在读请求体**之前**。
     *
     * 以前它排在这些关卡后面，理由是「前面那些关卡本来就不该消耗额度」——
     * 但那句话对不上代码：`checkUploadQuota` 是**只读**的，真正消耗额度的
     * 是后面的 `markUpload`。所以这里的顺序不改变「谁会被扣额度」，
     * 只改变「谁要多花几次 D1 查询」。
     *
     * 而现在多了一个更实在的理由：管理员那档最大 100 MB，
     * 额度不够时让客户端**先把 100 MB 传完再收到 429** 是很糟的体验，
     * 而且白占一次完整的上传。长度已经在手上，先判完再决定要不要读。
     * 代价是类型不对（415）的请求会多花这几个查询 —— 那是个罕见的错误路径。
     *
     * 注意配额有两把尺子：文件数按天、字节数按累计总量，所以兜底文案不能写成
     * 「今天的额度用完了」——存储满了是删文件才能恢复，不是等到明天。
     */
    const quota = await checkUploadQuota(c.env.DB, sub, declared)
    if (!quota.allowed) {
      return c.json({ error: quota.reason ?? '上传额度用完了' }, 429)
    }

    /*
     * ── 取内容：小文件读进内存，大文件走流式 ──
     *
     * 分界线就是 `MAX_UPLOAD_BYTES`（16 MB）：只有管理员能跨过它。
     * 跨过去之后 `arrayBuffer()` 就不能用了 —— 把 100 MB 拷进内存这件事
     * 本身就贴着 128 MB 内存和 10 ms CPU 两道墙。流式那一档只把开头的
     * 几个字节读进内存做嗅探，剩下的原样转交 R2，Worker 里始终没有整份文件。
     */
    let detected: ReturnType<typeof detectMedia> = null
    let payload: ArrayBuffer | ReadableStream<Uint8Array>
    /** 流式那一档的泵。非 null 时必须在 put 之后 await 掉，不能让它悬着。 */
    let pump: Promise<void> | null = null
    /** 实际写进 R2 的字节数。用来记账，不信任声明值。 */
    let size = declared

    if (declared > MAX_UPLOAD_BYTES) {
      const body = c.req.raw.body
      if (body === null) return c.json({ error: '没有收到文件内容' }, 400)

      // 只读开头这一小段；剩下的留在 reader 里交给泵。
      const { head, reader } = await readHead(body, SNIFF_BYTES)
      detected = detectMedia(head)
      if (detected === null) {
        return c.json({ error: '不支持这种文件类型（支持图片 / 音视频 / pdf / 压缩包 / 文本）' }, 415)
      }

      // 类型判定已经过了，后面不会再早退 —— 现在启动泵是安全的。
      const stream = pumpToR2(declared, head, reader)
      payload = stream.readable
      pump = stream.done
    } else {
      const buffer = await c.req.arrayBuffer().catch(() => null)
      if (buffer === null || buffer.byteLength === 0) {
        return c.json({ error: '没有收到文件内容' }, 400)
      }
      // 上面已经用 Content-Length 比过一次；这里是照实际字节数的兜底断言，
      // 防的是「声明值和实际值不一致」的上游（代理、手写客户端）。
      if (buffer.byteLength > MAX_UPLOAD_BYTES) {
        return c.json(tooLarge, 413)
      }
      payload = buffer
      detected = detectMedia(new Uint8Array(buffer))
      if (detected === null) {
        return c.json({ error: '不支持这种文件类型（支持图片 / 音视频 / pdf / 压缩包 / 文本）' }, 415)
      }
    }

    const filename = sanitizeFilename(c.req.header('x-filename'))
    const key = buildMediaKey(detected.ext)
    const encodedName = encodeURIComponent(filename)
    // 记下是哪天传的：文件数那把尺子是按天的，撤回时要退回**上传的那一天**，
    // 不能退到今天（跨日撤回会把今天的额度凭空加满）。
    // 字节数那把尺子是累计总量，不涉及日期。
    const day = quotaDay()

    let object: R2Object | null = null
    let putError: unknown = null
    try {
      object = await c.env.MEDIA.put(key, payload, {
        httpMetadata: {
          contentType: detected.contentType,
          // 文档一律强制下载；图片和音视频内联，否则 <video> 没法直接播。
          // 这是「上传的东西绝不会被当成网页执行」的关键一步：
          // 非图片的音视频只以 video/* audio/* 出现，文档则是 attachment。
          contentDisposition:
            detected.kind === 'document' ? `attachment; filename*=UTF-8''${encodedName}` : 'inline',
          // key 里带 uuid，内容永不改变，所以可以放心长缓存
          cacheControl: 'public, max-age=31536000, immutable',
        },
        /*
         * uploaderId / uploader 用来判断「这个对象是不是这条消息的作者传的」，
         * 防止有人在消息里写上别人的图片 URL 再撤回，把别人的文件删了。
         *
         * 两个都存，但**判断以 uploaderId 为准**（撤回那边先读它）。
         * 用户名可复用：账号被注销后那行 users 就没了，别人能注册同名账号 ——
         * 只按用户名比对会让他有权删掉前任的文件。userId 不复用，没这个问题。
         * `uploader` 保留是为了能读懂老对象、也方便人肉排查。
         *
         * day 用来在撤回时把**按天的文件数**退回到上传的那一天，不能退到今天。
         * 累计字节那两个键没有日期，所以不受影响。
         */
        customMetadata: { filename, uploaderId: user.id, uploader: user.username, day },
      })
    } catch (error) {
      putError = error
    } finally {
      /*
       * 无论 put 成没成，都要把泵收掉。
       *
       * put 成功时它早就跑完了（R2 读完了整个可读端），这一句是空操作；
       * put 失败时可读端已经变成错误态，泵正卡在某次 read/write 上 ——
       * 不 await 它就留下一个悬着的 promise，日志里会变成
       * unhandled rejection，而真正的错因（put 那条）反而被淹没。
       */
      if (pump !== null) {
        await pump.catch((error: unknown) => {
          console.error('上传流中断', { key, error })
        })
      }
    }

    // put 抛异常（R2 抖动、带宽中断、FixedLengthStream 发现字节数不对）时上面已经
    // 记了错，这里给客户端一个可重试的信号。不用 500 —— 这不是我们的 bug。
    if (putError !== null || object === null) {
      console.error('写入 R2 失败', { key, size: declared, error: putError })
      return c.json({ error: '文件上传失败，请重试' }, 502)
    }

    /*
     * 记账用 R2 回给我们的**实际大小**，而不是 `Content-Length`。
     *
     * 正常情况下两者一定相等（请求体受 Content-Length 约束，流式那档还有
     * FixedLengthStream 兜着），但如果哪天它们不相等，账本应该跟着**真的存了多少**走：
     * 不然就能靠一个撒谎的长度头把累计字节额度骗过去。
     */
    size = object.size

    // 存进 R2 之后才记账 —— 反过来会让失败的上传也吃掉用户额度
    const marked = await markUpload(c.env.DB, sub, size)
    if (!marked) {
      /*
       * 走到这里说明：在我们上面「够不够」的预检之后、这笔记账之前，
       * 额度（个人的或全站的）被别人抢完了。预检是纯读的，这种竞态挡不住。
       *
       * 刚传上去的对象必须删掉 —— 它没有被任何消息引用，留着就是一个
       * 白占 R2 的孤儿，而且那条 URL 是公开可访问的（内容其实还在）。
       *
       * ⚠️ 这一档（> 16 MB）尤其要紧：100 MB 的孤儿对象一个就能吃掉
       * 全站累计额度（8 GB）的 1.2%，而账本里**一点都没记**。
       * 删失败也不改结论：这次上传本来就不该成功。
       */
      await c.env.MEDIA.delete(key).catch((error: unknown) => {
        console.error('额度被抢占后删除对象失败', { key, error })
      })
      return c.json({ error: '上传额度刚刚被用完了，请稍后再试' }, 429)
    }

    return c.json(
      {
        key,
        kind: detected.kind,
        filename,
        size,
        contentType: detected.contentType,
        url: `${c.env.MEDIA_BASE_URL.replace(/\/+$/, '')}/${key}`,
      },
      201,
    )
  })


  /**
   * 读取媒体对象。
   *
   * **线上不走这条路。** 页面上拿到的是 R2 直连的 URL，图片和视频直接问 R2：
   * 既不消耗 Worker 请求额度，视频拖动进度条要的 HTTP Range 也由 R2 原生支持
   * （走 Worker 代理反而得自己实现 Range）。
   *
   * 留着它的原因是**本地 wrangler dev 的 R2 是模拟的** —— 对象只存在本机，
   * 线上的 r2.dev 域名当然找不到。把 `.dev.vars` 里的 MEDIA_BASE_URL 指向这里，
   * 本地才能完整跑通「上传 → 显示」。
   */
  app.get('/api/media/:key{.+}', cookieAuthBridge, auth.middleware(), async (c) => {
    const key = c.req.param('key')
    // 挡路径穿越：key 必须是 `<年-月>/<uuid>.<ext>` 那个形状
    if (!isMediaKey(key)) return c.json({ error: '路径不合法' }, 400)

    const object = await c.env.MEDIA.get(key)
    if (object === null) return c.json({ error: '文件不存在' }, 404)

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  })
}
