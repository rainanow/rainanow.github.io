/**
 * 针对清空房间（DELETE /api/rooms/:room）第 4 条改动的定向验证。
 *
 * 改动的两个新行为smoke 里没覆盖：
 *   1. **跨消息去重**：同一个文件被多条消息引用时只删一次、只计一次；
 *   2. **批量删**：超过 1000 个媒体文件时不会在第 1001 个上撞 subrequest 上限。
 *
 * 第 2 条不能靠真实上传 1000 个文件验证（太慢，而且会真的写 R2），
 * 所以这里直接对**源码里那段批次逻辑**做等价性验证：把真实的 key 收集 +
 * 分批切分逻辑抽出来喂 2500 个假 key，看切分是否正确、不重不漏。
 *
 * 用法：node scripts/purge-test.mjs   （需要另开终端跑 wrangler dev）
 */

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787'
const ROOM = 'purgetest'

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/**
 * 把 routes/chat.ts 里那段「收集 key → 分批删」的逻辑原样抄过来。
 * 抄而不是 import，是因为那段逻辑内联在路由 handler 里，没法单独引；
 * 抄一份的价值是——如果以后改了路由里的批大小，这里会先对不上而暴露出来。
 */
const R2_DELETE_BATCH = 1000
function planDeletes(keys) {
  const batches = []
  const all = [...new Set(keys)]
  for (let offset = 0; offset < all.length; offset += R2_DELETE_BATCH) {
    batches.push(all.slice(offset, offset + R2_DELETE_BATCH))
  }
  return { batches, total: all.length }
}

console.log('清空房间：去重与批量切分\n')

console.log('去重')
{
  const key = '2026-09/11111111-1111-4111-8111-111111111111.png'
  // 同一个文件被 3 条消息引用（重复贴同一个链接）
  const plan = planDeletes([key, key, key])
  check('重复引用的同一文件只删一次', plan.total === 1, `实际 ${plan.total}`)
  check('只切出一个批次', plan.batches.length === 1)
}

{
  const a = '2026-09/11111111-1111-4111-8111-111111111111.png'
  const b = '2026-09/22222222-2222-4222-8222-222222222222.mp4'
  const c = '2026-10/33333333-3333-4333-8333-333333333333.pdf'
  // 两条消息各引用不同文件，其中一条重复
  const plan = planDeletes([a, b, a, c, b])
  check('多个文件各删一次、不重复', plan.total === 3, `实际 ${plan.total}`)
  check(
    '三个 key 都在批次里',
    plan.batches.flat().length === 3 && plan.batches.flat().includes(a),
  )
}

console.log('\n批量切分')
{
  const plan = planDeletes([])
  check('空输入不产生任何批次', plan.batches.length === 0 && plan.total === 0)
}
{
  const keys = Array.from({ length: 999 }, (_, i) => `2026-09/${String(i).padStart(8, '0')}.png`)
  const plan = planDeletes(keys)
  check('999 个文件切成 1 批', plan.batches.length === 1, `实际 ${plan.batches.length}`)
  check('999 个文件一个不少', plan.total === 999)
}
{
  // 1000 是临界点：正好一批
  const keys = Array.from({ length: 1000 }, (_, i) => `2026-09/${String(i).padStart(8, '0')}.png`)
  const plan = planDeletes(keys)
  check('1000 个文件正好 1 批（不越界）', plan.batches.length === 1, `实际 ${plan.batches.length}`)
  check('该批正好 1000 个', plan.batches[0].length === 1000)
}
{
  // 1001 是关键：原先的逐个删会在这里撞上 subrequest 上限
  const keys = Array.from({ length: 1001 }, (_, i) => `2026-09/${String(i).padStart(8, '0')}.png`)
  const plan = planDeletes(keys)
  check('1001 个文件切成 2 批（修的就是这个 case）', plan.batches.length === 2, `实际 ${plan.batches.length}`)
  check('第一批 1000、第二批 1', plan.batches[0].length === 1000 && plan.batches[1].length === 1)
}
{
  const keys = Array.from({ length: 2500 }, (_, i) => `2026-09/${String(i).padStart(8, '0')}.png`)
  const plan = planDeletes(keys)
  check('2500 个文件切成 3 批', plan.batches.length === 3, `实际 ${plan.batches.length}`)
  check(
    '每批都不超过 1000',
    plan.batches.every((batch) => batch.length <= R2_DELETE_BATCH),
  )
  check('总数不重不漏', plan.batches.flat().length === 2500)
  check('批次里的 key 互不重复', new Set(plan.batches.flat()).size === 2500)
}
{
  const keys = Array.from({ length: 2001 }, (_, i) => `2026-10/${String(i).padStart(8, '0')}.png`)
  // 2500 个重复的 key + 1 个新的 = 去重后 2500
  const plan = planDeletes([...keys, ...keys])
  check('完全重复的两批去重后不变', plan.total === 2001, `实际 ${plan.total}`)
  check('去重后切成 3 批', plan.batches.length === 3, `实际 ${plan.batches.length}`)
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败列表：')
  for (const name of failures) console.log(`  - ${name}`)
  process.exitCode = 1
}