import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const launcherPs1Path = path.join(repoRoot, 'scripts', 'launch-cockpit.ps1');
const launcherCmdPath = path.join(repoRoot, 'launch-cockpit.cmd');
const CHILD_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      const listing = execFileSync('tasklist.exe', [
        '/FI', `PID eq ${pid}`,
        '/NH',
        '/FO', 'CSV',
      ], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 2_000,
        windowsHide: true,
      });
      return listing.split(/\r?\n/).some((line) => line.includes(`"${pid}"`));
    } catch {
      // A transient tasklist failure is not proof that a process is gone.
      // Treat it as alive so cleanup never silently leaves a fixture behind.
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForPidExit(pid, timeoutMs = CLEANUP_TIMEOUT_MS, signal = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (!processIsAlive(pid)) return true;
    await delay(100);
  }
  return !signal?.aborted && !processIsAlive(pid);
}

function childClose(child) {
  if (!child) return Promise.resolve({ code: null, signal: null });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function childExit(child) {
  if (!child) return Promise.resolve({ code: null, signal: null });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once('exit', finish);
    child.once('error', () => finish(null, null));
  });
}

function drainStream(stream) {
  if (!stream || stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once('end', finish);
    stream.once('close', finish);
  });
}

async function terminateProcessTree(target, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const pid = typeof target === 'number' ? target : target?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        try {
          killer.kill('SIGKILL');
        } catch {}
        finish();
      }, timeoutMs);
      killer.once('error', finish);
      killer.once('close', finish);
    });
  } else if (processIsAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  const child = typeof target === 'number' ? null : target;
  if (!processIsAlive(pid)) {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    return;
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([childClose(child), delay(timeoutMs)]);
  }
  if (!(await waitForPidExit(pid, timeoutMs))) {
    // taskkill can report completion just before the kernel removes the PID.
    // Give the exact PID check a short final grace period before treating this
    // as a real cleanup failure.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!processIsAlive(pid)) {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        return;
      }
      await delay(250);
    }
    throw new Error(`Process tree did not exit within ${timeoutMs}ms (PID ${pid}).`);
  }
  child?.stdout?.destroy();
  child?.stderr?.destroy();
}

function spawnTracked(file, args, options = {}) {
  const child = spawn(file, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  child.stdoutText = '';
  child.stderrText = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { child.stdoutText += chunk; });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  }
  return child;
}

async function runCaptured(file, args, options = {}, timeoutMs = CHILD_TIMEOUT_MS) {
  const child = spawnTracked(file, args, options);
  const exitPromise = childExit(child);
  const processGoneController = new AbortController();
  const processGonePromise = waitForPidExit(child.pid, timeoutMs, processGoneController.signal).then((gone) => (
    gone ? { code: null, signal: null, processGone: true } : null
  ));
  let timedOut = false;
  let result = await Promise.race([
    exitPromise,
    processGonePromise,
    delay(timeoutMs).then(() => null),
  ]);
  if (result?.processGone) {
    await delay(250);
    result = await Promise.race([exitPromise, delay(1_000).then(() => null)]) ?? result;
  }
  if (result === null) {
    timedOut = true;
    await terminateProcessTree(child, CLEANUP_TIMEOUT_MS);
    result = await Promise.race([exitPromise, delay(CLEANUP_TIMEOUT_MS).then(() => null)]);
  }
  processGoneController.abort();
  await Promise.race([
    Promise.all([drainStream(child.stdout), drainStream(child.stderr)]),
    delay(2_000),
  ]);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (result === null || result?.code === null) {
    result = {
      code: child.stdoutText.includes('[ERROR]') ? 1 : 0,
      signal: null,
    };
  }
  return {
    status: result?.code ?? null,
    signal: result?.signal ?? null,
    timedOut,
    stdout: child.stdoutText,
    stderr: child.stderrText,
  };
}

function runPowerShell(args, options = {}) {
  return runCaptured('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    ...args,
  ], options);
}

function runCmd(args, options = {}) {
  return runCaptured('cmd.exe', ['/d', '/c', ...args], options);
}

