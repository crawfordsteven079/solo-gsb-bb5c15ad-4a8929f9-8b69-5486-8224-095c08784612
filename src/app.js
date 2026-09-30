import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTx, waitForDatabase } from './db.js';
import { validateCues, deriveStates } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = Number(process.env.PORT || 3000);

const CUE_TYPES = new Set(['light', 'sound', 'set']);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------- 操作人身份 ----------------

async function requireOperator(req, _res, next) {
  const raw = req.get('X-Operator-Id');
  const id = Number(raw);
  if (!Number.isInteger(id)) {
    return next(new HttpError(401, '未选择操作人，请先在页面右上角选择或新建操作人。'));
  }
  const { rows } = await query('SELECT id, name, role FROM operators WHERE id=$1', [id]);
  if (rows.length === 0) return next(new HttpError(401, '操作人不存在，请重新选择。'));
  req.operator = rows[0];
  next();
}

// ---------------- 数据访问辅助 ----------------

async function loadDraft(client, showId) {
  const cues = (await client.query(
    `SELECT id, show_id, cue_code, cue_type, title, notes, seq
       FROM cue_drafts WHERE show_id=$1 ORDER BY seq, id`,
    [showId],
  )).rows;
  const prereqs = (await client.query(
    'SELECT cue_id, prereq_id FROM prereq_drafts WHERE show_id=$1',
    [showId],
  )).rows;
  return { cues, prereqs };
}

async function getShowOr404(client, showId) {
  const { rows } = await client.query('SELECT * FROM shows WHERE id=$1', [showId]);
  if (rows.length === 0) throw new HttpError(404, '场次不存在。');
  return rows[0];
}

async function getLatestVersion(client, showId) {
  const { rows } = await client.query(
    'SELECT * FROM versions WHERE show_id=$1 ORDER BY version_no DESC LIMIT 1',
    [showId],
  );
  return rows[0] || null;
}

