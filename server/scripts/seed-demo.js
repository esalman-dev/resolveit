// seed-demo script: replaces the demo data with a fresh two months of help desk history.
//
// Usage (from the server folder):
//   npm run seed-demo                 shows what it would do; changes nothing
//   npm run seed-demo -- --yes        replaces the demo data
//   npm run seed-demo -- --remove     deletes the demo data and demo accounts only
//
// Only accounts on demo.example.com and what they own are deleted or created; real accounts
// and their tickets are never touched (see scripts/demoData.js). The demo logins use
// DEMO_PASSWORD from .env, or a default that's fine for a local copy.

import fs from 'node:fs';
import pool, { withTransaction } from '../db/index.js';
import { DEMO_LOGINS, removeDemoData, seedDemoData } from './demoData.js';

const args = new Set(process.argv.slice(2));
const password = process.env.DEMO_PASSWORD || 'try-resolveit-demo';
const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

try {
  if (args.has('--remove')) {
    const removed = await withTransaction((db) => removeDemoData(db));
    console.log(`Removed ${removed} demo accounts and everything they owned.`);
  } else if (!args.has('--yes')) {
    console.log('This replaces the demo data: about 30 demo accounts and two months of tickets, all on demo.example.com.');
    console.log('Real accounts and their tickets are not touched.\n\nNothing was changed. Add --yes to run it.');
  } else {
    const study = readJson('../eval/study/results/study-2026-11-17T19-07-22.json'); // the full 500-ticket run
    const stats = await withTransaction((db) =>
      seedDemoData(db, {
        tickets: readJson('../eval/study/tickets.json').tickets,
        scenarios: readJson('../eval/study/scenarios.json').scenarios,
        studyResults: study.results,
        password,
      })
    );
    console.log(`Demo data ready: ${stats.users} accounts, ${stats.tickets} tickets, ${stats.helpSessions} Get help requests, ${stats.comments} comments, ${stats.reviews} reviews, ${stats.articles} knowledge base articles.\n`);
    console.log('Log in as:');
    for (const login of Object.values(DEMO_LOGINS)) console.log(`  ${login.name.padEnd(16)} ${login.email}`);
    console.log(`Password: ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD from .env)' : password}`);
  }
} finally {
  await pool.end();
}
