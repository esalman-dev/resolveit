// Demo data: fills the database with about two months of realistic help desk history, so the
// app (and later its dashboard) can be explored without real users.
//
// Everything it makes belongs to accounts on demo.example.com (a domain reserved for examples,
// so it can never be a real address). That's how removeDemoData finds it again: real accounts
// and their tickets are never touched.
//
// The tickets are the ticket reduction study's simulated tickets (eval/study/tickets.json), and
// what the AI said about each one comes from the study's full run, so the Get help history
// shows real AI answers. Technician work (replies, status changes, resolution) is generated
// around the target times per priority, with a few tickets running late.
//
// Used by scripts/seed-demo.js (npm run seed-demo) and the tests.

import bcrypt from 'bcryptjs';

const DEMO_DOMAIN = 'demo.example.com';

/** The three accounts anyone can log in with to try the app. */
export const DEMO_LOGINS = {
  user: { name: 'Demo User', email: `demo.user@${DEMO_DOMAIN}`, role: 'user' },
  technician: { name: 'Demo Technician', email: `demo.tech@${DEMO_DOMAIN}`, role: 'technician' },
  admin: { name: 'Demo Admin', email: `demo.admin@${DEMO_DOMAIN}`, role: 'admin' },
};

const TECHNICIANS = ['Sam Rivera', 'Priya Nair', 'Marcus Chen']; // plus Demo Technician
const USERS = [
  'Jordan Lee', 'Avery Brooks', 'Maria Gomez', 'Daniel Kim', 'Olivia Turner', 'Ethan Walker',
  'Sofia Rossi', 'Liam O\'Connor', 'Hannah Schmidt', 'Noah Patel', 'Grace Okafor', 'Lucas Moreau',
  'Chloe Martin', 'Isaac Cohen', 'Mia Johansson', 'Ryan Murphy', 'Zoe Adams', 'Omar Haddad',
  'Lily Chen', 'Caleb Wright', 'Nora Fischer', 'Jacob Silva', 'Emma Novak',
]; // plus Demo User

// Target times per priority, in hours: first reply, resolved. Must match the defaults of the
// target-times (SLA) feature, so the demo has a realistic mix of on-time and late tickets.
const TARGET_HOURS = {
  urgent: [1, 4],
  high: [4, 24],
  medium: [24, 72],
  low: [48, 168],
};

const HOUR = 60 * 60 * 1000;
const MODEL = 'claude-haiku-5-5';

// --- Random numbers ---

