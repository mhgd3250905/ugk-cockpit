import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityMigrationBacklog } from '../src/core/identity-migration.mjs';

// Use the browser session of the actual listener, never a token from another file view.
export async function verifyServiceData(directory, url) {
  const db = new DatabaseSync(path.join(directory, 'cockpit.db'), { readOnly: true });
  let projects;
  let owedIdentities = [];
  try {
    // Match the dashboard's visible-project scope: removed and user-archived
    // projects are intentionally absent from the active list; counting them
    // here would refuse a perfectly consistent service after any archive.
    const columns = db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name);
    const visibility = ['removed_at', 'archived_at']
      .filter((column) => columns.includes(column))
      .map((column) => `${column} IS NULL`)
      .join(' AND ');
    projects = db.prepare(`SELECT id FROM projects${visibility ? ` WHERE ${visibility}` : ''}`).all();
    // 启动核对不能只看列表数量：位置身份尚未收敛的工作副本会在下一次探测时要求
    // 人工确认，必须在这里就说出来，而不是等用户在工作台撞上。
    owedIdentities = identityMigrationBacklog(db);
  } finally {
    db.close();
  }
  for (const entry of owedIdentities) {
    console.log(`[WARN] 位置身份尚未收敛：${entry.canonicalPath}（原因 ${entry.reason ?? 'unknown'}`
      + `${entry.attempts ? `，已尝试 ${entry.attempts} 次` : ''}）。`
      + '目录重新可见后会在下一次开库自动收敛；不要重新 init、移除项目或清库。');
  }
  const shell = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const cookie = shell.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const response = await fetch(new URL('/api/v1/dashboard', url), {
    headers: { cookie }, signal: AbortSignal.timeout(10000),
  });
  const dashboard = await response.json();
  if (!response.ok || !dashboard.ok || !Array.isArray(dashboard.projects)) {
    throw new Error('Project list could not be loaded from the running service.');
  }
  const actual = new Set(dashboard.projects.map((project) => project.id));
  if (projects.length !== actual.size || projects.some((project) => !actual.has(project.id))) {
    throw new Error(`Database/service project mismatch: database=${projects.length}, service=${actual.size}.`);
  }
  for (const project of projects) {
    const detail = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(project.id)}`, url), {
      headers: { cookie }, signal: AbortSignal.timeout(10000),
    });
    if (!detail.ok || !(await detail.json()).ok) throw new Error(`Project detail failed: ${project.id}`);
  }
  return projects.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const count = await verifyServiceData(process.argv[2], process.argv[3]);
    console.log(`[OK] Verified ${count} existing projects against the running service.`);
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  }
}
