-- What the app or the bot did that Trello still has to show: a ticked or unticked line on a day card, or a new
-- done line such as «Пуш №12 надіслано». Claude applies the queue to the board «Мої задачі Кебабця» at every
-- Trello sync (until the server gets its own Trello key) and fills done_at.
create table if not exists as_trello_queue (
  id         bigint generated always as identity primary key,
  action     text not null,                 -- check | uncheck | add
  card       text not null default '',      -- the day card's name as in the snapshot, e.g. «02.11»
  item       text not null,                 -- the checklist line
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  error      text
);
create index if not exists as_trello_queue_open on as_trello_queue (done_at);
alter table as_trello_queue enable row level security;
grant select, insert, update, delete on as_trello_queue to service_role;
