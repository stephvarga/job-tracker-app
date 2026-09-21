# QA Rundown: Shop Timer

The goal is to stop trusting "I used it all week and it seemed fine." A week of
normal use only ever samples one hour of the day, which is precisely why the
5pm bug survived so long.

Total time for a full pass: **about 15 minutes.**

---

## First, one time

```bash
pnpm install     # picks up vitest, newly added
```

---

## Layer 1: Automated (10 seconds)

```bash
pnpm verify      # typecheck + lint + tests
```

This is the whole safety net for date handling. `src/time.test.ts` walks every
hour of a full week and every hour of a month spanning the March DST change,
asserting each time that the "today" and "this week" windows actually contain
the moment being asked about. If a boundary is ever off by an hour or a day,
one of those 336 assertions fails.

It also pins the old bug in place so it can't come back:

```
✓ does not roll over to tomorrow at 5pm Pacific
✓ keeps Monday inside the week when checked on Monday evening
```

**Run it in other timezones too:**

```bash
pnpm test:tz     # UTC, Tokyo, New York
```

All boundaries are pinned to `America/Los_Angeles` regardless of what the
viewing device thinks the time is. This matters if you ever check hours from a
laptop that's travelled, and it's the difference between a test that proves
something and a test that happens to pass on your machine.

---

## Layer 2: Database healthcheck (5 seconds)

```bash
pnpm healthcheck
```

It prompts for your login (echo off, nothing written to disk, or set
`SHOP_EMAIL` / `SHOP_PASSWORD` for CI). It has to sign in: RLS means an
anonymous client sees zero rows in every table, which is indistinguishable from
your data having vanished.

Read-only. Answers the questions the UI can't:

| Check | Why it matters |
|---|---|
| Connectivity | A paused free-tier project fails here and nowhere else |
| RLS | Warns if unauthenticated reads return rows |
| `archived IS NULL` jobs | The old query hid these completely |
| Unclosed time entries | Where hours actually go missing |
| Multiple open sessions | Only the newest is used; the rest strand their entries |
| Today / week totals | Numbers the app *should* be showing right now |

Finish by opening the app and confirming the two tabs match the totals it
printed. That single comparison catches almost any query-level regression.

**Run this first whenever something looks wrong.** It distinguishes "the data
is gone" from "the app can't see the data," which are very different problems.

---

## Layer 3: Manual, the parts a script can't check (10 minutes)

Do this against a scratch Supabase project, not the shop's live data.

### Sign-in states

Check these first, they're pure render-order logic, and getting them wrong
means the app never paints at all.

1. Signed out, hard reload → **Login screen**, not a stuck spinner
2. Sign in → job list appears
3. Sign out → back to Login, no spinner
4. Signed in, hard reload → brief spinner, then the list with totals intact

### The core loop

1. Clock in → General starts counting automatically
2. Tap a job → General stops, that job starts
3. Tap a second job → first stops, second starts, first keeps its total
4. Tap the running job → it stops, General resumes
5. Clock out → running job stops, session total freezes and stays on screen
6. Reload the page → every total is still there

### The failure modes that actually happen in a shop

| Scenario | How to force it | Expected |
|---|---|---|
| Phone sleeps mid-job | Lock the phone 2 min, unlock | Timer catches up, doesn't reset |
| Dead zone in the shop | DevTools → Network → Offline, then tap a job | Red banner, no silent loss |
| Recovers after signal | Go back online, hit Retry | Totals reload correctly |
| Killed mid-shift | Clock in, start a job, close the tab, reopen | Job is not stuck "running" forever |
| Fat-fingered double tap | Double-tap a job fast | One entry created, not two |
| Job name with a comma | Add `Smith, John` → Export CSV | Opens in Excel as one column |
| Two devices | Clock in on phone and laptop | Healthcheck warns about two open sessions |

### Crossing boundaries

The thing that used to break. Force it with your system clock rather than
waiting for the real thing:

1. Set the Mac clock to **4:55pm**, clock in, track a few minutes
2. Let it roll past **5:00pm**: the Today tab must keep the time, not zero out
3. Set it to **11:58pm Sunday** and roll into Monday. This Week resets, Today resets
4. Set it to **1:58am on 8 March 2026** (spring forward), no negative or 25-hour readings

Reset your clock afterwards.

---

## What changed, and why

