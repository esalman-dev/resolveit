// Roles (client copy): the role ranking, so screens only offer changes the server will allow.
//
//   user (0) < technician (1) < admin (2) < owner (3)
//   You can only manage people ranked below you, and only give out roles ranked below your own.
//
// Note: this mirrors server/roles.js; keep the two in sync. It's for a clear interface, not
// for security: the server still checks every change.

/** Every role, lowest to highest. */
export const ROLES = ['user', 'technician', 'admin', 'owner']

const RANK = { user: 0, technician: 1, admin: 2, owner: 3 }
const rankOf = (role) => RANK[role] ?? -1

/** True for the roles that work on tickets (the server's STAFF list). */
export const isStaff = (role) => role === 'technician' || role === 'admin' || role === 'owner'

/** True for the roles that see the admin screens. */
export const isAdminOrOwner = (role) => role === 'admin' || role === 'owner'

/** Can someone with `actorRole` change the account of someone who is `targetRole`? */
export const canManage = (actorRole, targetRole) => rankOf(targetRole) < rankOf(actorRole)

/** The roles `actorRole` may give out. Never includes owner: owners are made on the server. */
export const grantableRoles = (actorRole) => ROLES.filter((role) => rankOf(role) < rankOf(actorRole))
