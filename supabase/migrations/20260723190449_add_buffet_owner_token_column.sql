-- owner_token identifies which browser created an entry (crypto.randomUUID(),
-- cached in localStorage), so the buffet-api Edge Function can let guests
-- free only their own entries. Split out from the RLS lockdown migration so
-- it could be applied immediately (purely additive, needed for saving to
-- work at all) without yet touching the anon policies.
alter table public.buffet add column if not exists owner_token text;
