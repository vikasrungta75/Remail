# Getting started: host on Netlify and test with vikas@ravity.io

Allow about 45 minutes. The steps run in this order because each one needs the URL or keys from the step before.

## Step 1. Get a Gemini API key (2 minutes)

1. Open **https://aistudio.google.com/apikey** and sign in with a Google account.
2. Select **Create API key** and pick (or create) a Google Cloud project.
3. Copy the key, which starts with `AIza…`. You will paste it into Netlify as `GEMINI_API_KEY`.

remail uses **`gemini-3.8-flash`** by default. It's Google's current stable Flash model: fast, inexpensive at 500+ emails a day, and it supports structured JSON output. To change the model, set `GEMINI_MODEL`:
* `gemini-3.5-flash-lite` is the cheapest.
* `gemini-3.1-pro-preview` gives the deepest analysis.

## Step 2. Create the Netlify site from GitHub (5 minutes)

1. Go to **https://app.netlify.com**, then **Add new project → Import an existing project → GitHub**.
2. Authorise Netlify for GitHub if asked, and choose **vikasrungta75/remail**. GitHub may show it as `Remail`.
3. Keep the build settings Netlify reads from `netlify.toml`:
   * Branch: `main`
   * Build command: `npm run migrate && npm run build:web`
   * Publish directory: `dist`
   * Functions directory: `netlify/functions`
4. Select **Deploy**. The first build may fail because there is no database yet. That's expected.
5. Name the project **emailanalytics** under **Project configuration → Change project name**. The site is then `https://emailanalytics.netlify.app`, and every URL below uses that address.

## Step 3. Add Postgres (3 minutes)

**Option A, Netlify Database (inside Netlify):** in the emailanalytics project, open **Data & Storage → Database** in the left menu and select **Create a database** (or **Create a database manually**). Netlify provisions Postgres and gives the site `NETLIFY_DB_URL` automatically. remail detects it, so there's nothing to copy.

**Option B, Neon directly (works on every Netlify plan):**
1. Go to **https://console.neon.tech** and sign up. Google sign-in works.
2. Select **New project**. Name it `emailanalytics` and pick a region close to you, such as AWS Europe (London) or US East.
3. On the project dashboard, select **Connect**. Copy the connection string, which starts with `postgresql://` and ends with `?sslmode=require`.
4. In Netlify, go to **Project configuration → Environment variables** and add `DATABASE_URL` with that value.

remail creates all its tables automatically on the next deploy or the first request.

## Step 4. Register remail in Microsoft Entra, Ravity's tenant (10 minutes)

This lets you sign in with Microsoft and connect vikas@ravity.io. You need to be an admin of the ravity.io Microsoft 365 tenant, or ask whoever is.

1. Go to **https://entra.microsoft.com**, then **Applications → App registrations → New registration**.
   * Name: `remail by Ravity`
   * Supported account types: **Accounts in any organizational directory (Multitenant)**. This is needed later for Wheel King.
   * Redirect URI: platform **Web**, value `https://emailanalytics.netlify.app/api/auth/microsoft/callback`
   * Select **Register**.
2. On the app's **Overview**, copy the **Application (client) ID**.
3. Go to **Authentication → Add URI** and add two more Web redirect URIs, then **Save**:
   * `https://emailanalytics.netlify.app/api/connect/microsoft/callback`
   * `https://emailanalytics.netlify.app/api/connect/microsoft-admin/callback`
4. Go to **Certificates & secrets → Client secrets → New client secret**. Name it `remail` and choose 24 months. Copy the **Value** immediately, because it's shown only once.
5. Go to **API permissions → Add a permission → Microsoft Graph**:
   * **Delegated permissions:** `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Read`
   * **Application permissions:** `Mail.Read`. This is used later for Wheel King's shared mailboxes.
   * Select **Grant admin consent for Ravity**. This avoids a consent prompt for each Ravity user.

## Step 5. Environment variables in Netlify (5 minutes)

Open **Project configuration → Environment variables → Add a variable → Add a single variable**. Add each one below.

To generate the three secrets, run `openssl rand -hex 32` in a terminal for each. You can also use any password generator, set to 64 characters of letters and numbers.

| Key | Value |
| --- | --- |
| `GEMINI_API_KEY` | key from step 1 |
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `AI_PROVIDER` | `gemini` |
| `JWT_SECRET` | random 64 characters |
| `ENCRYPTION_KEY` | random 64 characters (keep a copy: changing it disconnects mailboxes) |
| `INTERNAL_API_SECRET` | random 48 characters |
| `ADMIN_EMAIL` | `vikas@ravity.io` |
| `ADMIN_PASSWORD` | a strong password, at least 10 characters with letters and numbers |
| `ADMIN_NAME` | `Vikas Rungta` |
| `ORG_NAME` | `Wheel King TransHaul` |
| `INTERNAL_DOMAINS` | `ravity.io` for testing. Add Wheel King's domains later. |
| `MS_CLIENT_ID` | Application (client) ID from step 4 |
| `MS_CLIENT_SECRET` | secret value from step 4 |
| `MS_SSO_ALLOWED_DOMAINS` | `ravity.io` |
| `MS_SSO_DEFAULT_ROLE` | optional. Role for people who sign in for the first time: `analyst` (default, sees only their own email), `viewer` or `manager`. |
| `DATABASE_URL` | only if you used Option B in step 3 |

