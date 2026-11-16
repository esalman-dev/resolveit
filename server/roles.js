// The four roles and their ranking, in ONE place, so every route uses the same rules.
//
//   user (0) < technician (1) < admin (2) < owner (3)
//
// The one rule for changing roles: you can only manage people RANKED BELOW you,
// and only give out roles RANKED BELOW your own. That single rule means:
//   - owners manage admins, technicians and users
//   - admins manage technicians and users (not other admins, and not owners)
//   - owners can't demote each other (another owner isn't below you)
//   - nobody can make someone an owner from the website (no role ranks above owner)
//     -> owners are created only on the server: npm run make-owner -- email
// KEEP IN SYNC with client/src/roles.js (a copy, used only to tidy the screen).

export const ROLES = ['user', 'technician', 'admin', 'owner']; // must match the CHECK in schema.sql

const RANK = { user: 0, technician: 1, admin: 2, owner: 3 };
export const rankOf = (role) => RANK[role] ?? -1; // unknown role ranks below everyone

// Groups used by the routes
export const STAFF = ['technician', 'admin', 'owner']; // work on tickets
export const ADMINS = ['admin', 'owner'];              // manage users and categories

// Can `actorRole` change the role of someone who is currently `targetRole`?
export const canManage = (actorRole, targetRole) => rankOf(targetRole) < rankOf(actorRole);

// Can `actorRole` give someone the role `newRole`?
export const canGrant = (actorRole, newRole) => rankOf(newRole) < rankOf(actorRole);
