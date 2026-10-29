# remail: AI email intelligence for Wheel King TransHaul

**Response from Ravity to Wheel King TransHaul's requirement for an AI-powered email intelligence solution**
Prepared by Ravity · October 2026 · Commercial figures are indicative and valid for 60 days

---

## 1. Proposed solution overview

remail turns Wheel King's customer and operational email into a live view of customer health. It connects read-only to the monitored Microsoft 365 mailboxes and rebuilds every conversation across them. Duplicates are removed (the same email CC'd to several mailboxes is analysed once). AI then reads each thread the way an experienced customer service lead would.

For every conversation, remail produces:
* a concise summary
* sentiment, both per email and overall
* a customer state: satisfied, neutral, at risk or dissatisfied
* an explainable red, amber or green rating
* escalation risk and priority
* the issues raised: delays, missed collections, damage, billing, POD, driver conduct and more
* the commitments your team made and the requests the customer is waiting on

Results roll up into a customer health score for each account. That score drives a real-time dashboard, a critical-issues queue, alerts with automatic escalation, and scheduled reports by email.

remail is built on the same platform, sign-in and design as rfleet.ai, so Wheel King's teams work in one familiar Ravity experience.

**Outcome for Wheel King:** problems surface within minutes of the customer writing, not at month-end reviews. No unhappy key account waits unanswered. Promises made by email are tracked to completion. Management sees which customers, lanes and failure types are getting worse.

## 2. Key features and capabilities

| Requirement | How remail delivers it |
| --- | --- |
| Monitor multiple Outlook mailboxes | Microsoft Graph delta sync of Inbox and Sent Items for each mailbox, every 5 minutes. Unlimited mailboxes. Gmail and .eml import are also supported. |
| Process conversations and threads | Threads rebuilt from Outlook conversation IDs, reply headers and subject matching, including across mailboxes. Quoted history and signatures are stripped so only new content is analysed. |
| Eliminate duplicates | Exact duplicates are matched by RFC Message-ID across mailboxes. Near-duplicates (re-sent or forwarded copies) are matched by content fingerprint. Duplicates stay visible for audit but are excluded from analysis and metrics. |
| Concise summaries | AI summary for every conversation, refreshed as each new email arrives. |
| Sentiment (positive, neutral, negative) | Scored per email and per conversation, weighted towards the customer's latest messages. |
| Dissatisfied, at-risk and satisfied customers | Customer state per conversation, plus a 0–100 customer health score with daily history and a 7-day trend. |
| Traffic-light categorisation | Red, amber or green per conversation. The AI proposes and transparent business rules decide, with the reason shown, for example: "Negative sentiment with high urgency · awaiting reply 6h (SLA 4h)". |
| Critical issues needing immediate attention | Priority queue ranked by rating, escalation risk, customer tier, urgency and time waiting. Supports assignment, status and team notes. |
| Topics, complaints, failures, delays, billing, escalation risk | 17-category logistics taxonomy, free-text topics, issue severity and escalation-risk score. Legal, cancellation and churn language is detected. |
| Action items and commitments | Promises by Wheel King staff ("we'll confirm the ETA by 3pm") and customer requests are extracted with owner and due date, and tracked to done. Overdue commitments are flagged. |
| Recurring issues and trends | Recurring issues per customer, period-over-period change by issue type, a weekly heatmap and emerging topics. |
| Real-time dashboard | Overview refreshes every 30 seconds and shows the last mailbox sync time. |
| Filters: date, customer, mailbox, sentiment, status | All of these, plus rating, issue type and customer tier, applied consistently across every view. |
| Trending and summary views | Sentiment trend, red/amber/green over time, satisfaction (health) trend, mailbox volume and duplicates. |
| Automated email reports | Daily, weekly or monthly branded reports to any distribution list, with preview, send-now and history. |
| Prioritise and highlight critical issues | Critical-issues page, priority score, alert badges in navigation. |
| Alerts for high-risk or negative email | Six rule types: red, negative email from key customers, escalation risk, watch-words, reply SLA breach and health drop. Delivered in-app, by email, to Microsoft Teams or to Slack. |
| Escalation notifications | Alerts not acknowledged within the rule's time window escalate to a second distribution list (two levels). |

**Beyond the brief**
* **Mail Sage:** ask questions such as "Which key accounts are unhappy about billing this month?" and get answers that cite the source threads.
* **Suggested replies:** a courteous draft reply for unanswered threads (never sent automatically).
* **Reply-time SLA:** first-response time per conversation, with breach tracking.
* **Customer management:** tiering (strategic, key, standard), domain mapping, merge and account notes.
* **CSV export** and an **audit trail** of every view, export and change.

## 3. Solution architecture

```
 Wheel King Microsoft 365 ──(Graph API, Mail.Read, limited to 5 mailboxes)──┐
                                                                           ▼
                                 ┌────────────── remail worker (every 5 min) ──────────────┐
                                 │ delta sync → normalise → de-duplicate → thread → match  │
                                 │ customer → PII redaction → AI analysis → RAG rules →    │
                                 │ health score → alerts / escalations → scheduled reports │
                                 └──────────────────────────┬──────────────────────────────┘
                                                            ▼
                                             PostgreSQL (encrypted at rest)
                                                            ▲
 Users (browser) ── HTTPS ── remail web app ── REST API (auth, RBAC, audit) ┘
                                   │
            Alerts and reports ── email (SMTP/Resend) · Microsoft Teams · Slack
```

