-- «Пуш RFM»: the push plan (copied from the push plan sheet by Claude), what was actually sent, and the reminders
-- that keep coming until a push is marked sent. The data lives only in the database, never in this repo.
create table if not exists as_push (
  num         int primary key,
  due_at      timestamptz not null,
  segment     text not null default '',
  why         text not null default '',
  source      text not null default '',
  places      text not null default '',
  title       text not null default '',
  body        text not null default '',
  news        text not null default '',
  bonus       text not null default '',
  measure     text not null default '',
  check_on    date,
  check_what  text not null default '',
  status      text not null default 'plan',  -- plan | sent | skipped | cancelled
  sent_count  int,
  sent_at     timestamptz,
  nags        int not null default 0,         -- how many reminders already went for this due_at
  msg_id      bigint,
  updated_at  timestamptz not null default now()
);
create index if not exists as_push_due on as_push (status, due_at);
alter table as_push enable row level security;
grant select, insert, update, delete on as_push to service_role;

-- Lists exported from uployal, kept only as hashed client id, RFM group, number of checks and last purchase date,
-- so a later export can show who came back after a push.
create table if not exists as_push_files (
  id         bigint generated always as identity primary key,
  push_num   int,
  kind       text not null default 'sent',     -- sent: who got the push · check: export made at the check date
  file_name  text not null,
  rows       jsonb not null default '[]',      -- [{i: hashed id, g: group, c: checks, l: 'YYYY-MM-DD'}]
  n          int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists as_push_files_num on as_push_files (push_num);
alter table as_push_files enable row level security;
grant select, insert, update, delete on as_push_files to service_role;
