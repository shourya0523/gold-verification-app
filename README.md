# Gold verification app

A small web app for a team checking gold rows against their sources. Each row
shows the figure, its quote and Claude's note beside the source document, with
the figure found and highlighted where the document allows.

Live at https://gold-verification-app.vercel.app/ (Vercel deploys this
repository's root on every push to `main`).

Gold itself lives in
[`shourya0523/pharma-analog-uptake-workbench`](https://github.com/shourya0523/pharma-analog-uptake-workbench)
under `seed/gold/`. This tool is kept in its own repository on purpose: it is
built on the answer key, and nothing the workbench's pipeline reads may come
from the answer key (that repository's CLAUDE.md, rule 3). Scripts here read
gold from a workbench checkout: `$WORKBENCH`, or by default a sibling folder
named `pharma-analog-uptake-workbench`.

## What is in it

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `preview.js`, `export.js`, `style.css`, `config.js` | The app: static files, no build step. `config.js` names the Supabase project. |
| `scripts/build_rows.py` | Turns gold into `data/rows.json`: every gold row that cites a source (quarterly, annual and companion figures, and the evidence for each exclusion), with a priority tier, reasons, Claude's note and a batch. |
| `scripts/prefetch_sources.py` | Warms the source cache: fetches every cited document once through the `source` function, paced at 2 per second, skipping what is already cached. |
| `scripts/pull_verdicts.py` | Snapshots the app's verdicts into the workbench checkout, for its tracker workbook. |
| `supabase/schema.sql` | Tables, open access rules (no sign-in), a trigger that records the gold figure each reviewer was shown, `load_gold()`, and the progress views. |
| `supabase/functions/source` | Edge Function that fetches a row's source document for the in-app preview. It serves only URLs some gold row cites. Deploy with JWT verification off. |
| `tests/` | `test_build_rows.py` (every sourced gold row is served once, unchanged), `test_pull_verdicts.py`, and `e2e/` (the whole app against a local stand-in for Supabase). |
| `docs/design-specimen.html` | The design language the app was built to. |

## Using it

- **No sign-in.** On first visit, pick your name; the browser remembers it, and **Switch** changes it. Anyone with the address can use the app: it holds nothing sensitive.
- **Queue**: pick a tier (P1 first), filter to your batches or unassigned ones, **Claim** a batch (or set anyone as its assignee), and open it. To assign many at once, tick batches (or *Select all shown*) and use **Claim selected** or **Assign selected to…**.
- **Review**: the row is on the left, the document on the right.
  - `1` confirms. `F` then `2`–`6` flags a reason (wrong value, period or scope; not in the source; can't open it). Type the value you read and press `Enter`.
  - `J`/`K` move between rows. `O` opens the source in a separate tab, `/` searches inside the document, and Undo appears after every save.
- **Flags**: every row someone flagged, with all verdicts. Settle each as "gold is correct", "gold needs a fix" or "can't decide".
- **Progress**: counts by tier, kind and reviewer. Also the gold loader, and a CSV of all verdicts.
- **Export Excel** (top bar): downloads the tracker workbook as it stands: a checklist per product, every gold row with its verdicts, and every verdict.

## Running it

### Team members

Add someone by email and display name; they then appear on the first screen.
Ask Claude with the emails and names, or run this in the Supabase SQL editor:

    insert into team_members (email, display_name) values ('name@company.com', 'Name')
      on conflict (email) do update set display_name = excluded.display_name;

### Loading or refreshing gold

    python scripts/build_rows.py

Then in the app go to **Progress → Gold rows** and choose `data/rows.json`.

- **Matching:** the loader confirms the database holds exactly the file's rows.
- **Reloading after gold changes:** reloading keeps every verdict. Rows no longer in gold drop out of the queue. A verdict given against a figure that has since changed is marked for re-checking.

### One-time settings

- **SEC contact:** SEC asks automated clients to name a contact. Each preview request declares the requesting reviewer's own `team_members` email (so SEC rate-limits reviewers separately). When none is sent, the function falls back to one from `app_config`:

      insert into app_config values ('sec_contact', 'Team name contact@company.com')
        on conflict (key) do update set value = excluded.value;

- **Source cache:** the preview function stores each fetched document in the private `source-cache` storage bucket (created by `supabase/schema.sql`, along with the `source_cache` table), so repeat views never go back to SEC. Re-run `schema.sql` and redeploy the function to enable it. To refetch a document, delete its `source_cache` row.

### The tracker workbook in the workbench

**Export Excel** in the app is the quick way. To fill the workbench's own
tracker (`exports/gold_verification_tracker.xlsx`, which also carries Claude's
verification columns) with the app's verdicts:

    # from the app's CSV download (Progress → Download all verdicts), or --from-supabase
    python scripts/pull_verdicts.py --from-csv gold-verdicts-YYYY-MM-DD.csv
    # then, in the workbench checkout
    python scripts/sourcing/build_verification_tracker.py

`--from-supabase` needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
environment. The snapshot lands in the workbench's
`docs/sourcing/human_verdicts.json`; committing it there lets anyone rebuild the
same tracker.

### Tests

    pytest tests

The end-to-end run uses a local Supabase stand-in:

- **Stack:** Postgres with `schema.sql`, PostgREST, and the real Edge Function under Deno.
- **Steps:** it loads gold through the app's own button and drives the review flow in Chromium. It then compares every database row with gold.
- **Running it:** see the header of `tests/e2e/run_e2e.sh` for what it needs.

      tests/e2e/run_e2e.sh
