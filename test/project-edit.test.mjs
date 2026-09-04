import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCockpitDatabase } from '../src/core/database.mjs';
import {
  readDashboard,
  registerProject,
  updateProject,
  scanProjectImages,
  resolveProjectImage,
  worktreeIdFor,
} from '../src/core/projects.mjs';
import { readProjectDetail } from '../src/core/timeline.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const TOKEN = 'phase-zero-test-token-that-is-long-enough';

function createFixture(t, { registerHook = true } = {}) {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-edit-'));
  const repoRoot = path.join(container, 'repository');
  mkdirSync(repoRoot, { recursive: true });

  const git = (args) => execFileSync('git', args, { cwd: repoRoot, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UGK Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);

  const dbPath = path.join(container, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);

  const cleanup = () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // ignore
    }
  };

  if (t && registerHook) {
    t.after(cleanup);
  }

  return { container, repoRoot, dbPath, db, cleanup };
}

function sampleObservation(repoRoot) {
  return {
    canonicalPath: repoRoot,
    repositoryCommonDir: path.join(repoRoot, '.git'),
    gitDirectory: path.join(repoRoot, '.git'),
    indexPath: path.join(repoRoot, '.git', 'index'),
    objectDirectories: [path.join(repoRoot, '.git', 'objects')],
    repositoryIdentity: 'repo-edit-test',
    worktreeIdentity: 'worktree-edit-test',
    observedAt: new Date().toISOString(),
    coherence: 'coherent',
    headRelation: 'same',
    after: {
      head: '1'.repeat(40),
      branch: 'main',
      hasChanges: false,
    },
  };
}

test('updateProject: updates display name and avatarPath, reflected in dashboard and detail', (t) => {
  const { repoRoot, db } = createFixture(t);
  const reg = registerProject(db, {
    commandId: 'reg-p1',
    name: '原始项目名',
    observation: sampleObservation(repoRoot),
  });
  assert.equal(reg.ok, true);

  // Initial dashboard & detail
  let dashboard = readDashboard(db);
  assert.equal(dashboard[0].name, '原始项目名');
  assert.equal(dashboard[0].avatarPath, null);

  let detail = readProjectDetail(db, reg.projectId);
  assert.equal(detail.project.name, '原始项目名');
  assert.equal(detail.project.avatarPath, null);

  // Update name only
  const update1 = updateProject(db, {
    commandId: 'cmd-update-1',
    projectId: reg.projectId,
    name: '新的项目名',
  });
  assert.equal(update1.ok, true);
  assert.equal(update1.project.name, '新的项目名');
  assert.equal(update1.project.avatarPath, null);

  dashboard = readDashboard(db);
  assert.equal(dashboard[0].name, '新的项目名');

  // Create avatar file
  mkdirSync(path.join(repoRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'assets', 'logo.png'), 'fake-avatar-data');

  // Update avatarPath
  const update2 = updateProject(db, {
    commandId: 'cmd-update-2',
    projectId: reg.projectId,
    avatarPath: 'assets/logo.png',
  });
  assert.equal(update2.ok, true);
  assert.equal(update2.project.name, '新的项目名');
  assert.equal(update2.project.avatarPath, 'assets/logo.png');

  dashboard = readDashboard(db);
  assert.equal(dashboard[0].avatarPath, 'assets/logo.png');
  detail = readProjectDetail(db, reg.projectId);
  assert.equal(detail.project.avatarPath, 'assets/logo.png');

  // Clear avatarPath
  const update3 = updateProject(db, {
    commandId: 'cmd-update-3',
    projectId: reg.projectId,
    avatarPath: '',
  });
  assert.equal(update3.ok, true);
  assert.equal(update3.project.avatarPath, null);
  assert.equal(readDashboard(db)[0].avatarPath, null);

  // Idempotent replay of cmd-update-2 returns cached result
  const replay2 = updateProject(db, {
    commandId: 'cmd-update-2',
    projectId: reg.projectId,
    avatarPath: 'assets/logo.png',
  });
  assert.equal(replay2.ok, true);
  assert.equal(replay2.project.avatarPath, 'assets/logo.png');
});

