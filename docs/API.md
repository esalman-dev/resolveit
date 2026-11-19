# API reference

[← Back to the README](../README.md)

Every endpoint the React app calls.

| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/api/health` | Anyone | Checks the server and database |
| POST | `/api/auth/register` | Anyone | Create an account. Returns the user and an access token, and sets the refresh cookie |
| POST | `/api/auth/login` | Anyone | Log in with email and password |
| POST | `/api/auth/google` | Anyone | Log in with a Google ID token |
| POST | `/api/auth/refresh` | Refresh cookie | Get a new access token (rotates the refresh token) |
| POST | `/api/auth/logout` | Refresh cookie | Revoke this session |
| GET | `/api/auth/me` | Logged in | The current user |
| GET | `/api/users` | Admin, owner | List all users |
| PATCH | `/api/users/:id/role` | Admin, owner | Change a role: only for people ranked below you, and only to a role below yours |
| PATCH | `/api/users/:id/disabled` | Admin, owner | Disable or re-enable an account ranked below you |
| GET | `/api/users/history` | Admin, owner | Account history, newest first (`?user_id=` for one person) |
| POST | `/api/tickets` | Logged in | Open a ticket (always starts open and unassigned; only staff can choose a priority, otherwise it starts at medium); `attachment_ids` attaches uploaded files |
| GET | `/api/tickets` | Logged in | List tickets: users see their own, technicians, admins and owners see all |
| GET | `/api/tickets/:id` | Creator, staff | One ticket **with its history** and its due times (404 for other users' tickets, so ids can't be probed) |
| PATCH | `/api/tickets/:id` | Creator, staff | Staff: change anything. Creator: edit title/description while open, or close it. Every change is logged |
| GET | `/api/tickets/assignees` | Staff | Active technicians, admins, and owners a ticket can be assigned to |
| GET | `/api/tickets/:id/comments` | Creator, staff | Comments, oldest first, each with its earlier versions (internal notes only for staff) |
| POST | `/api/tickets/:id/comments` | Creator, staff | Add a comment, with `attachment_ids`; staff can mark it internal (its files are staff-only too) |
| GET | `/api/tickets/:id/attachments` | Creator, staff | Every file on the ticket and its comments (files on internal notes only for staff) |
| PATCH | `/api/tickets/:id/comments/:commentId` | The comment's author | Edit your comment; the old text is kept |
| GET | `/api/categories` | Logged in | Active categories (admins can add `?all=true` for archived ones) |
| POST | `/api/categories` | Admin, owner | Add a category |
| PATCH | `/api/categories/:id` | Admin, owner | Rename, archive, or restore a category |
| POST | `/api/help/suggest` | Logged in | Get help: safe steps, or a ticket for a technician (counts toward the daily limit); screenshots in `attachment_ids` are sent to the AI too |
| POST | `/api/help/:id/outcome` | The person who asked | "That fixed it" / "Still broken" (Get help opens a ticket with the steps tried); "did this help?" for Ask IT |
| GET | `/api/help/mine` | Logged in | Your unfinished Get help requests (last 7 days) |
| GET | `/api/help/:id` | The person who asked | Reopen a request where you left off (no new AI call) |
| POST | `/api/help/ask` | Logged in | Ask IT: one quick question, one answer (counts toward the daily limit) |
| GET | `/api/help/questions/mine` | Logged in | Your recent Ask IT questions and whether each helped |
| GET | `/api/help/sessions` | Staff | Every AI request with its result, plus counts per result and source |
| POST | `/api/attachments` | Logged in | Upload one file (form field `file`); it's attached when sent with a ticket, comment or Get help request |
| GET | `/api/tickets/:id/rating` | Creator, admin, owner | The ticket's review (technicians get 403: the ticket page shows who opened it) |
| PUT | `/api/tickets/:id/rating` | Creator, once resolved | Give or change the review (1-5 stars, optional comment; 7 days to change it) |
| GET | `/api/reviews` | Staff | Reviews with a summary; technicians get only their own, without names or ticket numbers; admins can filter with `?technician_id=` |
| GET | `/api/dashboard` | Staff | Every dashboard number for `?days=1`, `7`, `30` or `90`, with the period before (technicians get only their own technician row) |
| PUT | `/api/dashboard/goals` | Admin, owner | Change the team goals |
| GET | `/api/presence` | Logged in | How many staff are online; staff also get who, and their own status |
| POST | `/api/presence/heartbeat` | Staff | The once-a-minute check-in (`{ active }`: mouse or keyboard used since the last one) |
| PUT | `/api/presence/me` | Staff | Set your status: available, busy or away |
| POST | `/api/help/match` | Logged in | Published articles that match a problem (no AI call) |
| POST | `/api/help/article-fixed` | Logged in | "That fixed it" on an article: saved as fixed, no daily limit used |
| GET | `/api/kb` | Logged in | Articles (`?q=` to search); staff also `?status=draft` or `archived`, `?source_ticket=` |
| GET | `/api/kb/:id` | Logged in | One article (drafts and archived: staff only) |
| POST | `/api/kb` | Staff | Write an article (starts as a draft) |
| PATCH | `/api/kb/:id` | Staff | Edit an article (a published one can't gain a risky step) |
| POST | `/api/kb/:id/publish` | Staff (restore: admin, owner) | Publish after re-checking every step |
| POST | `/api/kb/:id/archive` | Admin, owner | Hide a published article |
| DELETE | `/api/kb/:id` | Staff | Discard a draft |
| POST | `/api/kb/:id/feedback` | Logged in | "Was this helpful?" |
| GET | `/api/sla-targets` | Staff | The target times per priority |
| PUT | `/api/sla-targets` | Admin, owner | Change the target times (every priority; fixed can't be shorter than first reply) |
| GET | `/api/attachments/:id` | Whoever can see what it's attached to | Download a file (404 for anyone else) |
| DELETE | `/api/attachments/:id` | The uploader | Remove a file before it's sent |

Protected endpoints expect `Authorization: Bearer <access token>`. "Staff" means a technician, admin, or owner.
