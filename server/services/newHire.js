// New-hire setup tickets: their wording, and reading their checklist.
//
// The server writes the title, not the browser, so every new-hire ticket reads the same way in
// the list ("New hire: Jane Doe, Sales Associate"). The checklist is changed through
// routes/checklist.js; these helpers are shared with routes/tickets.js.

/**
 * The ticket title for a new hire.
 * newHireTitle({ name: 'Jane Doe', jobTitle: 'Sales Associate' }) → 'New hire: Jane Doe, Sales Associate'
 * Both values arrive already trimmed and checked (1 to 80 characters each).
 */
export function newHireTitle({ name, jobTitle }) {
  return `New hire: ${name}, ${jobTitle}`;
}

/** A ticket's checklist in order, each step with who last ticked it. Empty for other tickets. */
export async function loadChecklist(db, ticketId) {
  const result = await db.query(
    `SELECT i.id, i.title, i.state, i.changed_at, i.changed_by, u.name AS changed_by_name
       FROM ticket_checklist_items i
       LEFT JOIN users u ON u.id = i.changed_by
      WHERE i.ticket_id = $1
      ORDER BY i.position`,
    [ticketId]
  );
  return result.rows;
}

/** How many of a ticket's steps are still to do (neither done nor marked not needed). */
export async function stepsLeft(db, ticketId) {
  const result = await db.query(
    "SELECT COUNT(*)::int AS left FROM ticket_checklist_items WHERE ticket_id = $1 AND state = 'todo'",
    [ticketId]
  );
  return result.rows[0].left;
}
