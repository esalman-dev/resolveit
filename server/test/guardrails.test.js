// Tests for the server-side guardrail check (services/guardrails.js).
//
// Plain function tests, no database or HTTP: the check must catch risky steps whatever the AI
// says, and turn any answer into a clean, known shape.

import { describe, it, expect } from 'vitest';
import { findBlockedTopic, reviewAnswer, reviewSuggestion, MAX_STEPS } from '../services/guardrails.js';

const categories = [
  { id: 1, name: 'Network' },
  { id: 2, name: 'Printer' },
];

/** An answer with safe steps; `fields` overrides any part. */
const safeAnswer = (fields = {}) => ({
  escalate: false,
  reason: '',
  steps: [
    { title: 'Restart the router', detail: 'Unplug it, wait 30 seconds, and plug it back in.' },
    { title: 'Forget and rejoin the network', detail: 'Open Wi-Fi settings, forget the network, then connect again.' },
  ],
  suggested_category: 'Network',
  suggested_priority: 'medium',
  ...fields,
});

/** An answer whose second step is `title`/`detail`. */
const answerWithStep = (title, detail = '') =>
  safeAnswer({ steps: [{ title: 'Restart the computer', detail: 'Save your work first.' }, { title, detail }] });

describe('findBlockedTopic', () => {
  it.each([
    ['Open regedit and change the value', 'registry edits'],
    ['Edit the Windows Registry', 'registry edits'],
    ['Restart and press F2 to enter the BIOS', 'BIOS, UEFI or firmware'],
    ['Update the printer firmware', 'BIOS, UEFI or firmware'],
    ['Open gpedit.msc', 'Group Policy'],
    ['Open Command Prompt and run ipconfig /release', 'command-line tools'],
    ['Run this in PowerShell', 'command-line tools'],
    ['Run sfc /scannow', 'command-line tools'],
    ['Log in with an administrator account', 'administrator rights'],
    ['Delete the temp folder', 'deleting, formatting or resetting'],
    ['Format the USB drive', 'deleting, formatting or resetting'],
    ['Reinstall Windows', 'deleting, formatting or resetting'],
    ['Do a factory reset', 'deleting, formatting or resetting'],
    ['Temporarily turn off Windows Defender', 'turning off security settings'],
    ['Disable your antivirus for a minute', 'turning off security settings'],
    ['Open the case and reseat the RAM', 'working inside the computer'],
    ['Reseat the graphics card', 'working inside the computer'],
    ['Try reseating the memory modules', 'working inside the computer'],
    ['Type your password into the box', 'passwords'],
  ])('blocks "%s" (%s)', (text, topic) => {
    expect(findBlockedTopic(text)).toBe(topic);
  });

  it.each([
    'Restart the router',
    'Clear the browser cache',
    'Check that the printer has paper and toner',
    'Unplug the USB mouse and plug it back in',
    'Check for Windows updates and install them',
    'Turn airplane mode off',
    'Try another browser',
    'Use the password reset page to choose a new one',
    'Forget the network, then reconnect and enter the Wi-Fi password',
    'Reseat the video cable at both ends',
    'Reseat the HDMI cable in the monitor',
    'Type the wireless password from the sticker on the router',
  ])('allows "%s"', (text) => {
    expect(findBlockedTopic(text)).toBeNull();
  });

  it('ignores capital letters and extra spaces', () => {
    expect(findBlockedTopic('OPEN   REGEDIT')).toBe('registry edits');
    expect(findBlockedTopic('command\n prompt')).toBe('command-line tools');
  });

  it('still blocks a password step that also mentions the reset page', () => {
    expect(findBlockedTopic('Go to the password reset page, then email us your password')).toBe('passwords');
    expect(findBlockedTopic('Enter the Wi-Fi password, then your Windows password')).toBe('passwords');
  });

  it('does not match parts of other words', () => {
    expect(findBlockedTopic('Check the formatted date')).toBeNull(); // "formatted" is not "format"
    expect(findBlockedTopic('Open the biosphere app')).toBeNull();
  });
});

