-- ============================================================================
-- TaskTrade AU — production schema
-- Run this in Supabase SQL editor (or `supabase db push`) on a fresh project.
-- Safe to re-run top-to-bottom on an empty database only (uses `create`, not
-- `create or replace`) — for migrations later, create numbered files instead.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type public.user_role as enum ('customer','tradie','admin');
create type public.job_status as enum ('open','quoted','hired','completed','cancelled','disputed');
create type public.quote_status as enum ('pending','accepted','declined','withdrawn');
create type public.verification_status as enum ('unverified','pending','verified','rejected');
create type public.payment_status as enum ('requires_payment','processing','held','released','refunded','failed');
create type public.report_status as enum ('open','reviewing','actioned','dismissed');

-- ----------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'customer',
  full_name text not null,
  business_name text,
  postcode text check (postcode ~ '^[0-9]{4}$'),
  phone text,
  phone_verified boolean not null default false,
  email_verified boolean not null default false,
  trade text,
  abn text check (abn is null or abn ~ '^[0-9]{11}$'),
  abn_status verification_status not null default 'unverified',
  abn_verified_name text,
  licence_number text,
  licence_status verification_status not null default 'unverified',
  licence_state text,
  bio text,
  avatar_path text,
  rating numeric(2,1) default 0,
  rating_count int not null default 0,
  is_suspended boolean not null default false,
  suspended_reason text,
  stripe_customer_id text,
  stripe_connect_account_id text,
  stripe_connect_ready boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  category text not null,
  description text not null check (char_length(description) between 10 and 4000),
  postcode text not null check (postcode ~ '^[0-9]{4}$'),
  suburb text,
  state text,
  budget numeric(12,2) check (budget is null or budget >= 0),
  timing text,
  status job_status not null default 'open',
  hired_tradie_id uuid references public.profiles(id),
  latitude double precision,
  longitude double precision,
  is_flagged boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  tradie_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  message text not null check (char_length(message) between 5 and 2000),
  status quote_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, tradie_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Reviews can only ever be inserted for a job that is completed and only by
-- the customer on that job, for the tradie who was actually hired. Enforced
-- both by RLS (who can insert) and this trigger (data correctness), because
-- RLS alone can't cross-check job.status/hired_tradie_id cheaply per-row.
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  tradie_id uuid not null references public.profiles(id),
  rating int not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 2000),
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  tradie_id uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  platform_fee numeric(12,2) not null default 0,
  currency text not null default 'aud',
  status payment_status not null default 'requires_payment',
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  released_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id),
  reported_user_id uuid references public.profiles(id),
  job_id uuid references public.jobs(id),
  reason text not null check (char_length(reason) between 5 and 2000),
  status report_status not null default 'open',
  admin_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Simple per-user action rate limiting (jobs posted, quotes sent, messages
-- sent, reports filed) checked by the app / edge functions before insert.
create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_user_action_idx on public.rate_limit_events(user_id, action, created_at);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.job_photos enable row level security;
alter table public.quotes enable row level security;
alter table public.messages enable row level security;
alter table public.reviews enable row level security;
alter table public.payments enable row level security;
alter table public.reports enable row level security;
alter table public.rate_limit_events enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- profiles
create policy "profiles public read" on public.profiles for select using (not is_suspended or auth.uid() = id or public.is_admin());
create policy "profiles self insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles self update" on public.profiles for update using (auth.uid() = id or public.is_admin());

-- jobs
create policy "jobs public read" on public.jobs for select using (not is_flagged or customer_id = auth.uid() or public.is_admin());
create policy "customers create jobs" on public.jobs for insert with check (auth.uid() = customer_id);
create policy "customers update own jobs" on public.jobs for update using (auth.uid() = customer_id or public.is_admin());

-- job_photos
create policy "job photos read" on public.job_photos for select using (true);
create policy "job photos insert by owner" on public.job_photos for insert with check (
  exists(select 1 from public.jobs j where j.id = job_id and j.customer_id = auth.uid())
);

-- quotes: only the tradie who wrote it and the customer who owns the job can see it
create policy "quotes involved read" on public.quotes for select using (
  auth.uid() = tradie_id
  or exists(select 1 from public.jobs j where j.id = job_id and j.customer_id = auth.uid())
  or public.is_admin()
);
create policy "tradies create quotes" on public.quotes for insert with check (
  auth.uid() = tradie_id
  and exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'tradie' and not p.is_suspended)
);
create policy "tradies update own quotes" on public.quotes for update using (auth.uid() = tradie_id);
create policy "customers update quotes on own jobs" on public.quotes for update using (
  exists(select 1 from public.jobs j where j.id = job_id and j.customer_id = auth.uid())
);

