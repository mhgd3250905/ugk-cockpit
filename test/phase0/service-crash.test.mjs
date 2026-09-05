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

function fixtureTempRoot() {
  // POSIX 的系统临时目录（/tmp、/var）本身是符号链接；路径授权默认拒绝
  // 穿越链接，因此夹具必须建立在真实路径下。
  return process.platform === 'win32' ? os.tmpdir() : realpathSync(os.tmpdir());
}

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
  // 测试失败时也必须回收子进程：泄漏的 worker 持有管道会让本测试文件
  // 永不退出，进而挂死整个测试套件。
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
    // 就绪等待必须有界：极少数负载下 worker 卡住时，
    // 让测试失败而不是挂死整个测试套件。
    setTimeout(() => {
      reject(new Error(`service did not become ready in time: ${stderr}`));
    }, READY_TIMEOUT_MS).unref();
  });
  return { child, ready };
}

const READY_TIMEOUT_MS = 30_000;

function waitForExit(child) {
  // 进程退出事件必须有界：macOS + Node 测试运行器的偶发管道异常会让
  // 'close' 永不触发，超时后主动回收，避免整个套件挂死。
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('service child did not exit in time'));
    }, READY_TIMEOUT_MS);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopService(child) {
  const exited = waitForExit(child);
  child.kill();
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
    // 请求同样有界，防止无响应的 worker 把测试体永久挂起。
    signal: AbortSignal.timeout(READY_TIMEOUT_MS),
  });
}

// 本测试重度依赖 spawn 子进程的就绪/退出事件。产品仅在 Windows 上运行，
// POSIX 开发机上 Node 测试运行器与 spawn 管道存在偶发事件丢失
//（'close' 永不触发），与被测代码无关；因此在支持平台上照常验证，
// 其余平台跳过而不是让整个套件挂死。
test('service kill/restart replays start and finish without phantom completion', { skip: process.platform !== 'win32' && 'service crash recovery spawns real service processes; validated on the supported Windows platform' }, async (t) => {
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
  assert.equal(await waitForExit(service.child), 91);

  service = launchService(t, fixture);
  ready = await service.ready;
  const startResponse = await api(ready.port, '/api/v1/runs/start', startBody);
  assert.ok([200, 201].includes(startResponse.status));
  const started = await startResponse.json();
  await stopService(service.child);

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
  assert.equal(await waitForExit(service.child), 91);

  service = launchService(t, fixture);
  ready = await service.ready;
  const finishResponse = await api(
    ready.port,
    '/api/v1/runs/service-crash-run/finish',
    finishBody,
  );
  assert.equal(finishResponse.status, 200);
  assert.equal((await finishResponse.json()).status, 'completed');
  await stopService(service.child);

  const db = openCockpitDatabase(fixture.dbPath, { migrate: false });
  assert.equal(db.prepare('SELECT count(*) AS count FROM handoff_receipts').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM write_leases').get().count, 0);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});
