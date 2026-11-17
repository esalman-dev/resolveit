// Guardrails: the server's own safety check on every AI answer.
//
// The AI is told the rules, but it can make mistakes or be talked into breaking them. This file
// doesn't trust it: it reads every step the AI suggests, and if any step touches a blocked topic,
// the steps are thrown away and the problem goes to a technician instead. It also cleans up the
// answer (order, lengths, step count, category, priority) so the rest of the server gets a known
// shape.

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const MAX_STEPS = 7;
const MAX_STEP_TITLE = 120;
const MAX_STEP_DETAIL = 600;
const MAX_REASON = 500;

/**
 * Topics that are never self-service. A step whose text matches a pattern is blocked.
 *
 * Why: word lists can't understand meaning, so they are deliberately broad. A false alarm only
 * sends someone to a technician; a miss could tell them to edit the registry.
 * `unless` removes allowed phrases before checking: the password reset page, and the Wi-Fi
 * password, which rejoining a network (an allowed step) always needs.
 */
const BLOCKED_TOPICS = [
  { topic: 'registry edits', pattern: /\b(regedit|registry)\b/ },
  { topic: 'BIOS, UEFI or firmware', pattern: /\b(bios|uefi|firmware)\b/ },
  { topic: 'Group Policy', pattern: /\b(group policy|gpedit)\b/ },
  {
    topic: 'command-line tools',
    pattern: /\b(command prompt|command line|cmd|powershell|terminal|sudo|ipconfig|netsh|sfc|dism|chkdsk|diskpart)\b/,
  },
  { topic: 'administrator rights', pattern: /\b(administrator|admin (rights|privileges|account|password)|run as admin)/ },
  {
    topic: 'deleting, formatting or resetting',
    pattern:
      /\b(delete|deleting|erase|erasing|wipe|wiping|format|formatting|reinstall|reinstalling|uninstall|uninstalling|factory reset|reset this pc|system restore)\b/,
  },
  {
    topic: 'turning off security settings',
    pattern:
      /\b(disable|disabling|turn off|turning off|switch off|deactivate|pause)\b[^.]{0,40}\b(antivirus|anti-virus|firewall|defender|security|smartscreen|uac)\b/,
  },
  {
    topic: 'working inside the computer',
    // "Reseat" only counts for parts inside the computer: reseating a cable is a safe step.
    pattern:
      /\b(open (up )?(the )?(computer |pc |laptop |desktop )?(case|chassis)|motherboard|screwdriver|reseat(ing)?\b[^.]{0,30}\b(ram|memory|graphics card|video card|gpu|hard drive|ssd|cpu|expansion card))\b/,
  },
  {
    topic: 'passwords',
    pattern: /\bpasswords?\b/,
    unless: /\b(password reset page|(wi-?fi|wireless|network) password)\b/g,
  },
];

/**
 * Returns the first blocked topic the text touches, or null if it's clear.
 *
 * @example
 * findBlockedTopic('Open regedit and ...') // 'registry edits'
 * findBlockedTopic('Restart the router')   // null
 */
export function findBlockedTopic(text, { skip = [] } = {}) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, ' ');
  for (const { topic, pattern, unless } of BLOCKED_TOPICS) {
    if (skip.includes(topic)) continue;
    const checked = unless ? normalized.replace(unless, '') : normalized;
    if (pattern.test(checked)) return topic;
  }
  return null;
}

/** Trims a value to a string of at most `max` characters ('' for anything that isn't a string). */
function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Turns the AI's raw answer into the decision the server acts on.
 *
 * Escalates when the AI asked to, when it gave no usable steps, or when any step touches a
 * blocked topic. `overridden` is true when the server escalated against the AI's answer, which
 * the test set uses to score the AI on its own. `blocked` holds the steps a blocked-topic check
 * threw away, saved for staff so false alarms can be spotted (never shown to users).
 *
 * @param {object} raw the AI's answer: { escalate, reason, steps, suggested_category, suggested_priority }
 * @param {{ categories: Array<{ id: number, name: string }> }} options the active categories
 * @returns {{ escalate: boolean, reason: string|null, steps: Array<{ title: string, detail: string }>,
 *   suggested_category_id: number|null, suggested_priority: string, overridden: boolean,
 *   blocked: Array<{ title: string, detail: string }> }}
 */
