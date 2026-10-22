# AI Entrepreneur Network

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

The first person to register becomes the **admin**. Admins can create channels,
schedule calls, and make other members admins from their profile.

## Going live (Cloudflare)

The D1 database `ai-entrepreneur-network` already exists in the Cloudflare
account and is referenced in `wrangler.jsonc`.

1. In the Cloudflare dashboard go to **Workers & Pages → Create application →
   Import a repository**, pick `ai-entrepreneur-network`, and keep the project
   name `ai-entrepreneur-network` (it must match `wrangler.jsonc`). Leave the
   build command empty and the deploy command as `npx wrangler deploy`.
2. After the first deploy, open the Worker's **Settings → Variables and Secrets**
   and add a secret named `INVITE_CODE`. People will need it to join. Without it,
   anyone with the link can sign up.
3. Visit the `*.workers.dev` link, register first (you become admin), then share
   the link and invite code.

Every push to `main` redeploys automatically.

## Development

```bash
npm install
npm run dev   # local Worker with a local D1 + Durable Object at http://localhost:8787
npm test      # starts a throwaway local Worker and runs the API/realtime tests
```

Put local settings such as `INVITE_CODE=test` in a `.dev.vars` file.

- `worker/` — API routes, realtime hub, schema, password hashing, call scheduling
- `public/` — the browser app (plain HTML/CSS/JS, no build step)
- `test/` — integration tests
