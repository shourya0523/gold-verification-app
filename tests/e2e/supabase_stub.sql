-- What a fresh Supabase project provides that schema.sql relies on: the API
-- roles, auth.jwt()/auth.role() reading PostgREST's request claims, and the
-- default grants Supabase gives those roles on new objects in public.
-- Roles belong to the cluster, so another database may have made them already.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'authenticator' noinherit;
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(auth.jwt() ->> 'role', '') $$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create publication supabase_realtime;
-- Storage's bucket table, for the bucket schema.sql declares. There is no
-- storage API here: the preview function's cache writes fail and it serves
-- each document straight from its source, which is its behaviour when caching
-- fails in production.
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