test('updateProject: rejects empty or blank project name', (t) => {
  const { repoRoot, db } = createFixture(t);
  const reg = registerProject(db, {
    commandId: 'reg-p2',
    name: '测试项目',
    observation: sampleObservation(repoRoot),
  });

  const res1 = updateProject(db, { commandId: 'cmd-err-1', projectId: reg.projectId, name: '' });
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'PROJECT_NAME_REQUIRED');

  const res2 = updateProject(db, { commandId: 'cmd-err-2', projectId: reg.projectId, name: '   ' });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'PROJECT_NAME_REQUIRED');

  const res3 = updateProject(db, { commandId: 'cmd-err-3', projectId: 'non-existent', name: '有效名称' });
  assert.equal(res3.ok, false);
  assert.equal(res3.code, 'PROJECT_NOT_FOUND');
});

test('scanProjectImages: discovers raster images and ignores SVGs and non-images', (t) => {
  const { repoRoot } = createFixture(t);

  mkdirSync(path.join(repoRoot, 'assets', 'nested'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.git', 'hooks'), { recursive: true });

  // Raster images
  writeFileSync(path.join(repoRoot, 'logo.png'), 'fake-png-data');
  writeFileSync(path.join(repoRoot, 'assets', 'banner.jpg'), 'fake-jpg-data');
  writeFileSync(path.join(repoRoot, 'assets', 'icon.WEBP'), 'fake-webp-data');
  writeFileSync(path.join(repoRoot, 'assets', 'nested', 'thumb.gif'), 'fake-gif-data');

  // Should be ignored
  writeFileSync(path.join(repoRoot, 'vector.svg'), '<svg></svg>');
  writeFileSync(path.join(repoRoot, 'readme.txt'), 'text');
  writeFileSync(path.join(repoRoot, 'node_modules', 'pkg', 'ignored.png'), 'ignored');
  writeFileSync(path.join(repoRoot, '.git', 'hooks', 'ignored.png'), 'ignored');

  const images = scanProjectImages(repoRoot);
  const relativePaths = images.map((img) => img.relativePath.replace(/\\/g, '/')).sort();

  assert.deepEqual(relativePaths, [
    'assets/banner.jpg',
    'assets/icon.WEBP',
    'assets/nested/thumb.gif',
    'logo.png',
  ]);

  // Check bounds
  const limited = scanProjectImages(repoRoot, { maxCount: 2 });
  assert.equal(limited.length, 2);

  const depthLimited = scanProjectImages(repoRoot, { maxDepth: 0 });
  assert.deepEqual(depthLimited.map((img) => img.relativePath.replace(/\\/g, '/')), ['logo.png']);
});

test('resolveProjectImage: validates paths, rejects SVG, traversal, missing, oversize', (t) => {
  const { repoRoot } = createFixture(t);

  mkdirSync(path.join(repoRoot, 'img'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'img', 'valid.png'), Buffer.from('PNGDATA'));
  writeFileSync(path.join(repoRoot, 'img', 'vector.svg'), '<svg></svg>');

  // Valid
  const resolved = resolveProjectImage(repoRoot, 'img/valid.png');
  assert.equal(resolved.mimeType, 'image/png');
  assert.ok(resolved.size > 0);

  // SVG rejected with INVALID_IMAGE_TYPE
  assert.throws(
    () => resolveProjectImage(repoRoot, 'img/vector.svg'),
    (err) => err.code === 'INVALID_IMAGE_TYPE'
  );

  // Non-image rejected
  writeFileSync(path.join(repoRoot, 'script.js'), 'console.log()');
  assert.throws(
    () => resolveProjectImage(repoRoot, 'script.js'),
    (err) => err.code === 'INVALID_IMAGE_TYPE'
  );

  // Traversal rejected
  assert.throws(
    () => resolveProjectImage(repoRoot, '../outside.png'),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );

  // Missing file
  assert.throws(
    () => resolveProjectImage(repoRoot, 'img/nonexistent.png'),
    (err) => err.code === 'IMAGE_NOT_FOUND'
  );

  // Oversize rejected
  writeFileSync(path.join(repoRoot, 'img', 'oversize.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.throws(
    () => resolveProjectImage(repoRoot, 'img/oversize.png'),
    (err) => err.code === 'IMAGE_TOO_LARGE'
  );

  // Empty file rejected
  writeFileSync(path.join(repoRoot, 'img', 'empty.png'), Buffer.alloc(0));
  assert.throws(
    () => resolveProjectImage(repoRoot, 'img/empty.png'),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );

  // Symlink rejected
  symlinkSync(path.join(repoRoot, 'img', 'valid.png'), path.join(repoRoot, 'img', 'linked.png'), 'file');
  assert.throws(
    () => resolveProjectImage(repoRoot, 'img/linked.png'),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );
});

test('HTTP API: /api/v1/projects/:id/images and /avatar endpoints and edit endpoint', async (t) => {
  const { repoRoot, dbPath, db, cleanup } = createFixture(t, { registerHook: false });

  mkdirSync(path.join(repoRoot, 'public'), { recursive: true });
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(path.join(repoRoot, 'public', 'avatar.png'), pngHeader);

  const reg = registerProject(db, {
    commandId: 'reg-http-p1',
    name: 'HTTP测试项目',
    observation: sampleObservation(repoRoot),
  });
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
  });
  t.after(async () => {
    await service.close();
    cleanup();
  });

  const req = (pathname, options = {}) =>
    fetch(`http://${service.host}:${service.port}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(options.headers || {}),
      },
    });

  // 1. Scan images
  const scanRes = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(scanRes.status, 200);
  const scanBody = await scanRes.json();
  assert.equal(scanBody.images.length, 1);
  assert.equal(scanBody.images[0].relativePath.replace(/\\/g, '/'), 'public/avatar.png');

  // 2. Avatar not set yet -> 404
  const noAvatarRes = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(noAvatarRes.status, 404);

  // 3. Preview candidate avatar using ?path=
  const previewRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=public/avatar.png`);
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('content-type'), 'image/png');
  assert.equal(previewRes.headers.get('x-content-type-options'), 'nosniff');
  const buf = Buffer.from(await previewRes.arrayBuffer());
  assert.deepEqual(buf, pngHeader);

  // 4. Update project name and avatarPath via POST
  const editRes = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-edit-http-1',
      name: '更新后的名称',
      avatarPath: 'public/avatar.png',
    }),
  });
  assert.equal(editRes.status, 200);
  const editBody = await editRes.json();
  assert.equal(editBody.project.name, '更新后的名称');
  assert.equal(editBody.project.avatarPath, 'public/avatar.png');

  // 5. Fetch avatar now returns the saved avatar
  const avatarRes = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(avatarRes.status, 200);
  assert.equal(avatarRes.headers.get('content-type'), 'image/png');

  // 6. Test HEAD request for avatar
  const headRes = await req(`/api/v1/projects/${reg.projectId}/avatar`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-type'), 'image/png');
  assert.equal(headRes.headers.get('content-length'), String(pngHeader.length));

  // 7. Error cases: empty name
  const emptyNameRes = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-edit-err-1',
      name: '',
    }),
  });
  assert.equal(emptyNameRes.status, 400);
  const emptyNameBody = await emptyNameRes.json();
  assert.equal(emptyNameBody.code, 'PROJECT_NAME_REQUIRED');

  // 8. Error cases: SVG preview
  writeFileSync(path.join(repoRoot, 'icon.svg'), '<svg></svg>');
  const svgRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=icon.svg`);
  assert.equal(svgRes.status, 415);
  const svgBody = await svgRes.json();
  assert.equal(svgBody.code, 'INVALID_IMAGE_TYPE');

  // 9. Error cases: invalid path traversal
  const traversalRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=../../etc/passwd.png`);
  assert.equal(traversalRes.status, 400);
  const traversalBody = await traversalRes.json();
  assert.equal(traversalBody.code, 'INVALID_IMAGE_PATH');
  assert.ok(traversalBody.message);
  assert.ok(traversalBody.impact);
  assert.ok(traversalBody.required_action);

  // 10. Error cases: oversize image (413)
  writeFileSync(path.join(repoRoot, 'public', 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  const hugeRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=public/huge.png`);
  assert.equal(hugeRes.status, 413);
  const hugeBody = await hugeRes.json();
  assert.equal(hugeBody.code, 'IMAGE_TOO_LARGE');
  assert.ok(hugeBody.message);
  assert.ok(hugeBody.impact);
  assert.ok(hugeBody.required_action);

  // 11. Error cases: symlink image (400)
  symlinkSync(path.join(repoRoot, 'public', 'avatar.png'), path.join(repoRoot, 'public', 'symlink-avatar.png'), 'file');
  const symlinkRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=public/symlink-avatar.png`);
  assert.equal(symlinkRes.status, 400);
  const symlinkBody = await symlinkRes.json();
  assert.equal(symlinkBody.code, 'INVALID_IMAGE_PATH');
  assert.ok(symlinkBody.message);
  assert.ok(symlinkBody.impact);
  assert.ok(symlinkBody.required_action);
});

