# Clan Ledger

The website replaces the old CSV workflow with a public clan report and a password-protected admin workspace. The Python counter remains in the repository as a legacy tool; it does not sync with this website.

## First use

1. Open the private owner setup link. Choose your clan name, tag, and an admin password of at least 12 characters. This link works only until the admin account is created.
2. Add your players in **Players**, or import the 189 names and aliases from the previous counter in **Clan settings**. Archived members keep their history.
3. Review the 46 scoring rules imported from the previous counter. In **Points library**, add or edit chest names, exact game sources, levels, points, and approved OCR aliases. Use level 0 for sources without a level.
4. Share the website's ordinary URL with the clan. Viewers can see confirmed entries, member contributions, points, and CSV exports. They cannot change records or see screenshot evidence.

## Live capture

Use Chrome on a laptop for the most practical tab-sharing workflow. Safari can be used where its screen-sharing support is available. The website does not log in to Total Battle.

1. Open the game at **My Clan → Gifts**. Keep the list at the top.
2. In the website's **Live capture**, choose **Share game** and select the game tab/window.
3. Draw a box around the top chest's three text lines: chest name, `From:`, and `Source:`. Exclude the icon, time-left text, and buttons.
4. Draw a second box around **only the total Gifts badge number**. Do not select a chest's level or the Triumphal Gifts count.
5. Start reading. Wait for **Ready to open the top chest**.
6. Open that one top chest manually in the game. Wait for the next ready message before opening another.

Keep the same browser zoom and game layout throughout a session. Calibrate again after changing window size, zoom, tab, or gifts category. Do not scroll or open a different row while using this mode. The reader does not open chests or use the game's private APIs.

Browsers require a user gesture and fresh screen-sharing permission for each session; a website cannot silently start capture merely because the game opens. See [MDN's screen-capture security requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia#security).

## What prevents duplicate counts

- Text is never a chest's identity. Two identical chests from the same player are separate events when the remaining-gifts count decreases from N to N−1 for each opening.
- Both the old row and the changed gifts number need stable readings. A row that remains on screen without a count decrease creates no entry, regardless of how long it is stuck.
- Every capture session has a server checkpoint and a monotonically increasing sequence. The database enforces a unique `(session, sequence)` key. Network retries reuse that key.
- Only one capture session can own the clan at a time. A short lease and heartbeat stop two laptops from independently counting the same opening.
- Manual submissions also reuse a unique ID while retrying.

## Accuracy and review

Screen OCR cannot guarantee zero mistakes. Automatic confirmation requires an exact active-player name or approved alias, one exact source/level scoring rule, a known chest name, at least 90% confidence (including the least-confident recognized word), two matching row readings, and screenshot evidence. Fuzzy guesses never silently become player matches. Uncertain text is stored as a review entry, excluded from all totals.

In **Review queue**, inspect the cropped screenshot and original OCR text, select the correct member and scoring rule, and approve with a reason. All corrections appear in **Activity log**. Incorrect entries can be voided and restored; they are not permanently deleted. Editing a rule does not recalculate already awarded points.

The badge method cannot reconstruct unseen events. Capture pauses if the count jumps, increases, or a chest opens before a stable row is available. An arrival and an opening at the same moment can leave the badge unchanged, hiding that opening. Review the game's list and add any such chests manually. Do not open multiple chests rapidly or use “claim all” with this mode.

The reader runs in your browser and needs the laptop, website, and game to remain running. This is not an unattended cloud game bot. Total Battle's published [Terms of Service](https://totalbattle.com/en/policies/terms_of_service/20251208/) restrict unauthorized third-party tools and automation; this implementation's passive screen-reading design is not a claim of publisher approval.

## Connection recovery

Before posting, a reading is saved in this browser's local storage. If delivery fails, capture pauses. Use **Retry delivery**: even if the first request reached the server, the retry returns the existing entry rather than adding another.

If the session has expired, download the pending readings. **Download & archive** preserves them in a JSON file and clears the local queue so you can reconnect. Check each event ID in the ledger before entering it manually. Do not clear browser data while readings are pending.

## Reports and data

- Today, week, month, and all-time totals use the clan's configured timezone. Weeks start Monday. The per-player goal is a weekly goal.
- Pending review and voided records do not affect chest or point totals.
- Points are stored as a snapshot on each entry. Editing a points rule applies to future entries. Correcting an entry without changing its rule keeps its previous awarded points.
- Export the filtered ledger as CSV. Formula-like names are escaped for spreadsheet safety.
- **Clan settings → Download JSON backup** exports players, rules, entries, private evidence, and the audit log. Store that file privately. It excludes passwords and login sessions. Restoring a full backup currently requires a database administrator; there is no browser restore button.

## Development

Node 22 or later is recommended. Install with `npm ci`. Copy a private random `SETUP_TOKEN` into `.dev.vars`; keep it out of source control. Build, migrate the local database, and start the Cloudflare preview:

```sh
npm run build
npm run db:local
npm run preview
```

Visit `http://127.0.0.1:8787`. For fast UI development, also run `npm run dev`; Vite proxies `/api` to Wrangler. `?demo=1` uses clearly labeled sample data in memory, never production records. `npm test` runs domain and API tests against an in-memory SQLite D1 adapter. The test-only `scripts/smoke-local.mjs` sends requests solely to the local preview and uses disposable local credentials.

The build copies the Tesseract worker, WebAssembly, and English language model from installed packages into the static assets. Recognition does not call an external OCR service. These generated files, local databases, private tokens, and build output are ignored by Git.

## Cloudflare operations

The selected Cloudflare account is `93190b572b808d0eb2d7850d9cce61fd` (Sufiyanrazaq55@gmail.com's Account). The Worker is `clan-ledger`; D1 is `clan-ledger-db`, bound as `DB`. Do not deploy this project using another account.

Database schema changes use versioned SQL files in `migrations/`. Apply them with `npm run db:remote` before code that requires them. Build with `npm run build`, then use `wrangler deploy`. On initial deployment only, supply a private JSON secrets file with a cryptographically random `SETUP_TOKEN` through Wrangler's `--secrets-file` option. Retain the existing secret on later deployments. The setup route refuses to reset an existing account.

Check `/api/health` and `/api/state` after deployment. Never insert QA players or sample chests into the production database. Use Cloudflare D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) or a reviewed SQL import for disaster recovery.

Authentication uses PBKDF2-SHA256 with a per-clan salt, 100,000 iterations, hashed random server sessions, HttpOnly/Secure/SameSite cookies, same-origin mutation checks, and login rate limits. Public endpoints expose confirmed records and scoring data; evidence, pending readings, audit logs, backups, and all writes require admin access.
