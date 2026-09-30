-- ============================================================
-- Call Board 初始化脚本
-- 该脚本仅在 PostgreSQL 数据目录首次初始化时由官方镜像自动执行。
-- ============================================================

BEGIN;

-- ---------- 操作人（登录身份） ----------
CREATE TABLE IF NOT EXISTS operators (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL DEFAULT 'stage_manager'
               CHECK (role IN ('stage_manager','assistant','director')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 剧目/场次 ----------
CREATE TABLE IF NOT EXISTS shows (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  BIGINT REFERENCES operators(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 草稿提示 ----------
CREATE TABLE IF NOT EXISTS cue_drafts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    show_id    BIGINT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    cue_code   TEXT NOT NULL,           -- 如 LX 1、SQ 12、SC 3
    cue_type   TEXT NOT NULL CHECK (cue_type IN ('light','sound','set')),
    title      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    seq        INTEGER NOT NULL,        -- 排列顺序
    UNIQUE (show_id, cue_code)
);
CREATE INDEX IF NOT EXISTS idx_cue_drafts_show ON cue_drafts(show_id, seq);

-- ---------- 草稿前置提示 ----------
CREATE TABLE IF NOT EXISTS prereq_drafts (
    id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    show_id  BIGINT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    cue_id   BIGINT NOT NULL REFERENCES cue_drafts(id) ON DELETE CASCADE,
    prereq_id BIGINT NOT NULL REFERENCES cue_drafts(id) ON DELETE CASCADE,
    UNIQUE (cue_id, prereq_id),
    CHECK (cue_id <> prereq_id)
);
CREATE INDEX IF NOT EXISTS idx_prereq_drafts_prereq ON prereq_drafts(show_id, prereq_id);

-- ---------- 已发布版本（不可变） ----------
CREATE TABLE IF NOT EXISTS versions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    show_id     BIGINT NOT NULL REFERENCES shows(id),
    version_no  INTEGER NOT NULL,
    published_by BIGINT REFERENCES operators(id),
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    note        TEXT NOT NULL DEFAULT '',
    UNIQUE (show_id, version_no)
);

-- ---------- 版本快照中的提示（不可变） ----------
CREATE TABLE IF NOT EXISTS cues (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version_id BIGINT NOT NULL REFERENCES versions(id),
    cue_code   TEXT NOT NULL,
    cue_type   TEXT NOT NULL CHECK (cue_type IN ('light','sound','set')),
    title      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    seq        INTEGER NOT NULL,
    UNIQUE (version_id, cue_code)
);
CREATE INDEX IF NOT EXISTS idx_cues_version ON cues(version_id, seq);

-- ---------- 版本快照中的前置引用（不可变） ----------
CREATE TABLE IF NOT EXISTS prereqs (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version_id BIGINT NOT NULL REFERENCES versions(id),
    cue_id    BIGINT NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
    prereq_id BIGINT NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
    UNIQUE (cue_id, prereq_id),
    CHECK (cue_id <> prereq_id)
);
CREATE INDEX IF NOT EXISTS idx_prereqs_prereq ON prereqs(version_id, prereq_id);

-- ---------- 每场演出（从某一已发布版本启动） ----------
CREATE TABLE IF NOT EXISTS performances (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    show_id     BIGINT NOT NULL REFERENCES shows(id),
    version_id  BIGINT NOT NULL REFERENCES versions(id),
    name        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ended')),
    started_by  BIGINT REFERENCES operators(id),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_performances_show ON performances(show_id, started_at DESC);

-- ---------- 提示执行结果（每个提示至多一条有效结果） ----------
CREATE TABLE IF NOT EXISTS cue_results (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    performance_id BIGINT NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
    cue_id         BIGINT NOT NULL REFERENCES cues(id),
    result         TEXT NOT NULL CHECK (result IN ('triggered','skipped')),
    reason         TEXT NOT NULL DEFAULT '',  -- 跳过时必须填写
    operator_id    BIGINT NOT NULL REFERENCES operators(id),
    acted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (performance_id, cue_id)
);
CREATE INDEX IF NOT EXISTS idx_cue_results_perf ON cue_results(performance_id);

-- ============================================================
-- 种子数据：默认操作人 + 一个示例场次（含已发布 v1）
-- ============================================================

INSERT INTO operators (name, role) VALUES
    ('王监督', 'stage_manager'),
    ('李助理', 'assistant')
ON CONFLICT (name) DO NOTHING;

INSERT INTO shows (name, description, created_by)
SELECT '《冬之旅》首演排练', '示例场次：灯光 / 音效 / 布景提示及前置依赖', id
FROM operators WHERE name = '王监督'
ON CONFLICT DO NOTHING;

-- 草稿
INSERT INTO cue_drafts (show_id, cue_code, cue_type, title, notes, seq)
SELECT s.id, v.cue_code, v.cue_type, v.title, v.notes, v.seq
FROM shows s
CROSS JOIN (VALUES
    ('LX 1',  'light', '开场灯',          '观众厅暗场，暖光起',          10),
    ('SQ 1',  'sound', '开场前奏曲',      '15 秒渐入',                   20),
    ('SC 1',  'set',   '第一场布景就位',  '客厅场景，舞台左沙发',        30),
    ('LX 2',  'light', '第一场灯光',      '配合 SC 1 完成后切换',        40),
    ('SQ 2',  'sound', '风雪音效',        '门打开后触发',                50),
    ('LX 3',  'light', '转场蓝调',        '第一场结束，蓝调 3 秒转场',   60)
) AS v(cue_code, cue_type, title, notes, seq)
WHERE s.name = '《冬之旅》首演排练'
ON CONFLICT DO NOTHING;

-- 已发布版本 v1（快照）
INSERT INTO versions (show_id, version_no, published_by, note)
SELECT s.id, 1, o.id, '初始执行单'
FROM shows s
JOIN operators o ON o.name = '王监督'
WHERE s.name = '《冬之旅》首演排练'
ON CONFLICT DO NOTHING;

INSERT INTO cues (version_id, cue_code, cue_type, title, notes, seq)
SELECT v.id, d.cue_code, d.cue_type, d.title, d.notes, d.seq
FROM versions v
JOIN shows s ON s.id = v.show_id
JOIN cue_drafts d ON d.show_id = s.id
WHERE s.name = '《冬之旅》首演排练' AND v.version_no = 1
ON CONFLICT DO NOTHING;

-- 前置依赖：LX 2 依赖 SC 1；LX 3 依赖 LX 2 与 SQ 2；SQ 2 依赖 LX 1
INSERT INTO prereqs (version_id, cue_id, prereq_id)
SELECT v.id, c.id, p.id
FROM versions v
JOIN shows s ON s.id = v.show_id
JOIN cues c ON c.version_id = v.id
JOIN cues p ON p.version_id = v.id
JOIN cue_drafts cd ON cd.show_id = s.id AND cd.cue_code = c.cue_code
JOIN cue_drafts pd ON pd.show_id = s.id AND pd.cue_code = p.cue_code
WHERE s.name = '《冬之旅》首演排练' AND v.version_no = 1
  AND (
        (c.cue_code = 'LX 2' AND p.cue_code = 'SC 1')
     OR (c.cue_code = 'LX 3' AND p.cue_code = 'LX 2')
     OR (c.cue_code = 'LX 3' AND p.cue_code = 'SQ 2')
     OR (c.cue_code = 'SQ 2' AND p.cue_code = 'LX 1')
  )
ON CONFLICT DO NOTHING;

-- 同步草稿前置依赖（编辑页可见）
INSERT INTO prereq_drafts (show_id, cue_id, prereq_id)
SELECT s.id, cd.id, pd.id
FROM shows s
JOIN cue_drafts cd ON cd.show_id = s.id
JOIN cue_drafts pd ON pd.show_id = s.id
WHERE s.name = '《冬之旅》首演排练'
  AND (
        (cd.cue_code = 'LX 2' AND pd.cue_code = 'SC 1')
     OR (cd.cue_code = 'LX 3' AND pd.cue_code = 'LX 2')
     OR (cd.cue_code = 'LX 3' AND pd.cue_code = 'SQ 2')
     OR (cd.cue_code = 'SQ 2' AND pd.cue_code = 'LX 1')
  )
ON CONFLICT DO NOTHING;

COMMIT;
