// Ticket labels: a ticket's status and priority in words, e.g. "in_progress" → "In progress".
//
// Note: the keys must match the CHECK constraints on tickets.status and tickets.priority in
// server/db/schema.sql.

const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' }

/** A status in words, e.g. "in_progress" → "In progress". */
export const statusLabel = (status) => STATUS_LABELS[status] ?? status

/** A priority in words, e.g. "high" → "High". */
export const priorityLabel = (priority) => PRIORITY_LABELS[priority] ?? priority
