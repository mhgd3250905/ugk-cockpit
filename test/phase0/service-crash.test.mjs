import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCockpitDatabase } from '../../src/core/database.mjs';

const workerPath = fileURLToPath(new URL('../../scripts/service-worker.mjs', import.meta.url));
const token = 'phase-zero-service-crash-token-123456789';

// POSIX 的系统临时目录（/tmp、/var）本身是符号链接；路径授权按产品契约拒绝
// 穿越链接的路径，夹具必须建立在真实路径下，否则授权在故障注入前就失败。
function fixtureTempRoot() {
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

// 子进程的就绪、退出与请求都必须有界：任何一步卡住时让测试失败并回收
// worker，而不是让泄漏的管道把整个测试套件永久挂起。
const READY_TIMEOUT_MS = 30_000;

function createFixture(t) {
  const container = mkdtempSync(path.join(fixtureTempRoot(), 'ugk-cockpit-service-crash-'));
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const repository = path.join(container, 'repository');
  mkdirSync(repository);
  const git = (args) => execFileSync('git', args, {
    cwd: repository,
    windowsHide: true,
    stdio: 'pipe',
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UGK Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(repository, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'fixture baseline']);
  return { container, repository, dbPath: path.join(container, 'cockpit.db') };
}

function launchService(t, fixture, faultPoint = null) {
  const encoded = Buffer.from(JSON.stringify({
    dbPath: fixture.dbPath,
    token,
    authorizedRoots: [fixture.repository],
    faultPoint,
  })).toString('base64url');
  const child = spawn(process.execPath, [workerPath, encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    try { child.kill(); } catch {}
  });
  const ready = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      try {
        resolve(JSON.parse(chunk.toString().trim()));
      } catch (error) {
        reject(new Error(`service did not return ready JSON: ${stderr}`, { cause: error }));
      }
    });
    child.once('close', (code) => {
      if (code !== 91) reject(new Error(`service exited before ready (${code}): ${stderr}`));
    });
    setTimeout(() => {
      reject(new Error(`service did not become ready in time: ${stderr}`));
    }, READY_TIMEOUT_MS).unref();
  });
  // 'close' 必须在 spawn 后立即订阅：macOS 上故障退出的子进程回收极快，
  // 事件可能在测试体随后才挂监听器之前就已发出并丢失，导致等待永远超时。
  const exited = new Promise((resolve) => child.once('close', resolve));
  return { child, ready, exited };
}

function waitForExit(service) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { service.child.kill(); } catch {}
      reject(new Error('service child did not exit in time'));
    }, READY_TIMEOUT_MS);
    timer.unref();
    service.exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    }, reject);
  });
}

async function stopService(service) {
  const exited = waitForExit(service);
  service.child.kill();
  await exited;
}

function api(port, pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(READY_TIMEOUT_MS),
  });
}

test('service kill/restart replays start and finish without phantom completion', async (t) => {
  const fixture = createFixture(t);
  const startBody = {
    commandId: 'service-crash-start',
    runId: 'service-crash-run',
    worktreePath: fixture.repository,
    agentClaim: 'codex',
    goal: 'service crash recovery',
  };

  let service = launchService(t, fixture, 'start.after_lease_insert');
  let ready = await service.ready;
  await assert.rejects(api(ready.port, '/api/v1/runs/start', startBody));
  assert.equal(await waitForExit(service), 91);

  service = launchService(t, fixture);
  ready = await service.ready;
  const startResponse = await api(ready.port, '/api/v1/runs/start', startBody);
  assert.ok([200, 201].includes(startResponse.status));
  const started = await startResponse.json();
  await stopService(service);

  const finishBody = {
    commandId: 'service-crash-finish',
    expectedRevision: started.revision,
    leaseGeneration: started.leaseGeneration,
    outcome: 'completed',
    summary: 'finish after restart',
  };
  service = launchService(t, fixture, 'finish.after_receipt_insert');
  ready = await service.ready;
  await assert.rejects(api(
    ready.port,
    '/api/v1/runs/service-crash-run/finish',
    finishBody,
  ));
  assert.equal(await waitForExit(service), 91);

  service = launchService(t, fixture);
  ready = await service.ready;
  const finishResponse = await api(
    ready.port,
    '/api/v1/runs/service-crash-run/finish',
    finishBody,
  );
  assert.equal(finishResponse.status, 200);
  assert.equal((await finishResponse.json()).status, 'completed');
  await stopService(service);

  const db = openCockpitDatabase(fixture.dbPath, { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});
