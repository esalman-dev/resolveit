// Roles: the four roles, their ranking, and who may manage whom.
//
//   user (0) < technician (1) < admin (2) < owner (3)
//
// One rule covers every role change: you can only manage people ranked below you, and only
// give out roles ranked below your own. So owners manage admins, admins manage technicians and
// users, owners can't demote each other, and nobody can make someone an owner from the website
// (owners are created on the server with `npm run make-owner -- email`).
//
// Note: client/src/roles.js is a copy used to tidy the screen. Keep the two in sync.

/** Every role, lowest to highest. Must match the CHECK constraint in db/schema.sql. */
export const ROLES = ['user', 'technician', 'admin', 'owner'];

const RANK = { user: 0, technician: 1, admin: 2, owner: 3 };

/** A role's rank number. An unknown role ranks below everyone, so a typo never grants power. */
export const rankOf = (role) => RANK[role] ?? -1;

/** Roles that work on tickets. */
export const STAFF = ['technician', 'admin', 'owner'];

/** Roles that manage users and categories. */
export const ADMINS = ['admin', 'owner'];

/** Can someone with `actorRole` change the account of someone who is `targetRole`? */
export const canManage = (actorRole, targetRole) => rankOf(targetRole) < rankOf(actorRole);

/** Can someone with `actorRole` give out the role `newRole`? */
export const canGrant = (actorRole, newRole) => rankOf(newRole) < rankOf(actorRole);
