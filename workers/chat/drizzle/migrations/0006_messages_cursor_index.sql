-- 手写迁移（不经过 drizzle-kit）。理由同 0001：nanoka 的字段 DSL 没有索引声明，
-- drizzle-kit 生成出来的表永远是 0 indexes，所以索引只能手写在这里。
--
-- ## 为什么需要它
--
-- 历史消息查询从「单键游标」改成了「复合游标」：
--
--   改前：WHERE room=? AND deleted=0 AND createdAt < ?
--         ORDER BY createdAt DESC LIMIT 50
--
--   改后：WHERE room=? AND deleted=0 AND (createdAt, id) < (?, ?)
--         ORDER BY createdAt DESC, id DESC LIMIT 50
--
-- 改动的动机是**修丢消息**：createdAt 是毫秒整数、不唯一，一页正好切在
-- 一组同毫秒消息中间时，单键游标会把「同毫秒、本页没包含」的那几条一起排掉。
--
-- ## 为什么原索引不够用（这是本次改动最容易踩的地方）
--
-- 原来的 `messages_room_deleted_created_idx (room, deleted, createdAt)` 满足不了
-- 新的 ORDER BY：`messages.id` 是 text 主键、**不是 rowid**，所以同一毫秒内
-- 索引里的隐含顺序（rowid 升序）和 `id DESC` 不一致 → 必须额外排序 →
-- SQLite 得先把整个房间的行读出来。那会把 0001 靠索引省下的读取额度全花回去，
-- 而且**是全表读**，很可能比压根没有索引还贵。
--
-- 把 id 加到索引末尾就解决了：反向扫这个索引即可直接满足
-- `ORDER BY createdAt DESC, id DESC`，区间定位也能走行值比较
-- `(createdAt, id) < (?, ?)`。
--
-- 已用 `EXPLAIN QUERY PLAN` 在本地 D1 上确认过新旧两种查询形状都用上了新索引
-- （见 README「设计取舍与踩过的坑」里那条）。新索引的前缀
-- (room, deleted, createdAt) 与原索引完全相同，所以原索引成了纯冗余：
-- 留着只会让每条消息的 INSERT 多维护一个索引。
DROP INDEX IF EXISTS `messages_room_deleted_created_idx`;
--> statement-breakpoint

CREATE INDEX `messages_room_deleted_created_id_idx`
  ON `messages` (`room`, `deleted`, `createdAt`, `id`);
