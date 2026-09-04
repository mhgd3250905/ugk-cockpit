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
} from '../src/core/projects.mjs';
import {
  stageProjectAvatar,
  resolveProjectAvatar,
  MAX_AVATAR_FILE_SIZE,
} from '../src/core/project-avatars.mjs';
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
  const avatarStorageRoot = path.join(container, 'project-avatars');
  mkdirSync(avatarStorageRoot, { recursive: true });

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

  return { container, repoRoot, dbPath, avatarStorageRoot, db, cleanup };
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
  const { repoRoot, avatarStorageRoot, container, db } = createFixture(t);
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
  }, { avatarStorageRoot });
  assert.equal(update1.ok, true);
  assert.equal(update1.project.name, '新的项目名');
  assert.equal(update1.project.avatarPath, null);

  dashboard = readDashboard(db);
  assert.equal(dashboard[0].name, '新的项目名');

  // Stage an external avatar file
  const externalImage = path.join(container, 'external-logo.png');
  writeFileSync(externalImage, Buffer.from('fake-avatar-data-content'));

  const staged = stageProjectAvatar({
    sourcePath: externalImage,
    storageRoot: avatarStorageRoot,
    projectId: reg.projectId,
  });
  assert.ok(staged.avatarPath.startsWith(`${reg.projectId}/`));

  // Update avatarPath
  const update2 = updateProject(db, {
    commandId: 'cmd-update-2',
    projectId: reg.projectId,
    avatarPath: staged.avatarPath,
  }, { avatarStorageRoot });
  assert.equal(update2.ok, true);
  assert.equal(update2.project.name, '新的项目名');
  assert.equal(update2.project.avatarPath, staged.avatarPath);

  dashboard = readDashboard(db);
  assert.equal(dashboard[0].avatarPath, staged.avatarPath);
  detail = readProjectDetail(db, reg.projectId);
  assert.equal(detail.project.avatarPath, staged.avatarPath);

  // Clear avatarPath
  const update3 = updateProject(db, {
    commandId: 'cmd-update-3',
    projectId: reg.projectId,
    avatarPath: '',
  }, { avatarStorageRoot });
  assert.equal(update3.ok, true);
  assert.equal(update3.project.avatarPath, null);
  assert.equal(readDashboard(db)[0].avatarPath, null);

  // Idempotent replay of cmd-update-2 returns cached result
  const replay2 = updateProject(db, {
    commandId: 'cmd-update-2',
    projectId: reg.projectId,
    avatarPath: staged.avatarPath,
  }, { avatarStorageRoot });
  assert.equal(replay2.ok, true);
  assert.equal(replay2.project.avatarPath, staged.avatarPath);
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

