# Live website: gamethatneutrino.com

**Canonical production URL: https://gamethatneutrino.com** (also `www.gamethatneutrino.com`). Publish to its existing DigitalOcean server, not ChatGPT Sites. `.openai/hosting.json` is legacy configuration and does not identify the production destination.

The current server is `root@68.183.115.68`. nginx and Certbot provide HTTPS and proxy to `neutrino.service` on `127.0.0.1:8000`. The service runs `python3 server.py` from `/opt/neutrino/app`. Releases live in `/opt/neutrino/releases/`, with the active application linked at `/opt/neutrino/app`. Persistent JSON scores, analytics, and the private SQLite account/Endless database live at `/opt/neutrino/data/reset-20261015-1/`, selected by `NEUTRINO_DATA_DIR`. `GAME_STATE_EPOCH=reset-20261015-1` rejects pre-reset score uploads. Both login/account saves and the shared Endless leaderboard are supported on this server.

Back up the current application and persistent data before deployment, upload a release without local data or private databases, and check it on a loopback staging port with separate temporary data. Switch the application link and restart `neutrino.service` only after checks pass. Verify the canonical HTTPS URL and its APIs. Keep the previous release for rollback. Preserve the existing nginx, DNS, and certificate configuration. `deploy/live.json` records these locations.

The public game offers only Collaborator Game (default) and Endless Mode. Retired Friday, Learning Quiz, and Quick Quiz links open Collaborator instead; saved retired runs cannot resume as playable modes. Analysis navigation also offers only the two current modes. Existing research data and historical APIs remain retained for archival access. The old `4.0.html` shortcut redirects to the homepage.

The Docker/PostgreSQL deployment described below is an optional scaling setup; it is not the current server runtime.

The requested October 15, 2026 leaderboard reset uses the `reset-20261015-1` state epoch. On the canonical server, current scores, trophies, analytics, and private account saves use the persistent data directory above; pre-reset data remain in the prior application backup. A separate legacy ChatGPT mirror has JSON files at `data/reset-20261015-1/` in GitHub. Those are not the authoritative production data. Future updates must preserve the canonical server's data directory rather than replace it with repository snapshots.

**Analysis & Export** includes a mode selector, per-user performance and growth, per-video responses, all retained runs and answers, video-set breakdowns, and activity reports per user and video. Historical Friday and research data remain stored for archival access through their existing APIs. Gameplay reports use the active score history; activity reports include the rolling 5,000-event window, including events from before the reset. `GET /api/analytics?view=full` returns that complete retained event window, while the ordinary endpoint keeps its compact recent-event preview. Tables preview 50 rows; detailed CSV exports include all available rows and preserve headers when empty. Endless totals use available leaderboard/device saves, while detailed answers are explicitly limited to the ten most recent picks retained per local run.

The optional scaling setup uses PostgreSQL, Gunicorn, nginx, and Caddy. It has no ChatGPT hosting, GitHub API, or other external application dependency at runtime. Videos are served by nginx and can optionally use your own media CDN. The `server.py` entry point and `worker/` directory are not launched by this Docker setup.

## Start on a server

Install Docker Engine and Docker Compose on a Linux server. Copy this project, including `videos/`, then:

```sh
cp .env.example .env
```

Set `POSTGRES_PASSWORD` in `.env` to a long, random, URL-safe value (letters/numbers work). Set `SITE_ADDRESS` to your domain, without `http://`. Point that domain's DNS records to the server and allow inbound ports 80 and 443. Use `http://localhost` for a local HTTP preview.

```sh
docker compose up -d --build
```

Startup waits for PostgreSQL, applies pending schema migrations once, starts the app, and then starts the web tier. Caddy obtains HTTPS certificates for a public domain. Only the HTTPS service exposes public ports; the database and Python application remain on the internal Docker network. Preserve the database and certificate volumes across upgrades.

Readiness checks:

```sh
docker compose ps
docker compose exec -T app python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/ready').read().decode())"
```

## Optional player accounts

Players can choose **Log in / Sign up** or keep playing as guests. Accounts use only a username and password. They save an unfinished run (question order, answers, and coins), the latest ten finished games, earned trophies, and pending collaborator submissions. Creating an account or first logging into an empty account carries over the current guest progress. Existing accounts restore their saved progress. Guest and account browser storage are separate, and conflicting saves from another tab or device require the player to choose a copy.

