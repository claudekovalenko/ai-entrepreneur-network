# AI Christian Entrepreneurs

A private community space for Christian entrepreneurs who are using AI to build
ventures that free up their time — so more of it can go toward making disciples
and serving in ministry.

It works like a small, focused Slack:

- **Group channels** — `#general`, `#encouragement`, `#prayer-requests`,
  `#ai-tools-and-content`, `#ideas`, `#wins` (admins can add or remove channels).
  Real-time messages, 🙏 reactions, edits, typing indicators and unread badges.
- **Direct messages** — private one-to-one conversations between any two members.
- **Projects board** — post what you're building and what help you need. Others can
  click **I can help** (with a note), comment, and message you. Mark projects as
  looking for help, in progress, launched or paused.
- **Community calls** — admins schedule a weekly, bi-weekly or one-time call with a
  meeting link. Members see it in their own timezone, RSVP, and get a **Join call**
  button (highlighted while the call is live). Times stay correct across daylight
  saving changes.
- **Push notifications** — private messages, @mentions (admins can use `@everyone`),
  and a reminder 15 minutes before each call, delivered even when the app is closed. Works
  on Android and computers; on iPhone/iPad once ACE is added to the Home Screen. No setup
  needed: the server creates its own notification (VAPID) keys on first use.
- **Member directory** — profiles with headline, skills/tools and ministry focus,
  searchable, with online status.
- **Home dashboard** — mission statement, verse of the day, the next call and
  projects that need help.

## How it runs

It runs entirely on Cloudflare's free Workers plan:

- **Worker** (`worker/index.js`) serves the API and the browser app in `public/`.
- **D1** stores members, messages, projects and calls. The tables are created
  automatically on first use, so there is no migration step.
- **A Durable Object** (`worker/hub.js`) holds everyone's live connection and
  pushes new messages, reactions, typing and online status instantly.

ACE is **invite-only**. The first person to sign up becomes the **admin**. After that,
admins invite people one at a time from **Members → Invite someone**: each invite is a
personal link that works once and expires after 14 days. Admins can cancel unused
invites, remove members, create channels, schedule calls, and make other members admins.

## Going live (Cloudflare, deployed by GitHub Actions)

The D1 database `ai-entrepreneur-network` already exists in the Cloudflare
account and is referenced in `wrangler.jsonc`. The workflow in
`.github/workflows/deploy.yml` runs the tests and then deploys on every push to
`main`. It needs three repository secrets
(**Settings → Secrets and variables → Actions → New repository secret**):

| Secret                  | Where to get it                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"     |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account ID in the right-hand panel                  |

After adding them, open **Actions → Test and deploy → Run workflow**. The live
link appears at the end of the deploy step (`https://ai-entrepreneur-network.<subdomain>.workers.dev`).
Register first to become the admin, then invite members one by one (see below).

### Google sign-in (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), set up the
   **OAuth consent screen** (External), then **Create credentials → OAuth client ID →
   Web application**.
2. Add the authorized redirect URI
   `https://ai-entrepreneur-network.faith-journey-funnel.workers.dev/api/auth/google/callback`.
3. Add repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then re-run the
   workflow. The **Continue with Google** button appears once both are set. New members
   still need a personal invite link; existing members can sign in with Google using the same email.

## Development

```bash
npm install
npm run dev   # local Worker with a local D1 + Durable Object at http://localhost:8787
npm test      # starts a throwaway local Worker and runs the API/realtime tests
```

Put local settings (for example Google keys) in a `.dev.vars` file.

- `worker/` — API routes, realtime hub, schema, password hashing, call scheduling
- `public/` — the browser app (plain HTML/CSS/JS, no build step)
- `test/` — integration tests