test('Modals contract: ConfirmFolderModal, HandoffModal, EditProjectModal prevent backdrop click dismissal', () => {
  const mainJsxPath = path.resolve('web/src/main.jsx');
  const mainJsx = readFileSync(mainJsxPath, 'utf8');

  // Verify ConfirmFolderModal export/alias exists
  assert.match(mainJsx, /const ConfirmFolderModal = ConfirmAddModal;|export (const|function) ConfirmFolderModal/);

  // Verify ConfirmAddModal, HandoffModal, and EditProjectModal do not have onClick on modal-backdrop
  // Match modal-backdrop divs and ensure none of them have onClick
  const backdropMatches = [...mainJsx.matchAll(/<div[^>]*className=["'][^"']*modal-backdrop[^"']*["'][^>]*>/g)];
  assert.ok(backdropMatches.length >= 3, `Expected at least 3 modal-backdrop instances, found ${backdropMatches.length}`);
  for (const match of backdropMatches) {
    assert.doesNotMatch(match[0], /onClick/, `modal-backdrop should not have onClick handler: ${match[0]}`);
  }

  // Verify useFocusTrap ignores Escape when busy
  assert.match(mainJsx, /if \(busyRef\.current\) return;/);
});

test('Fail-closed: replacing authorizedRoot or ancestor with junction/symlink blocks scanning, preview, and saved avatar', async (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-junction-'));
  const targetOutside = path.join(container, 'outside');
  mkdirSync(targetOutside, { recursive: true });
  writeFileSync(path.join(targetOutside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const parentDir = path.join(container, 'parent');
  const repoRoot = path.join(parentDir, 'repo');
  mkdirSync(repoRoot, { recursive: true });

  const git = (args) => execFileSync('git', args, { cwd: repoRoot, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UGK Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
  mkdirSync(path.join(repoRoot, 'img'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'img', 'valid.png'), Buffer.from('VALID_PNG'));
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const dbPath = path.join(container, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const reg = registerProject(db, {
    commandId: 'reg-junc-1',
    name: 'Junction Test',
    observation: sampleObservation(repoRoot),
  });
  // Save avatar initially
  const setAvatar = updateProject(db, {
    commandId: 'cmd-set-avatar',
    projectId: reg.projectId,
    avatarPath: 'img/valid.png',
  });
  assert.equal(setAvatar.ok, true);
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
  });
  t.after(async () => {
    await service.close();
    try {
      rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // ignore
    }
  });

  const req = (pathname, options = {}) =>
    fetch(`http://${service.host}:${service.port}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(options.headers || {}),
      },
    });

  // Verify normal access works first
  const initialScan = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(initialScan.status, 200);
  const initialScanBody = await initialScan.json();
  assert.equal(initialScanBody.images.length, 1);
  assert.equal(initialScanBody.images[0].relativePath, 'img/valid.png');

  const initialAvatar = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(initialAvatar.status, 200);

  // Now replace repoRoot with a junction pointing to outside
  rmSync(repoRoot, { recursive: true, force: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(targetOutside, repoRoot, linkType);

  // 1. Direct scanProjectImages throws REPARSE_POINT
  assert.throws(
    () => scanProjectImages(repoRoot),
    (err) => err.code === 'REPARSE_POINT'
  );

  // 2. Direct resolveProjectImage throws REPARSE_POINT
  assert.throws(
    () => resolveProjectImage(repoRoot, 'secret.png'),
    (err) => err.code === 'REPARSE_POINT'
  );

  // 3. HTTP scan fails closed (400 REPARSE_POINT), never returns external directory content
  const scanBlocked = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(scanBlocked.status, 400);
  const scanBlockedBody = await scanBlocked.json();
  assert.equal(scanBlockedBody.code, 'REPARSE_POINT');
  assert.ok(!scanBlockedBody.images);

  // 4. HTTP preview fails closed (400 REPARSE_POINT), never returns external directory content
  const previewBlocked = await req(`/api/v1/projects/${reg.projectId}/avatar?path=secret.png`);
  assert.equal(previewBlocked.status, 400);
  const previewBlockedBody = await previewBlocked.json();
  assert.equal(previewBlockedBody.code, 'REPARSE_POINT');

  // 5. HTTP reading saved avatar fails closed (400 REPARSE_POINT)
  const savedAvatarBlocked = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(savedAvatarBlocked.status, 400);
  const savedAvatarBlockedBody = await savedAvatarBlocked.json();
  assert.equal(savedAvatarBlockedBody.code, 'REPARSE_POINT');

  // 6. Test ancestor directory replaced with junction
  // Remove junction at repoRoot
  rmSync(repoRoot, { recursive: true, force: true });
  // Now replace parentDir with a junction pointing to outside
  rmSync(parentDir, { recursive: true, force: true });
  symlinkSync(targetOutside, parentDir, linkType);
  // repoRoot is now parentDir/repo, which passes through a junction ancestor!
  assert.throws(
    () => scanProjectImages(repoRoot),
    (err) => err.code === 'REPARSE_POINT'
  );
  const ancestorScanBlocked = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(ancestorScanBlocked.status, 400);
  assert.equal((await ancestorScanBlocked.json()).code, 'REPARSE_POINT');
});

test('scanProjectImages: enforces mandatory resource limits (maxEntries, maxDirectories, deadline)', async (t) => {
  const { repoRoot, dbPath, db, cleanup } = createFixture(t, { registerHook: false });

  // Create 30 directories with text files (no images)
  for (let i = 0; i < 30; i += 1) {
    const dir = path.join(repoRoot, `dir_${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `file_${i}.txt`), 'not an image');
  }

  // 1. maxDirectories limit reached even with 0 images
  const dirLimitResult = scanProjectImages(repoRoot, { maxDirectories: 5 });
  assert.equal(dirLimitResult.length, 0);
  assert.equal(dirLimitResult.truncated, true);
  assert.equal(dirLimitResult.limitReached, 'maxDirectories');
  assert.ok(dirLimitResult.totalDirectories <= 6);

  // 2. maxEntries limit reached even with 0 images
  const entryLimitResult = scanProjectImages(repoRoot, { maxEntries: 10 });
  assert.equal(entryLimitResult.length, 0);
  assert.equal(entryLimitResult.truncated, true);
  assert.equal(entryLimitResult.limitReached, 'maxEntries');

  // 3. deadline limit reached
  const deadlineResult = scanProjectImages(repoRoot, { deadline: Date.now() - 1 });
  assert.equal(deadlineResult.length, 0);
  assert.equal(deadlineResult.truncated, true);
  assert.equal(deadlineResult.limitReached, 'deadline');

  // 4. API returns observable truncated and limitReached info
  const reg = registerProject(db, {
    commandId: 'reg-bounds-test',
    name: 'Bounds Test',
    observation: sampleObservation(repoRoot),
  });
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
  });
  t.after(async () => {
    await service.close();
    cleanup();
  });

  const req = (pathname) =>
    fetch(`http://${service.host}:${service.port}${pathname}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  const scanRes = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(scanRes.status, 200);
  const scanBody = await scanRes.json();
  assert.equal(scanBody.ok, true);
  assert.ok(Array.isArray(scanBody.images));
  assert.equal(typeof scanBody.truncated, 'boolean');
  assert.ok('limitReached' in scanBody);
});

test('updateProject: strict terminal replay returns cached result before filesystem revalidation, surviving avatar deletion', async (t) => {
  const { repoRoot, dbPath, db, cleanup } = createFixture(t, { registerHook: false });

  mkdirSync(path.join(repoRoot, 'assets'), { recursive: true });
  const avatarFile = path.join(repoRoot, 'assets', 'deletable-avatar.png');
  writeFileSync(avatarFile, Buffer.from('AVATAR_DATA'));

  const reg = registerProject(db, {
    commandId: 'reg-replay-p1',
    name: 'Replay Project',
    observation: sampleObservation(repoRoot),
  });

  // 1. Initial successful update with avatar
  const updateRes = updateProject(db, {
    commandId: 'cmd-avatar-update-1',
    projectId: reg.projectId,
    name: 'Updated Name',
    avatarPath: 'assets/deletable-avatar.png',
  });
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.avatarPath, 'assets/deletable-avatar.png');

  // 2. Delete the avatar file from disk!
  rmSync(avatarFile, { force: true });
  assert.equal(existsSync(avatarFile), false);

  // 3. Terminal replay with same commandId and same request MUST succeed before any disk check
  const replayRes = updateProject(db, {
    commandId: 'cmd-avatar-update-1',
    projectId: reg.projectId,
    name: 'Updated Name',
    avatarPath: 'assets/deletable-avatar.png',
  });
  assert.equal(replayRes.ok, true);
  assert.equal(replayRes.avatarPath, 'assets/deletable-avatar.png');
  assert.equal(replayRes.commandId, 'cmd-avatar-update-1');

  // 4. Conflict fails closed: same commandId with different request
  assert.throws(
    () => updateProject(db, {
      commandId: 'cmd-avatar-update-1',
      projectId: reg.projectId,
      name: 'Conflict Name',
      avatarPath: 'assets/deletable-avatar.png',
    }),
    (err) => err.code === 'COMMAND_CONFLICT'
  );

  // 5. Validation failure persistence and replay
  const failRes = updateProject(db, {
    commandId: 'cmd-avatar-fail-1',
    projectId: reg.projectId,
    name: 'Valid Name',
    avatarPath: 'assets/missing-file.png',
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.code, 'IMAGE_NOT_FOUND');

  // Replay of failed command returns consistent failure without re-probing
  const failReplay = updateProject(db, {
    commandId: 'cmd-avatar-fail-1',
    projectId: reg.projectId,
    name: 'Valid Name',
    avatarPath: 'assets/missing-file.png',
  });
  assert.equal(failReplay.ok, false);
  assert.equal(failReplay.code, 'IMAGE_NOT_FOUND');

  // 6. Test via HTTP API
  // Re-create a temporary avatar file
  const httpAvatar = path.join(repoRoot, 'assets', 'http-avatar.png');
  writeFileSync(httpAvatar, Buffer.from('HTTP_AVATAR'));

  db.close();
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
  });
  t.after(async () => {
    await service.close();
    cleanup();
  });

  const req = (pathname, options = {}) =>
    fetch(`http://${service.host}:${service.port}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(options.headers || {}),
      },
    });

  const httpUpdate = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-http-replay-1',
      name: 'HTTP Project Name',
      avatarPath: 'assets/http-avatar.png',
    }),
  });
  assert.equal(httpUpdate.status, 200);

  // Delete the avatar file on disk
  rmSync(httpAvatar, { force: true });

  // Replay HTTP request with same commandId
  const httpReplay = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-http-replay-1',
      name: 'HTTP Project Name',
      avatarPath: 'assets/http-avatar.png',
    }),
  });
  assert.equal(httpReplay.status, 200);
  const httpReplayBody = await httpReplay.json();
  assert.equal(httpReplayBody.ok, true);
  assert.equal(httpReplayBody.avatarPath, 'assets/http-avatar.png');

  // HTTP conflict returns 409 COMMAND_CONFLICT
  const httpConflict = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-http-replay-1',
      name: 'Conflicting Name',
      avatarPath: 'assets/http-avatar.png',
    }),
  });
  assert.equal(httpConflict.status, 409);
  const httpConflictBody = await httpConflict.json();
  assert.equal(httpConflictBody.code, 'COMMAND_CONFLICT');
});

