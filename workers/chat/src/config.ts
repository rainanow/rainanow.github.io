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
 * 成员名单一次最多返回多少个账号。
 * users 本来就是小表，这个上限纯粹是防呆：D1 按「读取行数」计费，
 * 哪天账号真的涨到几千个，也不至于一次名单请求就把额度吃掉。
 */
export const MEMBER_LIST_LIMIT = 500

/** 用户名规则：中文 / 字母 / 数字 / 下划线，2-20 位。 */
export const USERNAME_PATTERN = /^[\w\u4e00-\u9fa5]{2,20}$/
