import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

test('rejecting a future schema version leaves the database file untouched', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ugk-db-future-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const futurePath = path.join(root, 'future.db');
  // 原生连接构造 delete-journal 的“未来版本”数据库，不经 openCockpitDatabase。
  const seed = new DatabaseSync(futurePath);
  seed.exec('CREATE TABLE marker (id TEXT); INSERT INTO marker VALUES (\'origin\');');
  seed.exec('PRAGMA user_version = 999;');
  seed.close();
  const prelude = new DatabaseSync(futurePath, { readOnly: true });
  assert.equal(prelude.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  prelude.close();
  const before = readFileSync(futurePath);

  assert.throws(() => openCockpitDatabase(futurePath, { migrate: false }),
    (error) => error?.code === 'UNSUPPORTED_SCHEMA_VERSION');
  assert.deepEqual(readFileSync(futurePath), before,
    '拒绝未来版本时不得改动数据库文件（journal_mode 是持久化设置）');
  const probe = new DatabaseSync(futurePath, { readOnly: true });
  assert.equal(probe.prepare('PRAGMA journal_mode').get().journal_mode, 'delete',
    '被拒绝打开的数据库必须保持原有日志模式');
  assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 999);
  probe.close();
});
