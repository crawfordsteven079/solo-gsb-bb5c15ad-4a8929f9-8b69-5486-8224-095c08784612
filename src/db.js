import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

// 测试用：DB_DRIVER=pglite 时使用进程内 PostgreSQL（生产/Docker 不使用）
const usePglite = process.env.DB_DRIVER === 'pglite';

let pglite = null;
if (usePglite) {
  const { PGlite } = await import('@electric-sql/pglite');
  pglite = new PGlite();
  // 建表 + 种子数据（测试可通过 globalThis 注入，默认读取标准初始化脚本）
  const initSql = globalThis.__PGLITE_INIT_SQL || readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'init', '01_schema.sql'),
    'utf8',
  );
  await pglite.exec(initSql);
}

export const pool = usePglite
  ? {
      async connect() {
        return {
          query: (text, params) => pglite.query(text, params),
          async begin() {},
          release() {},
        };
      },
      query: (text, params) => pglite.query(text, params),
    }
  : new Pool({
      host: process.env.PGHOST || 'db',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'callboard',
      password: process.env.PGPASSWORD || 'callboard',
      database: process.env.PGDATABASE || 'callboard',
      max: 10,
    });

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * 在单个事务中执行回调；回调抛出错误时整体回滚。
 * 用法：const client = await withTx(async (client) => { ... });
 */
export async function withTx(fn) {
  if (usePglite) {
    try {
      await pglite.query('BEGIN');
      const result = await fn(pglite);
      await pglite.query('COMMIT');
      return result;
    } catch (err) {
      await pglite.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (!usePglite) client.release();
  }
}

/** 等待数据库就绪（compose 启动顺序兜底）。 */
export async function waitForDatabase(retries = 30, delayMs = 1000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries) throw err;
      console.log(`等待数据库就绪 (${i}/${retries}) ...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
