import { openCockpitDatabase } from '../src/core/database.mjs';
import { beginCommand } from '../src/core/command-journal.mjs';
import {
  finishRun,
  heartbeatWriteRun,
  prepareFinish,
  startWriteRun,
} from '../src/core/runs.mjs';

const request = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'));
const db = openCockpitDatabase(process.argv[2], { migrate: false });

async function retryDatabaseBusy(operation) {
  // The connection's busy_timeout is 150ms by design, and 100-way write
  // contention on a slow CI disk can hold BEGIN IMMEDIATE well past the ~1s
  // a small retry budget tolerates. The worker exists to check who wins the
  // election, not how fast the disk is, so stay patient: SQLITE_BUSY is
  // retried for up to 300 attempts with the sleep capped at 50ms.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (error?.errcode !== 5 || attempt >= 299) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, 5 + attempt)));
    }
  }
}

try {
  let result;
  if (request.action === 'start') {
    result = await retryDatabaseBusy(() => startWriteRun(db, request.payload));
  } else if (request.action === 'finish') {
    result = await retryDatabaseBusy(() => finishRun(db, request.payload));
  } else if (request.action === 'heartbeat') {
    result = await retryDatabaseBusy(() => heartbeatWriteRun(db, request.payload));
  }
  else if (request.action === 'crash-after-start-journal') {
    beginCommand(db, {
      commandId: request.payload.commandId,
      kind: 'run.start',
      request: request.payload,
      runId: request.payload.runId,
    });
    process.exit(91);
  } else if (request.action === 'crash-after-finish-observing') {
    prepareFinish(db, request.payload);
    process.exit(91);
  } else if (request.action === 'crash-start-at') {
    startWriteRun(db, request.payload.request, {
      faultInjector(point) {
        if (point === request.payload.faultPoint) process.exit(91);
      },
    });
  } else if (request.action === 'crash-finish-at') {
    finishRun(db, request.payload.request, {
      faultInjector(point) {
        if (point === request.payload.faultPoint) process.exit(91);
      },
    });
  } else throw new Error(`Unknown worker action: ${request.action}`);
  process.stdout.write(JSON.stringify(result));
} finally {
  db.close();
}
