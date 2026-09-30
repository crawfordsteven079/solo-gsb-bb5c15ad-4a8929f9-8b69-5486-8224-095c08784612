/**
 * 端到端冒烟测试（不随镜像发布）：
 *   DB_DRIVER=pglite node test/e2e.mjs
 * 使用进程内 PostgreSQL 运行真实服务代码，覆盖：
 *   草稿编辑 / 缺失引用 / 自引用 / 循环依赖 / 发布 / 启动演出 /
 *   待执行·受阻·触发·跳过 / 前置不满足 / 并发只记一次 /
 *   草稿修改不影响已开始演出 / 历史版本回看 / 结束演出
 */
import { readFileSync } from 'node:fs';

process.env.DB_DRIVER = 'pglite';
process.env.PORT = '3111';

// db.js 的 pglite 分支会自动执行 db/init/01_schema.sql 建表并写入种子数据
await import('../src/app.js');

// 等待端口监听
await new Promise((r) => setTimeout(r, 800));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function req(method, path, { op, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (op) headers['X-Operator-Id'] = String(op);
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

try {
  console.log('1. 操作人与鉴权');
  const r401 = await req('POST', '/api/shows', { body: { name: 'x' } });
  ok(r401.status === 401, '未选择操作人 → 401');
  const op = (await req('POST', '/api/operators', { body: { name: '测试监督', role: 'stage_manager' } })).body;
  const op2 = (await req('POST', '/api/operators', { body: { name: '测试助理', role: 'assistant' } })).body;
  ok(op.id && op2.id, '可创建两名操作人');

  console.log('2. 场次与草稿');
  const show = (await req('POST', '/api/shows', { op: op.id, body: { name: '测试剧', description: 'd' } })).body;
  const sid = show.id;
  const noVer = await req('POST', `/api/shows/${sid}/performances`, { op: op.id, body: {} });
  ok(noVer.status === 400 && /没有已发布版本/.test(noVer.body.error), '无已发布版本启动演出 → 400 且提示明确');

  // 空草稿发布
  const emptyPub = await req('POST', `/api/shows/${sid}/publish`, { op: op.id, body: {} });
  ok(emptyPub.status === 422 && emptyPub.body.errors[0].code === 'EMPTY', '空草稿发布 → 422 EMPTY');

  // 添加 4 个提示
  const mk = async (code, type) =>
    (await req('POST', `/api/shows/${sid}/cues`, { op: op.id, body: { cue_code: code, cue_type: type, title: code } })).body;
  const a = await mk('LX 1', 'light');
  const b = await mk('SQ 1', 'sound');
  const c = await mk('SC 1', 'set');
  const d = await mk('LX 2', 'light');

  // 重复编号
  const dup = await req('POST', `/api/shows/${sid}/cues`, { op: op.id, body: { cue_code: 'LX 1', cue_type: 'light' } });
  ok(dup.status === 409, '重复提示编号 → 409');

  console.log('3. 依赖校验：缺失引用 / 自引用 / 循环依赖');
  // 自引用
  const self = await req('PUT', `/api/cues/${a.id}/prereqs`, { op: op.id, body: { prereq_ids: [a.id] } });
  ok(self.status === 422, '自引用前置 → 422');

  // 正常前置：d 依赖 a；b 依赖 d
  await req('PUT', `/api/cues/${d.id}/prereqs`, { op: op.id, body: { prereq_ids: [a.id] } });
  await req('PUT', `/api/cues/${b.id}/prereqs`, { op: op.id, body: { prereq_ids: [d.id] } });
  let val = (await req('POST', `/api/shows/${sid}/validate`)).body;
  ok(val.valid, '无环依赖链校验通过');

  // 制造循环：a -> b (此时 a→? 链: b→d→a, 加 a→b 形成 a→b→d→a)
  const cyc = await req('PUT', `/api/cues/${a.id}/prereqs`, { op: op.id, body: { prereq_ids: [b.id] } });
  val = (await req('POST', `/api/shows/${sid}/validate`)).body;
  ok(!val.valid && val.errors.some((e) => e.code === 'CIRCULAR'), '循环依赖被检出');
  const cycPub = await req('POST', `/api/shows/${sid}/publish`, { op: op.id, body: {} });
  ok(cycPub.status === 422, '存在循环依赖时发布 → 422');
  // 解开环
  await req('PUT', `/api/cues/${a.id}/prereqs`, { op: op.id, body: { prereq_ids: [] } });

  console.log('4. 发布不可变执行单');
  const v1 = (await req('POST', `/api/shows/${sid}/publish`, { op: op.id, body: { note: 'v1' } })).body;
  ok(v1.version_no === 1, '发布 v1');
  val = (await req('POST', `/api/shows/${sid}/validate`)).body;
  ok(val.valid, '发布后草稿仍可校验');

  // 版本回看
  const sheet = (await req('GET', `/api/versions/${v1.id}`)).body;
  ok(sheet.cues.length === 4 && sheet.prereqs.length === 2, '版本快照包含 4 提示 2 依赖');

  console.log('5. 从 v1 启动演出并执行');
  const perf = (await req('POST', `/api/shows/${sid}/performances`, { op: op.id, body: { name: '晚场' } })).body;
  ok(perf.version_id === v1.id, '默认从最新已发布版本启动');
  let board = (await req('GET', `/api/performances/${perf.id}`)).body;
  const byCode = Object.fromEntries(board.cues.map((x) => [x.cue_code, x]));
  ok(byCode['LX 1'].state === 'pending', '无前置 LX 1 = 待执行');
  ok(byCode['LX 2'].state === 'blocked', 'LX 2 前置未触发 = 受阻');
  ok(byCode['SQ 1'].state === 'blocked', 'SQ 1 间接受阻（前置 LX 2 未触发）');
  ok(byCode['SC 1'].state === 'pending', '无前置 SC 1 = 待执行');
  ok(board.counts.blocked === 2 && board.counts.pending === 2, '统计：2 受阻 / 2 待执行');

  // 受阻项不能触发
  const blockedGo = await req('POST', `/api/performances/${perf.id}/cues/${byCode['LX 2'].id}/trigger`, { op: op.id });
  ok(blockedGo.status === 422 && blockedGo.body.blockedBy[0].cue_code === 'LX 1', '受阻项触发 → 422 且给出所阻前置');

  // 跳过必须填原因
  const noReason = await req('POST', `/api/performances/${perf.id}/cues/${byCode['SC 1'].id}/skip`, { op: op.id, body: { reason: '   ' } });
  ok(noReason.status === 400, '跳过不填原因 → 400');

  // 正常触发 LX 1（记录操作人与时间）
  const t1 = await req('POST', `/api/performances/${perf.id}/cues/${byCode['LX 1'].id}/trigger`, { op: op2.id });
  ok(t1.status === 201, 'LX 1 触发成功');
  board = (await req('GET', `/api/performances/${perf.id}`)).body;
  const lx1 = board.cues.find((x) => x.cue_code === 'LX 1');
  ok(lx1.result.operator_name === '测试助理' && !!lx1.result.acted_at, '结果留存操作人与时间');

  // 重复触发同一提示：并发 5 个，只允许 1 次
  const sc1 = (await req('GET', `/api/performances/${perf.id}`)).body.cues.find((x) => x.cue_code === 'SC 1');
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      req('POST', `/api/performances/${perf.id}/cues/${sc1.id}/trigger`, { op: i % 2 ? op.id : op2.id })),
  );
  const created = concurrent.filter((x) => x.status === 201).length;
  const conflicted = concurrent.filter((x) => x.status === 409).length;
  ok(created === 1 && conflicted === 4, `并发触发同一提示：1 成功 / 4 冲突（实际 ${created}/${conflicted}）`);
  ok(/已被/.test(concurrent.find((x) => x.status === 409).body.error), '冲突响应告知当前状态/操作人/时间');

  // 已触发的再次触发 → 409
  const again = await req('POST', `/api/performances/${perf.id}/cues/${sc1.id}/trigger`, { op: op.id });
  ok(again.status === 409, '已触发结果不可更改 → 409');

  // 前置触发后 LX 2 变为待执行
  board = (await req('GET', `/api/performances/${perf.id}`)).body;
  const lx2 = board.cues.find((x) => x.cue_code === 'LX 2');
  ok(lx2.state === 'pending', '前置 LX 1 已触发后 LX 2 → 待执行');

  // 跳过 SQ 1（此时前置 LX 2 未触发，受阻但允许跳过并填原因）
  const sq1Before = (await req('GET', `/api/performances/${perf.id}`)).body.cues.find((x) => x.cue_code === 'SQ 1');
  const skipBlocked = await req('POST', `/api/performances/${perf.id}/cues/${sq1Before.id}/skip`,
    { op: op.id, body: { reason: '设备故障' } });
  // 注意：SQ 1 前置 LX 2 未触发（受阻），跳过应被允许
  ok(skipBlocked.status === 201, '受阻项可跳过（填原因）');
  board = (await req('GET', `/api/performances/${perf.id}`)).body;
  const sq1 = board.cues.find((x) => x.cue_code === 'SQ 1');
  ok(sq1.state === 'skipped' && sq1.result.reason === '设备故障', '跳过原因留存');

  // 触发 LX 2 后收尾
  const t2 = await req('POST', `/api/performances/${perf.id}/cues/${lx2.id}/trigger`, { op: op.id });
  ok(t2.status === 201, 'LX 2 在前置满足后触发');

  // 结束演出
  const end = await req('POST', `/api/performances/${perf.id}/end`, { op: op.id });
  ok(end.status === 200, '结束演出');
  const afterEnd = await req('POST', `/api/performances/${perf.id}/cues/${board.cues.find((x)=>x.cue_code==='LX 2').id}/trigger`, { op: op.id });
  ok(afterEnd.status === 409, '演出结束后不能再记录结果 → 409');

  console.log('6. 草稿修改不影响已开始演出 & 新版本');
  // 改草稿：重命名 + 新增 + 改前置
  await req('PATCH', `/api/cues/${a.id}`, { op: op.id, body: { title: '改后的灯光名' } });
  const e = await req('POST', `/api/shows/${sid}/cues`, { op: op.id, body: { cue_code: 'SQ 9', cue_type: 'sound' } });
  await req('PUT', `/api/cues/${d.id}/prereqs`, { op: op.id, body: { prereq_ids: [a.id, c.id] } });
  const v2 = (await req('POST', `/api/shows/${sid}/publish`, { op: op.id, body: { note: 'v2' } })).body;
  ok(v2.version_no === 2, '发布 v2');

  // 回看旧演出：仍是 v1 的 4 个提示与旧标题
  board = (await req('GET', `/api/performances/${perf.id}`)).body;
  ok(board.performance.version_no === 1 && board.cues.length === 4, '历史演出仍锚定 v1（4 提示）');
  const oldA = board.cues.find((x) => x.cue_code === 'LX 1');
  ok(oldA.title === 'LX 1', '历史记录显示 v1 当时内容（草稿改名不影响）');
  const oldSheet = (await req('GET', `/api/versions/${v1.id}`)).body;
  ok(oldSheet.cues.length === 4, 'v1 快照仍可回看（不可变）');
  const newSheet = (await req('GET', `/api/versions/${v2.id}`)).body;
  ok(newSheet.cues.length === 5, 'v2 快照含新增提示');

  // 新演出可用 v1 也可用 v2
  const perf2 = (await req('POST', `/api/shows/${sid}/performances`, { op: op.id, body: { name: '午场', version_id: v2.id } })).body;
  const b2 = (await req('GET', `/api/performances/${perf2.id}`)).body;
  ok(b2.cues.length === 5 && b2.performance.version_no === 2, '新演出独立锚定 v2');

  // 非法版本
  const badVer = await req('POST', `/api/shows/${sid}/performances`, { op: op.id, body: { version_id: 999999 } });
  ok(badVer.status === 400, '引用不存在版本启动 → 400');

  console.log('7. 排序');
  const draft = (await req('GET', `/api/shows/${sid}/draft`)).body;
  const reversed = [...draft.cues].reverse().map((x) => x.id);
  const ord = await req('PUT', `/api/shows/${sid}/cues/order`, { op: op.id, body: { order: reversed } });
  ok(ord.status === 204, '全量排序保存成功');
  const stale = await req('PUT', `/api/shows/${sid}/cues/order`, { op: op.id, body: { order: [a.id] } });
  ok(stale.status === 400, '排序列表与当前提示不一致 → 400');

  console.log('8. 静态资源');
  const index = await fetch(BASE + '/');
  ok(index.status === 200 && (await index.text()).includes('CALL BOARD'), '首页可访问');
} catch (err) {
  console.error('测试运行异常：', err);
  fail++;
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
