import { acquireInstanceLock } from '../src/core/single-instance.mjs';

const [lockPath, holdValue] = process.argv.slice(2);
try {
  const lock = acquireInstanceLock(lockPath);
  process.stdout.write('acquired\n');
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, Number(holdValue));
} catch (error) {
  process.stdout.write(`${error.code ?? 'error'}\n`);
  process.exit(error.code === 'INSTANCE_ALREADY_RUNNING' ? 2 : 3);
}