Optional:

| Key | Value |
| --- | --- |
| `RAVITY_IAM_URL` | same as rfleet's `REACT_APP_SERVICE_URL`, for Ravity sign-in |
| `RAVITY_SPACE_NAME` | same as rfleet's `REACT_APP_SPACE_NAME` |
| `ALERT_RECIPIENTS` | `vikas@ravity.io` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | so alerts, reports and the My day email are actually sent. For example, Microsoft 365 SMTP is `smtp.office365.com` on port `587`. |

`INTERNAL_DOMAINS=ravity.io` matters for testing. It tells remail that @ravity.io senders are your team, so their emails count as internal or as your replies, and everyone else (Google, Hyundai, partners) appears as an external organisation.

## Step 6. Deploy (3 minutes)

1. Go to **Deploys → Trigger deploy → Deploy project**.
2. Wait for **Published**. In the deploy log you should see `[migrate] schema up to date`.
3. Go to **Logs → Functions**. You should see `api`, `scheduler` (every 5 minutes) and `worker-background`.

## Step 7. Sign in and connect vikas@ravity.io (5 minutes)

1. Open `https://emailanalytics.netlify.app`.
2. Either select **Sign in with Microsoft** and use vikas@ravity.io, or sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Either way you are the administrator, because you are the first user.
3. Go to **Admin → Mailboxes**. Under "When a new mailbox is connected, the first sync looks back", choose **30 days**.
4. Under **Your own Outlook**, select **Connect my Outlook**, sign in as vikas@ravity.io and select **Accept**.
5. You'll return to Mailboxes with "Connected vikas@ravity.io". The mailbox shows **Active** and the first sync starts. Select **Sync** on that row to run it straight away.
6. A 30-day backfill of a normal mailbox takes 2 to 10 minutes, depending on volume. Gemini analysis runs in the same background job.

### Colleagues at Ravity

Everyone else just opens the site and selects **Sign in with Microsoft** with their ravity.io account. Microsoft asks them once to allow read-only access to their mail, and signing in connects their inbox automatically: no secrets, no Connect step. Their last 30 days sync in the background (`SIGNIN_BACKFILL_DAYS`).

* They start as **analyst** and see only their own email. You, as admin, and anyone you make **manager** in **Admin → Users** see everyone's mail combined under **Everyone**.
* To skip the per-person Microsoft prompt, tick **Consent on behalf of your organization** the first time you sign in with Microsoft as tenant admin. This grants only the delegated permissions, never "read all mailboxes".
* A mailbox an admin has paused stays paused when its owner signs in again.

## Step 8. What to check

| Where | What you should see |
| --- | --- |
| Header switch **My view** | Only threads you took part in |
| **My day** | Emails waiting for your reply, your commitments with due dates, open proposals |
| **All email** | Your mail split into categories (customer service, proposals, operations, finance, vendors, internal, events, notifications) |
| **Conversations** | Open a thread for the Gemini summary, sentiment, red/amber/green with the reason, issues, action items, suggested reply, and "Open in Outlook" |
| **Customers and accounts** | External organisations, sorted into customers, prospects, vendors and so on, with a health score |
| **Proposals and quotes** | Any RFQ, quote or proposal threads, with stage and deadline |
| **Mail Sage** | Ask, for example, "What is waiting on me this week?" and get an answer with links to threads |
| **Admin → Settings** | **AI analysis** shows `gemini · gemini-3.8-flash`. AI usage counts calls and tokens. |
| Any conversation → **Re-analyse** | Re-runs Gemini on that thread |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Build fails at `migrate` | The database variable is missing. Repeat step 3 and redeploy. |
| No "Sign in with Microsoft" button | `MS_CLIENT_ID` or `MS_CLIENT_SECRET` is missing. Redeploy after adding them. |
| Microsoft error `AADSTS50011` (redirect URI mismatch) | The URI in Entra must match exactly: `https`, your site name, no trailing slash. |
| Microsoft asks for admin approval | Grant admin consent in Entra (step 4.5), or allow user consent for the tenant. |
| Mailbox shows **Error** | Hover over the error text. `invalid_grant` means you should select **Connect my Outlook** again. |
| Threads show "remail-heuristic-v1" as the model | `GEMINI_API_KEY` is missing or invalid. Check **Logs → Functions → worker-background** for `[ai]` errors, then select **Re-analyse**. |
| Gemini `429` errors | You hit the free-tier rate limit. Set `AI_MIN_INTERVAL_MS=6000` (about 10 requests a minute) or enable billing on the Google Cloud project. Threads that fell back to the rules engine are re-analysed automatically 30 minutes later. |
| Nothing new after a while | The scheduler runs every 5 minutes. Select **Sync now** on the Overview page, or **Sync** on the mailbox row. |

## Next: Wheel King's shared mailboxes

When Wheel King is ready, their Microsoft 365 administrator signs in and goes to **Admin → Mailboxes → Grant administrator consent**. Their IT team restricts the app to the monitored mailboxes, and you add each mailbox with **Test access**. See [MICROSOFT_365_SETUP.md](MICROSOFT_365_SETUP.md) §3. Remember to add Wheel King's domains to `INTERNAL_DOMAINS`.
