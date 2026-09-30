import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'

import { MAX_UPLOAD_BYTES, UPLOAD_MIN_INTERVAL_MS } from '../config'
import type { AppEnv, ChatContext } from '../context'
import { buildMediaKey, detectMedia, isMediaKey, sanitizeFilename } from '../media'
import { cookieAuthBridge } from '../middleware'

function requireSubject(c: Context<AppEnv>): string {
  const sub = c.get('user')['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new HTTPException(401, { message: '未登录' })
  }
  return sub
}

/**
 * 上传限流，放在 isolate 内存里，理由和发言限流一样：
 * 这条路径本来就有「读用户 + 写 R2」两次往返，再加一次 D1 写不划算。
 * 目的是防手滑连点和简单刷存储，不是安全边界 —— 真正的边界是登录态 + 大小/类型校验。
 */
const lastUploadAt = new Map<string, number>()

function throttleUpload(userId: string): number | null {
  const now = Date.now()
  const last = lastUploadAt.get(userId)
  if (last !== undefined && now - last < UPLOAD_MIN_INTERVAL_MS) {
    return Math.max(1, Math.ceil((UPLOAD_MIN_INTERVAL_MS - (now - last)) / 1000))
  }
  lastUploadAt.set(userId, now)

  if (lastUploadAt.size > 512) {
    for (const [key, timestamp] of lastUploadAt) {
      if (now - timestamp > UPLOAD_MIN_INTERVAL_MS) lastUploadAt.delete(key)
    }
  }
  return null
}

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

    const retryAfter = throttleUpload(sub)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: `上传太频繁了，${retryAfter} 秒后再试` }, 429)
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

    const filename = sanitizeFilename(c.req.header('x-filename'))
    const key = buildMediaKey(detected.ext)
    const encodedName = encodeURIComponent(filename)

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
      // 撤回时靠 uploader 判断「这个对象是不是这条消息的作者传的」，防止误删别人的文件
      customMetadata: { filename, uploader: user.username },
    })

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
