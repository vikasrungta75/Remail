// Database migrations. Applied in order, tracked in schema_migrations.
// Add new migrations to the end of the list; never edit an applied one.
export const migrations: { id: string; sql: string }[] = [
{ id: '001_init', sql: String.raw`
-- remail schema v1
-- All timestamps are timestamptz (UTC). All ids are bigserial unless noted.

create extension if not exists pgcrypto;

-- ── Organisation & identity ────────────────────────────────────────────────
create table if not exists organisations (
  id              bigserial primary key,
  name            text not null,
  internal_domains text[] not null default '{}',
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists users (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  email           text not null,
  full_name       text not null default '',
  role            text not null default 'viewer' check (role in ('admin','manager','analyst','viewer')),
  auth_provider   text not null default 'local' check (auth_provider in ('local','ravity')),
  external_id     text,
  password_hash   text,
  is_active       boolean not null default true,
  all_mailboxes   boolean not null default false,
  timezone        text not null default 'America/Toronto',
  notify_email    boolean not null default true,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists users_email_uq on users (lower(email));

create table if not exists sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         bigint not null references users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  ip_address      text,
  user_agent      text
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists password_resets (
  id              bigserial primary key,
  user_id         bigint not null references users(id) on delete cascade,
  token_hash      text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

-- ── Mailboxes & connectors ─────────────────────────────────────────────────
create table if not exists mailboxes (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  provider        text not null check (provider in ('microsoft','microsoft_app','gmail','upload','demo')),
  address         text not null,
  display_name    text not null default '',
  -- encrypted OAuth refresh token (AES-256-GCM, base64) for delegated connections
  credentials_enc text,
  status          text not null default 'active' check (status in ('active','paused','error','pending')),
  last_error      text,
  sync_state      jsonb not null default '{}'::jsonb,   -- delta links / history ids per folder
  backfill_days   int not null default 30,
  last_synced_at  timestamptz,
  messages_synced bigint not null default 0,
  created_by      bigint references users(id),
  created_at      timestamptz not null default now()
);
create unique index if not exists mailboxes_org_addr_uq on mailboxes (org_id, provider, lower(address));

create table if not exists user_mailboxes (
  user_id         bigint not null references users(id) on delete cascade,
  mailbox_id      bigint not null references mailboxes(id) on delete cascade,
  primary key (user_id, mailbox_id)
);

-- ── Customers ──────────────────────────────────────────────────────────────
create table if not exists customers (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  name            text not null,
  domains         text[] not null default '{}',
  tier            text not null default 'standard' check (tier in ('strategic','key','standard')),
  account_owner   text,
  notes           text,
  health_score    int,
  health_status   text check (health_status in ('satisfied','neutral','at_risk','dissatisfied')),
  health_trend    int not null default 0,
  last_contact_at timestamptz,
  auto_created    boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists customers_org_idx on customers (org_id);
create index if not exists customers_domains_idx on customers using gin (domains);

create table if not exists contacts (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  customer_id     bigint references customers(id) on delete set null,
  email           text not null,
  name            text not null default '',
  created_at      timestamptz not null default now()
);
create unique index if not exists contacts_org_email_uq on contacts (org_id, lower(email));

-- ── Conversations & emails ─────────────────────────────────────────────────
create table if not exists conversations (
  id                 bigserial primary key,
  org_id             bigint not null references organisations(id) on delete cascade,
  customer_id        bigint references customers(id) on delete set null,
  subject            text not null default '',
  normalized_subject text not null default '',
  first_message_at   timestamptz,
  last_message_at    timestamptz,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  message_count      int not null default 0,
  inbound_count      int not null default 0,
  duplicate_count    int not null default 0,
  mailbox_ids        bigint[] not null default '{}',
  participants       text[] not null default '{}',
  awaiting_reply     boolean not null default false,
  first_response_minutes int,
  -- analysis
  summary            text,
  sentiment          text check (sentiment in ('positive','neutral','negative')),
  sentiment_score    real,
  rag                text check (rag in ('red','amber','green')),
  rag_reason         text,
  customer_state     text check (customer_state in ('satisfied','neutral','at_risk','dissatisfied')),
  urgency            text check (urgency in ('low','medium','high','critical')),
  escalation_risk    int,
  priority_score     int not null default 0,
  categories         text[] not null default '{}',
  topics             text[] not null default '{}',
  entities           jsonb not null default '{}'::jsonb,
  suggested_reply    text,
  analysis_model     text,
  analysed_at        timestamptz,
  needs_analysis     boolean not null default true,
  -- workflow
  status             text not null default 'open' check (status in ('open','in_progress','resolved','ignored')),
  assignee_id        bigint references users(id) on delete set null,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists conv_org_last_idx on conversations (org_id, last_message_at desc);
create index if not exists conv_customer_idx on conversations (customer_id);
create index if not exists conv_rag_idx on conversations (org_id, rag);
create index if not exists conv_needs_analysis_idx on conversations (needs_analysis) where needs_analysis;
create index if not exists conv_norm_subject_idx on conversations (org_id, normalized_subject);

create table if not exists conversation_keys (
  conversation_id bigint not null references conversations(id) on delete cascade,
  key             text not null,
  primary key (key)
);
create index if not exists conv_keys_conv_idx on conversation_keys (conversation_id);

create table if not exists emails (
  id                   bigserial primary key,
  org_id               bigint not null references organisations(id) on delete cascade,
  mailbox_id           bigint not null references mailboxes(id) on delete cascade,
  conversation_id      bigint references conversations(id) on delete set null,
  provider_message_id  text not null,
  internet_message_id  text,
  provider_thread_id   text,
  in_reply_to          text,
  dedup_key            text not null,
  content_hash         text not null,
  is_duplicate         boolean not null default false,
  duplicate_of         bigint references emails(id) on delete set null,
  direction            text not null check (direction in ('inbound','outbound','internal')),
  from_address         text not null default '',
  from_name            text not null default '',
  to_addresses         text[] not null default '{}',
  cc_addresses         text[] not null default '{}',
  subject              text not null default '',
  body_text            text not null default '',
  body_clean           text not null default '',
  snippet              text not null default '',
  has_attachments      boolean not null default false,
  importance           text,
  web_link             text,
  sent_at              timestamptz not null,
  sentiment            text check (sentiment in ('positive','neutral','negative')),
  sentiment_score      real,
  created_at           timestamptz not null default now()
);
create unique index if not exists emails_mailbox_msg_uq on emails (mailbox_id, provider_message_id);
create index if not exists emails_dedup_idx on emails (org_id, dedup_key);
create index if not exists emails_content_idx on emails (org_id, content_hash);
create index if not exists emails_conv_idx on emails (conversation_id, sent_at);
create index if not exists emails_org_sent_idx on emails (org_id, sent_at desc);
create index if not exists emails_imid_idx on emails (org_id, internet_message_id);

-- ── Insights ───────────────────────────────────────────────────────────────
create table if not exists issues (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  conversation_id bigint not null references conversations(id) on delete cascade,
  customer_id     bigint references customers(id) on delete set null,
  category        text not null,
  description     text not null,
  severity        text not null default 'medium' check (severity in ('low','medium','high','critical')),
  detected_at     timestamptz not null default now()
);
create index if not exists issues_org_cat_idx on issues (org_id, category, detected_at);
create index if not exists issues_conv_idx on issues (conversation_id);

create table if not exists action_items (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  conversation_id bigint not null references conversations(id) on delete cascade,
  customer_id     bigint references customers(id) on delete set null,
  description     text not null,
  owner_side      text not null default 'us' check (owner_side in ('us','customer')),
  owner_name      text,
  is_commitment   boolean not null default false,
  due_date        date,
  status          text not null default 'open' check (status in ('open','done','dismissed')),
  assignee_id     bigint references users(id) on delete set null,
  fingerprint     text not null,
  source_email_id bigint references emails(id) on delete set null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create unique index if not exists actions_fp_uq on action_items (conversation_id, fingerprint);
create index if not exists actions_org_status_idx on action_items (org_id, status, due_date);

create table if not exists customer_health_daily (
  customer_id     bigint not null references customers(id) on delete cascade,
  day             date not null,
  health_score    int not null,
  negative_pct    real not null default 0,
  red_count       int not null default 0,
  email_count     int not null default 0,
  primary key (customer_id, day)
);

create table if not exists conversation_notes (
  id              bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  user_id         bigint references users(id) on delete set null,
  body            text not null,
  created_at      timestamptz not null default now()
);

-- ── Alerts ─────────────────────────────────────────────────────────────────
create table if not exists alert_rules (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  name            text not null,
  enabled         boolean not null default true,
  rule_type       text not null check (rule_type in ('rag_red','negative_key_customer','escalation_risk','keyword','sla_breach','health_drop')),
  params          jsonb not null default '{}'::jsonb,
  severity        text not null default 'high' check (severity in ('medium','high','critical')),
  channels        text[] not null default '{in_app,email}',
  recipients      text[] not null default '{}',
  escalate_after_minutes int,
  escalation_recipients  text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create table if not exists alerts (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  rule_id         bigint references alert_rules(id) on delete set null,
  conversation_id bigint references conversations(id) on delete cascade,
  customer_id     bigint references customers(id) on delete set null,
  severity        text not null,
  title           text not null,
  body            text not null default '',
  dedup_key       text not null,
  status          text not null default 'open' check (status in ('open','acknowledged','resolved')),
  escalation_level int not null default 0,
  escalated_at    timestamptz,
  acknowledged_by bigint references users(id) on delete set null,
  acknowledged_at timestamptz,
  delivered       jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists alerts_dedup_uq on alerts (org_id, dedup_key);
create index if not exists alerts_org_status_idx on alerts (org_id, status, created_at desc);

-- ── Reports ────────────────────────────────────────────────────────────────
create table if not exists report_schedules (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  name            text not null,
  frequency       text not null check (frequency in ('daily','weekly','monthly')),
  hour_utc        int not null default 7 check (hour_utc between 0 and 23),
  day_of_week     int default 1 check (day_of_week between 0 and 6),
  day_of_month    int default 1 check (day_of_month between 1 and 28),
  recipients      text[] not null default '{}',
  filters         jsonb not null default '{}'::jsonb,
  enabled         boolean not null default true,
  last_run_at     timestamptz,
  created_by      bigint references users(id),
  created_at      timestamptz not null default now()
);

create table if not exists report_runs (
  id              bigserial primary key,
  org_id          bigint not null references organisations(id) on delete cascade,
  schedule_id     bigint references report_schedules(id) on delete set null,
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  html            text not null,
  summary         jsonb not null default '{}'::jsonb,
  recipients      text[] not null default '{}',
  delivery_status text not null default 'pending',
  created_at      timestamptz not null default now()
);

-- ── Ops ────────────────────────────────────────────────────────────────────
create table if not exists sync_runs (
  id              bigserial primary key,
  mailbox_id      bigint references mailboxes(id) on delete cascade,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  fetched         int not null default 0,
  inserted        int not null default 0,
  duplicates      int not null default 0,
  error           text
);

create table if not exists audit_log (
  id              bigserial primary key,
  org_id          bigint,
  user_id         bigint references users(id) on delete set null,
  user_email      text,
  action          text not null,
  entity_type     text,
  entity_id       text,
  details         jsonb not null default '{}'::jsonb,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists audit_org_time_idx on audit_log (org_id, created_at desc);

create table if not exists ai_usage (
  id              bigserial primary key,
  org_id          bigint,
  model           text not null,
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  purpose         text not null,
  created_at      timestamptz not null default now()
);

create table if not exists oauth_states (
  state           text primary key,
  user_id         bigint references users(id) on delete cascade,
  provider        text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
` },
{ id: '002_categories_views_microsoft', sql: String.raw`
alter table users drop constraint if exists users_auth_provider_check;
alter table users add constraint users_auth_provider_check check (auth_provider in ('local','ravity','microsoft'));
alter table users add column if not exists ms_object_id text;
alter table users add column if not exists email_aliases text[] not null default '{}';
alter table users add column if not exists digest_enabled boolean not null default true;
alter table users add column if not exists last_digest_at timestamptz;
alter table users add column if not exists ravity_space_key text;

alter table sessions add column if not exists iam_token_enc text;

alter table emails add column if not exists is_automated boolean not null default false;

alter table conversations add column if not exists business_category text not null default 'other';
alter table conversations add column if not exists is_internal boolean not null default false;
alter table conversations add column if not exists is_automated boolean not null default false;
alter table conversations add column if not exists staff_participants text[] not null default '{}';
alter table conversations add column if not exists proposal jsonb;
alter table conversations add column if not exists proposal_stage text;
alter table conversations add column if not exists proposal_stage_locked boolean not null default false;
alter table conversations add column if not exists category_locked boolean not null default false;
create index if not exists conv_bcat_idx on conversations (org_id, business_category, last_message_at desc);
create index if not exists conv_staff_idx on conversations using gin (staff_participants);

alter table action_items add column if not exists source text not null default 'ai';
alter table action_items add column if not exists created_by bigint references users(id) on delete set null;
alter table action_items add column if not exists reminder_sent_at timestamptz;
alter table action_items add column if not exists notes text;
alter table action_items alter column conversation_id drop not null;

alter table alert_rules drop constraint if exists alert_rules_rule_type_check;
alter table alert_rules add constraint alert_rules_rule_type_check check (rule_type in ('rag_red','negative_key_customer','escalation_risk','keyword','sla_breach','health_drop','action_overdue','proposal_deadline'));
insert into alert_rules (org_id, name, rule_type, params, severity, channels, recipients)
  select o.id, 'Action overdue', 'action_overdue', '{"days":1}', 'medium', '{in_app,email}', '{}' from organisations o
   where not exists (select 1 from alert_rules r where r.org_id=o.id and r.rule_type='action_overdue');
insert into alert_rules (org_id, name, rule_type, params, severity, channels, recipients)
  select o.id, 'Proposal deadline within 2 days', 'proposal_deadline', '{"days":2}', 'high', '{in_app,email}', '{}' from organisations o
   where not exists (select 1 from alert_rules r where r.org_id=o.id and r.rule_type='proposal_deadline');
alter table customers add column if not exists kind text not null default 'customer';
alter table customers add column if not exists kind_locked boolean not null default false;
update conversations set needs_analysis = true;
` },
{ id: '003_remove_demo_data', sql: String.raw`
-- one-time clean-up: remove any demo dataset so only real mail remains
delete from conversations where id in (
  select distinct e.conversation_id from emails e join mailboxes m on m.id = e.mailbox_id
   where m.provider = 'demo' and e.conversation_id is not null);
delete from mailboxes where provider = 'demo';
delete from customers c where not exists (select 1 from conversations v where v.customer_id = c.id);
delete from alerts where conversation_id is null and customer_id is null;
delete from action_items where conversation_id is null and source = 'demo';
` },
{ id: '004_google_workspace', sql: String.raw`
-- Gmail edition: Google sign-in and Workspace shared mailboxes (domain-wide delegation)
alter table mailboxes drop constraint if exists mailboxes_provider_check;
alter table mailboxes add constraint mailboxes_provider_check check (provider in ('microsoft','microsoft_app','gmail','gmail_app','upload','demo'));
alter table users drop constraint if exists users_auth_provider_check;
alter table users add constraint users_auth_provider_check check (auth_provider in ('local','ravity','microsoft','google'));
alter table users add column if not exists google_sub text;
create unique index if not exists users_google_sub_uq on users (google_sub) where google_sub is not null;
` },
{ id: '005_reply_drafts', sql: String.raw`
-- AI-drafted replies, kept in the app until a person presses Send (then sent through Gmail in-thread)
create table if not exists reply_drafts (
  id               bigserial primary key,
  org_id           bigint not null references organisations(id) on delete cascade,
  conversation_id  bigint not null references conversations(id) on delete cascade,
  body             text not null default '',
  generated_body   text not null default '',
  model            text,
  edited           boolean not null default false,
  status           text not null default 'draft' check (status in ('draft','sent','dismissed','replied_elsewhere')),
  to_addresses     text[] not null default '{}',
  cc_addresses     text[] not null default '{}',
  subject          text not null default '',
  reply_to_email_id bigint references emails(id) on delete set null,
  send_mailbox_id  bigint references mailboxes(id) on delete set null,
  generated_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       bigint references users(id) on delete set null,
  sent_at          timestamptz,
  sent_by          bigint references users(id) on delete set null,
  provider_message_id text,
  last_error       text
);
create unique index if not exists reply_drafts_conv_uq on reply_drafts (conversation_id);
create index if not exists reply_drafts_org_status_idx on reply_drafts (org_id, status, generated_at desc);
alter table mailboxes alter column backfill_days set default 90;
` },
{ id: '006_worker_lease_ai_state', sql: String.raw`
-- one background run at a time (the scheduler fires every 5 minutes, a run lasts up to 13)
create table if not exists worker_lease (
  name   text primary key,
  holder text,
  until  timestamptz not null default now()
);
-- AI provider back-off: when the quota is used up, analysis pauses instead of retrying
create table if not exists ai_state (
  id            int primary key default 1,
  paused_until  timestamptz,
  last_error    text,
  last_error_at timestamptz,
  check (id = 1)
);
insert into ai_state (id) values (1) on conflict do nothing;
` },
{ id: '007_ai_state_provider', sql: String.raw`
-- a quota pause belongs to one provider, so switching provider is not held back by the old one's pause
alter table ai_state add column if not exists provider text;
` },
{ id: '008_subgroups_templates_reference', sql: String.raw`
-- subgroup (subheading) within business_category
alter table conversations add column if not exists subcategory text;
alter table conversations add column if not exists subcategory_locked boolean not null default false;
create index if not exists conversations_org_cat_sub_idx on conversations (org_id, business_category, subcategory);
-- default reply template per subgroup; seeded from server/templates.ts, editable by admins
create table if not exists reply_templates (
  id          bigserial primary key,
  org_id      bigint not null references organisations(id) on delete cascade,
  group_key   text not null,
  subgroup_key text not null,
  title       text not null,
  body        text not null,
  guidance    text not null default '',
  is_active   boolean not null default true,
  is_default  boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  bigint references users(id) on delete set null,
  unique (org_id, group_key, subgroup_key)
);
-- reference data used in drafts: book catalogue, FAQs and policies
create table if not exists reference_items (
  id          bigserial primary key,
  org_id      bigint not null references organisations(id) on delete cascade,
  kind        text not null check (kind in ('book','faq','policy')),
  code        text,
  title       text not null,
  body        text not null default '',
  keywords    text[] not null default '{}',
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
create index if not exists reference_items_org_kind_idx on reference_items (org_id, kind);
create unique index if not exists reference_items_code_uq on reference_items (org_id, kind, code) where code is not null;
-- existing threads get a subgroup from the rules engine in the background (no AI cost); new mail gets it from the AI
` },
{ id: '009_customer_profiles', sql: String.raw`
-- customer database: what is known about each shipper, broker, carrier, consignee or supplier, gathered from their emails
alter table customers add column if not exists profile jsonb not null default '{}';
alter table customers add column if not exists profile_manual jsonb not null default '{}';
alter table customers add column if not exists profile_source text;
alter table customers add column if not exists profile_at timestamptz;
create index if not exists customers_profile_at_idx on customers (org_id, profile_at);
` },
{ id: '010_customer_enrichment', sql: String.raw`
-- what remail adds to a customer record: activity, region from postal code, possible duplicates, an organisation's own website
alter table customers add column if not exists enrichment jsonb not null default '{}';
alter table customers add column if not exists enriched_at timestamptz;
` },
];
