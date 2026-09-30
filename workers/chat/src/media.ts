/**
 * 上传文件的类型判定、存储键，以及从消息正文里反解引用。
 *
 * ## 判类型一律看文件头（魔数），不看客户端给的 MIME / 扩展名
 *
 * 客户端说什么都不作数 —— `Content-Type` 是它自己填的，扩展名也是它自己起的。
 * 图片这一档尤其要紧：它会被前端内联渲染成 `<img src>`，
 * 万一有人把 HTML 或 SVG 伪装成 .png，那就是一条现成的 XSS 通路。
 * 所以图片必须**字节级**匹配，匹配不上就当不支持。
 *
 * 音视频和文档不进取 `<img>`，风险低得多，但也过一遍白名单，
 * 免得 bucket 变成谁都能塞东西的网盘。
 *
 * ## 为什么没有 .svg
 *
 * SVG 是唯一能内嵌脚本的图片格式，放进 `<img>` 虽然不执行脚本，
 * 但一旦有人直接打开原图（R2 直连是公开的）就会在同源下执行。
 * 直接不收，一了百了。
 */

export type MediaKind = 'image' | 'audio' | 'video' | 'document'

export interface DetectedMedia {
  kind: MediaKind
  ext: string
  contentType: string
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

/** 把 ASCII 字符串转成字节序列，写魔数表时比一堆 0x 好读。 */
function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0))
}

/** `ftyp` 出现在第 4 字节：mp4 / m4a / mov 都是这个容器。 */
function isIsoBaseMedia(bytes: Uint8Array): boolean {
  return startsWith(bytes, ascii('ftyp'), 4)
}

type Matcher = (bytes: Uint8Array) => boolean

interface TypeRule {
  ext: string
  contentType: string
  match: Matcher
}

/** 图片：会被内联成 <img>，必须严格匹配魔数。 */
const IMAGE_RULES: readonly TypeRule[] = [
  { ext: 'png', contentType: 'image/png', match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  { ext: 'jpg', contentType: 'image/jpeg', match: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { ext: 'gif', contentType: 'image/gif', match: (b) => startsWith(b, ascii('GIF8')) },
  {
    ext: 'webp',
    contentType: 'image/webp',
    match: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  },
]

/** 视频：会被渲染成 <video>。 */
const VIDEO_RULES: readonly TypeRule[] = [
  // mp4 / m4v / mov 共用 ISO BMFF 容器（用 video/mp4 返回，浏览器按容器解码）
  { ext: 'mp4', contentType: 'video/mp4', match: isIsoBaseMedia },
  { ext: 'webm', contentType: 'video/webm', match: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) },
]

/** 音频：会被渲染成 <audio>。 */
const AUDIO_RULES: readonly TypeRule[] = [
  { ext: 'm4a', contentType: 'audio/mp4', match: isIsoBaseMedia },
  { ext: 'mp3', contentType: 'audio/mpeg', match: (b) => startsWith(b, ascii('ID3')) || (b[0] === 0xff && (b[1] ?? 0) >= 0xe0) },
  { ext: 'ogg', contentType: 'audio/ogg', match: (b) => startsWith(b, ascii('OggS')) },
  { ext: 'wav', contentType: 'audio/wav', match: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8) },
  { ext: 'flac', contentType: 'audio/flac', match: (b) => startsWith(b, ascii('fLaC')) },
]

/** 文档 / 压缩包：只提供下载，不内联渲染。 */
const DOCUMENT_RULES: readonly TypeRule[] = [
  { ext: 'pdf', contentType: 'application/pdf', match: (b) => startsWith(b, ascii('%PDF')) },
  // zip 容器：zip / docx / xlsx / pptx 都落在这里
  { ext: 'zip', contentType: 'application/zip', match: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) },
  { ext: 'zip', contentType: 'application/zip', match: (b) => startsWith(b, [0x50, 0x4b, 0x05, 0x06]) },
]

