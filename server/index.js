import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || path.join(process.cwd(), 'data', 'network.db');

const db = openDb(dbFile);
const { server } = createApp({
  db,
  inviteCode: process.env.INVITE_CODE || '',
  secureCookies: process.env.SECURE_COOKIES === 'true',
});

server.listen(port, () => {
  console.log(`AI Entrepreneur Network running at http://localhost:${port}`);
  if (!process.env.INVITE_CODE) console.log('Note: INVITE_CODE is not set, so anyone with the link can join.');
});
