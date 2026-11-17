// Ticket generator: writes the study's 500 simulated help desk tickets, once, from scenarios.json.
//
// Each scenario gets its share of its cell's tickets (spread evenly, leftovers to the first
// scenarios in file order). Every ticket is given a writing style (length, tone, spelling, and
// one realistic flaw such as a wrong guess about the cause), picked by a seeded random number
// generator so the plan is the same on every run. A model then writes the tickets in those
// styles, seeing what the user notices and the hidden cause, but told never to reveal the cause.
//
// The result, tickets.json, is frozen: it's committed to the repo and every study run uses the
// same tickets. This script refuses to overwrite it unless --force is given.
//
// This calls the real AI and costs money, so it shows an estimate and needs --yes to send.
//
// Usage (from server/):
//   node eval/study/generate-tickets.js              plan and cost estimate only
//   node eval/study/generate-tickets.js --yes        generate and save tickets.json
// Options: --model (default claude-haiku-5-5), --concurrency (default 4), --force,
// --note (why the tickets were made, for the run log in eval/RUNS.md).

import 'dotenv/config';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { MAX_TITLE, MAX_DESCRIPTION } from '../../routes/tickets.js';
import { logRun } from '../runLog.js';

// Note: this is also the model that answers in the app. A different model (--model) would avoid
// grading the app's model on text written in its own style; the study reports which one was used.
const DEFAULT_MODEL = 'claude-haiku-5-5';

// Models that accept server-side fallback (another model finishes a request this one declines).
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const SEED = 2026;

// Price per million tokens (input, output), for the cost estimate.
// Note: check the provider's price page before relying on these numbers.
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

// The style dimensions. Every ticket gets one value from each list.
const STYLES = {
  length: [
    'very short: a title and one sentence',
    'short: two or three sentences',
    'longer: four to six sentences, including a detail that does not matter',
  ],
  tone: ['calm and polite', 'frustrated', 'in a hurry', 'unsure and not technical'],
  writing: ['clean spelling', 'a few typos and missing capital letters', 'one long run-on sentence'],
  flaw: [
    'none',
    'guesses the wrong cause',
    'leaves out one useful detail',
    'mentions something they already tried that did not help',
  ],
};

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' } },
        required: ['n', 'title', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['tickets'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You write realistic IT help desk tickets for a test set. Each ticket is written by an ordinary office employee, in the first person, in a company's "Get help" form: a short title and a description.

You are given one scenario: what the employee notices, and the hidden cause. The employee does not know the hidden cause. Never state it, hint at the fix, or use wording only an IT person would use. Describe only what they see, hear, or want, in their own words. Keep every detail consistent with the hidden cause.

Write exactly one ticket per numbered style, and set "n" to that style's number. Each ticket must follow its style. A flaw changes how the ticket is written, never the facts. A wrong guess is only the employee's opinion about the cause. Never add facts that would change who should handle the ticket: other people having the same problem, a suspicious email, link or pop-up, damage, lost files, or a security worry.

Make the tickets differ from each other in wording and in small details (time of day, which app, what they were doing), as if different people wrote them. No names of people or companies, email addresses, or phone numbers.`;

// --- Settings from the command line ---

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);
const model = args.model || DEFAULT_MODEL;
// Why: models miscount long lists, so each request asks for a few tickets at most.
const BATCH_SIZE = 5;
const concurrency = Number(args.concurrency ?? 4);
const outFile = new URL('./tickets.json', import.meta.url);

// --- Helpers ---

/** Returns a seeded random number generator (mulberry32): same seed, same numbers. */
function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seededRandom(SEED);
const pick = (list) => list[Math.floor(random() * list.length)];

/** Shuffles a copy of the list with the seeded generator (Fisher–Yates). */
function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- The plan: how many tickets each scenario gets, and their styles ---

const { mix, scenarios } = JSON.parse(fs.readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));

const plan = [];
for (const [category, routes] of Object.entries(mix.tickets)) {
  for (const [route, tickets] of Object.entries(routes)) {
    const group = scenarios.filter((s) => s.category === category && s.route === route);
    group.forEach((scenario, i) => {
      const count = Math.floor(tickets / group.length) + (i < tickets % group.length ? 1 : 0);
      const styles = Array.from({ length: count }, () =>
        Object.fromEntries(Object.entries(STYLES).map(([key, values]) => [key, pick(values)]))
      );
      if (count > 0) plan.push({ scenario, styles });
    });
  }
}
const total = plan.reduce((sum, job) => sum + job.styles.length, 0);
const requests = plan.reduce((sum, job) => sum + Math.ceil(job.styles.length / BATCH_SIZE), 0);

// --- Cost check before anything is sent ---

const [inPrice, outPrice] = PRICES[model] ?? [null, null];
// Rough guess per request: ~900 tokens in, ~400 thinking plus ~150 per ticket out.
const estimate =
  inPrice === null ? null : (requests * (900 * inPrice + 400 * outPrice) + total * 150 * outPrice) / 1e6;
console.log(`Model: ${model}`);
console.log(`Scenarios: ${plan.length} · tickets: ${total} · requests: ${requests}`);
console.log(`Estimated cost: ${estimate === null ? 'unknown (no price for this model)' : `about $${estimate.toFixed(2)}`}`);
if (total !== mix.total) {
  console.error(`\nThe plan has ${total} tickets but the mix says ${mix.total}. Run check-scenarios.js.`);
  process.exit(1);
}
if (fs.existsSync(outFile) && !args.force) {
  console.error('\ntickets.json already exists and is frozen. Add --force to replace it.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nANTHROPIC_API_KEY is not set in server/.env. Nothing was sent.');
  process.exit(1);
}
if (!args.yes) {
  console.log('\nNothing was sent. Add --yes to run it.');
  process.exit(0);
}

// --- Generating ---

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
const usage = { input_tokens: 0, output_tokens: 0 };

/** Builds the request text for one batch of a scenario's tickets. */
function buildMessage(scenario, styles, earlierTitles) {
  return [
    `Category: ${scenario.category.replace(/_/g, ' ')}`,
    `What the employee notices or wants: ${scenario.user_notices}`,
    `Hidden cause (the employee does not know this): ${scenario.hidden_cause}`,
    ...(earlierTitles.length
      ? ['', `Other people already wrote these titles; use different wording: ${earlierTitles.join(' | ')}`]
      : []),
    '',
    `Write ${styles.length} ticket(s), one per style:`,
    ...styles.map(
      (s, i) => `${i + 1}. Length: ${s.length}. Tone: ${s.tone}. Writing: ${s.writing}. Flaw: ${s.flaw}.`
    ),
  ].join('\n');
}

/** Writes all of one scenario's tickets, a batch at a time, in style order. */
async function generate(job) {
  const tickets = [];
  let writtenBy;
  for (let start = 0; start < job.styles.length; start += BATCH_SIZE) {
    const styles = job.styles.slice(start, start + BATCH_SIZE);
    const batch = await generateBatch(job.scenario, styles, tickets.map((t) => t.title));
    tickets.push(...batch.tickets);
    writtenBy = batch.model;
  }
  return { tickets, model: writtenBy };
}

/** Asks the model for one batch; retries once if the answer is unusable. */
async function generateBatch(scenario, styles, earlierTitles) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Why: where available, server-side fallback lets another model finish the request if this
    // one declines, which matters for the security scenarios (phishing, ransomware) in the set.
    const fallback = FALLBACK_MODELS.includes(model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : {};
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...fallback,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TICKET_SCHEMA } },
      messages: [{ role: 'user', content: buildMessage(scenario, styles, earlierTitles) }],
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    if (response.stop_reason === 'refusal') throw new Error(`${scenario.id}: the model declined`);

    const text = response.content.find((block) => block.type === 'text')?.text;
    const written = JSON.parse(text ?? '{}').tickets ?? [];
    // Note: tickets are matched to styles by their number, so each keeps the style it was given.
    const tickets = styles.map((_, i) => written.find((t) => t.n === i + 1));
    const usable = tickets.every(
      (t) => t && t.title.trim() && t.description.trim() && t.title.length <= MAX_TITLE && t.description.length <= MAX_DESCRIPTION
    );
    if (usable) return { tickets, model: response.model };
    console.warn(`\n${scenario.id}: answer didn't match the ${styles.length} styles asked for, retrying`);
  }
  throw new Error(`${scenario.id}: no usable answer after 2 tries`);
}

