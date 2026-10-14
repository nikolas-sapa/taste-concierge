import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Node's native type stripping requires the explicit TypeScript extension.
import { buildBlockedSummary } from './runner.ts';

const summary = buildBlockedSummary();
const output = new URL('./public-summary.json', import.meta.url);
writeFileSync(fileURLToPath(output), `${JSON.stringify(summary, null, 2)}\n`);
console.log('Evaluation preflight: 0/7 targets executed; all blocked pending evidence.');
