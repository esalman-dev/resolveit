// Run log: adds one row per paid AI run to eval/RUNS.md, the committed record of every test.
//
// Why: result files show what one run did; the log shows how the numbers changed from run to
// run, what was changed in between, and what all of it cost. Each script adds its own row, so
// the log can't drift from what actually ran.

import fs from 'node:fs';

const LOG = new URL('./RUNS.md', import.meta.url);

const HEADER = `# AI test runs

Every paid run of the AI test scripts, oldest first. Each row is added by the script that ran.
Full results are in the linked file. Costs are estimates from token counts and list prices.

| When (UTC) | Script | What changed / why | Results | Cost | Result file |
|---|---|---|---|---|---|
`;

/** Makes text safe for one table cell. */
const cell = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * Adds one row to the run log, creating the file with its header the first time.
 * @param {{ script: string, note?: string, results: string, cost: number|null, file?: string }} run
 */
export function logRun({ script, note, results, cost, file }) {
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, HEADER);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const dollars = cost === null || cost === undefined ? 'unknown' : `$${cost.toFixed(3)}`;
  const link = file ? `[${file.split('/').pop()}](${file})` : '';
  const row = [when, script, note || '(no note)', results, dollars, link].map(cell).join(' | ');
  fs.appendFileSync(LOG, `| ${row} |\n`);
}