test('stageProjectAvatar and resolveProjectAvatar: format validation, size bounds, and reparse point rejection', (t) => {
  const { container, avatarStorageRoot } = createFixture(t);
  const projectId = 'project_0123456789abcdef01234567';

  // 1. Supported image formats
  const formats = [
    { ext: '.png', mime: 'image/png' },
    { ext: '.jpg', mime: 'image/jpeg' },
    { ext: '.jpeg', mime: 'image/jpeg' },
    { ext: '.gif', mime: 'image/gif' },
    { ext: '.webp', mime: 'image/webp' },
  ];

  for (const fmt of formats) {
    const filePath = path.join(container, `sample${fmt.ext}`);
    writeFileSync(filePath, Buffer.from(`DATA_FOR_${fmt.ext}`));
    const staged = stageProjectAvatar({
      sourcePath: filePath,
      storageRoot: avatarStorageRoot,
      projectId,
    });
    assert.equal(staged.mimeType, fmt.mime);
    assert.ok(staged.avatarPath.endsWith(fmt.ext.toLowerCase()));

    const resolved = resolveProjectAvatar({
      storageRoot: avatarStorageRoot,
      projectId,
      avatarPath: staged.avatarPath,
    });
    assert.equal(resolved.mimeType, fmt.mime);
    assert.equal(resolved.avatarPath, staged.avatarPath);
  }

  // 2. Reject SVG with INVALID_IMAGE_TYPE
  const svgPath = path.join(container, 'vector.svg');
  writeFileSync(svgPath, '<svg></svg>');
  assert.throws(
    () => stageProjectAvatar({ sourcePath: svgPath, storageRoot: avatarStorageRoot, projectId }),
    (err) => err.code === 'INVALID_IMAGE_TYPE'
  );

  // 3. Reject non-image with INVALID_IMAGE_TYPE
  const scriptPath = path.join(container, 'script.js');
  writeFileSync(scriptPath, 'console.log()');
  assert.throws(
    () => stageProjectAvatar({ sourcePath: scriptPath, storageRoot: avatarStorageRoot, projectId }),
    (err) => err.code === 'INVALID_IMAGE_TYPE'
  );

  // 4. Reject empty file with INVALID_IMAGE_PATH
  const emptyPath = path.join(container, 'empty.png');
  writeFileSync(emptyPath, Buffer.alloc(0));
  assert.throws(
    () => stageProjectAvatar({ sourcePath: emptyPath, storageRoot: avatarStorageRoot, projectId }),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );

  // 5. Reject oversize file with IMAGE_TOO_LARGE
  const hugePath = path.join(container, 'huge.png');
  writeFileSync(hugePath, Buffer.alloc(MAX_AVATAR_FILE_SIZE + 1));
  assert.throws(
    () => stageProjectAvatar({ sourcePath: hugePath, storageRoot: avatarStorageRoot, projectId }),
    (err) => err.code === 'IMAGE_TOO_LARGE'
  );

  // 6. Reject symlink source with REPARSE_POINT
  const validPath = path.join(container, 'sample.png');
  const symlinkPath = path.join(container, 'symlink.png');
  symlinkSync(validPath, symlinkPath, 'file');
  assert.throws(
    () => stageProjectAvatar({ sourcePath: symlinkPath, storageRoot: avatarStorageRoot, projectId }),
    (err) => err.code === 'REPARSE_POINT'
  );

  // 7. Direct resolveProjectAvatar checks:
  // Cross-project avatarPath rejected
  assert.throws(
    () => resolveProjectAvatar({
      storageRoot: avatarStorageRoot,
      projectId,
      avatarPath: 'project_other0123456789abcdef/1111111111111111111111111111111111111111111111111111111111111111.png',
    }),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );

  // Traversal path rejected
  assert.throws(
    () => resolveProjectAvatar({
      storageRoot: avatarStorageRoot,
      projectId,
      avatarPath: '../../outside.png',
    }),
    (err) => err.code === 'INVALID_IMAGE_PATH'
  );

  // Missing file rejected
  assert.throws(
    () => resolveProjectAvatar({
      storageRoot: avatarStorageRoot,
      projectId,
      avatarPath: `${projectId}/0000000000000000000000000000000000000000000000000000000000000000.png`,
    }),
    (err) => err.code === 'IMAGE_NOT_FOUND'
  );

  // 8. Direct buffer staging for all formats
  for (const fmt of formats) {
    const buf = Buffer.from(`BUFFER_DATA_FOR_${fmt.ext}`);
    const stagedBuf = stageProjectAvatar({
      content: buf,
      originalName: `upload${fmt.ext}`,
      storageRoot: avatarStorageRoot,
      projectId,
    });
    assert.equal(stagedBuf.mimeType, fmt.mime);
    assert.ok(stagedBuf.avatarPath.endsWith(fmt.ext.toLowerCase()));
  }
});

