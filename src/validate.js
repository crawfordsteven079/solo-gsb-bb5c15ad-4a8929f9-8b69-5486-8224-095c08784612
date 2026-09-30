/**
 * 草稿依赖校验：
 *  - 空场次
 *  - 重复提示编号
 *  - 缺失引用（悬空前置）
 *  - 自引用
 *  - 循环依赖
 *
 * cues: [{ id, cue_code, cue_type }]
 * prereqs: [{ cue_id, prereq_id }]
 * 返回错误数组，空数组表示校验通过。
 */
export function validateCues(cues, prereqs) {
  const errors = [];

  if (cues.length === 0) {
    errors.push({ code: 'EMPTY', message: '当前没有任何提示，无法发布执行单。' });
    return errors;
  }

  // 重复编号
  const seenCode = new Map();
  for (const c of cues) {
    if (seenCode.has(c.cue_code)) {
      errors.push({
        code: 'DUPLICATE_CODE',
        cue_code: c.cue_code,
        message: `提示编号重复：${c.cue_code}`,
      });
    } else {
      seenCode.set(c.cue_code, c.id);
    }
  }

  const ids = new Set(cues.map((c) => c.id));
  const codeById = new Map(cues.map((c) => [c.id, c.cue_code]));

  // 邻接表：cue 依赖它的 prereq（prereq 必须先发生）
  const adj = new Map(cues.map((c) => [c.id, []]));

  for (const e of prereqs) {
    if (!ids.has(e.cue_id)) {
      errors.push({
        code: 'MISSING_CUE',
        cue_id: e.cue_id,
        message: '存在指向已删除提示的依赖关系，请重新编辑前置提示。',
      });
      continue;
    }
    if (!ids.has(e.prereq_id)) {
      errors.push({
        code: 'MISSING_REFERENCE',
        cue_id: e.cue_id,
        cue_code: codeById.get(e.cue_id),
        message: `提示 ${codeById.get(e.cue_id) ?? '?'} 的前置提示不存在（缺失引用）。`,
      });
      continue;
    }
    if (e.cue_id === e.prereq_id) {
      errors.push({
        code: 'SELF_REFERENCE',
        cue_id: e.cue_id,
        cue_code: codeById.get(e.cue_id),
        message: `提示 ${codeById.get(e.cue_id)} 不能把自身设为前置。`,
      });
      continue;
    }
    adj.get(e.cue_id).push(e.prereq_id);
  }

  // 循环依赖检测（DFS 三色标记）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(cues.map((c) => [c.id, WHITE]));
  const stack = [];
  const reported = new Set();

  const dfs = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      if (!ids.has(next)) continue;
      if (color.get(next) === GRAY) {
        // 找到环：从 next 在栈中的位置开始
        const start = stack.indexOf(next);
        const cycle = stack.slice(start).concat(next);
        const key = [...cycle].map((x) => x).sort((a, b) => a - b).join(',');
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({
            code: 'CIRCULAR',
            cycle: cycle.map((x) => codeById.get(x)),
            message: `存在循环依赖：${cycle.map((x) => codeById.get(x)).join(' → ')}`,
          });
        }
      } else if (color.get(next) === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const c of cues) {
    if (color.get(c.id) === WHITE) dfs(c.id);
  }

  return errors;
}

/**
 * 计算执行单上每个提示的展示状态。
 *  - triggered / skipped：已有结果
 *  - blocked：存在既未触发也未跳过状态不明的前置 —— 实际上只要有前置不是 triggered 即受阻
 *  - pending：全部前置均已触发
 *
 * 约定：跳过的前置不会满足“均已触发”，因此其后继将持续受阻，
 * 需要由监督通过「跳过」显式处理（受阻项不能触发，但可跳过并填原因）。
 *
 * cues:     [{ id, seq, cue_code, cue_type, title, notes }]
 * prereqs:  [{ cue_id, prereq_id }]
 * results:  Map<cue_id, { result, reason, operator_id, operator_name, acted_at }>
 */
export function deriveStates(cues, prereqs, results) {
  const prereqOf = new Map(cues.map((c) => [c.id, []]));
  for (const e of prereqs) {
    if (!prereqOf.has(e.cue_id)) prereqOf.set(e.cue_id, []);
    prereqOf.get(e.cue_id).push(e.prereq_id);
  }

  const codeById = new Map(cues.map((c) => [c.id, c.cue_code]));
  const states = new Map();

  for (const cue of cues) {
    const result = results.get(cue.id);
    if (result) {
      states.set(cue.id, { state: result.result, result });
      continue;
    }
    const prereqIds = prereqOf.get(cue.id) || [];
    const blockedBy = [];
    for (const pid of prereqIds) {
      const r = results.get(pid);
      if (!r || r.result !== 'triggered') {
        blockedBy.push({
          cue_id: pid,
          cue_code: codeById.get(pid) ?? '?',
          reason: !r ? 'not_triggered' : r.result, // not_triggered / skipped
        });
      }
    }
    states.set(cue.id, blockedBy.length === 0
      ? { state: 'pending' }
      : { state: 'blocked', blockedBy });
  }

  return { states, prereqOf };
}