describe('reviewSuggestion', () => {
  it('passes safe steps through, with the category turned into its id', () => {
    const result = reviewSuggestion(safeAnswer(), { categories });
    expect(result).toEqual({
      escalate: false,
      reason: null,
      steps: safeAnswer().steps,
      suggested_category_id: 1,
      suggested_priority: 'medium',
      overridden: false,
      blocked: [],
    });
  });

  it('keeps the AI escalation and its reason, with no steps', () => {
    const result = reviewSuggestion(
      { escalate: true, reason: 'Possible phishing.', steps: [], suggested_category: 'Network', suggested_priority: 'urgent' },
      { categories },
    );
    expect(result).toMatchObject({ escalate: true, reason: 'Possible phishing.', steps: [], suggested_priority: 'urgent', overridden: false });
  });

  it('gives an escalation without a reason a default one', () => {
    expect(reviewSuggestion({ escalate: true, reason: '  ' }).reason).toBe('The assistant said this needs a technician.');
  });

  it('escalates when any step touches a blocked topic, even if the AI said it was safe', () => {
    const result = reviewSuggestion(answerWithStep('Clean up', 'Open regedit and delete the old key.'), { categories });
    expect(result).toMatchObject({
      escalate: true,
      reason: 'A suggested step involved registry edits, which needs a technician.',
      steps: [],
      overridden: true,
    });
    // The thrown-away steps are kept for staff, in order.
    expect(result.blocked).toEqual([
      { title: 'Restart the computer', detail: 'Save your work first.' },
      { title: 'Clean up', detail: 'Open regedit and delete the old key.' },
    ]);
  });

  it('checks the step title too, not just the detail', () => {
    expect(reviewSuggestion(answerWithStep('Run PowerShell as admin', 'It fixes it.')).escalate).toBe(true);
  });

  it('keeps the suggested category and priority on an override, for the ticket', () => {
    const result = reviewSuggestion(answerWithStep('Enter the BIOS'), { categories });
    expect(result).toMatchObject({ escalate: true, suggested_category_id: 1, suggested_priority: 'medium' });
  });

  it('escalates when there are no usable steps', () => {
    for (const steps of [[], undefined, 'restart', [{ title: '  ', detail: 'x' }, null]]) {
      expect(reviewSuggestion(safeAnswer({ steps }))).toMatchObject({
        escalate: true,
        reason: 'No safe steps were found for this problem.',
        overridden: true,
      });
    }
  });

  it(`keeps at most ${MAX_STEPS} steps and trims long text`, () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ title: `  Step ${i + 1}  `, detail: 'x'.repeat(1000) }));
    const result = reviewSuggestion(safeAnswer({ steps }));
    expect(result.steps).toHaveLength(MAX_STEPS);
    expect(result.steps[0].title).toBe('Step 1');
    expect(result.steps[0].detail).toHaveLength(600);
  });

  it('puts the steps in order of effort, easiest first, whatever order the AI wrote them in', () => {
    const steps = [
      { title: 'Restart the computer', detail: 'Save your work first.', effort: 4 },
      { title: 'Restart the app', detail: 'Close it and open it again.', effort: 2 },
      { title: 'Try right-click > Copy', detail: 'Use the menu instead of Ctrl+C.', effort: 1 },
      { title: 'Unplug and replug the keyboard', detail: 'Wait a few seconds.', effort: 3 },
      { title: 'Check for stuck keys', detail: 'Press Ctrl, C and V slowly.', effort: 1 },
    ];
    expect(reviewSuggestion(safeAnswer({ steps })).steps.map((s) => s.title)).toEqual([
      'Try right-click > Copy', // effort 1, in the AI's order
      'Check for stuck keys', // effort 1
      'Restart the app',
      'Unplug and replug the keyboard',
      'Restart the computer',
    ]);
  });

  it('treats a missing effort as 3, and keeps the easiest steps when there are too many', () => {
    const steps = [
      { title: 'No rating', detail: 'x' },
      { title: 'Quick check', detail: 'x', effort: 1 },
      ...Array.from({ length: 7 }, (_, i) => ({ title: `Restart ${i}`, detail: 'x', effort: 4 })),
    ];
    const titles = reviewSuggestion(safeAnswer({ steps })).steps.map((s) => s.title);
    expect(titles.slice(0, 2)).toEqual(['Quick check', 'No rating']);
    expect(titles).toHaveLength(MAX_STEPS); // two of the effort-4 steps were dropped
  });

  it('does not pass the effort rating on (the user sees title and detail only)', () => {
    const [step] = reviewSuggestion(safeAnswer({ steps: [{ title: 'Check the cable', detail: 'x', effort: 1 }] })).steps;
    expect(step).toEqual({ title: 'Check the cable', detail: 'x' });
  });

  it('matches the category ignoring capitals, and drops unknown ones', () => {
    expect(reviewSuggestion(safeAnswer({ suggested_category: 'printer' }), { categories }).suggested_category_id).toBe(2);
    expect(reviewSuggestion(safeAnswer({ suggested_category: 'Plumbing' }), { categories }).suggested_category_id).toBeNull();
    expect(reviewSuggestion(safeAnswer({ suggested_category: '' }), { categories }).suggested_category_id).toBeNull();
  });

  it('falls back to medium for an unknown priority', () => {
    expect(reviewSuggestion(safeAnswer({ suggested_priority: 'critical' })).suggested_priority).toBe('medium');
  });

  it('treats a missing or broken answer as "no safe steps"', () => {
    for (const raw of [null, undefined, 'oops', 42]) {
      expect(reviewSuggestion(raw)).toMatchObject({ escalate: true, overridden: true });
    }
  });
});

describe('reviewAnswer (Ask IT)', () => {
  it('passes a safe answer through', () => {
    expect(reviewAnswer({ answer: '  Restart the printer, then try again.  ', needs_technician: false, reason: '' })).toEqual({
      answer: 'Restart the printer, then try again.',
      needsTechnician: false,
      reason: null,
      blocked: null,
    });
  });

  it('keeps the AI saying a technician is needed, with a standard answer', () => {
    const result = reviewAnswer({ answer: 'ignored', needs_technician: true, reason: 'Phishing needs IT.' });
    expect(result).toMatchObject({ needsTechnician: true, reason: 'Phishing needs IT.', blocked: null });
    expect(result.answer).toMatch(/Get help/);
  });

  it('blocks a risky answer and keeps the original for staff', () => {
    const result = reviewAnswer({ answer: 'Open regedit and change the key.', needs_technician: false, reason: '' });
    expect(result).toMatchObject({ needsTechnician: true, blocked: 'Open regedit and change the key.' });
    expect(result.reason).toMatch(/registry/);
  });

  it('allows ordinary password advice, unlike steps', () => {
    expect(reviewAnswer({ answer: 'Use a long password you do not reuse.', needs_technician: false }).needsTechnician).toBe(false);
  });

  it('treats an empty or broken answer as needing a technician', () => {
    for (const raw of [null, { answer: '   ' }, 'oops']) expect(reviewAnswer(raw).needsTechnician).toBe(true);
  });
});
