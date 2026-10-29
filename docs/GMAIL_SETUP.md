# Testing with Gmail

1. Open **Google Cloud Console** and create a project called `remail`. Enable the **Gmail API**.
2. Set up the **OAuth consent screen**:
   * User type: External (or Internal for Google Workspace)
   * Scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly`
   * Test users: add your Gmail address. While the app is in "Testing", only listed users can connect.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**:
   * Authorised redirect URI: `https://<your-site>/api/connect/google/callback`
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Netlify and redeploy.
5. In remail, go to **Admin → Mailboxes → Connect Gmail**, sign in and approve read-only access.

Newsletters, promotions and no-reply senders are skipped (**Settings → Ignore newsletters…**), so only real conversations are analysed. A personal Gmail address is treated as your own identity. Everyone you correspond with becomes a customer record, which you can rename, tier or merge under **Customer health**.
