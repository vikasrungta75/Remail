# Deploying remail to Netlify

Setup takes about 15 minutes. You need a Netlify account, a Postgres database and the GitHub repo `vikasrungta75/remail`.

## 1. Create the Netlify site

1. In Netlify go to **Add new site → Import an existing project → GitHub** and pick `vikasrungta75/remail`.
2. The build settings come from `netlify.toml`. Leave them as they are:
   * Build command: `npm run migrate && npm run build:web`
   * Publish directory: `dist`
   * Functions directory: `netlify/functions`
3. Don't deploy yet. Add the database and environment variables first.

## 2. Add Postgres

Choose one:

* **Netlify Database (simplest):** in the project, open **Data & Storage → Database → Create a database**. Netlify sets `NETLIFY_DB_URL` for you, and remail reads it automatically.
* **Neon, Supabase, RDS or any other Postgres 14+:** create a database and set `DATABASE_URL` to the connection string, including `?sslmode=require`.

Tables are created automatically on the first build (`npm run migrate`) and checked again on the first API call.

## 3. Environment variables

Open **Site configuration → Environment variables** and add the following. The full list is in `.env.example`.

| Variable | Value |
| --- | --- |
| `JWT_SECRET` | output of `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | output of `openssl rand -hex 32` (keep it safe: changing it invalidates connected mailboxes) |
| `INTERNAL_API_SECRET` | output of `openssl rand -hex 24` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | first administrator (only used when the database has no users) |
| `ORG_NAME` | `Wheel King TransHaul` |
| `INTERNAL_DOMAINS` | Wheel King's email domains, comma separated |
| `GEMINI_API_KEY` | from aistudio.google.com/apikey (model `gemini-3.8-flash` by default; Claude, Azure OpenAI and OpenAI are also supported) |
| `APP_URL` | only if you use a custom domain, e.g. `https://remail.ravity.ai` |

Optional variables:
* **Ravity sign-in, same as rfleet:** `RAVITY_IAM_URL` (rfleet's `REACT_APP_SERVICE_URL`) and `RAVITY_SPACE_NAME` (rfleet's `REACT_APP_SPACE_NAME`).
* **Microsoft 365:** `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. These enable Sign in with Microsoft, Connect my Outlook and organisation consent (see MICROSOFT_365_SETUP.md).
* **Gmail (optional):** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see GMAIL_SETUP.md).
* **Email delivery for alerts and reports:** `SMTP_*`, `RESEND_API_KEY` or `MS_SENDER_MAILBOX`.
* **Chat alerts:** `TEAMS_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`.

## 4. Deploy

Trigger a deploy. Once it finishes:

1. Open the site and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Sign in with Microsoft: your inbox connects automatically. Demo data is off by default; set `DEMO_DATA_ENABLED=true` on a separate demo site to show **Load Wheel King demo data**.
3. Under **Functions** in Netlify, confirm that `scheduler` runs every 5 minutes and that `worker-background` logs `[worker] done`.

## Sign-in modes

remail uses the same sign-in mechanism and backend as rfleet. With `RAVITY_IAM_URL` set, the server calls these in order:

1. `/auth/getCustomerSpaces`
2. `/auth/authenticateuser`
3. `/auth/getUserInfoByToken`
4. `/user/getProfileUserDetails`

The Ravity token is kept encrypted with the session and revoked through `/auth/logout` when you sign out. Forgotten passwords go through `/user/forgetpasswordresetlink`, and the reset link (`/home?token=…`) posts to `/auth/updateforgotpassword`. The first user (or any address in `BOOTSTRAP_ADMIN_EMAILS`) becomes admin. Sign in with Microsoft and local admin passwords work alongside (`AUTH_MODE=both`).

Add the remail site URL to the space's allowed reset-link URL in Ravity IAM if it differs from rfleet's.

## Scaling

* About 500 emails a day across 5 mailboxes needs roughly 250 conversation analyses a day. Each worker run processes about 400 messages per mailbox per pass and resumes large backfills across runs.
* To handle more volume: increase the database tier, shorten the scheduler interval, or add workers per mailbox. The schema is multi-tenant (`org_id` on every table), so more operating companies can share one deployment.
