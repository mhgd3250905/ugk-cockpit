import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';

test('journal mode and synchronous pragmas apply regardless of the migration flag', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-db-settings-'));
  const db = openCockpitDatabase(path.join(root, 'fresh.db'), { migrate: false });
  // after 钩子按注册的逆序执行：先关库再清理目录，否则 WAL 附属文件仍被占用。
  t.after(() => {
    try { db.close(); } catch {}
  });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL 应恒为 2');
});