test('scanProjectImages: single large directory stops entry-by-entry on maxEntries and deadline without reading whole directory', (t) => {
  const { repoRoot } = createFixture(t);
  const largeDir = path.join(repoRoot, 'large_single_dir');
  mkdirSync(largeDir, { recursive: true });

  // Create 60 files in this single directory (30 images, 30 non-images)
  for (let i = 0; i < 60; i += 1) {
    const filename = i % 2 === 0 ? `avatar_${String(i).padStart(3, '0')}.png` : `notes_${String(i).padStart(3, '0')}.txt`;
    writeFileSync(path.join(largeDir, filename), 'file-content');
  }

  // 1. maxEntries budget stops incrementally inside a single directory
  const entryLimited = scanProjectImages(largeDir, { maxEntries: 10 });
  assert.equal(entryLimited.totalEntries, 10);
  assert.equal(entryLimited.truncated, true);
  assert.equal(entryLimited.limitReached, 'maxEntries');
  assert.ok(entryLimited.images.length > 0 && entryLimited.images.length <= 10);

  // 2. deadline budget stops incrementally inside a single directory
  const originalDateNow = Date.now;
  try {
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls >= 5 ? 10000 : 1000;
    };
    const deadlineLimited = scanProjectImages(largeDir, { deadline: 5000 });
    assert.equal(deadlineLimited.truncated, true);
    assert.equal(deadlineLimited.limitReached, 'deadline');
    assert.ok(deadlineLimited.totalEntries < 60, `Expected totalEntries < 60, got ${deadlineLimited.totalEntries}`);
  } finally {
    Date.now = originalDateNow;
  }

  // 3. Expired deadline stops before reading any entry from single directory
  const preExpired = scanProjectImages(largeDir, { deadline: Date.now() - 1 });
  assert.equal(preExpired.truncated, true);
  assert.equal(preExpired.limitReached, 'deadline');
  assert.equal(preExpired.totalEntries, 0);

  // 4. Directory handle is reliably closed: deletion succeeds immediately on Windows without handle locks
  rmSync(largeDir, { recursive: true, force: true });
  assert.equal(existsSync(largeDir), false);
});

test('scanProjectImages: directory handles are reliably closed on normal, limitReached, and error paths', (t) => {
  const { repoRoot } = createFixture(t);
  const testDir = path.join(repoRoot, 'handle_test_dir');
  mkdirSync(testDir, { recursive: true });

  for (let i = 0; i < 20; i += 1) {
    writeFileSync(path.join(testDir, `img_${i}.png`), 'content');
  }

  // Path A: normal complete read closes handle
  const normalRes = scanProjectImages(testDir);
  assert.equal(normalRes.truncated, false);
  assert.equal(normalRes.limitReached, null);

  // Path B: maxCount limit reached closes handle
  const countLimited = scanProjectImages(testDir, { maxCount: 2 });
  assert.equal(countLimited.length, 2);
  assert.equal(countLimited.limitReached, 'maxCount');

  // Path C: maxEntries limit reached closes handle
  const entryLimited = scanProjectImages(testDir, { maxEntries: 3 });
  assert.equal(entryLimited.totalEntries, 3);
  assert.equal(entryLimited.limitReached, 'maxEntries');

  // Path D: immediate cleanup succeeds without EBUSY/EPERM Windows file lock
  rmSync(testDir, { recursive: true, force: true });
  assert.equal(existsSync(testDir), false);
});



