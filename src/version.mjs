import { readFileSync } from 'node:fs';

export const VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

