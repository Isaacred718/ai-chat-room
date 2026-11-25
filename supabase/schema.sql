-- AI Chat Room schema. Safe to re-run (idempotent where reasonable).
-- SECURITY: this is a single-user app. After creating Isaac's auth user,
-- DISABLE SIGNUPS in the Supabase dashboard (Authentication > Providers > Email
-- > "Allow new users to sign up" off). Policies below allow ANY authenticated
-- user full access, so nobody else may ever be able to create an account.
-- The anon role has no policies, so it can read/write nothing.

create extension if not exists pgcrypto;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sender text,
  kind text not null check (kind in ('user','live','simulated','failed','system')),
  content text,
  agent text,
  machine text,
  job_id uuid null
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('chat','dispatch')),
  prompt text,
  lane text,
  agent text,
  classification text default 'auto',
  route_mode text default 'auto',
  route_note text,
  target_machine text,
  status text not null default 'pending'
    check (status in ('pending','running','done','failed','cancelled')),
  result text,
  error text,
  placeholder_message_id uuid null,
  claimed_by text,
  claimed_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.presence (
  machine text primary key,
  online boolean not null default false,
  checked_at timestamptz,
  detail text
);

create index if not exists jobs_status_created_idx on public.jobs (status, created_at);
create index if not exists messages_created_idx on public.messages (created_at);

alter table public.messages enable row level security;
alter table public.jobs enable row level security;
alter table public.presence enable row level security;

do $$
declare t text;
begin
  foreach t in array array['messages','jobs','presence'] loop
    execute format('drop policy if exists "authenticated full access" on public.%I', t);
    execute format(
      'create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Realtime publication (guarded so re-runs do not error).
do $$
declare t text;
begin
  foreach t in array array['messages','jobs','presence'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
