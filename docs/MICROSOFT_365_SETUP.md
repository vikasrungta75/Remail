# Microsoft 365 setup (read-only)

remail supports two ways of connecting:

| Mode | Use for | Permission |
| --- | --- | --- |
| **Organisation mailboxes** (`microsoft_app`) | Wheel King production: shared mailboxes such as customerservice@ and operations@ | Application `Mail.Read`, **restricted to named mailboxes** |
| **Connect Outlook** (`microsoft`) | Testing with your own mailbox | Delegated `Mail.Read` + `offline_access` |

## 1. Register the app in Microsoft Entra ID

1. Go to **Entra admin centre → App registrations → New registration**.
   * Name: `remail by Ravity`
   * Supported account types: *Accounts in this organizational directory only*. For testing across tenants, choose *Any organizational directory and personal Microsoft accounts*.
   * Redirect URI (Web): `https://<your-site>/api/connect/microsoft/callback`
2. Under **Certificates & secrets**, create a client secret and copy its **Value**.
3. Under **API permissions → Microsoft Graph**, add:
   * Application: `Mail.Read` (for organisation mailboxes)
   * Delegated: `Mail.Read`, `User.Read`, `offline_access`, `openid`, `email`, `profile` (for Connect Outlook)
   * Then select **Grant admin consent**.
4. Set these variables in Netlify: `MS_TENANT_ID` (Directory ID), `MS_CLIENT_ID` (Application ID) and `MS_CLIENT_SECRET`.

## 2. Restrict the app to the five monitored mailboxes

Application `Mail.Read` covers every mailbox in the tenant by default. Limit it with an Exchange Online application access policy:

```powershell
Connect-ExchangeOnline
New-DistributionGroup -Name "remail-monitored" -Type Security -PrimarySmtpAddress remail-monitored@wheelking.com
"customerservice@wheelking.com","operations@wheelking.com","accounts@wheelking.com","bookings@wheelking.com","keyaccounts@wheelking.com" |
  ForEach-Object { Add-DistributionGroupMember -Identity "remail-monitored" -Member $_ }
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId remail-monitored@wheelking.com `
  -AccessRight RestrictAccess -Description "remail read-only access to monitored mailboxes"
Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -Identity customerservice@wheelking.com   # AccessCheckResult: Granted
Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -Identity ceo@wheelking.com               # AccessCheckResult: Denied
```

Microsoft is moving these policies to **RBAC for Applications** (management scopes). The equivalent is `New-ManagementScope` followed by `New-ManagementRoleAssignment -Role "Application Mail.Read"`. Either approach works with remail.

## 3. Add the mailboxes in remail

Go to **Admin → Mailboxes → Microsoft 365 shared mailboxes → Add mailbox** and enter each address. The first sync goes back the selected number of days. After that, Graph delta queries pick up only new messages, every 5 minutes.

## What remail does and does not do

* It reads Inbox and Sent Items through `GET /users/{id}/mailFolders/{inbox|sentitems}/messages/delta`.
* It never sends, moves, flags, deletes or marks messages as read.
* Alerts and reports are sent by SMTP or Resend. The optional alternative is one dedicated sender mailbox (`MS_SENDER_MAILBOX`) with `Mail.Send` scoped to that mailbox only. This is the only write permission in the solution, and it is not used on monitored mailboxes.
