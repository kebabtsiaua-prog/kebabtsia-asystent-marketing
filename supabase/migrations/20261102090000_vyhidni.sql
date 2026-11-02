-- Files the bot sends on its own at a set time, such as the weekly PDF report Claude prepares on Sunday for Monday morning.
-- The file is kept as base64 text and cleared once sent.
create table if not exists as_outbox (
  id         bigint generated always as identity primary key,
  tg_id      bigint not null,
  file_name  text not null,
  file_b64   text,
  caption    text not null default '',
  send_after timestamptz not null,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists as_outbox_due on as_outbox (sent_at, send_after);
alter table as_outbox enable row level security;
grant select, insert, update, delete on as_outbox to service_role;