// ---------------- 健康检查 & 操作人 ----------------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/operators', async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, name, role, created_at FROM operators ORDER BY id',
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/operators', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const role = ['stage_manager', 'assistant', 'director'].includes(req.body?.role)
      ? req.body.role : 'stage_manager';
    if (!name) throw new HttpError(400, '操作人姓名不能为空。');
    const { rows } = await query(
      'INSERT INTO operators (name, role) VALUES ($1,$2) RETURNING id, name, role, created_at',
      [name, role],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------- 场次 ----------------

app.get('/api/shows', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT s.id, s.name, s.description, s.created_at,
             (SELECT count(*) FROM cue_drafts d WHERE d.show_id=s.id) AS draft_count,
             (SELECT max(version_no) FROM versions v WHERE v.show_id=s.id) AS latest_version,
             (SELECT count(*) FROM performances p WHERE p.show_id=s.id) AS performance_count
        FROM shows s ORDER BY s.id
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/shows', requireOperator, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new HttpError(400, '场次名称不能为空。');
    const description = String(req.body?.description || '').trim();
    const { rows } = await query(
      'INSERT INTO shows (name, description, created_by) VALUES ($1,$2,$3) RETURNING *',
      [name, description, req.operator.id],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

app.get('/api/shows/:id', async (req, res, next) => {
  try {
    const show = await getShowOr404(pool, Number(req.params.id));
    res.json(show);
  } catch (err) { next(err); }
});

app.patch('/api/shows/:id', requireOperator, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const show = await getShowOr404(pool, id);
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : show.name;
    const description = req.body?.description !== undefined
      ? String(req.body.description).trim() : show.description;
    if (!name) throw new HttpError(400, '场次名称不能为空。');
    const { rows } = await query(
      'UPDATE shows SET name=$1, description=$2 WHERE id=$3 RETURNING *',
      [name, description, id],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get('/api/shows/:id/versions', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getShowOr404(pool, id);
    const { rows } = await query(`
      SELECT v.id, v.version_no, v.note, v.published_at,
             o.name AS published_by_name,
             (SELECT count(*) FROM cues c WHERE c.version_id=v.id) AS cue_count
        FROM versions v
        LEFT JOIN operators o ON o.id = v.published_by
       WHERE v.show_id=$1 ORDER BY v.version_no DESC`, [id]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/shows/:id/performances', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getShowOr404(pool, id);
    const { rows } = await query(`
      SELECT p.id, p.name, p.status, p.started_at, p.ended_at,
             v.version_no,
             so.name AS started_by_name,
             (SELECT count(*) FROM cues c WHERE c.version_id=p.version_id) AS total_cues,
             (SELECT count(*) FROM cue_results cr
                WHERE cr.performance_id=p.id AND cr.result='triggered') AS triggered_count,
             (SELECT count(*) FROM cue_results cr
                WHERE cr.performance_id=p.id AND cr.result='skipped') AS skipped_count
        FROM performances p
        JOIN versions v ON v.id=p.version_id
        LEFT JOIN operators so ON so.id=p.started_by
       WHERE p.show_id=$1 ORDER BY p.started_at DESC`, [id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------- 草稿：读取 / 校验 ----------------

app.get('/api/shows/:id/draft', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getShowOr404(pool, id);
    const draft = await loadDraft(pool, id);
    res.json(draft);
  } catch (err) { next(err); }
});

app.post('/api/shows/:id/validate', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getShowOr404(pool, id);
    const draft = await loadDraft(pool, id);
    const errors = validateCues(draft.cues, draft.prereqs);
    res.json({ valid: errors.length === 0, errors });
  } catch (err) { next(err); }
});

// ---------------- 草稿：提示增改删 / 排序 / 前置 ----------------

app.post('/api/shows/:id/cues', requireOperator, async (req, res, next) => {
  try {
    const showId = Number(req.params.id);
    const cueCode = String(req.body?.cue_code || '').trim();
    const cueType = String(req.body?.cue_type || '').trim();
    const title = String(req.body?.title || '').trim();
    const notes = String(req.body?.notes || '').trim();
    if (!cueCode) throw new HttpError(400, '提示编号不能为空（如 LX 1）。');
    if (!CUE_TYPES.has(cueType)) throw new HttpError(400, '提示类型必须为 light / sound / set。');

    const row = await withTx(async (client) => {
      await getShowOr404(client, showId);
      const max = (await client.query(
        'SELECT COALESCE(MAX(seq),0) AS m FROM cue_drafts WHERE show_id=$1', [showId],
      )).rows[0].m;
      const r = await client.query(
        `INSERT INTO cue_drafts (show_id, cue_code, cue_type, title, notes, seq)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [showId, cueCode, cueType, title, notes, max + 10],
      );
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

app.patch('/api/cues/:cueId', requireOperator, async (req, res, next) => {
  try {
    const cueId = Number(req.params.cueId);
    const row = await withTx(async (client) => {
      const cur = (await client.query('SELECT * FROM cue_drafts WHERE id=$1', [cueId])).rows[0];
      if (!cur) throw new HttpError(404, '提示不存在。');
      const cueCode = req.body?.cue_code !== undefined ? String(req.body.cue_code).trim() : cur.cue_code;
      const cueType = req.body?.cue_type !== undefined ? String(req.body.cue_type).trim() : cur.cue_type;
      const title = req.body?.title !== undefined ? String(req.body.title).trim() : cur.title;
      const notes = req.body?.notes !== undefined ? String(req.body.notes).trim() : cur.notes;
      if (!cueCode) throw new HttpError(400, '提示编号不能为空。');
      if (!CUE_TYPES.has(cueType)) throw new HttpError(400, '提示类型必须为 light / sound / set。');
      const r = await client.query(
        `UPDATE cue_drafts SET cue_code=$1, cue_type=$2, title=$3, notes=$4
          WHERE id=$5 RETURNING *`,
        [cueCode, cueType, title, notes, cueId],
      );
      return r.rows[0];
    });
    res.json(row);
  } catch (err) { next(err); }
});

app.delete('/api/cues/:cueId', requireOperator, async (req, res, next) => {
  try {
    const cueId = Number(req.params.cueId);
    await withTx(async (client) => {
      const cur = (await client.query('SELECT * FROM cue_drafts WHERE id=$1', [cueId])).rows[0];
      if (!cur) throw new HttpError(404, '提示不存在。');
      await client.query('DELETE FROM cue_drafts WHERE id=$1', [cueId]);
      // 级联会同时清理 prereq_drafts
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// 全量保存顺序
app.put('/api/shows/:id/cues/order', requireOperator, async (req, res, next) => {
  try {
    const showId = Number(req.params.id);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : null;
    if (!order || order.length === 0) throw new HttpError(400, '缺少排序列表 order。');
    await withTx(async (client) => {
      await getShowOr404(client, showId);
      const { rows } = await client.query(
        'SELECT id FROM cue_drafts WHERE show_id=$1', [showId],
      );
      const ids = new Set(rows.map((r) => r.id));
      if (order.length !== ids.size || order.some((x) => !ids.has(x))) {
        throw new HttpError(400, '排序列表与当前提示不一致，请刷新后重试。');
      }
      await Promise.all(order.map((id, idx) =>
        client.query('UPDATE cue_drafts SET seq=$1 WHERE id=$2', [(idx + 1) * 10, id])));
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// 全量替换某提示的前置
app.put('/api/cues/:cueId/prereqs', requireOperator, async (req, res, next) => {
  try {
    const cueId = Number(req.params.cueId);
    const prereqIds = Array.isArray(req.body?.prereq_ids)
      ? [...new Set(req.body.prereq_ids.map(Number))] : null;
    if (!prereqIds) throw new HttpError(400, '缺少 prereq_ids 列表。');
    await withTx(async (client) => {
      const cue = (await client.query('SELECT * FROM cue_drafts WHERE id=$1', [cueId])).rows[0];
      if (!cue) throw new HttpError(404, '提示不存在。');
      if (prereqIds.includes(cueId)) {
        throw new HttpError(422, '提示不能把自身设为前置。');
      }
      const { rows } = await client.query(
        'SELECT id FROM cue_drafts WHERE show_id=$1', [cue.show_id],
      );
      const ids = new Set(rows.map((r) => r.id));
      if (prereqIds.some((x) => !ids.has(x))) {
        throw new HttpError(422, '前置提示必须属于同一场次（缺失引用）。');
      }
      await client.query('DELETE FROM prereq_drafts WHERE cue_id=$1', [cueId]);
      for (const pid of prereqIds) {
        await client.query(
          'INSERT INTO prereq_drafts (show_id, cue_id, prereq_id) VALUES ($1,$2,$3)',
          [cue.show_id, cueId, pid],
        );
      }
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---------------- 发布不可变执行单 ----------------

app.post('/api/shows/:id/publish', requireOperator, async (req, res, next) => {
  try {
    const showId = Number(req.params.id);
    const note = String(req.body?.note || '').trim();
    const version = await withTx(async (client) => {
      await getShowOr404(client, showId);
      // 锁定场次，避免并发发布产生相同版本号
      await client.query('SELECT id FROM shows WHERE id=$1 FOR UPDATE', [showId]);

      const draft = await loadDraft(client, showId);
      const errors = validateCues(draft.cues, draft.prereqs);
      if (errors.length > 0) {
        throw new HttpError(422, '草稿校验未通过，无法发布。', { errors });
      }

      const nextNo = (await client.query(
        'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM versions WHERE show_id=$1', [showId],
      )).rows[0].n;

      const v = (await client.query(
        `INSERT INTO versions (show_id, version_no, published_by, note)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [showId, nextNo, req.operator.id, note],
      )).rows[0];

      const idMap = new Map();
      for (const c of draft.cues) {
        const r = await client.query(
          `INSERT INTO cues (version_id, cue_code, cue_type, title, notes, seq)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [v.id, c.cue_code, c.cue_type, c.title, c.notes, c.seq],
        );
        idMap.set(c.id, r.rows[0].id);
      }
      for (const e of draft.prereqs) {
        await client.query(
          'INSERT INTO prereqs (version_id, cue_id, prereq_id) VALUES ($1,$2,$3)',
          [v.id, idMap.get(e.cue_id), idMap.get(e.prereq_id)],
        );
      }
      return v;
    });
    res.status(201).json(version);
  } catch (err) { next(err); }
});

// ---------------- 版本回看 ----------------

app.get('/api/versions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const version = (await query(`
      SELECT v.*, s.id AS show_id, s.name AS show_name, o.name AS published_by_name
        FROM versions v JOIN shows s ON s.id=v.show_id
        LEFT JOIN operators o ON o.id=v.published_by
       WHERE v.id=$1`, [id])).rows[0];
    if (!version) throw new HttpError(404, '版本不存在。');
    const cues = (await query(
      'SELECT * FROM cues WHERE version_id=$1 ORDER BY seq, id', [id])).rows;
    const prereqRows = (await query(
      'SELECT cue_id, prereq_id FROM prereqs WHERE version_id=$1', [id])).rows;
    const codeById = new Map(cues.map((c) => [c.id, c.cue_code]));
    const prereqs = prereqRows.map((e) => ({
      ...e,
      cue_code: codeById.get(e.cue_id),
      prereq_code: codeById.get(e.prereq_id),
    }));
    res.json({ version, cues, prereqs });
  } catch (err) { next(err); }
});

// ---------------- 演出 ----------------

app.post('/api/shows/:id/performances', requireOperator, async (req, res, next) => {
  try {
    const showId = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    const row = await withTx(async (client) => {
      await getShowOr404(client, showId);
      let version;
      if (req.body?.version_id) {
        version = (await client.query(
          'SELECT * FROM versions WHERE id=$1 AND show_id=$2',
          [Number(req.body.version_id), showId],
        )).rows[0];
        if (!version) throw new HttpError(400, '指定的已发布版本不存在或不属于该场次。');
      } else {
        version = await getLatestVersion(client, showId);
        if (!version) {
          throw new HttpError(400, '该场次还没有已发布版本，请先校验并发布执行单。');
        }
      }
      const r = await client.query(
        `INSERT INTO performances (show_id, version_id, name, started_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [showId, version.id, name, req.operator.id],
      );
      return r.rows[0];
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

async function buildBoard(client, perfId) {
  const perf = (await client.query(`
    SELECT p.*, v.version_no, s.name AS show_name, o.name AS started_by_name
      FROM performances p
      JOIN versions v ON v.id=p.version_id
      JOIN shows s ON s.id=p.show_id
      LEFT JOIN operators o ON o.id=p.started_by
     WHERE p.id=$1`, [perfId])).rows[0];
  if (!perf) throw new HttpError(404, '演出记录不存在。');

  const cues = (await client.query(
    'SELECT * FROM cues WHERE version_id=$1 ORDER BY seq, id', [perf.version_id])).rows;
  const prereqs = (await client.query(
    'SELECT cue_id, prereq_id FROM prereqs WHERE version_id=$1', [perf.version_id])).rows;
  const resultRows = (await client.query(`
    SELECT cr.cue_id, cr.result, cr.reason, cr.acted_at,
           cr.operator_id, o.name AS operator_name
      FROM cue_results cr JOIN operators o ON o.id=cr.operator_id
     WHERE cr.performance_id=$1`, [perfId])).rows;
  const results = new Map(resultRows.map((r) => [r.cue_id, r]));
  const { states, prereqOf } = deriveStates(cues, prereqs, results);

  const codeById = new Map(cues.map((c) => [c.id, c.cue_code]));
  const cueView = cues.map((c) => {
    const st = states.get(c.id);
    return {
      ...c,
      state: st.state,
      result: st.result || null,
      blockedBy: (st.blockedBy || []),
      prereq_codes: (prereqOf.get(c.id) || []).map((pid) => codeById.get(pid)),
    };
  });

  const counts = cueView.reduce((acc, c) => {
    acc[c.state] = (acc[c.state] || 0) + 1;
    return acc;
  }, {});

  return { performance: perf, cues: cueView, counts };
}

app.get('/api/performances/:id', async (req, res, next) => {
  try {
    res.json(await buildBoard(pool, Number(req.params.id)));
  } catch (err) { next(err); }
});

app.post('/api/performances/:id/end', requireOperator, async (req, res, next) => {
  try {
    const perfId = Number(req.params.id);
    const row = await withTx(async (client) => {
      await client.query('SELECT id FROM performances WHERE id=$1 FOR UPDATE', [perfId]);
      const cur = (await client.query('SELECT * FROM performances WHERE id=$1', [perfId])).rows[0];
      if (!cur) throw new HttpError(404, '演出记录不存在。');
      if (cur.status === 'ended') throw new HttpError(409, '演出已结束，不能重复结束。');
      const r = await client.query(
        `UPDATE performances SET status='ended', ended_at=now() WHERE id=$1 RETURNING *`,
        [perfId],
      );
      return r.rows[0];
    });
    res.json(row);
  } catch (err) { next(err); }
});

async function actOnCue(client, perfId, cueId, action, operatorId, reason) {
  // 锁定演出行，串行化同场演出的并发操作
  const locked = (await client.query(
    'SELECT id, status, version_id FROM performances WHERE id=$1 FOR UPDATE', [perfId],
  )).rows[0];
  if (!locked) throw new HttpError(404, '演出记录不存在。');
  if (locked.status === 'ended') throw new HttpError(409, '演出已结束，不能再记录提示结果。');

  const cue = (await client.query(
    'SELECT * FROM cues WHERE id=$1 AND version_id=$2', [cueId, locked.version_id],
  )).rows[0];
  if (!cue) throw new HttpError(404, '该提示不属于当前演出的执行单版本。');

  const existing = (await client.query(
    'SELECT cr.*, o.name AS operator_name FROM cue_results cr JOIN operators o ON o.id=cr.operator_id WHERE cr.performance_id=$1 AND cr.cue_id=$2 FOR UPDATE',
    [perfId, cueId],
  )).rows[0];
  if (existing) {
    // 并发/重复操作：只保留第一次的有效结果，告知当前状态
    throw new HttpError(409,
      `提示 ${cue.cue_code} 已被${existing.operator_name}于${new Date(existing.acted_at).toLocaleString('zh-CN')}「${existing.result === 'triggered' ? '触发' : '跳过'}」，当前状态不可更改。`,
      { current: existing });
  }

  const prereqRows = (await client.query(
    'SELECT prereq_id FROM prereqs WHERE version_id=$1 AND cue_id=$2',
    [locked.version_id, cueId],
  )).rows;
  const blockedBy = [];
  for (const { prereq_id } of prereqRows) {
    const r = (await client.query(
      'SELECT result FROM cue_results WHERE performance_id=$1 AND cue_id=$2',
      [perfId, prereq_id],
    )).rows[0];
    if (!r || r.result !== 'triggered') {
      const pc = (await client.query('SELECT cue_code FROM cues WHERE id=$1', [prereq_id])).rows[0];
      blockedBy.push({
        cue_id: prereq_id,
        cue_code: pc?.cue_code ?? '?',
        reason: !r ? 'not_triggered' : r.result,
      });
    }
  }

  if (action === 'trigger' && blockedBy.length > 0) {
    throw new HttpError(422,
      `前置提示未全部触发，提示 ${cue.cue_code} 目前受阻，不能触发。`,
      { blockedBy });
  }
  if (action === 'skip' && !reason) {
    throw new HttpError(400, '跳过提示必须填写原因。');
  }

  const inserted = (await client.query(
    `INSERT INTO cue_results (performance_id, cue_id, result, reason, operator_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [perfId, cueId, action === 'trigger' ? 'triggered' : 'skipped', reason || '', operatorId],
  )).rows[0];
  return inserted;
}

app.post('/api/performances/:id/cues/:cueId/trigger', requireOperator, async (req, res, next) => {
  try {
    const inserted = await withTx((client) =>
      actOnCue(client, Number(req.params.id), Number(req.params.cueId), 'trigger', req.operator.id));
    res.status(201).json(inserted);
  } catch (err) { next(err); }
});

app.post('/api/performances/:id/cues/:cueId/skip', requireOperator, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    const inserted = await withTx((client) =>
      actOnCue(client, Number(req.params.id), Number(req.params.cueId), 'skip', req.operator.id, reason));
    res.status(201).json(inserted);
  } catch (err) { next(err); }
});

// ---------------- 错误处理 ----------------

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: '数据冲突：可能是编号重复或重复操作。', detail: err.detail });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: '存在引用关系，无法完成该操作。', detail: err.detail });
  }
  if (err.code === '23514' || err.code === '23502') {
    return res.status(400).json({ error: '数据不合法，请检查输入。', detail: err.message });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误。' });
});

// ---------------- 启动 ----------------

waitForDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Call Board 已启动: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('无法连接数据库：', err.message);
    process.exit(1);
  });