test('HTTP API: avatar select, cancel, preview, save, cross-project key rejection, and surviving source image deletion', async (t) => {
  const { container, repoRoot, dbPath, avatarStorageRoot, db, cleanup } = createFixture(t, { registerHook: false });

  // Create an external image outside the repo
  const sourceImage = path.join(container, 'user-choice.png');
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  writeFileSync(sourceImage, pngHeader);

  const reg = registerProject(db, {
    commandId: 'reg-http-p1',
    name: 'HTTP测试项目',
    observation: sampleObservation(repoRoot),
  });

  const repoRoot2 = path.join(container, 'repository2');
  mkdirSync(repoRoot2, { recursive: true });
  writeFileSync(path.join(repoRoot2, 'README.md'), '# Fixture 2\n', 'utf8');

  const reg2 = registerProject(db, {
    commandId: 'reg-http-p2',
    name: '第二项目',
    observation: {
      ...sampleObservation(repoRoot2),
      canonicalPath: repoRoot2,
      worktreeIdentity: 'worktree-p2',
    },
  });
  assert.equal(reg2.ok, true);
  db.close();

  let nextPickerResult = sourceImage;
  let pickerCallCount = 0;
  let throwPickerError = null;

  const mockImagePicker = async () => {
    pickerCallCount += 1;
    if (throwPickerError) throw throwPickerError;
    return nextPickerResult;
  };

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
    imagePicker: mockImagePicker,
    avatarStorageRoot,
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

  // 1. Verify old scanning route /images returns 404 NOT_FOUND
  const scanRes = await req(`/api/v1/projects/${reg.projectId}/images`);
  assert.equal(scanRes.status, 404);

  // 2. Avatar not set yet -> 404
  const noAvatarRes = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(noAvatarRes.status, 404);

  // 3. User cancels selection in picker -> returns cancelled: true, DB remains unchanged
  nextPickerResult = null;
  const cancelSelectRes = await req(`/api/v1/projects/${reg.projectId}/avatar/select`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(cancelSelectRes.status, 200);
  const cancelBody = await cancelSelectRes.json();
  assert.equal(cancelBody.ok, true);
  assert.equal(cancelBody.cancelled, true);

  // Confirm DB avatar remains unset
  const detailAfterCancel = await req(`/api/v1/projects/${reg.projectId}`);
  assert.equal((await detailAfterCancel.json()).project.avatarPath, null);

  // 4. Image picker timeout -> 504 with 3-part public error
  throwPickerError = Object.assign(new Error('timed out'), { code: 'IMAGE_PICKER_TIMEOUT' });
  const timeoutRes = await req(`/api/v1/projects/${reg.projectId}/avatar/select`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(timeoutRes.status, 504);
  const timeoutBody = await timeoutRes.json();
  assert.equal(timeoutBody.code, 'IMAGE_PICKER_TIMEOUT');
  assert.ok(timeoutBody.message);
  assert.ok(timeoutBody.impact);
  assert.ok(timeoutBody.required_action);
  throwPickerError = null;

  // 5. Image picker unavailable -> 503 with 3-part public error
  throwPickerError = Object.assign(new Error('picker failed'), { code: 'IMAGE_PICKER_UNAVAILABLE' });
  const unavailRes = await req(`/api/v1/projects/${reg.projectId}/avatar/select`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(unavailRes.status, 503);
  const unavailBody = await unavailRes.json();
  assert.equal(unavailBody.code, 'IMAGE_PICKER_UNAVAILABLE');
  assert.ok(unavailBody.message);
  assert.ok(unavailBody.impact);
  assert.ok(unavailBody.required_action);
  throwPickerError = null;

  // 6. Successful avatar selection -> stages into Cockpit storage directory
  nextPickerResult = sourceImage;
  const selectRes = await req(`/api/v1/projects/${reg.projectId}/avatar/select`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(selectRes.status, 200);
  const selectBody = await selectRes.json();
  assert.equal(selectBody.ok, true);
  assert.equal(selectBody.cancelled, false);
  assert.ok(selectBody.avatarPath.startsWith(`${reg.projectId}/`));
  assert.equal(selectBody.mimeType, 'image/png');

  // Verify DB is STILL unchanged before user saves!
  const detailBeforeSave = await req(`/api/v1/projects/${reg.projectId}`);
  assert.equal((await detailBeforeSave.json()).project.avatarPath, null);

  // 7. Preview staged candidate avatar using ?path=
  const previewRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=${encodeURIComponent(selectBody.avatarPath)}`);
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('content-type'), 'image/png');
  assert.equal(previewRes.headers.get('x-content-type-options'), 'nosniff');
  const previewBuf = Buffer.from(await previewRes.arrayBuffer());
  assert.deepEqual(previewBuf, pngHeader);

  // 8. Delete original image file on user's disk!
  rmSync(sourceImage, { force: true });
  assert.equal(existsSync(sourceImage), false);

  // 9. Save project settings via POST -> persists avatar to database
  const saveRes = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-save-project-1',
      name: '保存后的名称',
      avatarPath: selectBody.avatarPath,
    }),
  });
  assert.equal(saveRes.status, 200);
  const saveBody = await saveRes.json();
  assert.equal(saveBody.project.name, '保存后的名称');
  assert.equal(saveBody.project.avatarPath, selectBody.avatarPath);

  // 10. Fetch saved avatar without ?path= -> returns the avatar even though original source was deleted!
  const savedAvatarRes = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(savedAvatarRes.status, 200);
  assert.equal(savedAvatarRes.headers.get('content-type'), 'image/png');
  const savedBuf = Buffer.from(await savedAvatarRes.arrayBuffer());
  assert.deepEqual(savedBuf, pngHeader);

  // 11. Test HEAD request for saved avatar
  const headRes = await req(`/api/v1/projects/${reg.projectId}/avatar`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-type'), 'image/png');
  assert.equal(headRes.headers.get('content-length'), String(pngHeader.length));

  // 12. Cross-project key rejection: reg2 cannot use reg's avatarPath
  const crossProjectRes = await req(`/api/v1/projects/${reg2.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-cross-project-err',
      name: '尝试越权的项目',
      avatarPath: selectBody.avatarPath, // belongs to reg, not reg2!
    }),
  });
  assert.equal(crossProjectRes.status, 400);
  const crossBody = await crossProjectRes.json();
  assert.equal(crossBody.code, 'INVALID_IMAGE_PATH');

  // 13. Path traversal rejection
  const traversalRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=../../etc/passwd.png`);
  assert.equal(traversalRes.status, 400);
  const traversalBody = await traversalRes.json();
  assert.equal(traversalBody.code, 'INVALID_IMAGE_PATH');

  // 14. Clear avatar
  const clearRes = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-clear-avatar-1',
      name: '保存后的名称',
      avatarPath: '',
    }),
  });
  assert.equal(clearRes.status, 200);
  assert.equal((await clearRes.json()).project.avatarPath, null);

  // Avatar endpoint now returns 404
  const clearedAvatarRes = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(clearedAvatarRes.status, 404);
});

test('HTTP API: direct avatar upload via multipart FormData and raw binary, size limits, and format checks', async (t) => {
  const { container, repoRoot, dbPath, avatarStorageRoot, db, cleanup } = createFixture(t, { registerHook: false });

  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  const reg = registerProject(db, {
    commandId: 'reg-upload-p1',
    name: 'Upload Test Project',
    observation: sampleObservation(repoRoot),
  });
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
    avatarStorageRoot,
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

  // 1. Multipart FormData upload
  const formData = new FormData();
  const file = new Blob([pngHeader], { type: 'image/png' });
  formData.append('file', file, 'avatar.png');

  const uploadRes = await req(`/api/v1/projects/${reg.projectId}/avatar/upload`, {
    method: 'POST',
    body: formData,
  });
  assert.equal(uploadRes.status, 200);
  const uploadBody = await uploadRes.json();
  assert.equal(uploadBody.ok, true);
  assert.equal(uploadBody.cancelled, false);
  assert.ok(uploadBody.avatarPath.startsWith(`${reg.projectId}/`));
  assert.equal(uploadBody.mimeType, 'image/png');

  // Preview works
  const previewRes = await req(`/api/v1/projects/${reg.projectId}/avatar?path=${encodeURIComponent(uploadBody.avatarPath)}`);
  assert.equal(previewRes.status, 200);
  assert.deepEqual(Buffer.from(await previewRes.arrayBuffer()), pngHeader);

  // 2. Raw binary upload with content-type
  const rawRes = await req(`/api/v1/projects/${reg.projectId}/avatar/upload?filename=raw-photo.jpg`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.from('JPEG_RAW_DATA_123'),
  });
  assert.equal(rawRes.status, 200);
  const rawBody = await rawRes.json();
  assert.equal(rawBody.ok, true);
  assert.equal(rawBody.mimeType, 'image/jpeg');

  // 3. Oversize upload (>5MB) rejected with 413 IMAGE_TOO_LARGE
  const hugeBuf = Buffer.alloc(MAX_AVATAR_FILE_SIZE + 10);
  const hugeRes = await req(`/api/v1/projects/${reg.projectId}/avatar/upload?filename=huge.png`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: hugeBuf,
  });
  assert.equal(hugeRes.status, 413);
  const hugeBody = await hugeRes.json();
  assert.equal(hugeBody.code, 'IMAGE_TOO_LARGE');

  // 4. Invalid format (svg) rejected with 415 INVALID_IMAGE_TYPE
  const svgRes = await req(`/api/v1/projects/${reg.projectId}/avatar/upload?filename=vector.svg`, {
    method: 'POST',
    headers: { 'content-type': 'image/svg+xml' },
    body: '<svg></svg>',
  });
  assert.equal(svgRes.status, 415);
  const svgBody = await svgRes.json();
  assert.equal(svgBody.code, 'INVALID_IMAGE_TYPE');

  // 5. Empty body rejected with 400 INVALID_IMAGE_PATH
  const emptyRes = await req(`/api/v1/projects/${reg.projectId}/avatar/upload?filename=empty.png`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.alloc(0),
  });
  assert.equal(emptyRes.status, 400);

  // 6. Unknown project rejected with 404 PROJECT_NOT_FOUND
  const notFoundRes = await req('/api/v1/projects/non-existent-proj/avatar/upload?filename=test.png', {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: pngHeader,
  });
  assert.equal(notFoundRes.status, 404);
});

test('Modals contract: ConfirmFolderModal, HandoffModal, EditProjectModal prevent backdrop click dismissal and contain no scan UI', () => {
  const mainJsxPath = path.resolve('web/src/main.jsx');
  const mainJsx = readFileSync(mainJsxPath, 'utf8');

  // Verify ConfirmFolderModal export/alias exists
  assert.match(mainJsx, /const ConfirmFolderModal = ConfirmAddModal;|export (const|function) ConfirmFolderModal/);

  // Verify ConfirmAddModal, HandoffModal, and EditProjectModal do not have onClick on modal-backdrop
  const backdropMatches = [...mainJsx.matchAll(/<div[^>]*className=["'][^"']*modal-backdrop[^"']*["'][^>]*>/g)];
  assert.ok(backdropMatches.length >= 3, `Expected at least 3 modal-backdrop instances, found ${backdropMatches.length}`);
  for (const match of backdropMatches) {
    assert.doesNotMatch(match[0], /onClick/, `modal-backdrop should not have onClick handler: ${match[0]}`);
  }

  // Verify useFocusTrap ignores Escape when busy
  assert.match(mainJsx, /if \(busyRef\.current\) return;/);

  // Verify scanning UI and copy are removed from EditProjectModal
  assert.doesNotMatch(mainJsx, /检索项目内图片/);
  assert.doesNotMatch(mainJsx, /candidate-images/);
  assert.doesNotMatch(mainJsx, /从已授权项目目录检索图片/);

  // Verify clear "选择图片" button is present and uses file input
  assert.match(mainJsx, /选择图片/);
  assert.match(mainJsx, /\/avatar\/(select|upload)/);
  assert.match(mainJsx, /type="file"/);
});

test('Fail-closed: replacing avatarStorageRoot or ancestor with junction/symlink blocks staging and avatar access', async (t) => {
  const container = mkdtempSync(path.join(os.tmpdir(), 'ugk-cockpit-avatar-junc-'));
  const targetOutside = path.join(container, 'outside');
  mkdirSync(targetOutside, { recursive: true });
  writeFileSync(path.join(targetOutside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const storageDir = path.join(container, 'project-avatars');
  mkdirSync(storageDir, { recursive: true });

  const repoRoot = path.join(container, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UGK Fixture']);
  git(['config', 'user.email', 'fixture@localhost']);
  writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);

  const dbPath = path.join(container, 'cockpit.db');
  const db = openCockpitDatabase(dbPath);
  const reg = registerProject(db, {
    commandId: 'reg-junc-1',
    name: 'Junction Test',
    observation: sampleObservation(repoRoot),
  });

  // Stage avatar normally first
  const validFile = path.join(container, 'valid.png');
  writeFileSync(validFile, Buffer.from('VALID_PNG_CONTENT'));
  const staged = stageProjectAvatar({
    sourcePath: validFile,
    storageRoot: storageDir,
    projectId: reg.projectId,
  });

  const setAvatar = updateProject(db, {
    commandId: 'cmd-set-avatar',
    projectId: reg.projectId,
    avatarPath: staged.avatarPath,
  }, { avatarStorageRoot: storageDir });
  assert.equal(setAvatar.ok, true);
  db.close();

  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
    avatarStorageRoot: storageDir,
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

  // Normal access works
  const initialAvatar = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(initialAvatar.status, 200);

  // Now replace storageDir with a junction pointing outside
  rmSync(storageDir, { recursive: true, force: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(targetOutside, storageDir, linkType);

  // 1. Direct resolveProjectAvatar throws REPARSE_POINT
  assert.throws(
    () => resolveProjectAvatar({
      storageRoot: storageDir,
      projectId: reg.projectId,
      avatarPath: staged.avatarPath,
    }),
    (err) => err.code === 'REPARSE_POINT'
  );

  // 2. Direct stageProjectAvatar throws REPARSE_POINT
  assert.throws(
    () => stageProjectAvatar({
      sourcePath: validFile,
      storageRoot: storageDir,
      projectId: reg.projectId,
    }),
    (err) => err.code === 'REPARSE_POINT'
  );

  // 3. HTTP reading saved avatar fails closed (400 REPARSE_POINT)
  const savedAvatarBlocked = await req(`/api/v1/projects/${reg.projectId}/avatar`);
  assert.equal(savedAvatarBlocked.status, 400);
  const savedAvatarBlockedBody = await savedAvatarBlocked.json();
  assert.equal(savedAvatarBlockedBody.code, 'REPARSE_POINT');
});

test('updateProject: strict terminal replay returns cached result before filesystem revalidation, surviving avatar deletion', async (t) => {
  const { container, repoRoot, dbPath, avatarStorageRoot, db, cleanup } = createFixture(t, { registerHook: false });

  const avatarFile = path.join(container, 'deletable-avatar.png');
  writeFileSync(avatarFile, Buffer.from('AVATAR_DATA_CONTENT'));

  const reg = registerProject(db, {
    commandId: 'reg-replay-p1',
    name: 'Replay Project',
    observation: sampleObservation(repoRoot),
  });

  const staged = stageProjectAvatar({
    sourcePath: avatarFile,
    storageRoot: avatarStorageRoot,
    projectId: reg.projectId,
  });

  // 1. Initial successful update with avatar
  const updateRes = updateProject(db, {
    commandId: 'cmd-avatar-update-1',
    projectId: reg.projectId,
    name: 'Updated Name',
    avatarPath: staged.avatarPath,
  }, { avatarStorageRoot });
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.avatarPath, staged.avatarPath);

  // 2. Delete the staged avatar file from disk!
  const stagedFileOnDisk = path.join(avatarStorageRoot, staged.avatarPath);
  rmSync(stagedFileOnDisk, { force: true });
  assert.equal(existsSync(stagedFileOnDisk), false);

  // 3. Terminal replay with same commandId and same request MUST succeed before any disk check
  const replayRes = updateProject(db, {
    commandId: 'cmd-avatar-update-1',
    projectId: reg.projectId,
    name: 'Updated Name',
    avatarPath: staged.avatarPath,
  }, { avatarStorageRoot });
  assert.equal(replayRes.ok, true);
  assert.equal(replayRes.avatarPath, staged.avatarPath);
  assert.equal(replayRes.commandId, 'cmd-avatar-update-1');

  // 4. Conflict fails closed: same commandId with different request
  assert.throws(
    () => updateProject(db, {
      commandId: 'cmd-avatar-update-1',
      projectId: reg.projectId,
      name: 'Conflict Name',
      avatarPath: staged.avatarPath,
    }, { avatarStorageRoot }),
    (err) => err.code === 'COMMAND_CONFLICT'
  );

  // 5. Validation failure persistence and replay
  const failRes = updateProject(db, {
    commandId: 'cmd-avatar-fail-1',
    projectId: reg.projectId,
    name: 'Valid Name',
    avatarPath: `${reg.projectId}/0000000000000000000000000000000000000000000000000000000000000000.png`,
  }, { avatarStorageRoot });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.code, 'IMAGE_NOT_FOUND');

  // Replay of failed command returns consistent failure without re-probing
  const failReplay = updateProject(db, {
    commandId: 'cmd-avatar-fail-1',
    projectId: reg.projectId,
    name: 'Valid Name',
    avatarPath: `${reg.projectId}/0000000000000000000000000000000000000000000000000000000000000000.png`,
  }, { avatarStorageRoot });
  assert.equal(failReplay.ok, false);
  assert.equal(failReplay.code, 'IMAGE_NOT_FOUND');

  // 6. Test via HTTP API
  // Re-create a temporary avatar file
  const httpAvatar = path.join(container, 'http-avatar.png');
  writeFileSync(httpAvatar, Buffer.from('HTTP_AVATAR_CONTENT'));
  const httpStaged = stageProjectAvatar({
    sourcePath: httpAvatar,
    storageRoot: avatarStorageRoot,
    projectId: reg.projectId,
  });

  db.close();
  const service = await createCockpitHttpServer({
    dbPath,
    token: TOKEN,
    authorizedRoots: [repoRoot],
    avatarStorageRoot,
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
      avatarPath: httpStaged.avatarPath,
    }),
  });
  assert.equal(httpUpdate.status, 200);

  // Delete the avatar file on disk
  const httpFileOnDisk = path.join(avatarStorageRoot, httpStaged.avatarPath);
  rmSync(httpFileOnDisk, { force: true });

  // Replay HTTP request with same commandId
  const httpReplay = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-http-replay-1',
      name: 'HTTP Project Name',
      avatarPath: httpStaged.avatarPath,
    }),
  });
  assert.equal(httpReplay.status, 200);
  const httpReplayBody = await httpReplay.json();
  assert.equal(httpReplayBody.ok, true);
  assert.equal(httpReplayBody.avatarPath, httpStaged.avatarPath);

  // HTTP conflict returns 409 COMMAND_CONFLICT
  const httpConflict = await req(`/api/v1/projects/${reg.projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: 'cmd-http-replay-1',
      name: 'Conflicting Name',
      avatarPath: httpStaged.avatarPath,
    }),
  });
  assert.equal(httpConflict.status, 409);
  const httpConflictBody = await httpConflict.json();
  assert.equal(httpConflictBody.code, 'COMMAND_CONFLICT');
});