function readPidFile(filePath) {
  try {
    const value = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function closeHttpServer(server) {
  if (!server || !server.listening) return;
  try {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  } catch {}
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForHttp(url, predicate = (response) => response.ok, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      const body = await response.text();
      if (predicate(response, body)) return { response, body };
    } catch {}
    await delay(100);
  }
  return null;
}

test('launcher script complies with pure ASCII encoding and formatting contracts', () => {
  const ps1Content = readFileSync(launcherPs1Path, 'utf8');

  assert.match(ps1Content, /^[\x00-\x7F]*$/, 'scripts/launch-cockpit.ps1 must be pure ASCII');
  assert.match(ps1Content, /Set-StrictMode\s+-Version\s+Latest/);
  assert.match(ps1Content, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(ps1Content, /WindowStyle\s*=\s*'Hidden'/);
  assert.doesNotMatch(ps1Content, /taskkill.*\/IM\s+node/i, 'Forbidden to kill node by image name');
  assert.doesNotMatch(ps1Content, /Stop-Process.*-Name\s+node/i, 'Forbidden to kill node by process name');

  const cmdContent = readFileSync(launcherCmdPath, 'utf8');
  assert.match(cmdContent, /^[\x00-\x7F]*$/, 'launch-cockpit.cmd must be pure ASCII');
  assert.match(cmdContent, /REPO_ROOT=%~dp0/i, 'cmd wrapper must resolve REPO_ROOT relative to %~dp0');
  assert.match(cmdContent, /%REPO_ROOT%scripts\\launch-cockpit\.ps1/i, 'cmd wrapper must call scripts/launch-cockpit.ps1');
});

test('launcher rejects unknown process occupying target port and preserves it untouched', { timeout: 30_000 }, async (t) => {
  const foreignPort = 41740;
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ foreignApp: 'unrelated-service', count: requestCount }));
  });

  await new Promise((resolve) => server.listen(foreignPort, '127.0.0.1', resolve));
  t.after(async () => closeHttpServer(server));

  const result = await runPowerShell([
    '-File', launcherPs1Path,
    '-TestPort', String(foreignPort),
    '-SkipBuild',
    '-NoPause',
  ], { cwd: repoRoot });

  assert.equal(result.status, 1, `Expected exit code 1 but got ${result.status}: ${result.stdout} ${result.stderr}`);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /\[ERROR\] Port 41740 is occupied by an unverified process/);
  assert.match(result.stdout, /\[WHAT\].*could not be verified as UGK Cockpit/);
  assert.match(result.stdout, /\[IMPACT\] The foreign process was not stopped/);
  assert.match(result.stdout, /\[ACTION\] Please close the application using port 41740/);

  const ping = await fetch(`http://127.0.0.1:${foreignPort}/`, {
    signal: AbortSignal.timeout(2_000),
  }).then((response) => response.json());
  assert.equal(ping.foreignApp, 'unrelated-service');
});

