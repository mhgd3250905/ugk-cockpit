import { createCockpitHttpServer } from '../src/service/http-server.mjs';

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const service = await createCockpitHttpServer({
  dbPath: config.dbPath,
  token: config.token,
  authorizedRoots: config.authorizedRoots,
  host: '127.0.0.1',
  port: 0,
  faultInjector: config.faultPoint
    ? (point) => {
        if (point === config.faultPoint) process.exit(91);
      }
    : undefined,
});
process.stdout.write(`${JSON.stringify({ port: service.port })}\n`);

async function stop() {
  await service.close();
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

