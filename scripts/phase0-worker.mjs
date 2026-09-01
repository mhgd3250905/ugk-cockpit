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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (error?.errcode !== 5 || attempt === 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt));
    }
  }
  throw new Error('unreachable');
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
