-- Lock down public.buffet: all client access now goes through the
-- buffet-api Edge Function (service_role), so the previously wide-open
-- anon policies (select/insert/update/delete all `true`) are removed.
-- RLS stays enabled with zero policies for anon/authenticated => default
-- deny; service_role bypasses RLS regardless.

drop policy if exists "anon read" on public.buffet;
drop policy if exists "anon insert" on public.buffet;
drop policy if exists "anon update" on public.buffet;
drop policy if exists "anon delete" on public.buffet;

alter table public.buffet add column if not exists owner_token text;
