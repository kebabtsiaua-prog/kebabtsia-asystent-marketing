-- Notes the user leaves for Claude in the app: a message on a project, or a new project to add.
-- Claude reads open rows at every sync, adds them to the project list, writes a short answer and fills done_at.
create table if not exists as_inbox (
  id         bigint generated always as identity primary key,
  tg_id      bigint not null,
  kind       text not null default 'note',  -- note | project
  project    text not null default '',      -- project number from the list, empty for a new project
  text       text not null,
  answer     text,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index if not exists as_inbox_open on as_inbox (done_at);
alter table as_inbox enable row level security;
grant select, insert, update, delete on as_inbox to service_role;