| Layer | Technology |
| --- | --- |
| Web app | React + TypeScript. Ravity design system shared with rfleet.ai. |
| API and workers | Serverless Node.js functions (Netlify): API, 5-minute scheduler, 15-minute background worker |
| Database | PostgreSQL (Neon, serverless) with automatic migrations |
| AI | Anthropic Claude by default. Azure OpenAI is supported if Wheel King wants AI processing inside its own Azure tenant. A deterministic fallback keeps the service running if the AI provider is unavailable. |
| Identity | Ravity sign-in (the same as rfleet) or remail accounts; roles: admin, manager, analyst, viewer; per-mailbox access |

**Security and compliance**
* **Read-only by design.** Graph `Mail.Read` is restricted by an Exchange application access policy to the monitored mailboxes only. remail cannot send, move, delete or mark email. Alerts go out through a separate sending service.
* OAuth tokens are encrypted with AES-256-GCM. TLS is used in transit. The database is encrypted at rest.
* Sessions are signed, expire after 12 hours and can be revoked. Sign-in throttling and password policy apply.
* Role-based access with optional restriction to specific mailboxes.
* An append-only audit log covers sign-ins, conversation views, exports and configuration changes.
* PII (card, bank and ID numbers, passwords) is redacted before text reaches the AI provider. AI providers process data under no-training terms.
* Configurable retention: email bodies are erased after N days (default 365), while metrics are kept.
* Data residency: Canadian or US hosting regions on request.

## 4. Implementation timeline

The platform is built, so implementation is configuration, tuning and adoption rather than development.

| Week | Activities | Outcome |
| --- | --- | --- |
| 1 | Kick-off, Entra app registration and access policy with Wheel King IT, environment provisioning, users and roles | Secure read-only connection approved |
| 2 | Connect the 5 mailboxes, 90-day historical backfill, customer list and tier import, internal domains | Historical baseline and first dashboards |
| 3 | Tune the taxonomy, RAG rules and SLA to Wheel King's lanes and customers. Configure alert rules, recipients, escalation paths and report schedules. | Alerts and reports live in pilot |
| 4 | User acceptance testing with customer service, operations and accounts. Training (two 60-minute sessions) and runbook handover. | Go-live |
| 5–6 | Hypercare: daily check-ins, accuracy review, threshold adjustments | Stable operation, sign-off |

A working pilot on demo data, or on one mailbox, can be shown in the first week.

## 5. Infrastructure requirements

**From Wheel King**
* Microsoft 365 / Exchange Online with a Global Administrator, or a Privileged Role Administrator plus Exchange Administrator, for one-time consent and the access policy (about 30 minutes, guided by Ravity).
* The list of monitored mailboxes and internal email domains.
* Optional: a Teams channel webhook for alerts and a distribution list for reports.
* Users need only a modern web browser. No on-premises servers or software.

**Provided by Ravity (managed SaaS)**
* Hosting, database, backups, monitoring, AI processing and email delivery.
* Sized for 5 mailboxes and 500+ emails a day, with headroom to 10× volume without re-architecture. The schema is multi-tenant, so more Wheel King entities or regions can be added.

## 6. One-time implementation cost

| Item | USD |
| --- | --- |
| Set-up, Microsoft 365 secure integration and 5 mailboxes | 4,500 |
| Historical backfill (90 days) and customer/tier import | 2,000 |
| Taxonomy, RAG rule and SLA tuning for Wheel King | 3,500 |
| Alerts, escalation paths, reports and dashboards configuration | 2,000 |
| UAT, training and 2 weeks of hypercare | 2,500 |
| **Total one-time** | **14,500** |

## 7. Recurring costs

| Plan | Monthly (USD) | Annual (USD) |
| --- | --- | --- |
| **remail Professional**: up to 10 mailboxes and 1,000 emails/day, unlimited users, hosting, AI processing, alerts, reports, standard support, upgrades | 1,250 | 13,500 (10% saving) |
| Additional mailbox (above 10) | 60 per mailbox | 650 per mailbox |
| Additional volume (above 1,000 emails/day) | 250 per extra 1,000 emails/day | 2,700 |
| Premium support (extended hours, named success manager) | 400 | 4,300 |

All hosting, database and AI usage costs are included in the subscription. For transparency, Ravity's underlying run-cost at Wheel King's stated volume is estimated at USD 120–250 a month. This assumes 5 mailboxes, about 15,000 emails a month and a Haiku-class model.

## 8. Support and maintenance model

| | Standard (included) | Premium |
| --- | --- | --- |
| Hours | Mon–Fri 08:00–18:00 Eastern | Mon–Sat 07:00–22:00 Eastern, plus P1 on call 24×7 |
| Channels | Email, support portal, Teams | Plus phone and a named success manager |
| P1: service down or no sync | 1 h response, 4 h workaround | 30 min response, 2 h workaround |
| P2: major feature impaired | 4 h response, 1 business day fix | 2 h response |
| P3: minor issue | 1 business day | 4 h |
| P4: question or enhancement | 3 business days | 1 business day |
| Availability target | 99.5% monthly | 99.9% monthly |
| Reviews | Quarterly accuracy and tuning review | Monthly service review and tuning |

Maintenance includes security patching, dependency updates, Microsoft Graph API changes, AI model upgrades with regression checks against Wheel King's labelled samples, monitoring of sync health and daily backups (point-in-time restore, 7 days).

## 9. Reference customers

remail is a new product in the Ravity platform. Wheel King would be its **launch design partner**, with preferential terms reflected above and influence on the roadmap.

The Ravity platform it runs on is in production with enterprise mobility customers, including Maruti Suzuki (also a strategic investor), Renault, Volvo and Ashok Leyland. It serves 10+ enterprise customers and 10k+ vehicles on rfleet.ai, and processes more than 10 billion data points a day. Reference calls with platform customers can be arranged subject to their consent.

A live environment loaded with Wheel King-style demo data is available for evaluation.

---
*Prices exclude applicable taxes. Ravity Software Solutions Pvt Ltd / Ravity Ltd (London).*
