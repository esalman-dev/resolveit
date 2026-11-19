# Security

[← Back to the README](../README.md)

Authentication is built by hand rather than with an auth service, so each decision is visible and tested:

| Concern | How ResolveIT handles it |
|---|---|
| Stored passwords | Hashed with **bcrypt** (cost 12, salted). The real password is never stored or returned. |
| Login tokens | Short-lived **JWT access token** (15 minutes) kept only in memory, never in `localStorage`. |
| Staying logged in | **Refresh token** in an `httpOnly`, `SameSite=Strict` cookie that JavaScript can't read. Stored as a SHA-256 hash, valid for 30 days of inactivity and at most 90 days in total. |
| Stolen refresh tokens | **Rotation:** every refresh token works once. **Reuse detection:** if an old one is presented again, all of that user's sessions are revoked. |
| Logging out | The server revokes the session, not just the browser. |
| Permissions | Role checks read the **current role from the database**, so promotions, demotions, disabled accounts, and deleted accounts take effect immediately. 401 = not logged in, 403 = not allowed. |
| Self-promotion | Sign-up always creates a `user`, whatever the request says. The first admin is created from the server with `npm run make-admin`, and owners only with `npm run make-owner`: no website request can create an owner. Nobody can change their own role. |
| Role hierarchy | user < technician < admin < owner. You can only change the role of someone **ranked below you**, and only give roles **below your own**: admins manage technicians and users, owners also manage admins, and owners can't demote each other. A role change is saved only if the person's role hasn't changed since it was checked (no race between two editors). |
| Password guessing | **Rate limits:** 10 failed logins per 15 minutes, 10 sign-ups per hour, and a general API cap. |
| Account fishing | Login gives the same error **and takes the same time** for an unknown email and a wrong password: it checks against a dummy bcrypt hash, so response timing can't reveal which emails have accounts. |
| Input limits | Names, emails, titles, descriptions, and comments have maximum lengths. Passwords are capped at **72 bytes**, because bcrypt silently ignores anything longer. |
| Disabled accounts | Disabling revokes every session at once; the next request, refresh, or login is refused. |
| Accountability | Every ticket change, role change, and disable is logged with who did it, in the **same database transaction** as the change, so the log can't miss anything. Comment edits keep every earlier version. |
| SQL injection | Every value goes through parameters (`$1`, `$2`). Where column names are built into SQL, they come from fixed lists in the code, never from the request. |
| Login tokens (JWT) | Verified with the algorithm pinned to HS256, so a token can't choose a different signing method. |
| Google sign-in | Google's ID token is verified (signature, audience, expiry). An existing account is linked only if Google confirms the email is verified **and** the account isn't already linked to a different Google account. |
| Risky AI advice | **Two layers.** The AI's instructions list what must go to a technician, and a **server-side check** reads every step (and every Ask IT answer) before anyone sees it. If anything touches a blocked topic, the steps are thrown away and it's escalated: the AI can't talk its way past code. Blocked text is kept for staff so false alarms can be fixed. |
| Prompt injection | The user's text is fenced as data, with the fence tags stripped from it; the AI is told to escalate any "ignore your rules" request; and the server check runs anyway. |
| AI answer format | **Structured output:** the AI must answer in a fixed JSON shape enforced by the API, so the server never guesses what it meant. Its text is shown as plain text, never HTML. |
| AI cost | Per-person and site-wide **daily limits** (20 and 300 by default), checked under a database lock so parallel requests can't slip past; a per-answer token cap; a short timeout; and a prepaid balance on the AI account. |
| AI privacy | Only the problem's title, category, details and the user's screenshots (or the question) are sent to the AI, never names, emails or ids; the form says screenshots are sent. The API key lives only on the server. Unsent drafts are kept per account in the browser and cleared on log out. |
| Uploaded files | The real type is read from the file's **first bytes** ("magic bytes"), not its name, so a program renamed `photo.png` is refused. The **5 MB limit is enforced while the file arrives**, files are stored under **random names** (the uploaded name is only ever shown as text), and each one is served only after the same "can you see this ticket?" check, with headers that stop the browser running it (`nosniff`, a sandboxed `Content-Security-Policy`). A daily upload limit per person, and unsent uploads are removed after a day. |
| Screenshot injection | A screenshot can contain text like "ignore your rules". The AI is told that text in an image is part of the problem, never an instruction, and the server check still reads every step. Tested with a screenshot that asks for registry edits: escalated every time. |
