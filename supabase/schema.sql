-- Gold verification app: schema, access rules and summary views.
-- Run once in the Supabase SQL editor (or `psql`) on a fresh project.
-- There is no sign-in: the app is for a small team on non-sensitive data, so
-- the browser's key reads and writes everything, and each person picks their
-- name from team_members. Rows and batches are written only through
-- load_gold() (the app's "Load gold rows" button); verdicts, batch assignees
-- and resolutions are written directly. A reviewer must be on team_members
-- (foreign key), which is what keeps names consistent.

create table if not exists team_members (
  email        text primary key,
  display_name text not null
);

create table if not exists batches (
  id             text primary key,
  tier           text not null check (tier in ('P1', 'P2', 'P3')),
  issuer         text not null,
  title          text not null,
  row_count      integer not null,
  document_count integer not null,
  assignee       text references team_members (email) on delete set null,
  assigned_at    timestamptz
);

create table if not exists rows (
  gold_id               text primary key,
  batch_id              text not null references batches (id),
  -- quarterly / annual / companion figures, or the evidence for an exclusion
  -- (which has no figure: value_reported is null).
  kind                  text not null default 'quarterly'
                        check (kind in ('quarterly', 'annual', 'companion', 'exclusion')),
  tier                  text not null check (tier in ('P1', 'P2', 'P3')),
  reasons               text[] not null default '{}',
  drug_name             text not null,
  generic_name          text,
  issuer                text not null,
  period                text not null,
  period_type           text not null check (period_type in ('quarter', 'year', 'none')),
  value_reported        numeric,
  currency              text not null default '',
  source_unit           text not null default '',
  source_value_reported numeric,
  value_usd_millions    numeric,
  derivation            text not null,
  scope                 text,
  line_label            text,
  source_url            text not null,
  source_quote          text not null,
  -- The figures a derived row is built from, each with its own document:
  -- [{value, source_url, label}]. Empty for a figure the document prints.
  inputs                jsonb not null default '[]'::jsonb,
  automated_check       text not null check (automated_check in ('pass', 'fail', 'none')),
  claude_checked        boolean not null default false,
  claude_note           text not null default '',
  claude_suggestion     text not null default '',
  -- False once a gold rebuild no longer contains the row; kept so its verdicts survive.
  in_current_gold       boolean not null default true,
  gold_build            text,
  loaded_at             timestamptz not null default now()
);
-- For a project created before the column existed.
alter table rows add column if not exists inputs jsonb not null default '[]'::jsonb;
create index if not exists rows_batch_idx on rows (batch_id);
create index if not exists rows_drug_idx on rows (drug_name, period);
create index if not exists rows_source_url_idx on rows (source_url);
create index if not exists batches_assignee_idx on batches (assignee);

-- One verdict per reviewer per row; saving again replaces it.
create table if not exists verdicts (
  gold_id         text not null references rows (gold_id) on delete cascade,
  reviewer        text not null references team_members (email),
  verdict         text not null check (verdict in (
                    'confirmed', 'wrong_value', 'wrong_period', 'wrong_scope',
                    'source_missing', 'cannot_access')),
  value_seen      numeric,
  note            text not null default '',
  -- The gold figure the reviewer was shown. If a rebuild changes the row,
  -- the verdict no longer speaks for it (see row_status.stale_verdicts).
  gold_value_seen numeric,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (gold_id, reviewer)
);
create index if not exists verdicts_reviewer_idx on verdicts (reviewer);

-- How a flagged row was settled.
create table if not exists resolutions (
  gold_id     text primary key references rows (gold_id) on delete cascade,
  outcome     text not null check (outcome in ('gold_correct', 'gold_needs_fix', 'cannot_decide')),
  note        text not null default '',
  resolved_by text not null references team_members (email),
  resolved_at timestamptz not null default now()
);
create index if not exists resolutions_resolved_by_idx on resolutions (resolved_by);

-- Settings read only by the source-preview Edge Function (service role), e.g.
-- sec_contact: the contact SEC asks automated clients to declare.
create table if not exists app_config (
  key   text primary key,
  value text not null
);
alter table app_config enable row level security;
revoke all on app_config from anon, authenticated;

-- Source documents the preview function has fetched, each kept gzipped in the
-- private `sources` storage bucket at `path`; written and read only by that
-- function (service role) and by scripts/warm_sources.py.
create table if not exists source_cache (
  url          text primary key,
  path         text not null,
  content_type text not null default '',
  final_url    text not null,
  bytes        bigint not null,
  fetched_at   timestamptz not null default now()
);
alter table source_cache enable row level security;
revoke all on source_cache from anon, authenticated;
insert into storage.buckets (id, name, public) values ('sources', 'sources', false)
on conflict (id) do nothing;

-- A verdict records which gold figure the reviewer was shown, whatever the
-- client sent, and when it was last changed.
create or replace function verdict_stamp() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.gold_value_seen := (select value_reported from rows where gold_id = new.gold_id);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists verdict_stamp on verdicts;
create trigger verdict_stamp before insert or update on verdicts
  for each row execute function verdict_stamp();

create or replace function resolution_stamp() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.resolved_at := now();
  return new;
end $$;
drop trigger if exists resolution_stamp on resolutions;
create trigger resolution_stamp before insert or update on resolutions
  for each row execute function resolution_stamp();

-- Only the assignee column of a batch may change from the app.
create or replace function batch_assign_only() returns trigger
  language plpgsql set search_path = public as $$
begin
  if auth.role() = 'service_role' or current_setting('app.loading_gold', true) = 'on' then
    return new;
  end if;
  if (new.id, new.tier, new.issuer, new.title, new.row_count, new.document_count)
     is distinct from
     (old.id, old.tier, old.issuer, old.title, old.row_count, old.document_count) then
    raise exception 'only the assignee of a batch can be changed';
  end if;
  new.assigned_at := case when new.assignee is null then null else now() end;
  return new;
end $$;
drop trigger if exists batch_assign_only on batches;
create trigger batch_assign_only before update on batches
  for each row execute function batch_assign_only();

-- Trigger functions are not API endpoints.
revoke execute on function verdict_stamp(), resolution_stamp(), batch_assign_only()
  from public, anon, authenticated;

-- Load or refresh gold rows from the app. Called in chunks: batches first,
-- then rows, then once with finish => true, which marks rows absent from this
-- build as no longer current. Nothing is deleted: a batch keeps its assignee
-- across loads and drops out of batch_progress once it has no current rows; a
-- row keeps its verdicts, and a verdict whose gold figure has since changed
-- shows as stale.
create or replace function load_gold(
  build text,
  batches_in jsonb default '[]'::jsonb,
  rows_in jsonb default '[]'::jsonb,
  finish boolean default false
) returns integer
  language plpgsql security definer set search_path = public as $$
declare
  written integer := 0;
begin
  perform set_config('app.loading_gold', 'on', true);

  insert into batches (id, tier, issuer, title, row_count, document_count)
  select b.id, b.tier, b.issuer, b.title, b.row_count, b.document_count
  from jsonb_to_recordset(batches_in)
    as b(id text, tier text, issuer text, title text, row_count int, document_count int)
  on conflict (id) do update set
    tier = excluded.tier, issuer = excluded.issuer, title = excluded.title,
    row_count = excluded.row_count, document_count = excluded.document_count;
  get diagnostics written = row_count;

  insert into rows (
    gold_id, batch_id, kind, tier, reasons, drug_name, generic_name, issuer, period, period_type,
    value_reported, currency, source_unit, source_value_reported, value_usd_millions,
    derivation, scope, line_label, source_url, source_quote, inputs, automated_check, claude_checked,
    claude_note, claude_suggestion, in_current_gold, gold_build, loaded_at)
  select r.gold_id, r.batch_id, coalesce(r.kind, 'quarterly'), r.tier, coalesce(r.reasons, '{}'), r.drug_name, r.generic_name,
         r.issuer, r.period, r.period_type, r.value_reported, coalesce(r.currency, ''),
         coalesce(r.source_unit, ''), r.source_value_reported, r.value_usd_millions,
         r.derivation, r.scope, r.line_label, r.source_url,
         r.source_quote, coalesce(r.inputs, '[]'::jsonb), r.automated_check, coalesce(r.claude_checked, false),
         coalesce(r.claude_note, ''), coalesce(r.claude_suggestion, ''), true, build, now()
  from jsonb_to_recordset(rows_in) as r(
    gold_id text, batch_id text, kind text, tier text, reasons text[], drug_name text, generic_name text,
    issuer text, period text, period_type text, value_reported numeric, currency text,
    source_unit text, source_value_reported numeric, value_usd_millions numeric,
    derivation text, scope text, line_label text, source_url text, source_quote text,
    inputs jsonb, automated_check text,
    claude_checked boolean, claude_note text, claude_suggestion text)
  on conflict (gold_id) do update set
    batch_id = excluded.batch_id, kind = excluded.kind, tier = excluded.tier, reasons = excluded.reasons,
    drug_name = excluded.drug_name, generic_name = excluded.generic_name,
    issuer = excluded.issuer, period = excluded.period, period_type = excluded.period_type,
    value_reported = excluded.value_reported, currency = excluded.currency,
    source_unit = excluded.source_unit, source_value_reported = excluded.source_value_reported,
    value_usd_millions = excluded.value_usd_millions, derivation = excluded.derivation,
    scope = excluded.scope, line_label = excluded.line_label, source_url = excluded.source_url,
    source_quote = excluded.source_quote, inputs = excluded.inputs, automated_check = excluded.automated_check,
    claude_checked = excluded.claude_checked, claude_note = excluded.claude_note,
    claude_suggestion = excluded.claude_suggestion, in_current_gold = true,
    gold_build = excluded.gold_build, loaded_at = now();
  get diagnostics written = row_count;

  if finish then
    -- Supabase refuses an API-role UPDATE without a WHERE (pg_safeupdate);
    -- this one also touches only the rows whose flag changes.
    update rows set in_current_gold = (gold_build = build)
    where in_current_gold is distinct from (gold_build = build);
  end if;
  return written;
end $$;
grant execute on function load_gold(text, jsonb, jsonb, boolean) to anon, authenticated;

alter table team_members enable row level security;
alter table batches      enable row level security;
alter table rows         enable row level security;
alter table verdicts     enable row level security;
alter table resolutions  enable row level security;

-- Open to the app's key: anyone with the address can read and write.
drop policy if exists members_read on team_members;
create policy members_read on team_members for select to anon, authenticated using (true);

drop policy if exists batches_read on batches;
create policy batches_read on batches for select to anon, authenticated using (true);
drop policy if exists batches_assign on batches;
create policy batches_assign on batches for update to anon, authenticated using (true) with check (true);

drop policy if exists rows_read on rows;
create policy rows_read on rows for select to anon, authenticated using (true);

drop policy if exists verdicts_read on verdicts;
create policy verdicts_read on verdicts for select to anon, authenticated using (true);
drop policy if exists verdicts_insert on verdicts;
create policy verdicts_insert on verdicts for insert to anon, authenticated with check (true);
drop policy if exists verdicts_update on verdicts;
create policy verdicts_update on verdicts for update to anon, authenticated using (true) with check (true);
-- Undo of a first verdict removes it.
drop policy if exists verdicts_delete on verdicts;
create policy verdicts_delete on verdicts for delete to anon, authenticated using (true);

drop policy if exists resolutions_read on resolutions;
create policy resolutions_read on resolutions for select to anon, authenticated using (true);
drop policy if exists resolutions_write on resolutions;
create policy resolutions_write on resolutions for insert to anon, authenticated with check (true);
drop policy if exists resolutions_update on resolutions;
create policy resolutions_update on resolutions for update to anon, authenticated using (true) with check (true);

-- Per-row state: how many people looked, whether anyone flagged it, whether
-- a flag was settled, and whether any verdict predates the current figure.
create or replace view row_status with (security_invoker = true) as
select
  r.gold_id,
  r.batch_id,
  r.tier,
  r.drug_name,
  r.period,
  count(v.reviewer)                                              as verdict_count,
  count(v.reviewer) filter (where v.verdict = 'confirmed')       as confirmed_count,
  count(v.reviewer) filter (where v.verdict <> 'confirmed')      as flagged_count,
  count(v.reviewer) filter (where v.gold_value_seen is distinct from r.value_reported) as stale_verdicts,
  bool_or(res.gold_id is not null)                               as resolved,
  case
    when count(v.reviewer) = 0 then 'unverified'
    when count(v.reviewer) filter (where v.verdict <> 'confirmed') > 0
         and not bool_or(res.gold_id is not null) then 'flagged'
    else 'verified'
  end                                                            as status,
  r.kind
from rows r
left join verdicts v on v.gold_id = r.gold_id
left join resolutions res on res.gold_id = r.gold_id
where r.in_current_gold
group by r.gold_id, r.batch_id, r.tier, r.drug_name, r.period, r.kind;

create or replace view batch_progress with (security_invoker = true) as
select
  b.id, b.tier, b.issuer, b.title, b.row_count, b.document_count, b.assignee, b.assigned_at,
  count(s.gold_id) filter (where s.status <> 'unverified') as verified_rows,
  count(s.gold_id) filter (where s.status = 'flagged')     as flagged_rows
from batches b
join row_status s on s.batch_id = b.id
group by b.id;

create or replace view tier_progress with (security_invoker = true) as
select tier,
       count(*)                                        as rows,
       count(*) filter (where status <> 'unverified')  as verified_rows,
       count(*) filter (where status = 'flagged')      as flagged_rows
from row_status group by tier;

create or replace view reviewer_progress with (security_invoker = true) as
select m.email, m.display_name,
       count(v.gold_id)                                           as verdicts,
       count(v.gold_id) filter (where v.verdict = 'confirmed')    as confirmed,
       count(v.gold_id) filter (where v.verdict <> 'confirmed')   as flagged,
       max(v.updated_at)                                          as last_active
from team_members m
left join verdicts v on v.reviewer = m.email
group by m.email, m.display_name;

-- Live updates in the app when someone saves a verdict or takes a batch.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table verdicts, batches, resolutions;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
