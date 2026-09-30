'use strict';

/* ============================================================
 * Call Board 前端（无框架单页应用，hash 路由）
 * ============================================================ */

const TYPE_LABEL = { light: '灯光', sound: '音效', set: '布景' };
const STATE_LABEL = { pending: '待执行', triggered: '已触发', skipped: '已跳过', blocked: '受阻' };
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待执行' },
  { key: 'blocked', label: '受阻' },
  { key: 'triggered', label: '已触发' },
  { key: 'skipped', label: '已跳过' },
];

const state = {
  operatorId: Number(localStorage.getItem('operatorId')) || null,
  operators: [],
  boardFilter: 'all',
  pollTimer: null,
  editorTab: 'draft',
};

/* ---------------- HTTP ---------------- */

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.operatorId) headers['X-Operator-Id'] = String(state.operatorId);
  const res = await fetch(path, { ...options, headers });
  let body = null;
  const text = await res.text();
  if (text) body = JSON.parse(text);
  if (!res.ok) {
    const err = new Error(body?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(t) {
  if (!t) return '';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}
function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function showErrors(prefix, err) {
  const details = err.body?.errors;
  if (Array.isArray(details) && details.length) {
    toast(`${prefix}：${details[0].message}${details.length > 1 ? `（等 ${details.length} 项）` : ''}`, 'error');
  } else if (err.body?.blockedBy?.length) {
    const names = err.body.blockedBy.map((b) => b.cue_code).join('、');
    toast(`${prefix}：前置 ${names} 未触发，当前处于受阻状态。`, 'error');
  } else {
    toast(`${prefix}：${err.message}`, 'error');
  }
}

/* ---------------- 弹窗 ---------------- */

function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-root').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-root').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

/* ---------------- 操作人 ---------------- */

async function loadOperators({ keepSelection = true } = {}) {
  state.operators = await api('/api/operators');
  const sel = document.getElementById('operator-select');
  sel.innerHTML = state.operators
    .map((o) => `<option value="${o.id}">${esc(o.name)}（${({ stage_manager: '舞台监督', assistant: '助理监督', director: '导演' })[o.role]}）</option>`)
    .join('');
  if (state.operators.some((o) => o.id === state.operatorId) && keepSelection) {
    sel.value = String(state.operatorId);
  } else if (state.operators.length) {
    state.operatorId = state.operators[0].id;
    localStorage.setItem('operatorId', String(state.operatorId));
    sel.value = String(state.operatorId);
  } else {
    state.operatorId = null;
    localStorage.removeItem('operatorId');
  }
}

/* ============================================================
 * 路由
 * ============================================================ */

const view = document.getElementById('view');

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function router() {
  stopPolling();
  closeModal();
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/show\/(\d+)/);
  const r = hash.match(/^#\/run\/(\d+)/);
  const v = hash.match(/^#\/version\/(\d+)/);
  try {
    if (m) await renderShow(Number(m[1]));
    else if (r) await renderRun(Number(r[1]));
    else if (v) await renderVersion(Number(v[1]));
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div>${esc(err.message)}</div>`;
  }
}
window.addEventListener('hashchange', router);

/* ============================================================
 * 首页：场次列表
 * ============================================================ */

async function renderHome() {
  const shows = await api('/api/shows');
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>场次列表</h1>
        <div class="sub">管理剧目排演草稿，校验依赖后发布不可变执行单</div>
      </div>
      <button class="btn btn-primary" data-action="new-show">＋ 新建场次</button>
    </div>
    ${shows.length === 0 ? `
      <div class="empty-state">
        <div class="icon">📋</div>
        还没有场次，点击右上角「新建场次」开始排演。
      </div>` : `
      <div class="grid">
        ${shows.map((s) => `
          <a class="show-card" href="#/show/${s.id}">
            <h3>${esc(s.name)}</h3>
            <div class="desc">${esc(s.description || '（无说明）')}</div>
            <div class="show-meta">
              <span class="tag">草稿提示 ${s.draft_count}</span>
              ${s.latest_version
                ? `<span class="tag live">已发布 v${s.latest_version}</span>`
                : `<span class="tag empty">未发布</span>`}
              <span class="tag">演出 ${s.performance_count}</span>
            </div>
          </a>`).join('')}
      </div>`}
  `;
}

/* ============================================================
 * 场次编辑页（草稿 / 版本 / 演出）
 * ============================================================ */

async function renderShow(id) {
  const [show, draft, versions, performances] = await Promise.all([
    api(`/api/shows/${id}`),
    api(`/api/shows/${id}/draft`),
    api(`/api/shows/${id}/versions`),
    api(`/api/shows/${id}/performances`),
  ]);
  state.showPage = { id, show, draft, versions, performances };

  view.innerHTML = `
    <div class="crumb"><a href="#/">场次列表</a> / ${esc(show.name)}</div>
    <div class="page-head">
      <div>
        <h1>${esc(show.name)}</h1>
        <div class="sub">${esc(show.description || '（无说明）')}</div>
      </div>
      <div class="toolbar">
        <button class="btn" data-action="validate-show" data-id="${id}">校验依赖</button>
        <button class="btn btn-primary" data-action="publish-show" data-id="${id}">发布执行单</button>
      </div>
    </div>
    <div class="toolbar">
      <button class="filter-btn ${state.editorTab === 'draft' ? 'active' : ''}" data-action="tab" data-tab="draft">草稿提示（${draft.cues.length}）</button>
      <button class="filter-btn ${state.editorTab === 'versions' ? 'active' : ''}" data-action="tab" data-tab="versions">已发布版本（${versions.length}）</button>
      <button class="filter-btn ${state.editorTab === 'runs' ? 'active' : ''}" data-action="tab" data-tab="runs">演出记录（${performances.length}）</button>
    </div>
    <div id="tab-panel"></div>
  `;
  renderShowTab();
}

function renderShowTab() {
  const panel = document.getElementById('tab-panel');
  const { id, draft, versions, performances } = state.showPage;

  if (state.editorTab === 'versions') {
    panel.innerHTML = versions.length === 0
      ? `<div class="empty-state"><div class="icon">📌</div>尚无已发布版本。草稿校验通过后点击「发布执行单」。</div>`
      : `<div class="panel"><table class="table">
          <thead><tr><th>版本</th><th>提示数</th><th>说明</th><th>发布人</th><th>发布时间</th><th></th></tr></thead>
          <tbody>${versions.map((v) => `
            <tr>
              <td><strong>v${v.version_no}</strong></td>
              <td>${v.cue_count}</td>
              <td>${esc(v.note || '—')}</td>
              <td>${esc(v.published_by_name || '—')}</td>
              <td>${fmtTime(v.published_at)}</td>
              <td><a class="btn btn-sm" href="#/version/${v.id}">查看执行单</a></td>
            </tr>`).join('')}
          </tbody></table></div>`;
    return;
  }

  if (state.editorTab === 'runs') {
    panel.innerHTML = `
      <div class="panel">
        <h2>启动新演出</h2>
        ${versions.length === 0
          ? `<div class="error-list"><li>该场次没有已发布版本，无法启动演出。请先在「草稿提示」中校验并发布执行单。</li></div>`
          : `<form data-submit="start-performance" data-show-id="${id}">
              <div class="form-row">
                <div class="form-field">
                  <label>本场名称（可选，如：周六晚场）</label>
                  <input type="text" name="name" placeholder="例如：9 月 30 日联排" />
                </div>
                <div class="form-field">
                  <label>执行单版本</label>
                  <select name="version_id">
                    ${versions.map((v) => `<option value="${v.id}">v${v.version_no}${v.id === versions[0].id ? '（最新）' : ''} — ${fmtTime(v.published_at)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="form-actions">
                <button class="btn btn-go" type="submit">▶ 从所选版本启动独立记录</button>
              </div>
            </form>`}
      </div>
      ${performances.length === 0 ? `<div class="empty-state">暂无演出记录。</div>` : `
      <div class="panel"><table class="table">
        <thead><tr><th>演出</th><th>版本</th><th>状态</th><th>进度</th><th>启动人</th><th>启动时间</th><th></th></tr></thead>
        <tbody>${performances.map((p) => `
          <tr>
            <td>${esc(p.name || '（未命名）')}</td>
            <td>v${p.version_no}</td>
            <td>${p.status === 'running' ? '<span class="state state-pending"><span class="live-dot"></span>进行中</span>' : '<span class="tag">已结束</span>'}</td>
            <td>${p.triggered_count} 触发 / ${p.skipped_count} 跳过 / 共 ${p.total_cues}</td>
            <td>${esc(p.started_by_name || '—')}</td>
            <td>${fmtTime(p.started_at)}</td>
            <td><a class="btn btn-sm btn-go" href="#/run/${p.id}">进入执行台</a></td>
          </tr>`).join('')}
      </tbody></table></div>`}`;
    return;
  }

  /* 草稿提示 */
  const codeById = new Map(draft.cues.map((c) => [c.id, c.cue_code]));
  const prereqMap = new Map(draft.cues.map((c) => [c.id, []]));
  for (const e of draft.prereqs) {
    prereqMap.get(e.cue_id)?.push(codeById.get(e.prereq_id) || '?');
  }

  panel.innerHTML = `
    <div class="panel">
      <h2>提示序列（灯光 / 音效 / 布景）</h2>
      ${draft.cues.length === 0 ? `
        <div class="empty-state">
          <div class="icon">💡</div>
          草稿为空。添加提示并设置前置，校验通过后即可发布。
          <div style="margin-top:14px"><button class="btn btn-primary" data-action="new-cue" data-show-id="${id}">＋ 添加提示</button></div>
        </div>` : `
      <div class="toolbar">
        <button class="btn btn-primary btn-sm" data-action="new-cue" data-show-id="${id}">＋ 添加提示</button>
        <span class="muted">用 ↑ ↓ 调整执行顺序；前置未全部触发时，该提示在现场将显示为「受阻」</span>
      </div>
      <div class="cue-list">
        ${draft.cues.map((c, i) => `
          <div class="cue-row">
            <div class="cue-seq">${i + 1}</div>
            <span class="type-badge type-${c.cue_type}">${TYPE_LABEL[c.cue_type]}</span>
            <div class="cue-main">
              <span class="cue-code">${esc(c.cue_code)}</span>
              <span class="cue-title">${esc(c.title)}</span>
              <div class="cue-notes">${esc(c.notes)}</div>
              ${(prereqMap.get(c.id)?.length) ? `<div class="prereq-line">前置：${prereqMap.get(c.id).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="cue-side">
              <div class="toolbar" style="margin:0">
                <button class="btn btn-sm btn-ghost" data-action="cue-up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
                <button class="btn btn-sm btn-ghost" data-action="cue-down" data-id="${c.id}" ${i === draft.cues.length - 1 ? 'disabled' : ''} title="下移">↓</button>
                <button class="btn btn-sm" data-action="edit-prereqs" data-id="${c.id}">前置</button>
                <button class="btn btn-sm" data-action="edit-cue" data-id="${c.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-action="delete-cue" data-id="${c.id}">删除</button>
              </div>
            </div>
          </div>`).join('')}
      </div>`}
    </div>
    <p class="muted">提示：排演中对草稿的任何修改都不会影响已经启动的演出；已发布版本与历史记录始终按当时版本回看。</p>
  `;
}

/* ---------------- 草稿：弹窗与操作 ---------------- */

function cueFormHtml(cue = {}) {
  return `
    <form data-submit="save-cue" data-cue-id="${cue.id || ''}" data-show-id="${cue.show_id || state.showPage.id}">
      <div class="form-row">
        <div class="form-field">
          <label>提示编号 *</label>
          <input type="text" name="cue_code" value="${esc(cue.cue_code || '')}" placeholder="如 LX 1 / SQ 2 / SC 1" required />
        </div>
        <div class="form-field">
          <label>类型 *</label>
          <select name="cue_type">
            <option value="light" ${cue.cue_type === 'light' ? 'selected' : ''}>灯光</option>
            <option value="sound" ${cue.cue_type === 'sound' ? 'selected' : ''}>音效</option>
            <option value="set" ${cue.cue_type === 'set' ? 'selected' : ''}>布景</option>
          </select>
        </div>
      </div>
      <div class="form-field">
        <label>名称</label>
        <input type="text" name="title" value="${esc(cue.title || '')}" placeholder="如 开场暖光" />
      </div>
      <div class="form-field">
        <label>操作说明</label>
        <textarea name="notes" placeholder="给执行人员的提示">${esc(cue.notes || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button type="submit" class="btn btn-primary">保存</button>
      </div>
    </form>`;
}

function prereqModalHtml(cue) {
  const { draft } = state.showPage;
  const selected = new Set(draft.prereqs.filter((e) => e.cue_id === cue.id).map((e) => e.prereq_id));
  return `
    <p class="muted">设置 <strong>${esc(cue.cue_code)}</strong> 的前置提示。仅当所有前置均「已触发」时，本提示才可在现场触发。自引用与循环依赖会在发布前被拦截。</p>
    <form data-submit="save-prereqs" data-cue-id="${cue.id}">
      <div class="checkbox-grid">
        ${draft.cues.filter((c) => c.id !== cue.id).map((c) => `
          <label>
            <input type="checkbox" name="prereq_ids" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''} />
            <span class="type-badge type-${c.cue_type}" style="width:auto;flex:none;padding:1px 6px;margin-right:4px">${TYPE_LABEL[c.cue_type]}</span>
            ${esc(c.cue_code)}
          </label>`).join('')}
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">取消</button>
        <button type="submit" class="btn btn-primary">保存前置</button>
      </div>
    </form>`;
}

async function moveCue(id, dir) {
  const cues = state.showPage.draft.cues;
  const idx = cues.findIndex((c) => c.id === id);
  const swap = idx + dir;
  if (swap < 0 || swap >= cues.length) return;
  [cues[idx], cues[swap]] = [cues[swap], cues[idx]];
  await api(`/api/shows/${state.showPage.id}/cues/order`, {
    method: 'PUT',
    body: JSON.stringify({ order: cues.map((c) => c.id) }),
  });
  await renderShow(state.showPage.id);
}

/* ============================================================
 * 版本只读回看
 * ============================================================ */

async function renderVersion(id) {
  const data = await api(`/api/versions/${id}`);
  const { version, cues, prereqs } = data;
  const codeById = new Map(cues.map((c) => [c.id, c.cue_code]));
  const prereqMap = new Map(cues.map((c) => [c.id, []]));
  for (const e of prereqs) prereqMap.get(e.cue_id)?.push(e.prereq_code);

  view.innerHTML = `
    <div class="crumb"><a href="#/">场次列表</a> / <a href="#/show/${version.show_id}">${esc(version.show_name)}</a> / 执行单 v${version.version_no}</div>
    <div class="page-head">
      <div>
        <h1>执行单 v${version.version_no} <span class="tag">不可变快照</span></h1>
        <div class="sub">${esc(version.note || '')} · 发布人 ${esc(version.published_by_name || '—')} · ${fmtTime(version.published_at)}</div>
      </div>
    </div>
    <div class="panel">
      <div class="cue-list">
        ${cues.map((c, i) => `
          <div class="cue-row">
            <div class="cue-seq">${i + 1}</div>
            <span class="type-badge type-${c.cue_type}">${TYPE_LABEL[c.cue_type]}</span>
            <div class="cue-main">
              <span class="cue-code">${esc(c.cue_code)}</span>
              <span class="cue-title">${esc(c.title)}</span>
              <div class="cue-notes">${esc(c.notes)}</div>
              ${prereqMap.get(c.id)?.length ? `<div class="prereq-line">前置：${prereqMap.get(c.id).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ============================================================
 * 现场执行台
 * ============================================================ */

async function renderRun(id, { silent = false } = {}) {
  let board;
  try {
    board = await api(`/api/performances/${id}`);
  } catch (err) {
    if (!silent) throw err;
    return;
  }
  state.runId = id;
  state.board = board;

  const { performance: perf, cues, counts } = board;
  const cueById = new Map(cues.map((c) => [c.id, c]));

  const filtered = cues.filter((c) => state.boardFilter === 'all' || c.state === state.boardFilter);

  if (!document.getElementById('run-head') || !silent) {
    view.innerHTML = `
      <div class="crumb"><a href="#/show/${perf.show_id}">${esc(perf.show_name)}</a> / ${esc(perf.name || '演出记录')}</div>
      <div class="page-head" id="run-head">
        <div>
          <h1>
            ${perf.status === 'running' ? '<span class="live-dot"></span>' : ''}${esc(perf.name || '现场演出')}
            <span class="tag">执行单 v${perf.version_no}</span>
            ${perf.status === 'ended' ? '<span class="tag">已结束</span>' : ''}
          </h1>
          <div class="sub">启动人 ${esc(perf.started_by_name || '—')} · ${fmtTime(perf.started_at)}${perf.ended_at ? ` · 结束于 ${fmtTime(perf.ended_at)}` : ''}</div>
        </div>
        ${perf.status === 'running' ? `<button class="btn btn-danger" data-action="end-performance" data-id="${perf.id}">结束本场演出</button>` : ''}
      </div>
      <div class="stat-bar" id="stat-bar"></div>
      <div class="toolbar" id="filter-bar">
        ${FILTERS.map((f) => `
          <button class="filter-btn ${state.boardFilter === f.key ? 'active' : ''}" data-action="filter" data-filter="${f.key}">
            ${f.label} ${f.key === 'all' ? `(${cues.length})` : `(${counts[f.key] || 0})`}
          </button>`).join('')}
      </div>
      <div class="cue-list" id="run-cues"></div>
    `;
  } else {
    // 轮询时仅更新计数和过滤器数字
    document.getElementById('stat-bar').innerHTML = statBarHtml(counts);
    document.getElementById('filter-bar').innerHTML = FILTERS.map((f) => `
      <button class="filter-btn ${state.boardFilter === f.key ? 'active' : ''}" data-action="filter" data-filter="${f.key}">
        ${f.label} ${f.key === 'all' ? `(${cues.length})` : `(${counts[f.key] || 0})`}
      </button>`).join('');
  }

  const statBar = document.getElementById('stat-bar');
  if (statBar) statBar.innerHTML = statBarHtml(counts);

  const list = document.getElementById('run-cues');
  list.innerHTML = filtered.length === 0
    ? `<div class="empty-state">该筛选下暂无提示。</div>`
    : filtered.map((c) => {
      const running = perf.status === 'running';
      const prereqChips = (c.prereq_codes || []).map((code) => {
        const pc = cues.find((x) => x.cue_code === code);
        const cls = pc?.state === 'triggered' ? 'ok' : (pc && pc.state !== 'pending' ? 'bad' : '');
        return `<span class="chip ${cls}">${esc(code)}${pc?.state === 'triggered' ? ' ✓' : ''}</span>`;
      }).join('');

      let side = '';
      if (c.result) {
        side = `
          <span class="state state-${c.state}">${STATE_LABEL[c.state]}</span>
          <div class="result-meta">
            ${c.state === 'skipped' ? `原因：${esc(c.result.reason)}<br>` : ''}
            ${esc(c.result.operator_name)} · ${fmtTime(c.result.acted_at)}
          </div>`;
      } else if (!running) {
        side = `<span class="state state-pending">演出已结束</span>`;
      } else if (c.state === 'blocked') {
        side = `
          <span class="state state-blocked">受阻</span>
          <button class="btn btn-sm btn-danger" data-action="skip-cue" data-perf="${perf.id}" data-cue="${c.id}">跳过（填原因）</button>
          <div class="blocked-detail">等待：${c.blockedBy.map((b) => esc(b.cue_code)).join('、')}</div>`;
      } else {
        side = `
          <span class="state state-pending">待执行</span>
          <div class="toolbar" style="margin:0">
            <button class="btn btn-sm btn-go" data-action="trigger-cue" data-perf="${perf.id}" data-cue="${c.id}">▶ 触发 GO</button>
            <button class="btn btn-sm btn-danger" data-action="skip-cue" data-perf="${perf.id}" data-cue="${c.id}">跳过</button>
          </div>`;
      }

      return `
        <div class="cue-row is-${c.state}">
          <div class="cue-seq">${c.seq / 10}</div>
          <span class="type-badge type-${c.cue_type}">${TYPE_LABEL[c.cue_type]}</span>
          <div class="cue-main">
            <span class="cue-code">${esc(c.cue_code)}</span>
            <span class="cue-title">${esc(c.title)}</span>
            <div class="cue-notes">${esc(c.notes)}</div>
            ${prereqChips ? `<div class="prereq-line">前置：${prereqChips}</div>` : ''}
          </div>
          <div class="cue-side">${side}</div>
        </div>`;
    }).join('');

  // 进行中的演出每 3 秒自动刷新（多机位/多人协作时状态同步）
  if (perf.status === 'running' && !state.pollTimer) {
    state.pollTimer = setInterval(() => renderRun(state.runId, { silent: true }), 3000);
  }
  if (perf.status !== 'running') stopPolling();
}

function statBarHtml(counts) {
  return [
    ['pending', '待执行'], ['triggered', '已触发'], ['skipped', '已跳过'], ['blocked', '受阻'],
  ].map(([k, l]) => `<div class="stat s-${k}"><div class="n">${counts[k] || 0}</div><div class="l">${l}</div></div>`).join('');
}

/* ============================================================
 * 全局事件代理
 * ============================================================ */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'close-modal') { closeModal(); return; }

  if (action === 'new-operator') {
    openModal('新建操作人', `
      <form data-submit="create-operator">
        <div class="form-field"><label>姓名 *</label><input type="text" name="name" required /></div>
        <div class="form-field">
          <label>角色</label>
          <select name="role">
            <option value="stage_manager">舞台监督</option>
            <option value="assistant">助理监督</option>
            <option value="director">导演</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="close-modal">取消</button>
          <button type="submit" class="btn btn-primary">创建</button>
        </div>
      </form>`);
    return;
  }

  // 以下操作均需选择操作人
  if (!state.operatorId && ['new-show', 'save', 'publish-show', 'trigger-cue', 'skip-cue',
    'end-performance', 'new-cue', 'edit-cue', 'delete-cue', 'edit-prereqs', 'cue-up', 'cue-down'].includes(action)) {
    toast('请先在右上角选择或新建操作人。', 'error');
    return;
  }

  try {
    switch (action) {
      case 'new-show':
        openModal('新建场次', `
          <form data-submit="create-show">
            <div class="form-field"><label>场次名称 *</label><input type="text" name="name" required placeholder="如：《冬之旅》周六联排" /></div>
            <div class="form-field"><label>说明</label><textarea name="notes" placeholder="场地、注意事项等"></textarea></div>
            <div class="form-actions">
              <button type="button" class="btn" data-action="close-modal">取消</button>
              <button type="submit" class="btn btn-primary">创建</button>
            </div>
          </form>`);
        break;

      case 'tab':
        state.editorTab = btn.dataset.tab;
        renderShowTab();
        document.querySelectorAll('[data-action="tab"]').forEach((b) =>
          b.classList.toggle('active', b.dataset.tab === state.editorTab));
        break;

      case 'new-cue':
        openModal('添加提示', cueFormHtml({}));
        break;

      case 'edit-cue': {
        const cue = state.showPage.draft.cues.find((c) => c.id === Number(btn.dataset.id));
        openModal('编辑提示', cueFormHtml(cue));
        break;
      }

      case 'delete-cue': {
        const cue = state.showPage.draft.cues.find((c) => c.id === Number(btn.dataset.id));
        if (!confirm(`确认删除提示 ${cue.cue_code}？相关前置引用会一并移除。`)) break;
        await api(`/api/cues/${cue.id}`, { method: 'DELETE' });
        toast('提示已删除（仅影响草稿，不影响已发布版本与进行中的演出）。', 'success');
        await renderShow(state.showPage.id);
        break;
      }

      case 'cue-up': await moveCue(Number(btn.dataset.id), -1); break;
      case 'cue-down': await moveCue(Number(btn.dataset.id), 1); break;

      case 'edit-prereqs': {
        const cue = state.showPage.draft.cues.find((c) => c.id === Number(btn.dataset.id));
        openModal(`设置前置 — ${cue.cue_code}`, prereqModalHtml(cue));
        break;
      }

      case 'validate-show':
      case 'publish-show': {
        const id = Number(btn.dataset.id);
        const result = await api(`/api/shows/${id}/validate`);
        if (!result.valid) {
          openModal(action === 'publish-show' ? '无法发布：依赖校验未通过' : '依赖校验结果',
            `<ul class="error-list">${result.errors.map((er) => `<li>${esc(er.message)}</li>`).join('')}</ul>
             <div class="form-actions"><button type="button" class="btn" data-action="close-modal">知道了</button></div>`);
          return;
        }
        if (action === 'validate-show') {
          openModal('依赖校验结果',
            `<div class="ok-banner">✅ 校验通过：无缺失引用、无循环依赖，可以发布。</div>
             <div class="form-actions"><button type="button" class="btn" data-action="close-modal">关闭</button></div>`);
        } else {
          openModal('发布执行单',
            `<p class="muted">发布将对当前草稿生成<strong>不可变快照</strong>，之后可从该版本启动演出。继续修改草稿不会影响此版本。</p>
             <form data-submit="publish" data-show-id="${id}">
               <div class="form-field"><label>版本说明（可选）</label><input type="text" name="note" placeholder="如：技术联排后修订" /></div>
               <div class="form-actions">
                 <button type="button" class="btn" data-action="close-modal">取消</button>
                 <button type="submit" class="btn btn-primary">确认发布</button>
               </div>
             </form>`);
        }
        break;
      }

      case 'filter':
        state.boardFilter = btn.dataset.filter;
        renderRun(state.runId, { silent: false });
        break;

      case 'trigger-cue': {
        const { perf, cue } = { perf: btn.dataset.perf, cue: btn.dataset.cue };
        btn.disabled = true;
        try {
          await api(`/api/performances/${perf}/cues/${cue}/trigger`, { method: 'POST', body: '{}' });
          toast('已记录：触发 GO', 'success');
        } catch (err) {
          showErrors('无法触发', err);
        }
        await renderRun(Number(perf));
        break;
      }

      case 'skip-cue': {
        openModal('跳过提示（必须填写原因）', `
          <form data-submit="skip" data-perf="${btn.dataset.perf}" data-cue="${btn.dataset.cue}">
            <div class="form-field">
              <label>跳过原因 *</label>
              <textarea name="reason" required placeholder="如：灯具故障 / 演员调度调整 / 前置未执行"></textarea>
            </div>
            <div class="form-actions">
              <button type="button" class="btn" data-action="close-modal">取消</button>
              <button type="submit" class="btn btn-danger">确认跳过</button>
            </div>
          </form>`);
        break;
      }

      case 'end-performance':
        if (!confirm('确认结束本场演出？结束后不能再记录任何提示结果。')) break;
        try {
          await api(`/api/performances/${btn.dataset.id}/end`, { method: 'POST', body: '{}' });
          toast('演出已结束。', 'success');
          await renderRun(Number(btn.dataset.id));
        } catch (err) { showErrors('操作失败', err); }
        break;
    }
  } catch (err) {
    showErrors('操作失败', err);
  }
});

/* 表单提交代理 */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  if (!state.operatorId) { toast('请先在右上角选择或新建操作人。', 'error'); return; }

  const fd = new FormData(form);
  const obj = Object.fromEntries(fd.entries());
  const kind = form.dataset.submit;

  try {
    if (kind === 'create-operator') {
      const created = await api('/api/operators', { method: 'POST', body: JSON.stringify(obj) });
      await loadOperators();
      state.operatorId = created.id;
      localStorage.setItem('operatorId', String(created.id));
      document.getElementById('operator-select').value = String(created.id);
      closeModal();
      toast(`操作人 ${created.name} 已创建并选中。`, 'success');
      return;
    }

    if (kind === 'create-show') {
      const created = await api('/api/shows', {
        method: 'POST',
        body: JSON.stringify({ name: obj.name, description: obj.notes || '' }),
      });
      closeModal();
      toast('场次已创建。', 'success');
      location.hash = `#/show/${created.id}`;
      return;
    }

    if (kind === 'save-cue') {
      const payload = { cue_code: obj.cue_code, cue_type: obj.cue_type, title: obj.title || '', notes: obj.notes || '' };
      if (form.dataset.cueId) {
        await api(`/api/cues/${form.dataset.cueId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api(`/api/shows/${form.dataset.showId}/cues`, { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal();
      toast('草稿已保存。', 'success');
      await renderShow(Number(form.dataset.showId || state.showPage.id));
      return;
    }

    if (kind === 'save-prereqs') {
      const ids = fd.getAll('prereq_ids').map(Number);
      await api(`/api/cues/${form.dataset.cueId}/prereqs`, {
        method: 'PUT',
        body: JSON.stringify({ prereq_ids: ids }),
      });
      closeModal();
      toast('前置提示已更新。', 'success');
      await renderShow(state.showPage.id);
      return;
    }

    if (kind === 'publish') {
      const v = await api(`/api/shows/${form.dataset.showId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ note: obj.note || '' }),
      });
      closeModal();
      state.editorTab = 'versions';
      toast(`执行单 v${v.version_no} 已发布（不可变）。`, 'success');
      await renderShow(Number(form.dataset.showId));
      return;
    }

    if (kind === 'start-performance') {
      const p = await api(`/api/shows/${form.dataset.showId}/performances`, {
        method: 'POST',
        body: JSON.stringify({ name: obj.name || '', version_id: Number(obj.version_id) }),
      });
      toast('演出已从所选版本启动独立记录。', 'success');
      location.hash = `#/run/${p.id}`;
      return;
    }

    if (kind === 'skip') {
      await api(`/api/performances/${form.dataset.perf}/cues/${form.dataset.cue}/skip`, {
        method: 'POST',
        body: JSON.stringify({ reason: obj.reason }),
      });
      closeModal();
      toast('已记录：跳过（含原因）。', 'success');
      await renderRun(Number(form.dataset.perf));
      return;
    }
  } catch (err) {
    showErrors('提交失败', err);
  }
});

/* 操作人切换 */
document.getElementById('operator-select').addEventListener('change', (e) => {
  state.operatorId = Number(e.target.value) || null;
  if (state.operatorId) localStorage.setItem('operatorId', String(state.operatorId));
});

/* ---------------- 启动 ---------------- */

(async function bootstrap() {
  await loadOperators();
  await router();
})();