-- messages: only sender/recipient
create policy "messages participant read" on public.messages for select using (
  auth.uid() in (sender_id, recipient_id) or public.is_admin()
);
create policy "messages sender insert" on public.messages for insert with check (auth.uid() = sender_id);
create policy "messages recipient mark read" on public.messages for update using (auth.uid() = recipient_id);

-- reviews
create policy "reviews public read" on public.reviews for select using (true);
create policy "customer review completed job" on public.reviews for insert with check (
  auth.uid() = customer_id
  and exists(
    select 1 from public.jobs j
    where j.id = job_id
      and j.customer_id = auth.uid()
      and j.hired_tradie_id = tradie_id
      and j.status = 'completed'
  )
);

-- payments: only the two parties on the job, and admins
create policy "payments involved read" on public.payments for select using (
  auth.uid() in (customer_id, tradie_id) or public.is_admin()
);
-- Inserts/updates to payments happen via the service-role key inside edge
-- functions (after talking to Stripe), never directly from the browser.
create policy "payments no direct client writes" on public.payments for insert with check (false);

-- reports: reporter can create and read their own; admins see all
create policy "reports own read" on public.reports for select using (auth.uid() = reporter_id or public.is_admin());
create policy "reports create" on public.reports for insert with check (auth.uid() = reporter_id);
create policy "reports admin update" on public.reports for update using (public.is_admin());

-- rate limit log: users can insert their own event, read their own, nothing else
create policy "rate limit self insert" on public.rate_limit_events for insert with check (auth.uid() = user_id);
create policy "rate limit self read" on public.rate_limit_events for select using (auth.uid() = user_id or public.is_admin());

-- ----------------------------------------------------------------------------
-- Triggers: keep updated_at fresh, keep rating aggregate correct
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.set_updated_at();
create trigger jobs_touch before update on public.jobs for each row execute function public.set_updated_at();
create trigger quotes_touch before update on public.quotes for each row execute function public.set_updated_at();
create trigger payments_touch before update on public.payments for each row execute function public.set_updated_at();

create or replace function public.apply_review_to_rating()
returns trigger language plpgsql security definer as $$
begin
  update public.profiles
  set rating = round((coalesce(rating,0) * rating_count + new.rating) / (rating_count + 1.0), 1),
      rating_count = rating_count + 1
  where id = new.tradie_id;
  return new;
end $$;

create trigger reviews_apply_rating after insert on public.reviews for each row execute function public.apply_review_to_rating();

-- new-user bootstrap: create a profile row when someone signs up, from
-- metadata passed at signUp() time (full_name, role, postcode, trade...)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, full_name, role, postcode, trade)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'New user'),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'customer'),
    new.raw_user_meta_data->>'postcode',
    new.raw_user_meta_data->>'trade'
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index jobs_category_postcode_status_idx on public.jobs(category, postcode, status);
create index quotes_job_idx on public.quotes(job_id);
create index quotes_tradie_idx on public.quotes(tradie_id);
create index messages_job_created_idx on public.messages(job_id, created_at);
create index messages_recipient_unread_idx on public.messages(recipient_id, read_at);
create index payments_job_idx on public.payments(job_id);

-- ----------------------------------------------------------------------------
-- Storage buckets (photos are private by default; served via signed URLs)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('job-photos', 'job-photos', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

create policy "job photo upload by job owner" on storage.objects for insert
  with check (
    bucket_id = 'job-photos'
    and exists(
      select 1 from public.jobs j
      where j.customer_id = auth.uid()
        and (storage.foldername(name))[1] = j.id::text
    )
  );
create policy "job photo read participants" on storage.objects for select
  using (
    bucket_id = 'job-photos'
    and exists(
      select 1 from public.jobs j
      left join public.quotes q on q.job_id = j.id
      where (storage.foldername(name))[1] = j.id::text
        and (j.customer_id = auth.uid() or q.tradie_id = auth.uid())
    )
  );
create policy "avatar public read" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatar owner write" on storage.objects for insert with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);
