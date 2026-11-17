// Scenario check: confirms scenarios.json is complete before any tickets are generated.
//
// Checks that every scenario has the fields the grader needs, that the ticket mix adds up to
// the stated total, and that every part of the mix with tickets has at least one scenario to
// draw them from. Free to run: it reads files only and never calls the AI.
//
// Usage (from server/):
//   node eval/study/check-scenarios.js

import fs from 'node:fs';

const ROUTES = ['self_fix', 'technician', 'risky'];
const APP_CATEGORIES = ['Network', 'Hardware', 'Software', 'Printer', 'Email', 'Account & Access', 'Other'];
const REQUIRED = ['id', 'category', 'route', 'app_category', 'hidden_cause', 'user_notices', 'fix'];

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const { mix, scenarios } = readJson('./scenarios.json');
const evalIds = new Set(readJson('../problems.json').map((p) => p.id));

const errors = [];
const seen = new Set();

// --- Each scenario ---

for (const s of scenarios) {
  const name = s.id ?? '(no id)';
  for (const field of REQUIRED) {
    if (typeof s[field] !== 'string' || !s[field].trim()) errors.push(`${name}: missing ${field}`);
  }
  if (seen.has(s.id)) errors.push(`${name}: duplicate id`);
  seen.add(s.id);
  if (!ROUTES.includes(s.route)) errors.push(`${name}: unknown route "${s.route}"`);
  if (!mix.tickets[s.category]) errors.push(`${name}: category "${s.category}" is not in the mix`);
  if (!APP_CATEGORIES.includes(s.app_category)) errors.push(`${name}: unknown app_category "${s.app_category}"`);
  // Why: the grader uses "why" to tell a needed escalation from an unnecessary one.
  if (s.route !== 'self_fix' && !s.why) errors.push(`${name}: technician and risky scenarios need "why"`);
  if (s.from_eval && !evalIds.has(s.from_eval)) errors.push(`${name}: from_eval "${s.from_eval}" not in problems.json`);
}

// --- The mix ---

let total = 0;
const rows = [];
for (const [category, routes] of Object.entries(mix.tickets)) {
  for (const route of ROUTES) {
    const tickets = routes[route] ?? 0;
    const count = scenarios.filter((s) => s.category === category && s.route === route).length;
    total += tickets;
    if (tickets > 0 && count === 0) errors.push(`${category}/${route}: ${tickets} tickets but no scenarios`);
    if (tickets === 0 && count > 0) errors.push(`${category}/${route}: ${count} scenarios but 0 tickets in the mix`);
    if (tickets > 0) rows.push({ category, route, tickets, scenarios: count, per_scenario: (tickets / count).toFixed(1) });
  }
}
if (total !== mix.total) errors.push(`mix adds up to ${total}, expected ${mix.total}`);

// --- Report ---

console.table(rows);
const byRoute = Object.fromEntries(
  ROUTES.map((route) => [route, rows.filter((r) => r.route === route).reduce((sum, r) => sum + r.tickets, 0)])
);
console.log(`${scenarios.length} scenarios, ${total} tickets:`, byRoute);
console.log(`Self-fixable ceiling: ${((byRoute.self_fix / total) * 100).toFixed(1)}%`);
console.log(`Folded in from the 64-problem test set: ${scenarios.filter((s) => s.from_eval).length}`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
