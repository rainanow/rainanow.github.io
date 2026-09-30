/** 全站共享的常量。改这里就能改行为，不用翻路由代码。 */

/** access token 的 Cookie 名。`@nanokajs/auth` 的默认值就是这两个名字，改这里必须同步改 createAuth 的 cookie 配置。 */
export const ACCESS_TOKEN_COOKIE = 'access_token'
export const REFRESH_TOKEN_COOKIE = 'refresh_token'

/**
 * access token 有效期 30 分钟（库默认 900 秒）。
 * 调大是因为聊天室页面会长时间挂着：HTTP 请求每次都要带新的 access token，
 * 30 分钟能把刷新频率压到一个不烦人的程度；WebSocket 只在握手时校验一次，不受影响。
 */
export const ACCESS_TOKEN_TTL_SECONDS = 1800

/** refresh token 有效期 7 天（库默认值，写出来是为了让这个决定显式）。 */
export const REFRESH_TOKEN_TTL_SECONDS = 604800

/** 默认聊天室。表里带 room 列是为了以后能开多房间，现在只用这一个。 */
export const DEFAULT_ROOM = 'general'

/** 单条消息最大长度，和 models/message.ts 里的 `.max(500)` 必须一致。 */
export const MAX_MESSAGE_LENGTH = 500

/** 历史消息一页的条数。 */
export const HISTORY_PAGE_SIZE = 50

/**
 * 导出房间内容时一次最多取多少条。
 * 超了就截断并在响应里带 `truncated` 标记 —— 免得某个房间攒了几万条时
 * 把响应体撑爆（Workers 的响应大小也有上限）。
 */
export const EXPORT_LIMIT = 5000

/**
 * 单个上传文件的上限。浏览器的 canvas 压缩会把手机原图压到这个数以下，
 * 所以实际上只有「文档」类会真的顶到这个上限。
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

/**
 * 上传和读取媒体的路径前缀。
 * 消息正文里存的就是这个前缀开头的相对路径（如 `/api/media/2026-09/xxx.png`），
 * 前端渲染时会校验前缀，只把自家 URL 变成图片/链接 —— 防止有人拿外链当图床或追踪访问者。
 */
export const MEDIA_PATH_PREFIX = '/api/media/'

/** 上传间隔：同一个人两次上传至少隔这么久，防手滑和刷存储。 */
export const UPLOAD_MIN_INTERVAL_MS = 3000

/**
 * 上传配额。分两层，因为两道防线拦的东西不一样：
 *
 *  - 单人那层挡「一个人刷」。正常聊天一天传二三十张图已经很多了。
 *  - 全站那层挡「注册一堆小号一起刷」—— 注册是开放的（免费套餐发不了验证邮件），
 *    所以只按人限是不够的，这是必须有的兜底。
 *
 * 数额是按 R2 免费额度（10 GB 存储 / 100 万次写操作每月）倒推的：
 * 全站每天 300 个文件 × 16 MB 顶格算也只有 4.8 GB，但那是全站同时发疯的极端值，
 * 正常日子离得很远，而一旦真的发生，一天之内就会被日志看出来。
 */
export const DAILY_UPLOAD_COUNT_PER_USER = 30
export const DAILY_UPLOAD_BYTES_PER_USER = 200 * 1024 * 1024

/** 全站每日熔断。超出后所有上传都会 429，直到第二天。 */
export const DAILY_UPLOAD_COUNT_GLOBAL = 300
export const DAILY_UPLOAD_BYTES_GLOBAL = 1024 * 1024 * 1024

/**
 * 成员名单一次最多返回多少个账号。
 * users 本来就是小表，这个上限纯粹是防呆：D1 按「读取行数」计费，
 * 哪天账号真的涨到几千个，也不至于一次名单请求就把额度吃掉。
 */
export const MEMBER_LIST_LIMIT = 500

/** 用户名规则：中文 / 字母 / 数字 / 下划线，2-20 位。 */
export const USERNAME_PATTERN = /^[\w\u4e00-\u9fa5]{2,20}$/
