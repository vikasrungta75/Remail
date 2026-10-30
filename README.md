# remail by Ravity

AI email intelligence for **Wheel King TransHaul**, a trucking and fleet management company.

remail connects read-only to Microsoft 365 / Outlook mailboxes. It rebuilds every thread, removes duplicates and analyses each conversation. You get two views:

* **My view:** the email I send and receive, what is waiting on me and what I promised.
* **Everyone:** a comprehensive view across all mailboxes, sorted into business categories: customer service and issues; sales, quotes and proposals; operations and dispatch; fleet and maintenance; billing and finance; compliance and claims; vendors; drivers and people; internal team; events and newsletters; automated notifications.

The look and the sign-in come from **rfleet.ai**. You sign in with your Ravity account (the same backend and flow as rfleet) or with Microsoft.

## Features

**Email analysis**
* Microsoft 365 shared mailboxes, after admin consent restricted to named mailboxes.
* Personal Outlook connection per user.
* Gmail and .eml import are optional.
* Threads are rebuilt across mailboxes, including internal threads that later involve a customer.
* Duplicates are removed by Message-ID and by content fingerprint.
* Quoted text and signatures are stripped.
* Each thread gets a concise AI summary.

**Every kind of email**
* Business categories with correction by users.
* Automated mail is stored and categorised without AI cost.
* External organisations are classified as customer, prospect, vendor or candidate.

**Customer experience**
* Sentiment per email and per thread.
* Satisfied, at-risk and dissatisfied customers.
* An explainable red, amber or green rating.
* A customer health score with history.
* A critical-issues queue ranked by priority.

**Fleet-specific insight**
* The issue taxonomy covers delays, missed pickups, damage, billing, POD, driver conduct, breakdowns and maintenance, accidents and cargo claims, detention, border and customs, ELD and HOS, fuel, and contract or escalation risk.
* Recurring issues, emerging topics, and trends compared with the previous period.

**Proposals and quotes**
* RFQs, rate requests, tenders and renewals are detected automatically.
* Stage, deadline, value, lane or scope, and next step are extracted.
* A pipeline board tracks each one from request to won or lost.
* Deadline alerts fire before proposals are due.

**Activities, delivered**
* Commitments ("we'll send the ETA by 3pm") and requests are extracted with owner and due date.
* You can add your own actions.
* Actions are assigned to people, tracked to done, and can be added to an Outlook calendar.
* Overdue-action alerts.
* A **My day** email every morning.

**Dashboards and reports**
* A real-time customer-health overview and an All email category view.
* My day, conversations, customers and accounts, actions, proposals, trends, and team performance (who replied and how fast).
* Filters by date, customer, mailbox, sentiment, rating, status, email type, issue type and tier.
* Scheduled branded email reports, plus preview and send-now.
* CSV export.

**Alerts and escalation**
* Rule types: red threads, negative email from key customers, escalation risk, watch-words, reply SLA, health drop, overdue action and proposal deadline.
* Delivered in-app, by email, to Microsoft Teams or to Slack.
* Alerts that aren't acknowledged escalate to a second level.

**Mail Sage**
* Ask questions about any email in plain English.
* Answers cite the source threads.

**Security**
* Read-only Graph scopes.
* Encrypted tokens.
* Revocable sessions.
* Role-based access (admin, manager, analyst, viewer) with per-mailbox restriction.
* Full audit log.
* PII redaction before AI.
* Configurable retention.

## Architecture

```
 Microsoft 365 (Graph, read-only) ─┐
 Personal Outlook (delegated) ─────┼─► Netlify background worker (every 5 min)
 Gmail / .eml (optional) ──────────┘     sync → dedupe → thread → classify → AI analysis → RAG/health
                                         → alerts/escalations → My day digests → scheduled reports
                                                 │
                                           PostgreSQL
                                                 │
 React app (rfleet design) ◄── /api/* Netlify Function ── Ravity IAM sign-in (as rfleet) · Microsoft sign-in · RBAC · audit
```

* **Frontend:** React 18, React Router, TanStack Query, ApexCharts. Ravity design tokens with Nunito and Nunito Sans fonts.
* **Backend:** Netlify Functions v2 in TypeScript.
  * `api`: the REST API
  * `scheduler`: runs every 5 minutes
  * `worker-background`: up to 15 minutes per run
* **Database:** PostgreSQL. Migrations run automatically from `server/migrations.ts`.
* **AI:** Anthropic Claude by default, or Azure OpenAI, or any OpenAI-compatible API. A fleet-tuned rules engine is the fallback, so everything works without an AI key.

## Sign-in (same as rfleet)

Set `RAVITY_IAM_URL` to rfleet's `REACT_APP_SERVICE_URL`, and `RAVITY_SPACE_NAME` to rfleet's `REACT_APP_SPACE_NAME` (or a dedicated remail space). remail then follows rfleet's sign-in flow step for step:

1. `/auth/getCustomerSpaces`
2. `/auth/authenticateuser`
3. `/auth/getUserInfoByToken`
4. `/user/getProfileUserDetails`

Sign-out calls `/auth/logout`. Forgotten passwords use `/user/forgetpasswordresetlink` and `/auth/updateforgotpassword`, and the reset link works on the same `/home?token=` path rfleet uses. Microsoft sign-in and local admin passwords work alongside.

## Run locally

```bash
npm install
cp .env.example .env            # DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, ADMIN_EMAIL, ADMIN_PASSWORD (+ RAVITY_IAM_URL, MS_*)
set -a; source .env; set +a
npm run migrate
npm run seed                    # optional Wheel King demo data
npm run dev:api                 # API on :8888, runs the worker every 5 minutes
npm run dev                     # app on :5173
npm test                        # pipeline tests (use an empty test database)
```

## Deploy

* [docs/DEPLOY.md](docs/DEPLOY.md): Netlify and Postgres.
* [docs/MICROSOFT_365_SETUP.md](docs/MICROSOFT_365_SETUP.md): Microsoft sign-in, connecting your own Outlook for testing, and Wheel King organisation consent.
