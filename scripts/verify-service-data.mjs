import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Use the browser session of the actual listener, never a token from another file view.
export async function verifyServiceData(directory, url) {
  // The read-only SQL pass is a bonus cross-check, not the authority: while a
  // service write transaction holds the file lock, a second connection can
  // get SQLITE_BUSY even though the data is perfectly healthy. Busy is not a
  // verification failure — the HTTP dashboard below stays the authority.
  let projects = null;
  const db = new DatabaseSync(path.join(directory, 'cockpit.db'), { readOnly: true });
  try {
    projects = db.prepare('SELECT id FROM projects').all();
  } catch (error) {
    if (!/busy|locked/i.test(error?.message ?? '')) throw error;
  } finally {
    db.close();
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
  if (projects && (projects.length !== actual.size || projects.some((project) => !actual.has(project.id)))) {
    throw new Error(`Database/service project mismatch: database=${projects.length}, service=${actual.size}.`);
  }
  for (const project of actual) {
    const detail = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(project)}`, url), {
      headers: { cookie }, signal: AbortSignal.timeout(10000),
    });
    if (!detail.ok || !(await detail.json()).ok) throw new Error(`Project detail failed: ${project}`);
  }
  return actual.size;
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
