# Verification — 13 November 2026

Production: https://clan-ledger.sufiyanrazaq55.workers.dev

Cloudflare account: Sufiyanrazaq55@gmail.com's Account (`93190b572b808d0eb2d7850d9cce61fd`). Worker: `clan-ledger`. Dedicated D1 database: `clan-ledger-db`, APAC.

## Passed

- Production build through Vite.
- 17 automated domain/API checks: exact OCR aliases, confidence/review gates, repeated stuck rows, separate identical chests, transient badge mistakes, skipped-opening pauses, timezone and daylight-saving boundaries, login/setup protection, public/admin separation, CSV safety, point snapshots, archival, correction, void/restore, and streamed backups.
- Integration requests against the actual local Wrangler/Workerd and D1 runtime: owner setup, login, roster creation, manual entry retries, two identical captured chest events, delivery retries, an uncertain reading, and all four report periods.
- Production HTTP checks: homepage, database health, today/week/month/all reports, OCR asset availability, and security headers. Unauthenticated writes and backups return 401. The owner setup secret is configured.
- Production reports were verified with zero real chest records and no configured admin password. Test players and entries exist only in the local test database.
- Private setup tokens and generated build/OCR files are ignored by Git. The production token is absent from public deployment assets.

## Screenshot OCR evidence

The existing `1.png` was cropped and enlarged locally, then read with the bundled English Tesseract model:

- `Orc Chest / From: Felharon / Source: Level 15 Crypt`: overall confidence 93%.
- `Rare Dragon Chest / From: bloodbourne again / Source: Level 10 rare Crypt`: overall confidence 95%.
- Gifts badge: `178`, overall confidence 96%.

These checks confirm recognition on this supplied screenshot. They do not establish accuracy across every game resolution, name, animation, language, or live opening. The browser reader also checks the least-confident recognized word and two matching frames before an entry can be confirmed automatically.

## Verification limits

The computer-use inventory reported an unavailable browser host. Safari control subsequently timed out, preventing rendered desktop/mobile inspection and an actual browser screen-sharing session. Browser visual QA and live-game calibration remain unverified. No game chests were opened by the agent.

Use the capture guide in `CLAN_LEDGER.md` for the first live session. Watch the first several openings against the game's gift count and the website's ledger. The system deliberately pauses on ambiguous count changes; it cannot promise error-free OCR or reconstruct unseen openings.

The production health-check script is `scripts/check-deployment.mjs`. It expects a fresh, unconfigured ledger; update its initial-state assertions after owner setup rather than running it unchanged against an established clan.
