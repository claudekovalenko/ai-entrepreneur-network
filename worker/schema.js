// D1 schema. Every statement is idempotent, so it runs once per Worker isolate
// and there is no separate migration step to remember when deploying.

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    headline TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '',
    ministry TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // Personal, single-use invite links. Joining ACE requires one (except for the very first admin).
  `CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // One row per device a member turned notifications on for.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // Call reminders already sent, so each occurrence is announced once.
  `CREATE TABLE IF NOT EXISTS call_reminders (
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    PRIMARY KEY (call_id, occurrence)
  )`,
  // Sign-in providers linked to a member, e.g. ('google', <Google account id>).
  `CREATE TABLE IF NOT EXISTS oauth_accounts (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (provider, subject)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // 1:1 private conversations. user_a < user_b keeps each pair unique.
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (user_a, user_b),
    CHECK (user_a < user_b)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    edited_at TEXT,
    CHECK ((channel_id IS NULL) <> (conversation_id IS NULL))
  )`,
  'CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id)',
  'CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id)',
  `CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  )`,
  // Last message each user has read, keyed by 'c:<channelId>' or 'd:<conversationId>'.
  `CREATE TABLE IF NOT EXISTS reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, room)
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    help_needed TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'looking',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS project_helpers (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (project_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS project_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL DEFAULT 'weekly',
    start_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    duration_min INTEGER NOT NULL DEFAULT 60,
    link TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (suggestion_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS suggestion_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // "What's working": member-shared working businesses (kind 'case') and blueprints (kind 'blueprint').
  `CREATE TABLE IF NOT EXISTS playbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    offer TEXT NOT NULL DEFAULT '',
    acquisition TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '',
    revenue TEXT NOT NULL DEFAULT '',
    hours_per_week INTEGER,
    time_freed TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS playbook_votes (
    playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (playbook_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS playbook_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS call_rsvps (
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (call_id, occurrence, user_id)
  )`,
  // People each member is discipling: praying for and pursuing. Private to that member.
  `CREATE TABLE IF NOT EXISTS five_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  'CREATE INDEX IF NOT EXISTS five_people_user ON five_people(user_id)',
  // Times a member met with one of their five, and any next step toward God they saw.
  `CREATE TABLE IF NOT EXISTS five_meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES five_people(id) ON DELETE CASCADE,
    met_on TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    next_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  'CREATE INDEX IF NOT EXISTS five_meetings_person ON five_meetings(person_id, met_on)',
  // Real estate deals members are looking into together.
  `CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    property_type TEXT NOT NULL DEFAULT 'single-family',
    status TEXT NOT NULL DEFAULT 'looking',
    price INTEGER NOT NULL DEFAULT 0,
    down_pct REAL NOT NULL DEFAULT 25,
    rate REAL NOT NULL DEFAULT 7,
    years INTEGER NOT NULL DEFAULT 30,
    closing_pct REAL NOT NULL DEFAULT 3,
    rent INTEGER NOT NULL DEFAULT 0,
    expenses INTEGER NOT NULL DEFAULT 0,
    link TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // Members who would like to partner on a deal.
  `CREATE TABLE IF NOT EXISTS deal_partners (
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (deal_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS deal_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  // Starter channels, only for a brand-new network.
  `INSERT INTO channels (name, description)
    SELECT column1, column2 FROM (VALUES
      ('general', 'Announcements and conversation for the whole network'),
      ('encouragement', 'Scripture, wins, and words to build one another up'),
      ('prayer-requests', 'Share what you need prayer for, and pray for others'),
      ('ai-tools-and-content', 'Tools, tutorials, prompts, and content worth sharing'),
      ('ideas', 'Business ideas to test, refine, and pressure-check together'),
      ('wins', 'Launches, first customers, hours given back to ministry'))
    WHERE NOT EXISTS (SELECT 1 FROM channels)`,
  // Added once to every network (an admin may delete it afterwards): where we tell the
  // stories of people taking a next step toward God.
  `INSERT INTO channels (name, description)
    SELECT 'next-steps', 'Did anyone take a next step toward God? Tell the story so we can celebrate what God is doing.'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'seeded:next-steps')
      AND NOT EXISTS (SELECT 1 FROM channels WHERE name = 'next-steps')`,
  "INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded:next-steps', '1')",
  `INSERT INTO channels (name, description)
    SELECT 'real-estate', 'Properties, markets, financing, and partnering on deals together'
    WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'seeded:real-estate')
      AND NOT EXISTS (SELECT 1 FROM channels WHERE name = 'real-estate')`,
  "INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded:real-estate', '1')",
];

// Columns added after launch. SQLite has no ADD COLUMN IF NOT EXISTS, so each one is
// tried and "duplicate column" is ignored.
const COLUMNS = [
  // 'guest' while experiencing the group, 'member' once committed for the year.
  "ALTER TABLE users ADD COLUMN stage TEXT NOT NULL DEFAULT 'member'",
  'ALTER TABLE users ADD COLUMN committed_on TEXT',
  // Where each member is in the pipeline, from building with AI to investing in real estate.
  "ALTER TABLE users ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'build'",
];

async function addColumns(db) {
  for (const sql of COLUMNS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message))) throw err;
    }
  }
}

let ready = null;

export function ensureSchema(db) {
  ready ??= db.batch(STATEMENTS.map((sql) => db.prepare(sql))).then(() => addColumns(db)).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