/** Runs the jobs a few at a time, printing a dot per scenario. */
async function runAll() {
  const results = new Array(plan.length);
  let next = 0;
  async function worker() {
    while (next < plan.length) {
      const index = next++;
      results[index] = await generate(plan[index]);
      process.stdout.write('.');
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

const started = Date.now();
const results = await runAll();

// Note: the order is shuffled so tickets from one category aren't next to each other, and ids
// are given after the shuffle so an id says nothing about the category or route.
const tickets = shuffle(
  plan.flatMap((job, i) =>
    results[i].tickets.map((t, j) => ({
      scenario_id: job.scenario.id,
      category: job.scenario.category,
      route: job.scenario.route,
      style: job.styles[j],
      written_by: results[i].model,
      title: t.title.trim(),
      description: t.description.trim(),
    }))
  )
).map((t, i) => ({ id: `t${String(i + 1).padStart(3, '0')}`, ...t }));

const cost = inPrice === null ? null : (usage.input_tokens * inPrice + usage.output_tokens * outPrice) / 1e6;
const output = {
  generated: {
    date: new Date().toISOString().slice(0, 10),
    model,
    seed: SEED,
    seconds: Math.round((Date.now() - started) / 1000),
    usage,
    cost_usd: cost === null ? null : Number(cost.toFixed(4)),
  },
  tickets,
};
fs.writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`\nSaved ${tickets.length} tickets to eval/study/tickets.json.`);
console.log(`Tokens: ${usage.input_tokens} in, ${usage.output_tokens} out · cost: ${cost === null ? 'unknown' : `$${cost.toFixed(2)}`}`);
logRun({
  script: 'generate-tickets',
  note: args.note,
  results: `${tickets.length} tickets written by ${model} (seed ${SEED})`,
  cost,
  file: 'study/tickets.json',
});