| Fix | The bug it kills |
|---|---|
| `src/time.ts`, all boundaries pinned to Pacific | `toISOString().slice(0,10)` returned tomorrow's date after 5pm, so the day's hours dropped out of every query |
| `getWeekStart` no longer mutates its input | `now.setDate()` corrupted the caller's date object |
| `.not('archived', 'is', true)` | `.eq('archived', false)` silently excluded jobs where `archived` is NULL |
| Orphan recovery in `loadData` | Entries left open by a crash are now closed using the parent session's clock-out, so that time is counted instead of discarded |
| Error banners on every read and write | A failed load rendered as "No jobs yet," indistinguishable from a genuinely empty list |
| Stranded-time notice | If an entry truly can't be recovered you're told, rather than the hours quietly vanishing |
| Session closed before entry on clock-out | Ordering means a mid-way failure is recoverable instead of double-counting |
| Timer driven by state, not `Date.now()` in render | Fixed 4 React purity errors; the displayed timer could update unpredictably |
| `strict: true` in tsconfig | Null-checking was off across the whole app |
| In-flight guard on all writes | Double-tapping created two open entries |
| Refetch on tab focus | A phone waking from sleep showed a stale timer |
| CSV quoting + formula guard (`src/csv.ts`) | Commas broke the export; names starting `=` `+` `-` `@` executed as formulas in Excel |
| `formatTime` clamps negatives | Clock skew could render `-1:-3:-20` |
| All three date boundaries from one instant | Three separate `new Date()` calls could straddle midnight and yield a day outside its own week |
| Entries with no `session_id` counted as stranded | They were being skipped by the orphan scan entirely, unrecoverable *and* unreported |
| Sign-in render order | `loading` was checked before auth, stranding signed-out users on a permanent spinner |

---

## Security

### Verified clean

- No secrets anywhere in git history, scanned all branches for `service_role`,
  `sb_secret`, `sbp_`, and JWT-shaped strings
- `.env.local` is gitignored; only `.env.example` is tracked
- The key in use is `sb_publishable_…`, not a service_role key
- No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function`. React
  escapes all job names on render
- `mailto:` / `sms:` bodies are `encodeURIComponent`-encoded, so a job name
  can't inject extra headers like `&bcc=`
- `dist/` is not tracked

### The one that matters: RLS

**Your publishable key ships inside the public JS bundle. That is by design:
row-level security is the only thing protecting this data.**

Every query in the app is unscoped (`.from('jobs').select('*')` with no
`user_id` filter), so whatever RLS allows is exactly what any visitor gets.
`pnpm healthcheck` now tests this directly, hitting all three tables with an
unauthenticated client:

```
Row-level security (unauthenticated client)
  ✓ jobs: no rows visible anonymously
  ✓ sessions: no rows visible anonymously
  ✓ time_entries: no rows visible anonymously
...
  ✓ RLS confirmed: signed-in sees rows, anonymous sees none
```

Postgres RLS *filters* rather than erroring, so zero anonymous rows is the
normal shape of a working policy, the confirmation line is what settles it,
by comparing against the signed-in count. A `READABLE BY ANYONE` line is the
failure case and needs fixing before this goes anywhere public. Minimum viable
policy, signed-in users only:

```sql
alter table jobs         enable row level security;
alter table sessions     enable row level security;
alter table time_entries enable row level security;

create policy "authenticated access" on jobs for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
-- repeat for sessions and time_entries
```

That's the right shape for one shop where everyone shares the data. If you ever
want per-user separation you'd add a `user_id` column defaulting to
`auth.uid()` and scope on that instead, a schema change, worth doing
deliberately rather than in a hurry.

### Accepted, worth knowing

- **Any signed-in user sees all jobs and hours.** Correct for a single shop,
  wrong the moment you add a second one.
- **Supabase error text is shown in the banner.** It can name tables or
  policies. That diagnostic detail is the entire point of the change, and the
  audience is shop staff, so it's a fair trade, but don't carry this pattern
  into anything public-facing.
- **Password auth only, no MFA or password reset flow.** Supabase rate-limits
  sign-in attempts server-side.

---

## About the Supabase pause warning

Worth separating from the data issue. Pausing **freezes** a free-tier project:
the Postgres volume stays on disk and restoring returns it to the exact state
it was in, with a one-year window to do so. It would have made the app fail
completely, not lose selected days, so it isn't what you were seeing.

It's still worth acting on. The free plan keeps **zero backups**, so there's no
snapshot if something does go wrong. Two options: hit the project once a week
(a cron job or an uptime pinger against the REST endpoint is enough), or export
periodically:

```bash
pg_dump "$SUPABASE_DB_URL" > backup-$(date +%F).sql
```

Given this is real invoicing data for a real shop, a weekly dump to somewhere
off-platform is cheap insurance regardless of which plan you're on.

Sources: [Project Pausing. Supabase Docs](https://supabase.com/docs/guides/platform/free-project-pausing)

---

## Before each release

```bash
pnpm verify && pnpm healthcheck && pnpm build
```

Then Layer 3's core loop. Everything else only when you've touched that area.
