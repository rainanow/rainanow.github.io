-- 手写迁移（不经过 drizzle-kit）。
--
-- 原因：nanoka 的字段 DSL 只支持列级约束（`.primary()` / `.unique()`），
-- 没有索引声明，所以 drizzle-kit 生成出来的四个表都是 0 indexes。
--
-- 索引在这里的价值不是「快」，是「省 D1 免费额度」：D1 按**读取行数**计费
-- （免费 500 万行/天）。历史消息查询是
--   SELECT ... WHERE room=? AND deleted=0 ORDER BY createdAt DESC LIMIT 50
-- 没有索引时 SQLite 要全表扫描 + 排序，一次翻页就吃掉全表行数；
-- 有了这个索引就是 50 行。按 5000 条消息估算，差别是 100 倍。
--
-- 注意：这个索引不在 drizzle 的 schema 快照里，所以以后跑 `drizzle-kit generate`
-- 不会重复创建、也不会把它删掉——它会一直留在库里。

CREATE INDEX `messages_room_deleted_created_idx`
  ON `messages` (`room`, `deleted`, `createdAt`);
--> statement-breakpoint

-- 吊销名单的过期清理（每次写名单时顺手删过期行）走 expiresAt 过滤。
CREATE INDEX `auth_blacklist_expires_at_idx`
  ON `auth_blacklist` (`expiresAt`);