export function reviewSuggestion(raw, { categories = [] } = {}) {
  const answer = raw && typeof raw === 'object' ? raw : {};

  const suggested_priority = PRIORITIES.includes(answer.suggested_priority) ? answer.suggested_priority : 'medium';
  const wanted = cleanText(answer.suggested_category, 100).toLowerCase();
  const match = categories.find((c) => c.name.toLowerCase() === wanted);
  const suggested_category_id = match ? match.id : null; // a name we don't have is dropped, not created

  const escalateWith = (reason, overridden, blocked = []) => ({
    escalate: true,
    reason,
    steps: [],
    suggested_category_id,
    suggested_priority,
    overridden,
    blocked,
  });

  if (answer.escalate === true) {
    return escalateWith(cleanText(answer.reason, MAX_REASON) || 'The assistant said this needs a technician.', false);
  }

  // Easiest first, enforced here rather than trusted to the AI: sorted by its effort rating
  // (1 = a few seconds … 4 = restart the computer), keeping its order within the same rating.
  // A missing or odd rating counts as 3, so it can't jump ahead of the quick checks.
  const steps = (Array.isArray(answer.steps) ? answer.steps : [])
    .map((step, index) => ({
      title: cleanText(step?.title, MAX_STEP_TITLE),
      detail: cleanText(step?.detail, MAX_STEP_DETAIL),
      effort: [1, 2, 3, 4].includes(step?.effort) ? step.effort : 3,
      index,
    }))
    .filter((step) => step.title)
    .sort((a, b) => a.effort - b.effort || a.index - b.index)
    .slice(0, MAX_STEPS) // keeps the easiest ones if there are too many
    .map(({ title, detail }) => ({ title, detail }));

  if (steps.length === 0) {
    return escalateWith('No safe steps were found for this problem.', true);
  }

  // Security: check every step, title and detail, before anyone sees it.
  for (const step of steps) {
    const topic = findBlockedTopic(`${step.title} ${step.detail}`);
    if (topic) return escalateWith(`A suggested step involved ${topic}, which needs a technician.`, true, steps);
  }

  return { escalate: false, reason: null, steps, suggested_category_id, suggested_priority, overridden: false, blocked: [] };
}

// --- Ask IT answers ---

const MAX_ANSWER = 2000;
const NEEDS_TECHNICIAN_ANSWER = 'This needs a technician. Use Get help to open a ticket, and IT will take it from here.';

/**
 * Turns the AI's answer to an Ask IT question into what the user sees.
 *
 * The answer text is checked like steps are, except for the password topic. Why: answers to
 * real questions mention passwords innocently ("use a strong password"), and the Ask IT
 * instructions already forbid asking for or sharing one. A blocked or "needs a technician"
 * answer is replaced with a standard message; the AI's text is kept in `blocked` for staff.
 *
 * @returns {{ answer: string, needsTechnician: boolean, reason: string|null, blocked: string|null }}
 */
export function reviewAnswer(raw) {
  const answer = raw && typeof raw === 'object' ? raw : {};
  const text = cleanText(answer.answer, MAX_ANSWER);

  if (answer.needs_technician === true) {
    const reason = cleanText(answer.reason, MAX_REASON) || 'The assistant said this needs a technician.';
    return { answer: NEEDS_TECHNICIAN_ANSWER, needsTechnician: true, reason, blocked: null };
  }
  if (!text) {
    return { answer: NEEDS_TECHNICIAN_ANSWER, needsTechnician: true, reason: 'No answer was found for this question.', blocked: null };
  }

  // Security: the server's own check, whatever the AI said.
  const topic = findBlockedTopic(text, { skip: ['passwords'] });
  if (topic) {
    return {
      answer: NEEDS_TECHNICIAN_ANSWER,
      needsTechnician: true,
      reason: `The answer involved ${topic}, which needs a technician.`,
      blocked: text,
    };
  }
  return { answer: text, needsTechnician: false, reason: null, blocked: null };
}
