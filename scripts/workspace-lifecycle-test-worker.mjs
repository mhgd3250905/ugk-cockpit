// Isolated regression worker: never starts the installed service.
import { appendFileSync } from 'node:fs';
import { openCockpitDatabase } from '../src/core/database.mjs';
import { removeDevelopmentWorkspace, reuseDevelopmentWorkspace } from '../src/core/workspaces.mjs';
import { removeGitWorktree, switchGitWorktreeToNewBranch } from '../src/git/workspace-ops.mjs';
import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString());
if (config.http) {
  const service = await createCockpitHttpServer({
    dbPath: config.dbPath, token: 'isolated-workspace-recovery-token', host: '127.0.0.1', port: 0,
    authorizedRoots: [config.repo],
    faultInjector: (point) => {
      if (point !== `workspace.${config.kind}.after_git_before_finalize`) return;
      appendFileSync(config.effectsPath, `${config.kind}\n`);
      if (config.crash) process.kill(process.pid, 'SIGKILL');
    },
  });
  process.send({ phase: 'ready', port: service.port });
} else {
  const db = openCockpitDatabase(config.dbPath);
  const afterEffect = async (operation, ...args) => {
    await operation(...args);
    appendFileSync(config.effectsPath, `${config.kind}\n`);
    if (config.crash) {
      process.send({ phase: 'git-complete' });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  };
  try {
    const operation = config.kind === 'remove' ? removeDevelopmentWorkspace : reuseDevelopmentWorkspace;
    const result = await operation(db, config.request, {
      removeGitWorktree: (...args) => afterEffect(removeGitWorktree, ...args),
      switchGitWorktreeToNewBranch: (...args) => afterEffect(switchGitWorktreeToNewBranch, ...args),
    });
    process.send({ phase: 'result', result });
  } catch (error) {
    process.send({ phase: 'error', message: error.stack });
    process.exitCode = 1;
  } finally {
    db.close();
    process.disconnect();
  }
}
