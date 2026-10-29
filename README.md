# remail by Ravity

AI email intelligence for **Wheel King TransHaul**. remail reads customer and operational email across Outlook (Microsoft 365) and Gmail mailboxes with read-only access. It rebuilds threads, removes duplicates and runs AI analysis on every conversation. The results feed a live customer-communication health dashboard, alerts, escalations and scheduled reports.

The look, layout and sign-in follow **rfleet.ai**: a navy side menu, the same glass sign-in card and the Ravity design system.

## What it does

| Area | Capabilities |
| --- | --- |
| Email analysis | Monitors multiple Microsoft 365 mailboxes (shared or user) and Gmail. Delta sync covers Inbox and Sent Items. Threads are rebuilt across mailboxes. Duplicates are removed by Message-ID and content fingerprint. Quoted text and signatures are stripped. Each conversation gets a concise summary. |
| Sentiment and customer experience | Sentiment per email and per conversation (positive, neutral, negative). Customer state (satisfied, neutral, at risk, dissatisfied). Explainable red, amber and green rating. A 0–100 customer health score with history and a 7-day trend. Priority scoring for critical issues. |
| Actionable insights | 17-category logistics taxonomy covering delays, missed collections, damage, billing, POD, driver conduct, contract and escalation risk, and more. Extracts commitments and action items with due dates. Spots recurring issues per customer and emerging topics. Captures key references (shipments, invoices, trucks, amounts). |
| Dashboard and reporting | Real-time overview that refreshes every 30 seconds, filtered by date, customer, mailbox, sentiment, rating, status, issue type and tier. Trend charts and a critical-issues queue. Customer health views. Branded HTML reports by email (daily, weekly or monthly) plus on-demand preview and CSV export. |
| Alerts and notifications | Six configurable rule types: red, negative key customer, escalation risk, watch-words, reply SLA breach and health drop. Delivered in-app, by email, to Microsoft Teams or to Slack. Alerts not acknowledged in time escalate automatically. |
| Beyond the brief | **Mail Sage**, an AI copilot that answers questions with citations. Suggested draft replies (never sent). Reply-time SLA tracking. Assignment and team notes. Customer merge and tiering. .eml import and a demo dataset. |
| Security and compliance | Read-only Graph and Gmail scopes. Microsoft 365 production access restricted to the five mailboxes by an Exchange application access policy. AES-256-GCM encryption of OAuth tokens. Signed sessions that can be revoked. Role-based access (admin, manager, analyst, viewer) with per-mailbox restriction. Full audit log. PII redaction before AI. Configurable retention. |

## Architecture

```
 Outlook / M365 (Graph, Mail.Read) ─┐
 Gmail (gmail.readonly) ────────────┼─► Netlify background worker (every 5 min)
 .eml upload ───────────────────────┘        │ sync → normalise → dedupe → thread → customer match
                                             ▼
                                        Postgres (Neon / Netlify DB)
                                             ▲            │
            AI analysis (Claude / Azure OpenAI / rules) ◄─┘  summaries, sentiment, RAG, actions, issues
                                             │
                    alerts (email / Teams / Slack) · scheduled reports · escalations
                                             │
 React SPA (Vite) ◄── /api/* Netlify Function ── auth (Ravity IAM like rfleet, or local), RBAC, audit
```

* **Frontend:** React 18, React Router, TanStack Query, ApexCharts and SCSS using the Ravity design tokens.
* **Backend:** Netlify Functions v2 written in TypeScript. `api` serves the REST API. `scheduler` runs every 5 minutes. `worker-background` has up to 15 minutes for sync and analysis.
* **Database:** PostgreSQL with schema migrations applied automatically (`server/migrations.ts`).
* **AI:** provider-agnostic. Anthropic Claude (default), Azure OpenAI or any OpenAI-compatible endpoint, with structured tool-call output. A deterministic logistics-tuned analyser is used when no key is configured, and also as a fallback.

## Run locally

```bash
npm install
cp .env.example .env            # set DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
set -a; source .env; set +a
npm run migrate
npm run seed                    # optional: Wheel King demo data (5 mailboxes, ~320 emails)
npm run dev:api                 # API on :8888 (also runs the worker every 5 minutes)
npm run dev                     # web app on :5173
```

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md) for Netlify and Postgres, [docs/MICROSOFT_365_SETUP.md](docs/MICROSOFT_365_SETUP.md) for the Microsoft 365 setup, and [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md) for testing with Gmail. The proposal response (solution overview, architecture, timeline, costs, support) is in [docs/PROPOSAL.md](docs/PROPOSAL.md).

## Project layout

```
server/            API, auth, connectors (microsoft, gmail, upload), ingest, AI, scoring, alerts, reports, worker
netlify/functions/ api.mts · scheduler.mts · worker-background.mts
src/               React app: layout, pages, components, contexts
scripts/           migrate, seed, create-admin, local dev server
docs/              deployment, connector setup, proposal
```
