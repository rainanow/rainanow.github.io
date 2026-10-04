import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'

import { MAX_UPLOAD_BYTES, UPLOAD_WINDOW_SECONDS } from '../config'
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

const MAX_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)

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

    // limit 传 2 的理由同发言限流：记账在先，窗口里的第一条要放行
    const attempt = await consumeRateLimit(
      c.env.DB,
      `upload:${sub}`,
      effectiveLimit(c.env, 2),
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

    // 先看声明的长度：不然一个超大的 body 会被整个读进内存，
    // Workers 免费版只有 128MB，很容易被打爆。
    const declared = Number.parseInt(c.req.header('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return c.json({ error: `文件不能超过 ${MAX_MB} MB` }, 413)
    }

    const buffer = await c.req.arrayBuffer().catch(() => null)
    if (buffer === null || buffer.byteLength === 0) {
      return c.json({ error: '没有收到文件内容' }, 400)
    }
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: `文件不能超过 ${MAX_MB} MB` }, 413)
    }

    const detected = detectMedia(new Uint8Array(buffer))
    if (detected === null) {
      return c.json({ error: '不支持这种文件类型（支持图片 / 音视频 / pdf / 压缩包 / 文本）' }, 415)
    }

    // 配额检查放在类型判定之后：前面那些关卡（没登录、太大、类型不对）本来就不该
    // 消耗额度，这里才是「确实要落库了」的位置。
    const quota = await checkUploadQuota(c.env.DB, sub, buffer.byteLength)
    if (!quota.allowed) {
      return c.json({ error: quota.reason ?? '今天的上传额度用完了' }, 429)
    }

    const filename = sanitizeFilename(c.req.header('x-filename'))
    const key = buildMediaKey(detected.ext)
    const encodedName = encodeURIComponent(filename)
    // 记下是哪天传的：撤回时要按**那一天**的账退还额度，不能退到今天
    const day = quotaDay()

    await c.env.MEDIA.put(key, buffer, {
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
       * day 用来在撤回时把额度退回到**上传的那一天**，不能退到今天。
       */
      customMetadata: { filename, uploaderId: user.id, uploader: user.username, day },
    })

    // 存进 R2 之后才记账 —— 反过来会让失败的上传也吃掉用户额度
    const marked = await markUpload(c.env.DB, sub, buffer.byteLength)
    if (!marked) {
      /*
       * 走到这里说明：在我们上面「够不够」的预检之后、这笔记账之前，
       * 额度（个人的或全站的）被别人抢完了。预检是纯读的，这种竞态挡不住。
       *
       * 刚传上去的对象必须删掉 —— 它没有被任何消息引用，留着就是一个
       * 白占 R2 的孤儿，而且那条 URL 是公开可访问的（内容其实还在）。
       * 删失败也不改结论：这次上传本来就不该成功。
       */
      await c.env.MEDIA.delete(key).catch((error: unknown) => {
        console.error('额度被抢占后删除对象失败', { key, error })
      })
      return c.json({ error: '今天的上传额度刚刚被用完了，明天再来吧' }, 429)
    }

    return c.json(
      {
        key,
        kind: detected.kind,
        filename,
        size: buffer.byteLength,
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