/** A seeded random number generator (mulberry32): the same seed makes the same demo. */
function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random helpers bound to one generator. */
function randomTools(seed) {
  const random = seededRandom(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  /** Picks a key of `weights` ({ a: 3, b: 1 } picks a three times as often as b). */
  const weighted = (weights) => {
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    let roll = random() * total;
    for (const [key, weight] of Object.entries(weights)) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return Object.keys(weights).at(-1);
  };
  /**
   * A duration around `typical` hours, usually shorter, sometimes much longer, like real work.
   * Why this shape: most tickets are handled quickly and a few drag on (a "long tail").
   */
  const duration = (typical) => typical * Math.exp((random() + random() + random() - 1.5) * 1.1);
  return { random, pick, weighted, duration };
}

// --- Words ---

const firstName = (name) => name.split(' ')[0];

const REPLIES = [
  (u) => `Hi ${u}, thanks for the details. I'm looking into this now.`,
  (u) => `Hi ${u}, I've picked this up and will get back to you shortly.`,
  (u) => `Thanks ${u}. Taking a look now, I'll update you here.`,
  (u) => `Hi ${u}, got it. Checking this on our side.`,
];
const USER_FOLLOW_UPS = [
  'Thanks!',
  'Thank you, let me know if you need anything from me.',
  "Thanks, I'm at my desk all afternoon if you need to come by.",
  'Any update on this?',
];
// Review comments by stars; most people leave none.
const REVIEW_COMMENTS = {
  5: ['Quick and friendly, thank you!', 'Fixed in minutes. Great service.', 'Really clear explanation, thanks.', 'Super helpful as always.'],
  4: ['Sorted, thanks. Took a little while.', 'Good help, would have liked an update sooner.', 'All working now.'],
  3: ['Fixed in the end, but I had to chase it.', 'OK, took longer than expected.'],
  2: ['Took days to get a reply.', 'Had to explain the problem twice.'],
  1: ['Waited too long, I fixed it myself in the end.'],
};

// Knowledge base articles for the demo, written like the AI drafts them from resolved tickets.
// The last two are drafts; one has a step the safety check flags, to show the review step.
const DEMO_ARTICLES = [
  { title: 'Outlook says Working Offline', category: 'Email', problem: 'Outlook shows "Working Offline" at the bottom of the window and new emails stop arriving.', steps: [
    { title: 'Turn off Work Offline', detail: 'On the Send / Receive tab, click Work Offline so it is no longer highlighted.' },
    { title: 'Wait a minute for new mail', detail: 'Outlook catches up on its own once it is back online.' },
    { title: 'Restart Outlook', detail: 'If it still says offline, close Outlook completely and open it again.' } ] },
  { title: 'Teams is stuck on the loading screen', category: 'Software', problem: 'Microsoft Teams shows a spinning circle and never opens.', steps: [
    { title: 'Use Teams on the web for now', detail: 'Open teams.microsoft.com in your browser so you can keep working.' },
    { title: 'Quit Teams completely', detail: 'Right-click the Teams icon near the clock, choose Quit, then open Teams again.' },
    { title: 'Restart your computer', detail: 'If it still hangs, save your work and restart.' } ] },
  { title: 'No Wi-Fi networks are showing', category: 'Network', problem: 'The laptop says no Wi-Fi networks are available, though it worked before.', steps: [
    { title: 'Turn off airplane mode', detail: 'Click the network icon near the clock and make sure Airplane mode is off.' },
    { title: 'Turn Wi-Fi on', detail: 'In the same panel, make sure Wi-Fi is switched on.' },
    { title: 'Restart the laptop', detail: 'If networks still do not appear, restart and check again.' } ] },
  { title: "Wi-Fi won't connect after the password changed", category: 'Network', problem: 'The office Wi-Fi password was changed and the laptop no longer connects.', steps: [
    { title: 'Forget the network', detail: 'Open Wi-Fi settings, choose the office network and click Forget.' },
    { title: 'Connect with the new password', detail: 'Pick the office network again and type the new Wi-Fi password.' } ] },
  { title: 'A print job is stuck and nothing prints', category: 'Printer', problem: 'A document has been "printing" for a long time and other jobs are waiting behind it.', steps: [
    { title: 'Open the print queue', detail: 'Go to Settings, Printers & scanners, choose the printer and open the print queue.' },
    { title: 'Cancel the stuck job', detail: 'Right-click the first job in the list and choose Cancel.' },
    { title: 'Print again', detail: 'Send your document to the printer again.' } ] },
  { title: 'A PDF attachment does nothing when clicked', category: 'Software', problem: 'Clicking a PDF in an email does nothing, or Windows asks how to open the file.', steps: [
    { title: 'Open it with Edge', detail: 'Right-click the file, choose Open with, then Microsoft Edge.' },
    { title: 'Make it the default', detail: 'Tick "Always use this app to open .pdf files" so it works next time.' } ] },
  { title: 'Password is "wrong" but you are sure it is right', category: 'Account & Access', problem: 'Signing in says the password is incorrect even though it is typed carefully.', steps: [
    { title: 'Check Caps Lock', detail: 'If the Caps Lock light is on, press Caps Lock and type the password again.' },
    { title: 'Check the keyboard language', detail: 'Look at the language near the clock; press Windows + Space to switch back to your usual one.' },
    { title: 'Use the password reset page', detail: 'If it still fails, use "Forgot password" on the sign-in page.' } ] },
  { title: 'OneDrive shows a pause symbol', category: 'Software', problem: 'The OneDrive icon has a pause symbol and files are not syncing.', steps: [
    { title: 'Resume syncing', detail: 'Click the OneDrive cloud icon near the clock and choose Resume syncing.' },
    { title: 'Plug in your laptop', detail: 'Battery saver can pause syncing again; charging stops that.' } ] },
  { title: 'Second monitor says No signal', category: 'Hardware', problem: 'The external monitor shows "No signal" when the laptop is plugged in.', steps: [
    { title: 'Choose the right input', detail: 'Press the input or source button on the monitor until it finds your laptop.' },
    { title: 'Check the cable at both ends', detail: 'Unplug the video cable and push it back in firmly at the monitor and the laptop.' },
    { title: 'Press Windows + P', detail: 'Choose Extend or Duplicate so Windows sends a picture to the monitor.' } ] },
  { title: 'Authenticator codes are always rejected', category: 'Account & Access', problem: 'Codes from the authenticator app are rejected even when typed quickly.', steps: [
    { title: "Set your phone's time to automatic", detail: 'In the phone settings, turn on automatic date and time.' },
    { title: 'Try a fresh code', detail: 'Wait for a new code in the app and type it straight away.' } ] },
  { title: 'Outlook keeps asking for your password', category: 'Email', status: 'draft', problem: 'After a password change, Outlook asks for the password again and again.', steps: [
    { title: 'Type your new password', detail: 'Enter the new password in the box Outlook shows and tick Remember.' },
    { title: 'Sign out of Office and back in', detail: 'In Outlook, go to File, Office Account, Sign out, then sign in again.' } ] },
  { title: 'Computer is slow to start', category: 'Software', status: 'draft', flagged: true, problem: 'The computer takes a long time to start in the morning.', steps: [
    { title: 'Restart once a week', detail: 'Restarting clears out programs that pile up.' },
    { title: 'Turn off startup apps in the registry', detail: 'Open regedit and remove entries under the Run key.' } ] },
];

const INTERNAL_NOTES = [
  'Seen this twice this week. Worth a knowledge base article.',
  'Checked the logs, nothing unusual on our side.',
  'Waiting on the vendor for this one.',
  'Same thing reported on the 3rd floor, keep an eye on it.',
];

/** The technician's closing comment, from the scenario's real fix. */
const resolution = (scenario) =>
  scenario.route === 'self_fix'
    ? `Sorted: ${scenario.fix} Let us know if it happens again.`
    : `All done on our side. Resolution: ${scenario.fix}`; // the fix reads like a log entry ("IT assigns a license…")

// --- Removing ---

/**
 * Deletes everything that belongs to demo accounts, and the accounts themselves.
 * Real accounts and their tickets are untouched.
 */
export async function removeDemoData(db) {
  const found = await db.query('SELECT id FROM users WHERE email LIKE $1', [`%@${DEMO_DOMAIN}`]);
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  // Order matters: rows that point at demo accounts go before the accounts themselves.
  await db.query('UPDATE tickets SET assigned_to = NULL WHERE assigned_to = ANY($1)', [ids]);
  await db.query('DELETE FROM help_sessions WHERE user_id = ANY($1)', [ids]);
  // Articles a demo account wrote or published go too (their account columns would otherwise just
  // be emptied, leaving ownerless demo articles behind).
  await db.query('DELETE FROM kb_articles WHERE created_by = ANY($1) OR published_by = ANY($1)', [ids]);
  await db.query('DELETE FROM attachments WHERE uploaded_by = ANY($1)', [ids]);
  await db.query('DELETE FROM tickets WHERE created_by = ANY($1)', [ids]); // their history and comments go too
  await db.query('DELETE FROM ticket_events WHERE actor_id = ANY($1)', [ids]);
  await db.query('DELETE FROM ticket_comments WHERE author_id = ANY($1)', [ids]);
  await db.query('DELETE FROM account_events WHERE user_id = ANY($1) OR actor_id = ANY($1)', [ids]);
  await db.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  return ids.length;
}

// --- Making ---

/**
 * Replaces the demo data with a fresh set. Run it inside a transaction.
 *
 * @param db a client inside a transaction (see withTransaction in db/index.js)
 * @param {{ tickets: object[], scenarios: object[], studyResults: object[], password: string,
 *   now?: Date, days?: number, count?: number, seed?: number }} options
 *   tickets, scenarios, studyResults: the study's files; count: how many study tickets to use
 * @returns {Promise<{ users: number, tickets: number, helpSessions: number, comments: number, reviews: number, articles: number }>}
 */
export async function seedDemoData(db, { tickets, scenarios, studyResults, password, now = new Date(), days = 60, count = 320, seed = 2026 }) {
  const { random, pick, weighted, duration } = randomTools(seed);
  await removeDemoData(db);

  // --- Accounts ---
  const passwordHash = await bcrypt.hash(password, 12); // one hash for every demo account
  const accountStart = new Date(now.getTime() - (days + 10) * 24 * HOUR);
  async function addUser(name, role, email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DEMO_DOMAIN}`) {
    const row = await db.query(
      'INSERT INTO users (name, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, name',
      [name, email, passwordHash, role, accountStart]
    );
    return row.rows[0];
  }
  const admin = await addUser(DEMO_LOGINS.admin.name, 'admin', DEMO_LOGINS.admin.email);
  const technicians = [await addUser(DEMO_LOGINS.technician.name, 'technician', DEMO_LOGINS.technician.email)];
  for (const name of TECHNICIANS) technicians.push(await addUser(name, 'technician'));
  const users = [await addUser(DEMO_LOGINS.user.name, 'user', DEMO_LOGINS.user.email)];
  for (const name of USERS) users.push(await addUser(name, 'user'));

  // Some technicians take more of the work than others, like a real team.
  const techWeights = Object.fromEntries(technicians.map((t, i) => [i, [3, 4, 3, 2][i] ?? 2]));
  // The demo user opens more tickets than most, so their "My tickets" isn't empty.
  const userWeights = Object.fromEntries(users.map((u, i) => [i, i === 0 ? 8 : 1 + Math.floor(random() * 3)]));

  const categories = (await db.query('SELECT id, name FROM categories WHERE active')).rows;
  const categoryId = (name) => categories.find((c) => c.name.toLowerCase() === String(name ?? '').toLowerCase())?.id ?? null;
  const scenarioById = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  const resultById = Object.fromEntries(studyResults.map((r) => [r.id, r]));

  // --- When each request was made: weekdays, office hours, a little busier recently ---
  function requestTime() {
    for (;;) {
      const daysAgo = Math.floor(days * Math.pow(random(), 1.15));
      const day = new Date(now.getTime() - daysAgo * 24 * HOUR);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      if (weekend && random() < 0.8) continue; // a few weekend tickets, not many
      day.setHours(8, 0, 0, 0);
      const at = new Date(day.getTime() + (random() + random()) * 5 * HOUR + random() * 30 * 60 * 1000);
      if (at < now) return at;
    }
  }

  const stats = { users: technicians.length + users.length + 1, tickets: 0, helpSessions: 0, comments: 0, reviews: 0 };
  const chosen = [...tickets].sort(() => random() - 0.5).slice(0, count);

  for (const source of chosen) {
    const scenario = scenarioById[source.scenario_id];
    const result = resultById[source.id];
    if (!scenario || !result) continue;
    const user = users[Number(weighted(userWeights))];
    const createdAt = requestTime();
    const suggestedCategory = categoryId(result.suggested_category ?? scenario.app_category);

    // How the request went: the way the study measured it for this ticket.
    let path;
    if (random() < 0.08) path = 'plain'; // AI was unavailable or busy: a plain ticket
    else if (result.escalated) path = 'escalated';
    else if (result.label === 'resolved') path = random() < 0.85 ? 'fixed' : 'still_broken';
    else path = 'still_broken';

    const priority =
      scenario.route === 'risky'
        ? weighted({ urgent: 3, high: 1 })
        : scenario.route === 'technician'
          ? weighted({ low: 2, medium: 6, high: 2 })
          : weighted({ low: 3, medium: 6, high: 1 });
    const minutes = (n) => new Date(createdAt.getTime() + n * 60 * 1000);
    const steps = result.steps ?? [];

    // A fixed request ends here: the AI solved it and no ticket was opened.
    if (path === 'fixed') {
      await addSession({ user, source, result, scenario, createdAt, finishedAt: minutes(4 + random() * 15), outcome: 'fixed', ticketId: null, steps, suggestedCategory, priority });
      continue;
    }

    // --- The ticket ---
    const stepsTried = path === 'still_broken' ? steps.map((s) => ({ ...s, tried: random() < 0.8 })) : [];
    const openedAt = path === 'plain' ? createdAt : minutes(path === 'escalated' ? 0.5 : 5 + random() * 20);
    const [replyTarget, resolveTarget] = TARGET_HOURS[priority];
    const replyAt = new Date(openedAt.getTime() + duration(replyTarget * 0.35) * HOUR);
    const resolveAt = new Date(replyAt.getTime() + duration(resolveTarget * 0.35) * HOUR);
    const tech = technicians[Number(weighted(techWeights))];
    const replied = replyAt < now;
    const resolved = resolveAt < now;
    const status = resolved ? 'resolved' : replied ? 'in_progress' : 'open';
    const lastActivity = resolved ? resolveAt : replied ? replyAt : openedAt;

    const inserted = await db.query(
      `INSERT INTO tickets (title, description, status, priority, category_id, created_by, assigned_to,
                            steps_tried, created_at, updated_at, resolved_at, first_response_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        source.title,
        source.description,
        status,
        priority,
        suggestedCategory,
        user.id,
        replied ? tech.id : null,
        JSON.stringify(stepsTried),
        openedAt,
        lastActivity,
        resolved ? resolveAt : null,
        // The first reply is the status change to In progress, a minute after assigning.
        replied ? new Date(Math.min(replyAt.getTime() + 60 * 1000, now.getTime() - 60 * 1000)) : null,
      ]
    );
    const ticketId = inserted.rows[0].id;
    stats.tickets++;

    if (path !== 'plain') {
      await addSession({ user, source, result, scenario, createdAt, finishedAt: openedAt, outcome: path, ticketId, steps, suggestedCategory, priority });
    }

    // --- Its history and conversation, in time order ---
    const event = (actor, at, field, oldValue, newValue) =>
      db.query(
        `INSERT INTO ticket_events (ticket_id, actor_id, action, field, old_value, new_value, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ticketId, actor.id, field ? 'changed' : 'created', field, oldValue, newValue, at]
      );
    const comment = async (author, at, body, internal = false) => {
      await db.query(
        'INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal, created_at) VALUES ($1, $2, $3, $4, $5)',
        [ticketId, author.id, body, internal, at]
      );
      stats.comments++;
    };
    const after = (at, minutesLater) => new Date(Math.min(at.getTime() + minutesLater * 60 * 1000, now.getTime() - 60 * 1000));

    await event(user, openedAt, null, null, path === 'plain' ? null : 'get_help');
    if (!replied) continue;
    await event(tech, replyAt, 'assignee', null, tech.name);
    await event(tech, after(replyAt, 1), 'status', 'open', 'in_progress');
    await comment(tech, after(replyAt, 2), pick(REPLIES)(firstName(user.name)));
    if (random() < 0.35) await comment(user, after(replyAt, 20 + random() * 120), pick(USER_FOLLOW_UPS));
    if (random() < 0.15) await comment(tech, after(replyAt, 30 + random() * 60), pick(INTERNAL_NOTES), true);
    if (!resolved) continue;
    await comment(tech, resolveAt, resolution(scenario));
    await event(tech, after(resolveAt, 0.5), 'status', 'in_progress', 'resolved');

    // About half of people leave a review, mostly good; a ticket that ran late scores lower.
    const reviewedAt = new Date(resolveAt.getTime() + (0.2 + random() * 30) * HOUR);
    if (random() < 0.55 && reviewedAt < now) {
      const late = resolveAt - openedAt > resolveTarget * HOUR;
      const stars = Number(late ? weighted({ 5: 2, 4: 3, 3: 3, 2: 2, 1: 1 }) : weighted({ 5: 14, 4: 6, 3: 2, 2: 0.6, 1: 0.3 }));
      await db.query(
        `INSERT INTO ticket_ratings (ticket_id, rated_by, technician_id, stars, comment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [ticketId, user.id, tech.id, stars, random() < 0.45 ? pick(REVIEW_COMMENTS[stars]) : null, reviewedAt]
      );
      stats.reviews++;
    }
  }

  /** Saves the Get help request behind a ticket (or one the AI fixed). */
  async function addSession({ user, source, result, scenario, createdAt, finishedAt, outcome, ticketId, steps, suggestedCategory, priority }) {
    await db.query(
      `INSERT INTO help_sessions (user_id, kind, title, description, steps, escalate_reason, suggested_category_id,
                                  suggested_priority, outcome, ticket_id, model, input_tokens, output_tokens,
                                  created_at, finished_at)
       VALUES ($1, 'fix', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        user.id,
        source.title,
        source.description,
        JSON.stringify(outcome === 'escalated' ? [] : steps),
        outcome === 'escalated' ? (result.reason ?? `Needs a technician: ${scenario.why ?? 'not something a user can fix'}`) : null,
        suggestedCategory,
        priority,
        outcome,
        ticketId,
        MODEL,
        result.answer_usage?.input_tokens ?? null,
        result.answer_usage?.output_tokens ?? null,
        createdAt,
        finishedAt,
      ]
    );
    stats.helpSessions++;
  }

  // --- Knowledge base: published how-tos, plus two drafts waiting for review ---
  for (const [i, a] of DEMO_ARTICLES.entries()) {
    const author = technicians[i % technicians.length];
    const publishedAt = new Date(now.getTime() - (days - 5 - i * 3) * 24 * HOUR);
    await db.query(
      `INSERT INTO kb_articles (title, problem, steps, category_id, status, flagged, created_by, published_by,
                                helpful_count, not_helpful_count, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $10, $11)`,
      [
        a.title,
        a.problem,
        JSON.stringify(a.steps),
        categoryId(a.category),
        a.status ?? 'published',
        a.flagged ?? false,
        author.id,
        a.status === 'draft' ? 0 : 3 + Math.floor(random() * 25),
        a.status === 'draft' ? 0 : Math.floor(random() * 4),
        publishedAt,
        a.status === 'draft' ? null : publishedAt,
      ]
    );
  }
  // Note: published_by is set on drafts above only to tie them to a demo account for removal;
  // it's cleared here so drafts read as unpublished.
  await db.query("UPDATE kb_articles SET published_by = NULL WHERE status = 'draft' AND created_by = ANY($1)", [technicians.map((t) => t.id)]);
  stats.articles = DEMO_ARTICLES.length;

  // The demo admin's own history line, so the Users screen's history isn't empty.
  await db.query(
    "INSERT INTO account_events (user_id, actor_id, action, old_value, new_value, created_at) VALUES ($1, NULL, 'role_changed', 'user', 'admin', $2)",
    [admin.id, accountStart]
  );
  return stats;
}
