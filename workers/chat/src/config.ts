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

/**
 * 单条消息最大长度。后端两处（Zod 校验、表约束）都读这个常量。
 *
 * 前端另有一个来源：`hugo.toml` 的 `params.chat.maxMessageLength`，
 * 它渲染进输入框的 `maxlength`。两边是否相等由 `npm run verify-build` 检查
 * （前后端是两套构建，没法共用一个常量，只能靠这条自动检查钉住）。
 */
export const MAX_MESSAGE_LENGTH = 500

/** 历史消息一页的条数。 */
export const HISTORY_PAGE_SIZE = 50

/**
 * 导出房间内容时一次最多取多少条。
 * 超了就截断并在响应里带 `truncated` 标记，前端会提示「只导出了最早的 N 条」。
 *
 * ## 这个值是被 CPU 上限卡住的，不是被响应体积卡住的
 *
 * 原先写 5000，理由是「别把响应体撑爆」。但真正会先爆的是 **CPU 10 ms / 请求**：
 * 实测把 5000 条消息序列化成 JSON 的开销是
 *
 *   | 每条消息长度 | 序列化耗时 | 响应体体积 |
 *   | --- | --- | --- |
 *   | 100 字符 | ~5 ms | 2.15 MB |
 *   | 500 字符（顶满 `MAX_MESSAGE_LENGTH`） | **9 – 13 ms** | 7.87 MB |
 *
 * 也就是说：**房间里消息一旦普遍接近 500 字上限，导出就会超 10 ms、
 * 被运行时掐掉返回 1102**。而请求体的体积上限（128 MB 内存）离 7.87 MB 还很远，
 * 根本没到瓶颈 —— 原来的理由写错了地方。
 *
 * 取 1000：最坏情况（每条顶格 500 字）序列化约 1.5 MB / ~2 ms，稳稳在预算内。
 * 想导出更多就翻页，别在一次请求里硬扛。
 */
export const EXPORT_LIMIT = 1000

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

/**
 * 发言 / 上传的频率限制窗口（秒），落在 D1 里。
 *
 * 以前这两个是 isolate 内存里的毫秒间隔，但内存计数**换个接入点就绕过去了** ——
 * 它挡得住手滑连点，挡不住真想刷的人。现在统一走 `consumeRateLimit`：
 * 固定窗口、落库、跨 isolate 可靠。代价是每次多一次 D1 写。
 *
 * 从「最小间隔」改成了「固定窗口」，语义上有个小差别：固定窗口在边界处会放行
 * 两条挨得很近的请求（窗口末尾发一条、窗口一重置立刻再发）。对聊天场景无所谓，
 * 换来的是不会被绕。
 */
export const MESSAGE_WINDOW_SECONDS = 2
export const UPLOAD_WINDOW_SECONDS = 3

/**
 * 撤回的频率限制。**独立于发言那个计数器**，理由见下。
 *
 * 撤回原先完全没有限流，是整个后端唯一一条「无限制、每条都要写库」的路由。
 * 它比发言更值得限，因为一次请求撬动的资源比发一条消息多得多：
 * D1 读 2 行 + 写 1 行 + 一次 DO 广播，带媒体时还要 R2 head × N、R2 delete × N、
 * 以及退配额的一次 D1 batch（2 条语句）。**不设限就等于把 D1 写额度和 R2 操作额度
 * 直接挂在公网上。** 注册是开放的（免费套餐发不了验证邮件），所以「多注册几个号」
 * 不是门槛，只能靠限流兜。
 *
 * ## 为什么必须用独立的 key，不能复用 `message:` 那个计数器
 *
 * 两者是**不同性质的操作**，共用一个桶会互相干扰：一个在整理聊天记录、
 * 连续撤回几条旧消息的人，会发现自己接下来几分钟发不出话了 —— 而他做的
 * 只是「收拾自己的房间」。反过来也一样。所以 key 用 `delete:<userId>`。
 *
 * ## 阈值取 20 的理由
 *
 * 正常使用的量级：改错别字、撤掉说错的话，一次也就一两条；
 * 管理员清理一小波刷屏可能要连点十几下。20 / 分钟对这两种情况都够用，
 * 而它把「脚本无限刷」压到了 20 次/分钟 —— 连同下面这个量化：
 * 带一条媒体的一次撤回约 4 次 D1 写，20 次/分钟就是 4800 次/小时，
 * 离 10 万/天的写额度还有足够距离，而且**一旦真被刷，日志里立刻看得出来**。
 *
 * 想调大/调小只改这里。管理员的大批量清理不要靠这个接口 ——
 * 那是「清空房间」的活（`DELETE /api/rooms/:room`，走 R2 批量删，不受这条限制）。
 */
export const DELETE_WINDOW_SECONDS = 60

/**
 * 一个窗口内**允许**的撤回次数。
 *
 * ⚠️ 传给 `consumeRateLimit` 时要 `+1`，因为那个函数是「先记账、再判断」：
 * 传 N 表示窗口内的第 N 次被拦，也就是实际只放行 N-1 次。
 * 想放行 20 次就得传 21。这条 off-by-one 已经在发消息那条路径上踩过一次
 * （见 `routes/chat.ts` 里「limit 传 2 而不是 1」的注释），这里用命名把意图写死，
 * 免得下一个人又数错一次。
 */
export const DELETE_ALLOWED_PER_WINDOW = 20

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
