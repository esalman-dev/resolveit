// Drafts: the Get help form's unsent text, kept in this browser so it survives leaving the page.
//
// Stored per account (the key includes the user id), so someone else logging in on the same
// computer doesn't see it, and all drafts are cleared on Log out. Browser storage can be
// switched off or full (e.g. some private windows), so every call is wrapped and failing quietly
// just means no draft.

const PREFIX = 'resolveit-help-draft-'

/** The saved draft for this user: { title, description, categoryId }, or null. */
export function loadDraft(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + userId))
    return saved && typeof saved === 'object' ? saved : null
  } catch {
    return null
  }
}

/** Saves the draft, or removes it when every box is empty. */
export function saveDraft(userId, draft) {
  try {
    if (draft.title || draft.description || draft.categoryId) localStorage.setItem(PREFIX + userId, JSON.stringify(draft))
    else localStorage.removeItem(PREFIX + userId)
  } catch {
    // Storage unavailable: the form still works, it just isn't remembered.
  }
}

/** Removes this user's draft (after sending, or "Ask about something else"). */
export function clearDraft(userId) {
  try {
    localStorage.removeItem(PREFIX + userId)
  } catch {
    // Nothing to clear.
  }
}

/**
 * Removes every account's draft from this browser. Called on Log out.
 * Security: problem text can be personal, and a shared computer shouldn't keep it.
 */
export function clearAllDrafts() {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => localStorage.removeItem(key))
  } catch {
    // Nothing to clear.
  }
}