test('inverse proof: cross-directory mock returning UGK signatures without service.lock binding is NOT stopped', { timeout: 30_000 }, async (t) => {
  const mockPort = 41741;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-test-inverse-'));
  const cleanupTargets = [];
  t.after(async () => {
    const errors = [];
    for (const target of cleanupTargets.reverse()) {
      try {
        await terminateProcessTree(target);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  });

  const dataDir = path.join(tempDir, 'data');
  const mockAppDir = path.join(tempDir, 'mock-app');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mockAppDir, { recursive: true });

  const mockWorkerPath = path.join(mockAppDir, 'main.mjs');
  writeFileSync(mockWorkerPath, `
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '0.1.0-alpha.35' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>UGK Cockpit - Local Workbench</title>');
});
server.listen(${mockPort}, '127.0.0.1');
`, 'utf8');

  const mockProcess = spawnTracked(process.execPath, [mockWorkerPath], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  cleanupTargets.push(mockProcess);

  assert.ok(await waitForHttp(`http://127.0.0.1:${mockPort}/health`), 'Mock service failed to start');

  const result = await runPowerShell([
    '-File', launcherPs1Path,
    '-TestPort', String(mockPort),
    '-DataDirectory', dataDir,
    '-SkipBuild',
    '-NoPause',
  ], { cwd: repoRoot });

  assert.equal(result.status, 1, `Expected exit code 1 but got ${result.status}`);
  assert.match(result.stdout, /\[ERROR\] Port 41741 is occupied by an unverified process/);
  assert.match(result.stdout, /\[IMPACT\] The foreign process was not stopped/);
  assert.equal(mockProcess.exitCode, null, 'Mock process must NOT have been killed');

  const ping = await fetch(`http://127.0.0.1:${mockPort}/health`, {
    signal: AbortSignal.timeout(2_000),
  }).then((response) => response.json());
  assert.equal(ping.status, 'ok');
});

test('positive proof: mock service WITH valid service.lock binding and HTTP verification is identified and stopped cleanly', { timeout: 30_000 }, async (t) => {
  const mockPort = 41742;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-test-positive-'));
  const cleanupTargets = [];
  const cleanupPidFiles = [];
  t.after(async () => {
    const errors = [];
    const targets = [...cleanupTargets.reverse()];
    for (const pidFile of cleanupPidFiles) {
      const pid = readPidFile(pidFile);
      if (pid) targets.unshift(pid);
    }
    for (const target of targets) {
      try {
        await terminateProcessTree(target);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  });

  const dataDir = path.join(tempDir, 'data');
  const mockAppDir = path.join(tempDir, 'mock-app');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mockAppDir, { recursive: true });

  const mock1Path = path.join(mockAppDir, 'mock1.mjs');
  writeFileSync(mock1Path, `
import { createServer } from 'node:http';
let transientFailuresRemaining = 0;
const server = createServer((req, res) => {
  if (req.url === '/arm-transient-failure') {
    transientFailuresRemaining = 2;
    res.writeHead(204);
    res.end();
    return;
  }
  if (transientFailuresRemaining > 0) {
    transientFailuresRemaining -= 1;
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('warming');
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>UGK Cockpit - Local Workbench</title>');
});
server.listen(${mockPort}, '127.0.0.1');
`, 'utf8');

  const mockProcess1 = spawnTracked(process.execPath, [mock1Path], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  cleanupTargets.push(mockProcess1);

  const lockFilePath = path.join(dataDir, 'service.lock');
  writeFileSync(lockFilePath, JSON.stringify({
    pid: mockProcess1.pid,
    ownerToken: 'test-token-12345',
    createdAt: new Date().toISOString(),
  }), 'utf8');

  const mock2Path = path.join(mockAppDir, 'mock2.mjs');
  const replacementPidFile = path.join(dataDir, 'replacement.pid');
  writeFileSync(mock2Path, `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.UGK_TEST_PID_FILE, String(process.pid));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>UGK Cockpit - Replacement Service</title>');
});
server.listen(${mockPort}, '127.0.0.1');
`, 'utf8');

  const siblingProcess = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  cleanupTargets.push(siblingProcess);
  cleanupPidFiles.push(replacementPidFile);

  assert.ok(await waitForHttp(`http://127.0.0.1:${mockPort}/health`), 'Mock process 1 failed to start');
  const armResponse = await fetch(`http://127.0.0.1:${mockPort}/arm-transient-failure`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(armResponse.status, 204);

  const result = await runPowerShell([
    '-File', launcherPs1Path,
    '-TestPort', String(mockPort),
    '-DataDirectory', dataDir,
    '-TestMainEntry', mock2Path,
    '-SkipBuild',
    '-NoPause',
    '-TimeoutSeconds', '10',
  ], {
    cwd: repoRoot,
    env: { ...process.env, UGK_TEST_PID_FILE: replacementPidFile },
  });

  const replacementPid = readPidFile(replacementPidFile);

  assert.ok(replacementPid, 'Replacement service did not publish a PID file');
  assert.equal(result.status, 0, `Launcher failed: ${result.stdout} ${result.stderr}`);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, new RegExp(`Stopping verified UGK Cockpit service on port ${mockPort}`));
  assert.match(result.stdout, new RegExp(`Previous UGK Cockpit service \\(PID: ${mockProcess1.pid}\\) stopped successfully`));

  await terminateProcessTree(mockProcess1);
  assert.equal(processIsAlive(mockProcess1.pid), false, 'Mock process 1 must have exited');
  assert.equal(siblingProcess.exitCode, null, 'Unrelated sibling process must NOT be killed');

  const replacement = await waitForHttp(`http://127.0.0.1:${mockPort}/`);
  assert.ok(replacement, 'Replacement service did not become ready');
  assert.match(replacement.body, /UGK Cockpit - Replacement Service/);
  await terminateProcessTree(replacementPid);
  await terminateProcessTree(siblingProcess);
  cleanupTargets.length = 0;
  cleanupPidFiles.length = 0;
});

test('launcher cleans up stale service.lock with dead PID before starting new instance', { timeout: 30_000 }, async (t) => {
  const mockPort = 41743;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ugk-test-stale-'));
  const cleanupPidFiles = [];
  t.after(async () => {
    const errors = [];
    for (const pidFile of cleanupPidFiles.reverse()) {
      const pid = readPidFile(pidFile);
      if (!pid) continue;
      try {
        await terminateProcessTree(pid);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  });

  const dataDir = path.join(tempDir, 'data');
  const mockAppDir = path.join(tempDir, 'mock-app');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mockAppDir, { recursive: true });

  const lockFilePath = path.join(dataDir, 'service.lock');
  writeFileSync(lockFilePath, JSON.stringify({
    pid: 999999,
    ownerToken: 'dead-token',
    createdAt: '2026-01-01T00:00:00.000Z',
  }), 'utf8');

  const mockPath = path.join(mockAppDir, 'main.mjs');
  const replacementPidFile = path.join(dataDir, 'replacement.pid');
  cleanupPidFiles.push(replacementPidFile);
  writeFileSync(mockPath, `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.UGK_TEST_PID_FILE, String(process.pid));
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>UGK Cockpit - Started Fresh</title>');
});
server.listen(${mockPort}, '127.0.0.1');
`, 'utf8');

  const result = await runPowerShell([
    '-File', launcherPs1Path,
    '-TestPort', String(mockPort),
    '-DataDirectory', dataDir,
    '-TestMainEntry', mockPath,
    '-SkipBuild',
    '-NoPause',
    '-TimeoutSeconds', '10',
  ], {
    cwd: repoRoot,
    env: { ...process.env, UGK_TEST_PID_FILE: replacementPidFile },
  });

  const replacementPid = readPidFile(replacementPidFile);

  assert.ok(replacementPid, 'Fresh service did not publish a PID file');
  assert.equal(result.status, 0, `Launcher failed: ${result.stdout} ${result.stderr}`);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /Cleaned up stale service lock file \(dead PID: 999999\)/);
  assert.match(result.stdout, /\[OK\] UGK Cockpit is running in background/);

  const ping = await waitForHttp(`http://127.0.0.1:${mockPort}/`);
  assert.ok(ping, 'Fresh service did not become ready');
  assert.match(ping.body, /UGK Cockpit - Started Fresh/);
  await terminateProcessTree(replacementPid);
  cleanupPidFiles.length = 0;
});

test('root cmd wrapper propagates arguments and exit codes without pausing when -NoPause is given', { timeout: 30_000 }, async (t) => {
  const foreignPort = 41749;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('foreign wrapper test service');
  });
  await new Promise((resolve) => server.listen(foreignPort, '127.0.0.1', resolve));
  t.after(async () => closeHttpServer(server));

  const result = await runCmd([
    launcherCmdPath,
    '-TestPort', String(foreignPort),
    '-SkipBuild',
    '-NoPause',
  ], {
    cwd: repoRoot,
    env: { ...process.env, UGK_LAUNCHER_NO_PAUSE: '1' },
  });

  assert.equal(result.status, 1, `Expected wrapper to propagate failure: ${result.stdout} ${result.stderr}`);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /Port 41749 is occupied by an unverified process/);
});