/**
 * 纯文本没有魔数，只能反过来判：解得出 UTF-8、不含 NUL 字节，**并且不是一整份 HTML/SVG**。
 *
 * 最后那条是关键。SVG 和 HTML 都是纯文本，光看字节跟普通 txt 没区别，
 * 会被这一档收下 —— 虽然是按 `text/plain` 存、按附件下载，浏览器不会执行，
 * 但**下载下来的文件名仍然叫 `xxx.svg`**，用户双击就可能在浏览器里跑起来。
 * 所以这里宁可错杀：整份文件以 svg / html / xml 开头的，一律不收。
 * 只在开头 64 个字符里判断，所以正常文本里提到这些词不受影响。
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096)
  if (head.includes(0)) return false

  let text: string
  try {
    // ignoreBOM 是 workers-types 里标成必填的（浏览器 DOM 里其实是可选的），
    // 这里给默认行为：BOM 在解码时被吃掉。
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(head)
  } catch {
    return false
  }

  const leading = text.trimStart().slice(0, 64).toLowerCase()
  const markup =
    leading.startsWith('<svg') ||
    leading.startsWith('<?xml') ||
    leading.startsWith('<!doctype html') ||
    leading.startsWith('<html') ||
    leading.startsWith('<script')

  return !markup
}

const TEXT_RULE: TypeRule = {
  ext: 'txt',
  contentType: 'text/plain',
  match: looksLikeText,
}

function matchRules(bytes: Uint8Array, kind: MediaKind, rules: readonly TypeRule[]): DetectedMedia | null {
  for (const rule of rules) {
    if (rule.match(bytes)) return { kind, ext: rule.ext, contentType: rule.contentType }
  }
  return null
}

/**
 * 嗅探文件类型。返回 null 表示不支持（调用方应回 415）。
 *
 * 顺序有意为之：图片第一档。因为 mp4 和 m4a 共用容器、zip 和 office 文档共用容器，
 * 先把最严格、最需要精确的一类判掉，后面的才好办。
 */
export function detectMedia(bytes: Uint8Array): DetectedMedia | null {
  if (bytes.length < 8) return null
  return (
    matchRules(bytes, 'image', IMAGE_RULES) ??
    matchRules(bytes, 'video', VIDEO_RULES) ??
    matchRules(bytes, 'audio', AUDIO_RULES) ??
    matchRules(bytes, 'document', DOCUMENT_RULES) ??
    matchRules(bytes, 'document', [TEXT_RULE])
  )
}

/** 存储键：`<年-月>/<uuid>.<ext>`。按月分目录，将来要按时间清理会方便很多。 */
export function buildMediaKey(ext: string, now = new Date()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `${month}/${crypto.randomUUID()}.${ext}`
}

/** 存储键的形状。读写两端都靠它挡路径穿越（`../` 之类）。 */
const MEDIA_KEY_PATTERN = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/

export function isMediaKey(value: string): boolean {
  return MEDIA_KEY_PATTERN.test(value)
}

/**
 * 从一条 URL 的 pathname 里抠出末尾的存储键。
 *
 * 为什么不用「去掉前导斜杠就是 key」这种写法：媒体 URL 有两种形态 ——
 * 线上是 R2 直连（`/2026-09/xxx.jpg`），本地为了能看到模拟 R2 里的对象，
 * 走的是 Worker 读取通道（`/api/media/2026-09/xxx.jpg`），前面多一段前缀。
 * 只认末尾，两种就都能对上。
 */
const MEDIA_KEY_AT_END = /(\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5})$/

/**
 * 从消息正文里把引用的媒体对象反解出来（撤回时用来删文件）。
 *
 * 正文是 markdown，媒体以 `![alt](url)` 或 `[文字](url)` 出现，
 * 所以这里只认「URL 里最后那段长得像存储键的路径」。
 * 拿不准的一律不返回 —— 宁可漏删一个对象，也不能误删别人的文件。
 */
export function extractMediaKeys(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/\((https?:\/\/[^\s)]+)\)/g)) {
    const url = match[1]
    if (url === undefined) continue
    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      continue
    }
    const key = MEDIA_KEY_AT_END.exec(pathname)?.[1]
    if (key !== undefined && isMediaKey(key)) found.add(key)
  }
  return [...found]
}

/** 下载文件名里的危险字符（路径分隔符、控制字符、引号）统一剔掉。 */
export function sanitizeFilename(raw: string | undefined): string {
  const fallback = 'download'
  if (raw === undefined) return fallback
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 解不开就用原样，后面还会再洗一遍
  }
  const cleaned = decoded
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : fallback
}
