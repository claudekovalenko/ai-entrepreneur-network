import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upcomingOccurrences, zonedToUtc } from '../worker/schedule.js';

// Runs the real Worker (D1 + Durable Objects) locally with a throwaway database.
let wrangler;
let stateDir;
const port = 8800 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aen-test-'));
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--persist-to', stateDir,
    '--var', 'INVITE_CODE:faith', '--show-interactive-dev-session=false'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  process.kill(-wrangler.pid);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function connect(cookie) {
  return new WebSocket(`ws://localhost:${port}/api/ws`, { headers: cookie ? { cookie } : {} });
}

function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body && JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  call.cookie = () => cookie;
  return call;
}

const alice = client();
const bob = client();
const carol = client();

test('registration requires the invite code and makes the first user admin', async () => {
  const bad = await alice('/api/auth/register', { method: 'POST', body: { email: 'a@x.com', password: 'password1', name: 'Alice' } });
  assert.equal(bad.status, 403);

  const a = await alice('/api/auth/register', { method: 'POST', body: { email: 'a@x.com', password: 'password1', name: 'Alice', inviteCode: 'faith' } });
  assert.equal(a.status, 200);
  assert.equal(a.data.user.role, 'admin');

  const b = await bob('/api/auth/register', { method: 'POST', body: { email: 'b@x.com', password: 'password1', name: 'Bob', inviteCode: 'faith' } });
  assert.equal(b.data.user.role, 'member');
  await carol('/api/auth/register', { method: 'POST', body: { email: 'c@x.com', password: 'password1', name: 'Carol', inviteCode: 'faith' } });

  const dup = await carol('/api/auth/register', { method: 'POST', body: { email: 'A@x.com', password: 'password1', name: 'X', inviteCode: 'faith' } });
  assert.equal(dup.status, 409);
});

test('login and unauthenticated access', async () => {
  const anon = client();
  assert.equal((await anon('/api/bootstrap')).status, 401);
  assert.equal((await anon('/api/auth/login', { method: 'POST', body: { email: 'a@x.com', password: 'nope' } })).status, 401);
  assert.equal((await anon('/api/auth/login', { method: 'POST', body: { email: 'a@x.com', password: 'password1' } })).status, 200);
  assert.equal((await anon('/api/bootstrap')).status, 200);
});

test('channel messages, reactions, edits and unread counts', async () => {
  const { data } = await alice('/api/bootstrap');
  assert.ok(data.channels.length >= 5);
  const general = data.channels.find((c) => c.name === 'general');

  const sent = await alice(`/api/rooms/${general.room}/messages`, { method: 'POST', body: { body: 'Welcome, friends!' } });
  assert.equal(sent.status, 200);
  const id = sent.data.message.id;

  const bobBoot = await bob('/api/bootstrap');
  assert.equal(bobBoot.data.channels.find((c) => c.id === general.id).unread, 1);
  await bob(`/api/rooms/${general.room}/read`, { method: 'POST', body: { lastReadId: id } });
  assert.equal((await bob('/api/bootstrap')).data.channels.find((c) => c.id === general.id).unread, 0);

  const reacted = await bob(`/api/messages/${id}/reactions`, { method: 'POST', body: { emoji: '🙏' } });
  assert.deepEqual(reacted.data.message.reactions, [{ emoji: '🙏', userIds: [2] }]);
  assert.equal((await bob(`/api/messages/${id}/reactions`, { method: 'POST', body: { emoji: '<script>' } })).status, 400);

  assert.equal((await bob(`/api/messages/${id}`, { method: 'PATCH', body: { body: 'hijack' } })).status, 403);
  const edited = await alice(`/api/messages/${id}`, { method: 'PATCH', body: { body: 'Welcome, everyone!' } });
  assert.ok(edited.data.message.editedAt);

  const list = await carol(`/api/rooms/${general.room}/messages`);
  assert.equal(list.data.messages.at(-1).body, 'Welcome, everyone!');
});

test('direct messages are private to the two members', async () => {
  const { data } = await alice('/api/conversations', { method: 'POST', body: { userId: 2 } });
  const room = data.conversation.room;
  const again = await bob('/api/conversations', { method: 'POST', body: { userId: 1 } });
  assert.equal(again.data.conversation.room, room);

  await alice(`/api/rooms/${room}/messages`, { method: 'POST', body: { body: 'Praying for your launch' } });
  assert.equal((await bob(`/api/rooms/${room}/messages`)).data.messages.length, 1);
  assert.equal((await carol(`/api/rooms/${room}/messages`)).status, 404);
  assert.equal((await carol(`/api/rooms/${room}/messages`, { method: 'POST', body: { body: 'hi' } })).status, 404);
  assert.equal((await bob('/api/bootstrap')).data.conversations[0].unread, 1);
});

