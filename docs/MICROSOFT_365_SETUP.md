# Microsoft 365 integration

remail is Microsoft 365-first. One app registration in Microsoft Entra ID handles three things:

| Capability | What it does | Microsoft permission |
| --- | --- | --- |
| **Sign in with Microsoft** | Staff sign in with their Office 365 work account | Delegated `openid profile email User.Read` |
| **Connect my Outlook** | Anyone links their own mailbox. It powers My day and their individual view, and is the way to test with your own email. | Delegated `Mail.Read`, `offline_access` |
| **Organisation mailboxes** | Shared mailboxes (customerservice@, dispatch@, accounts@ …) are monitored after a one-time admin consent | Application `Mail.Read`, restricted to named mailboxes |

Every permission is read-only. remail never sends, moves, deletes or flags anything in a monitored mailbox.

---

## 1. Register the app (about 10 minutes)

Do this in the tenant that owns the app: Ravity's tenant (ravity.io) for testing, or a dedicated tenant if you sell remail to several customers.

1. Go to **entra.microsoft.com → App registrations → New registration**.
   * Name: `remail by Ravity`
   * Supported account types: **Accounts in any organizational directory (multitenant)**. This lets Wheel King's tenant consent later. For a purely internal test you can choose single tenant.
   * Redirect URI, platform **Web**: `https://<your-netlify-site>/api/auth/microsoft/callback`
2. Under **Authentication**, add two more Web redirect URIs:
   * `https://<your-netlify-site>/api/connect/microsoft/callback` (connect my Outlook)
   * `https://<your-netlify-site>/api/connect/microsoft-admin/callback` (admin consent)
   * For local testing you can also add `http://localhost:8888/...` versions of all three.
3. Under **Certificates & secrets → New client secret**, copy the **Value** (not the ID).
4. Under **API permissions → Add → Microsoft Graph**, add:
   * **Delegated:** `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Read`
   * **Application:** `Mail.Read`
   * Optional, only if alerts should be sent from a Microsoft 365 mailbox: **Application** `Mail.Send`, and restrict it to that one mailbox as in step 4.
5. In Netlify, add these environment variables and redeploy:

| Variable | Value |
| --- | --- |
| `MS_CLIENT_ID` | Application (client) ID |
| `MS_CLIENT_SECRET` | the secret value |
| `MS_DELEGATED_TENANT` | `organizations` (default). Use your tenant ID to allow only your tenant's users. |
| `MS_SSO_ALLOWED_DOMAINS` | optional, e.g. `ravity.io,wheelking.com`: domains that may self-sign-up via Microsoft |
| `MS_SSO_DEFAULT_ROLE` | role for new Microsoft sign-ins (default `analyst`) |

The **Sign in with Microsoft** button appears on the sign-in page once `MS_CLIENT_ID` and `MS_CLIENT_SECRET` are set.

## 2. Test with your own Microsoft email (vikas@ravity.io)

1. Sign in to remail with the admin account, or with **Sign in with Microsoft**.
2. Go to **Admin → Mailboxes → Your own Outlook → Connect my Outlook**.
3. Approve the read-only permissions. The first sync goes back the number of days chosen on the page.
4. Within a minute or two your threads appear in **My day** (switch the header to **My view**), in **All email** by category, and in **Conversations**.

Your own address is added to your profile automatically, so replies you send are attributed to you in **Team performance**.

## 3. Connect Wheel King's organisation (production)

1. A Wheel King **Global Administrator** (or Privileged Role Administrator) signs in to remail. In **Admin → Mailboxes → 1. Connect Microsoft 365**, they select **Grant administrator consent**. Microsoft shows the exact read-only permissions before anything is granted.
2. remail stores Wheel King's tenant ID. No `MS_TENANT_ID` variable is needed, although setting one is still supported.
3. **Restrict the app to the monitored mailboxes.** Application `Mail.Read` otherwise covers every mailbox in the tenant:

```powershell
Connect-ExchangeOnline
New-DistributionGroup -Name "remail-monitored" -Type Security -PrimarySmtpAddress remail-monitored@wheelking.com
"customerservice@wheelking.com","dispatch@wheelking.com","accounts@wheelking.com","sales@wheelking.com","safety@wheelking.com" |
  ForEach-Object { Add-DistributionGroupMember -Identity "remail-monitored" -Member $_ }
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId remail-monitored@wheelking.com `
  -AccessRight RestrictAccess -Description "remail read-only access to monitored mailboxes"
```

Microsoft's newer equivalent is **RBAC for Applications** (`New-ManagementScope` plus `New-ManagementRoleAssignment -Role "Application Mail.Read"`). Either approach works.

4. In **2. Add shared mailboxes**, enter each address and select **Test access**. remail confirms "Access granted" or shows Microsoft's reason, for example that the mailbox isn't in the access policy. Then add it.

## How sync works

* remail uses Graph delta queries on Inbox and Sent Items every 5 minutes (`/mailFolders/{inbox|sentitems}/messages/delta`), resuming large backfills across runs.
* Refresh tokens for personal mailboxes are encrypted with AES-256-GCM. Microsoft rotates them and remail saves each new one.
* Throttling (HTTP 429) is retried with Microsoft's `Retry-After`. Expired delta tokens trigger an automatic resync of that folder.
* Each email has an **Open in Outlook** link, and any action can be added to an Outlook calendar (.ics).
* Alerts can go to a **Microsoft Teams** channel. Create a channel workflow "Post to a channel when a webhook request is received" and set `TEAMS_WEBHOOK_URL`.
