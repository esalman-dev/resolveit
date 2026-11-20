// Notifications: the rows behind the bell in the header.
//
// Routes call notify() when something happens on a ticket (assigned, a comment, resolved or
// reopened). Overdue warnings are different: nothing "happens" when a deadline passes, so they
// are added when the person's bell checks in (see routes/notifications.js).

/**
 * Tells people about something on a ticket. Must run inside the same transaction (`db`) as the
 * change itself, so there's never a notification for a change that was undone.
 *
 * Nobody is told about their own action, and each person is told once, even if they are both
 * the ticket's creator and its assignee.
 *
 * @param userIds who to tell; empty values (an unassigned ticket) are skipped
 * @param ticketId / outageId what it's about: a ticket, an outage (services/outages.js), or both
  * @param actorId who did it; null = automatic (auto-assign, outage spotting)
 * @example await notify(db, { userIds: [ticket.created_by], ticketId: 12, kind: 'resolved', actorId: req.user.id })
 */
export async function notify(db, { userIds, ticketId = null, outageId = null, kind, actorId = null }) {
  const people = [...new Set(userIds.filter((id) => id && id !== actorId))];
  if (people.length === 0) return;
  // unnest turns the list into rows, so everyone is added in one query.
  await db.query(
    `INSERT INTO notifications (user_id, ticket_id, outage_id, kind, actor_id)
     SELECT person, $2, $3, $4, $5 FROM unnest($1::int[]) AS person`,
    [people, ticketId, outageId, kind, actorId]
  );
}
