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

## Running it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there is no
database to install).

```bash
npm install
npm start          # http://localhost:3000
```

The first person to register becomes the **admin**. Admins can create channels,
schedule calls, and make other members admins from their profile.

### Configuration

| Variable          | Default             | Purpose                                                              |
| ----------------- | ------------------- | -------------------------------------------------------------------- |
| `PORT`            | `3000`              | Port to listen on                                                    |
| `INVITE_CODE`     | _(none)_            | If set, people must enter this code to create an account. Recommended. |
| `DATABASE_FILE`   | `./data/network.db` | Where the SQLite database is stored                                  |
| `SECURE_COOKIES`  | `false`             | Set to `true` when served over HTTPS                                 |

Example:

```bash
INVITE_CODE=kingdom-builders SECURE_COOKIES=true npm start
```

### Deploying

It is a single Node process with a SQLite file, so any host that runs Node and
gives you a persistent disk works (Render, Railway, Fly.io, a small VPS). Point
`DATABASE_FILE` at the persistent volume, set `INVITE_CODE`, and put it behind HTTPS.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API, permissions, realtime and scheduling tests
```

- `server/` — Express API, Socket.IO realtime, SQLite schema, call scheduling
- `public/` — the browser app (plain HTML/CSS/JS, no build step)
- `test/` — integration tests
