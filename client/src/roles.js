// The role ranking, mirrored from server/roles.js (KEEP IN SYNC) so the screen only OFFERS changes
// the server will allow. The server still checks every change: this file is for a
// clear interface, not for security.
//
//   user (0) < technician (1) < admin (2) < owner (3)
//   You can only manage people ranked below you, and only give out roles ranked below your own.

export const ROLES = ['user', 'technician', 'admin', 'owner']

const RANK = { user: 0, technician: 1, admin: 2, owner: 3 }
const rankOf = (role) => RANK[role] ?? -1

export const isAdminOrOwner = (role) => role === 'admin' || role === 'owner'

// Can someone with `actorRole` change the role of someone who is `targetRole`?
export const canManage = (actorRole, targetRole) => rankOf(targetRole) < rankOf(actorRole)

// The roles `actorRole` may hand out (owner is never in this list: owners are made on the server)
export const grantableRoles = (actorRole) => ROLES.filter((role) => rankOf(role) < rankOf(actorRole))