Migration `003_accounts.sql` adds private accounts, expiring server sessions, and shared login-attempt counters to PostgreSQL. The normal migration startup applies it automatically. Database backups include these tables. Passwords use salted PBKDF2-HMAC-SHA256 with 600,000 iterations, and only hashes of the random session tokens are stored. Session cookies are HttpOnly, SameSite=Lax, and Secure outside loopback development. Account responses bypass the public leaderboard cache. Account writes require a same-origin custom request header. The design follows the [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

For local `server.py` development, private accounts use `data/accounts.sqlite3`, which is ignored by Git and blocked from HTTP access, along with other private data and hidden files. Set `ACCOUNT_DB_PATH` to choose another local file. The legacy GitHub-backed Worker intentionally keeps guest mode only: account credentials and private saves must never be committed to a source repository. Full account support runs on the independent server described here. No email-based password recovery is included.

Account checks:

```sh
node tests/accounts-sync.cjs
TEST_DATABASE_URL=postgresql://user@localhost/neutrino_tests .venv/bin/python -m unittest discover -s tests -p test_accounts.py -v
```

## Endless Mode

Endless Mode samples all 100 replacement videos without repeats within a pass, then reshuffles for another pass. It has no fixed question count or automatic loss at zero coins. Normal correct calls earn 1 coin, hot-hand calls earn 2 after two consecutive correct answers, and Double or Nothing changes a hit to 2 (3 with a hot hand) or a miss to −2. Public vote bars and correct minority bonuses use the same rules as the collaborator game: a correct call with under 25% of recorded votes earns 2 extra coins. Public votes are aggregated from saved Endless checkpoints without double counting retries. The full game screen includes the wager, coin bank, streak celebration, public-line feedback, achievements, help, and recent-answer review.

Endless progress belongs to the player across visits, rather than ending with a session. **Pause & save** keeps the same continuing profile while the player visits other modes. Guest saves are separate for each normalized player name on that browser; signed-in accounts have their own private profile, with cross-device saves on the independent host. Existing paused saves migrate automatically. **Reset to 10 coins** clears the player’s Endless leaderboard entry as well as the wallet and current streak. The next answer starts a fresh leaderboard score. Lifetime questions, correct calls, best streak, research votes, and earned trophies remain available. It works while playing or paused and is saved offline for retry. Each profile keeps a bounded 100-clip deck, the latest ten answer details, and lifetime counters.

Migration `004_endless.sql` adds a separate `endless_runs` table, leaving other leaderboards unchanged. `/api/endless-players` accepts continuing checkpoints and ranks by correct calls, accuracy, and coins. Legacy completed runs remain archived and immutable. A private random checkpoint key prevents someone from rewriting a published profile; only its hash is stored with the score, and neither the key nor hash appears in leaderboard responses. A monotonic `walletResets` counter and leaderboard baseline totals prevent old checkpoints from restoring a prior wallet or leaderboard score, including resets followed by more answers offline. Reset markers also hide older archived runs for that player. Bounded per-video vote totals remain stored in each record independently of the last ten answer details. The public `history` payload keeps lifetime records available to Analysis & Export even when a reset hides a leaderboard entry. No additional migration is needed because the counter is stored in the existing record. Accounts save the private continuation key through the private progress API. The legacy GitHub-backed Worker keeps guest/local Endless saves only; the independent server supports its leaderboard.

```sh
node tests/endless-rules.cjs
TEST_DATABASE_URL=postgresql://user@localhost/neutrino_tests .venv/bin/python -m unittest discover -s tests -p test_endless.py -v
```

## Bring existing results with you

Before switching traffic, take a final copy of the old server's `data/` directory while writes there are paused. Existing files in this checkout may be older than the current live results. Keep the original copy as a backup. Import that final export:

```sh
docker compose run --rm -v "$PWD/data:/import:ro" app python manage.py import-json --directory /import
```

This imports all available mode histories, achievements, and activity events. Unique record IDs make rerunning an interrupted import safe. Historical run lengths and weekly cycles are retained. If the domain stays the same, the game keeps device-local pending collaborator runs and retries those against the replacement server. If moving to a different domain, browser-local runs and trophies do not automatically move to that domain; complete and sync pending runs on the old origin before the final export and cutover.

The production server does not read or modify JSON files during ordinary requests. It also does not expose `data/`, source files, or deployment configuration as web assets.

## Traffic behavior

- PostgreSQL stores one row per run and activity event, plus unique player/trophy pairs. Concurrent writes no longer replace a whole shared JSON document.
- The default leaderboard response contains compact player summaries and aggregated crowd votes. Full answer records and paginated history are fetched only when opening analysis/export. Existing game modes, scoring, trophies, crowd statistics, and CSV exports remain available.
- Visitors refresh the selected mode every 90–120 seconds while visible and outside an active run. Focus-triggered refreshes are throttled; overlapping requests share one response. The old five requests every minute become roughly one every 1.5–2 minutes, excluding on-demand trophy/analysis views and pending uploads.
- Public leaderboard and summary reads use a short shared nginx cache and a per-worker cache. Standings can lag briefly; confirmed submissions are acknowledged immediately. Public standings then refresh on each browser's next scheduled refresh.
- nginx queues a burst of up to 2,000 writes and feeds the app at 500 requests per second. A simultaneous wave of 1,500 submissions takes about three seconds to drain. Overload beyond that bounded queue receives HTTP 429; clients retain unconfirmed collaborator scores for retry.
- Activity events are sent in bounded batches at 30-second intervals rather than every four seconds. Outage telemetry is capped at 500 queued events per browser. Score persistence uses a separate queue and is not subject to that telemetry cap.
- The app defaults to four workers, eight threads each, and at most eight database connections per worker. Keep the total pool allowance below PostgreSQL's connection limit when increasing workers.

## Video bandwidth and CDN

Local tests establish application behavior, not the eventual server's internet capacity. A 1 MB clip downloaded by 1,500 browsers is about 1.5 GB of outbound traffic for that clip. If all downloads occur within ten seconds, that alone needs about 1.2 Gbit/s before overhead. Replaying clips and faster playback can increase the peak. A typical small server's network link can become the limiting factor even when its CPU is idle.

For a large public event, put the video files behind an independently hosted CDN or use a host with measured bandwidth sufficient for the event. Two supported options:

1. Put a CDN in front of your domain and cache `/videos/` responses. nginx already supplies byte-range support and one-day cache headers. Preserve range requests and `206 Partial Content` responses.
2. Upload the `videos/` tree to your own media origin/CDN, keeping folder names and paths. Set `VIDEO_BASE_URL=https://your-media-domain` in `.env`, then recreate the app. Manifests and the app stay on the primary site; clip URLs use that media domain. Serve files as `video/mp4`, preserve range requests, and configure the media service for browser playback.

No CDN account has been created or purchased. Test the chosen host and CDN from outside that host before announcing a 1,500-person event.

## Backups and updates

```sh
./scripts/backup.sh
docker compose up -d --build
```

Backups are written atomically into `backups/`. Copy them off the server using your normal backup system. To restore into an **empty replacement database**, start its database and import a dump:

```sh
docker compose up -d db
docker compose exec -T db pg_restore -U neutrino -d neutrino --no-owner < backups/your-backup.dump
docker compose up -d --build
```

Do not delete the production database volume during an update. Schema migrations are explicit and checksum-checked. Keep applied migration files unchanged and add a new migration for future schema changes.

Activity retention can be run daily by the host's scheduler. It removes old telemetry only; scores and trophies are retained:

```sh
docker compose exec -T app python manage.py prune-events --days 90
```

## Verification and repeatable load test

Install local test dependencies in a virtual environment. Integration checks require a disposable PostgreSQL database whose name ends in `_test` or `_tests`:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
TEST_DATABASE_URL=postgresql://user@localhost/neutrino_tests .venv/bin/python -m unittest discover -s tests -v
node tests/game-rules.cjs
node tests/shared-sync.cjs
```

Repeat the traffic test against a disposable deployment. Write phases create test scores and trophies; never run them against the real leaderboard:

```sh
ulimit -n 8192
.venv/bin/python scripts/load_test.py \
  --base-url http://localhost \
  --users 1500 --concurrency 1500 --allow-writes \
  --video-path '/videos/ntn_4.0_100_videos%20%281%29/track_smallspan_25/event3628_filenumber000000_directory_141154.mp4' \
  --output load-results/1500.json
```

The test runs separate simultaneous bursts for leaderboard reads, score submissions, duplicate retries, trophies, batched activity events, and 64 KiB video range requests. It records HTTP statuses and latency percentiles. Check database row counts as well: a successful test should add 1,500 unique runs, 1,500 profiles, 3,000 unique trophies, and 4,500 unique activity events. Retrying the same run IDs must not add runs or votes.

See `LOAD_TEST_REPORT.md` for the measured local results and remaining deployment verification.

## Collaborator video catalog

The collaborator game uses the 100 clips in `videos/ntn_4.0_100_videos (1)/`, with 25 clips in each of four sets. `manifest.csv` in that folder supplies the playable paths, event IDs, Track/Cascade answers, and neutral Set 1–4 labels. Each five-question run covers all four sets and draws its fifth clip from a randomly chosen set. The Low Energy Quiz remains a separate research catalog.

After changing the supplied event CSVs or videos, rebuild and verify the manifest, then refresh the presentation package:

```sh
python3 scripts/build-video-manifest.py
node tests/video-catalog.cjs
node scripts/build-presentation.mjs
```

The manifest builder matches the supplied CSV filenames to the actual files (including the underscore after `directory`) and checks every clip and answer key.