test('realtime delivery over WebSockets', async () => {
  const socket = connect(bob.cookie());
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const received = new Promise((resolve) => {
    socket.onmessage = (e) => {
      const { event, data } = JSON.parse(e.data);
      if (event === 'message:new') resolve(data);
    };
  });
  const { data } = await alice('/api/bootstrap');
  assert.ok(data.online.includes(2), 'bob shows as online');
  const ideas = data.channels.find((c) => c.name === 'ideas');
  await alice(`/api/rooms/${ideas.room}/messages`, { method: 'POST', body: { body: 'AI sermon clip tool?' } });
  const message = await received;
  assert.equal(message.body, 'AI sermon clip tool?');
  socket.close();

  const anon = connect();
  await new Promise((resolve) => { anon.onerror = resolve; anon.onclose = resolve; });
  assert.notEqual(anon.readyState, WebSocket.OPEN);
});

test('cross-site and non-JSON writes are rejected', async () => {
  const res = await fetch(`${base}/api/rooms/c:1/messages`, {
    method: 'POST', headers: { cookie: alice.cookie(), 'Content-Type': 'text/plain' }, body: '{"body":"x"}',
  });
  assert.equal(res.status, 415);
  const cross = await fetch(`${base}/api/rooms/c:1/messages`, {
    method: 'POST', headers: { cookie: alice.cookie(), 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"body":"x"}',
  });
  assert.equal(cross.status, 403);
});

test('only admins manage channels and calls', async () => {
  assert.equal((await bob('/api/channels', { method: 'POST', body: { name: 'x' } })).status, 403);
  const created = await alice('/api/channels', { method: 'POST', body: { name: 'Marketing Automation!', description: 'd' } });
  assert.equal(created.data.channel.name, 'marketing-automation');

  assert.equal((await bob('/api/calls', { method: 'POST', body: {} })).status, 403);
  const call = await alice('/api/calls', {
    method: 'POST',
    body: { title: 'Weekly Call', frequency: 'biweekly', startDate: '2026-01-06', startTime: '19:00', timezone: 'America/Chicago', durationMin: 60, link: 'https://meet.example.com/x' },
  });
  assert.equal(call.status, 200);
  const occ = call.data.call.occurrences[0];
  const rsvp = await bob(`/api/calls/${call.data.call.id}/rsvp`, { method: 'POST', body: { occurrence: occ.occurrence } });
  assert.deepEqual(rsvp.data.call.occurrences[0].rsvps, [2]);
  assert.equal((await bob(`/api/calls/${call.data.call.id}/rsvp`, { method: 'POST', body: { occurrence: '2020-01-01' } })).status, 400);
  assert.equal((await alice('/api/calls', { method: 'POST', body: { title: 'x', startDate: '2026-01-01', startTime: '10:00', link: 'javascript:alert(1)' } })).status, 400);
});

test('projects: post, offer help, comment, owner-only edits', async () => {
  const p = await bob('/api/projects', { method: 'POST', body: { title: 'Church follow-up bot', helpNeeded: 'Need a Twilio dev', tags: 'sms, ai' } });
  assert.equal(p.data.project.status, 'looking');
  const id = p.data.project.id;

  assert.equal((await carol(`/api/projects/${id}`, { method: 'PATCH', body: { title: 'mine now' } })).status, 403);
  const helped = await carol(`/api/projects/${id}/helpers`, { method: 'POST', body: { note: 'I know Twilio' } });
  assert.equal(helped.data.project.helpers[0].note, 'I know Twilio');
  await alice(`/api/projects/${id}/comments`, { method: 'POST', body: { body: 'Love this!' } });

  const detail = await bob(`/api/projects/${id}`);
  assert.equal(detail.data.project.comments.length, 1);
  const updated = await bob(`/api/projects/${id}`, { method: 'PATCH', body: { status: 'launched' } });
  assert.equal(updated.data.project.status, 'launched');
  assert.equal(updated.data.project.title, 'Church follow-up bot');
  assert.equal((await bob(`/api/projects/${id}`, { method: 'PATCH', body: { status: 'bogus' } })).status, 400);
});

