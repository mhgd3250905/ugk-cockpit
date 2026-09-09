import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPluginPackage } from './build-codex-plugin.mjs';

export function buildZcodePlugin(options = {}) { return buildPluginPackage({ ...options, host: 'zcode' }); }

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(buildZcodePlugin({ outputRoot: process.argv[2] }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