test('suggestions: post, vote, comment, admin-only status', async () => {
  const posted = await bob('/api/suggestions', { method: 'POST', body: { title: 'Monthly prayer day', details: 'Fast and pray for our ventures' } });
  assert.equal(posted.status, 200);
  const id = posted.data.suggestion.id;
  assert.equal(posted.data.suggestion.votes, 1, 'author backs their own idea');

  const voted = await carol(`/api/suggestions/${id}/vote`, { method: 'POST', body: { vote: true } });
  assert.equal(voted.data.suggestion.votes, 2);
  assert.equal(voted.data.suggestion.voted, true);
  await carol(`/api/suggestions/${id}/vote`, { method: 'POST', body: { vote: true } });
  assert.equal((await alice('/api/suggestions')).data.suggestions.find((x) => x.id === id).votes, 2, 'double votes count once');

  await alice(`/api/suggestions/${id}/comments`, { method: 'POST', body: { body: 'Yes! First Friday?' } });
  assert.equal((await bob(`/api/suggestions/${id}`)).data.suggestion.comments.length, 1);

  assert.equal((await bob(`/api/suggestions/${id}`, { method: 'PATCH', body: { status: 'planned' } })).status, 403);
  assert.equal((await carol(`/api/suggestions/${id}`, { method: 'PATCH', body: { title: 'hijack' } })).status, 403);
  const planned = await alice(`/api/suggestions/${id}`, { method: 'PATCH', body: { status: 'planned' } });
  assert.equal(planned.data.suggestion.status, 'planned');
  assert.equal(planned.data.suggestion.title, 'Monthly prayer day');

  assert.equal((await carol(`/api/suggestions/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await bob(`/api/suggestions/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await bob(`/api/suggestions/${id}`)).status, 404);
});

test("what's working: share cases and blueprints, mark helpful", async () => {
  const shared = await bob('/api/playbooks', {
    method: 'POST',
    body: { kind: 'case', title: 'AI receptionist for dentists', customer: 'Dental offices', hoursPerWeek: '6', revenue: '1k-5k', timeFreed: 'Home by 3pm' },
  });
  assert.equal(shared.status, 200);
  const id = shared.data.playbook.id;
  assert.equal(shared.data.playbook.hoursPerWeek, 6);
  assert.equal((await bob('/api/playbooks', { method: 'POST', body: { kind: 'case', title: 'x', hoursPerWeek: 500 } })).status, 400);
  assert.equal((await bob('/api/playbooks', { method: 'POST', body: { kind: 'case', title: 'x', revenue: 'a million' } })).status, 400);

  const blueprint = await alice('/api/playbooks', { method: 'POST', body: { kind: 'blueprint', title: 'First 3 clients', steps: 'Pick a niche\nInterview 5 owners' } });
  assert.equal(blueprint.data.playbook.kind, 'blueprint');

  const helpful = await carol(`/api/playbooks/${id}/vote`, { method: 'POST', body: { vote: true } });
  assert.equal(helpful.data.playbook.votes, 1);
  await carol(`/api/playbooks/${id}/comments`, { method: 'POST', body: { body: 'Which phone tool?' } });
  assert.equal((await bob(`/api/playbooks/${id}`)).data.playbook.comments.length, 1);

  assert.equal((await carol(`/api/playbooks/${id}`, { method: 'PATCH', body: { title: 'mine' } })).status, 403);
  const edited = await bob(`/api/playbooks/${id}`, { method: 'PATCH', body: { hoursPerWeek: '' } });
  assert.equal(edited.data.playbook.hoursPerWeek, null);
  assert.equal(edited.data.playbook.revenue, '1k-5k');
  assert.equal((await alice(`/api/playbooks/${id}`, { method: 'DELETE' })).status, 200, 'admins can remove posts');
});

test('recurring calls keep local wall-clock time across DST', () => {
  const call = { start_date: '2026-10-20', start_time: '19:00', timezone: 'America/Chicago', frequency: 'weekly', duration_min: 60 };
  const now = Date.parse('2026-10-21T02:00:00Z');
  const occ = upcomingOccurrences(call, now, 3);
  assert.deepEqual(occ.map((o) => o.occurrence), ['2026-10-27', '2026-11-03', '2026-11-10']);
  // 7pm CDT is 00:00Z next day; 7pm CST (after Nov 1) is 01:00Z.
  assert.equal(occ[0].startsAt, '2026-10-28T00:00:00.000Z');
  assert.equal(occ[1].startsAt, '2026-11-04T01:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-07-01', '09:30', 'Europe/London')).toISOString(), '2026-07-01T08:30:00.000Z');

  const once = { ...call, frequency: 'once' };
  assert.equal(upcomingOccurrences(once, Date.parse('2027-01-01')).length, 0);
});
