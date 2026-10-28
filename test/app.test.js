import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { upcomingOccurrences, zonedToUtc } from '../worker/schedule.js';

// Runs the real Worker (D1 + Durable Objects) locally with a throwaway database.
let wrangler;
let stateDir;
const port = 8800 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;

// Stands in for Google's token endpoint; each test sets the claims it should return.
let googleClaims = {};
const googleStub = http.createServer((req, res) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id_token: `${b64({ alg: 'none' })}.${b64(googleClaims)}.sig` }));
});

// Stands in for a browser push service and records what it receives.
const pushes = [];
const pushStub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.statusCode = req.url.includes('gone') ? 410 : 201;
    res.end();
  });
});

before(async () => {
  await new Promise((resolve) => googleStub.listen(0, resolve));
  await new Promise((resolve) => pushStub.listen(0, resolve));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aen-test-'));
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--persist-to', stateDir,
    '--var', 'INVITE_CODE:faith', '--var', 'GOOGLE_CLIENT_ID:test-client', '--var', 'GOOGLE_CLIENT_SECRET:shh',
    '--var', `GOOGLE_TOKEN_URL:http://127.0.0.1:${googleStub.address().port}/token`, '--var', 'ALLOW_HTTP_PUSH:1', '--var', 'REMINDER_CHECK_MS:1500',
    '--show-interactive-dev-session=false'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  googleStub.close();
  pushStub.close();
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

async function invite(name, email) {
  const res = await alice('/api/invites', { method: 'POST', body: { name, email } });
  assert.equal(res.status, 200);
  return res.data.invite.token;
}

test('membership is invite-only: personal, single-use links from an admin', async () => {
  // The very first person needs no invite and becomes the admin.
  const a = await alice('/api/auth/register', { method: 'POST', body: { email: 'a@x.com', password: 'password1', name: 'Alice' } });
  assert.equal(a.status, 200);
  assert.equal(a.data.user.role, 'admin');

  const noInvite = await bob('/api/auth/register', { method: 'POST', body: { email: 'b@x.com', password: 'password1', name: 'Bob' } });
  assert.equal(noInvite.status, 403);
  const wrongCode = await bob('/api/auth/register', { method: 'POST', body: { email: 'b@x.com', password: 'password1', name: 'Bob', inviteCode: 'nope' } });
  assert.equal(wrongCode.status, 403);

  const bobToken = await invite('Bob', 'b@x.com');
  const preview = await client()(`/api/invites/${bobToken}`);
  assert.equal(preview.data.invite.name, 'Bob');
  const b = await bob('/api/auth/register', { method: 'POST', body: { email: 'b@x.com', password: 'password1', name: 'Bob', inviteToken: bobToken } });
  assert.equal(b.data.user.role, 'member');

  // A used link can't be reused by someone else.
  const reuse = await client()('/api/auth/register', { method: 'POST', body: { email: 'z@x.com', password: 'password1', name: 'Z', inviteToken: bobToken } });
  assert.equal(reuse.status, 403);
  assert.equal((await client()(`/api/invites/${bobToken}`)).status, 404);

  const carolToken = await invite('Carol', 'c@x.com');
  // A failed sign-up (duplicate email) doesn't burn the invite.
  const dup = await carol('/api/auth/register', { method: 'POST', body: { email: 'A@x.com', password: 'password1', name: 'X', inviteToken: carolToken } });
  assert.equal(dup.status, 409);
  await carol('/api/auth/register', { method: 'POST', body: { email: 'c@x.com', password: 'password1', name: 'Carol', inviteToken: carolToken } });

  // Admins can cancel unused invites; members can't create them.
  const cancelled = await invite('Eve', 'eve@x.com');
  assert.equal((await alice(`/api/invites/${cancelled}`, { method: 'DELETE' })).status, 200);
  assert.equal((await client()('/api/auth/register', { method: 'POST', body: { email: 'eve@x.com', password: 'password1', name: 'Eve', inviteToken: cancelled } })).status, 403);
  assert.equal((await bob('/api/invites', { method: 'POST', body: { name: 'X', email: 'x@x.com' } })).status, 403);
  assert.equal((await alice('/api/invites', { method: 'POST', body: { name: 'Bob', email: 'B@x.com' } })).status, 409, 'already a member');

  // A link can be made from just a name.
  const nameOnly = await alice('/api/invites', { method: 'POST', body: { name: 'Just A Name' } });
  assert.equal(nameOnly.status, 200);
  assert.equal((await client()(`/api/invites/${nameOnly.data.invite.token}`)).data.invite.email, '');
  await alice(`/api/invites/${nameOnly.data.invite.token}`, { method: 'DELETE' });

  const list = await alice('/api/invites');
  assert.deepEqual(list.data.invites.map((i) => i.status).sort(), ['cancelled', 'cancelled', 'joined', 'joined']);
});

test('the group invite code still works, and admins can change or turn it off', async () => {
  assert.equal((await client()('/api/config')).data.codeEnabled, true);
  assert.equal((await alice('/api/invite-code')).data.code, 'faith', 'starts from the INVITE_CODE secret');
  assert.equal((await bob('/api/invite-code')).status, 403);

  const coded = await client()('/api/auth/register', { method: 'POST', body: { email: 'code1@x.com', password: 'password1', name: 'Coded One', inviteCode: ' Faith ' } });
  assert.equal(coded.status, 200, 'codes are not case-sensitive');

  // The shareable join link checks the code without signing in.
  assert.equal((await client()('/api/invite-code/check?code=FAITH')).data.valid, true);
  assert.equal((await client()('/api/invite-code/check?code=wrong')).data.valid, false);

  assert.equal((await alice('/api/invite-code', { method: 'PUT', body: { code: 'ab' } })).status, 400);
  await alice('/api/invite-code', { method: 'PUT', body: { code: 'kingdom-2026' } });
  assert.equal((await client()('/api/auth/register', { method: 'POST', body: { email: 'code2@x.com', password: 'password1', name: 'Old Code', inviteCode: 'faith' } })).status, 403);
  assert.equal((await client()('/api/auth/register', { method: 'POST', body: { email: 'code2@x.com', password: 'password1', name: 'New Code', inviteCode: 'kingdom-2026' } })).status, 200);

  await alice('/api/invite-code', { method: 'PUT', body: { code: '' } });
  assert.equal((await client()('/api/config')).data.codeEnabled, false);
  assert.equal((await client()('/api/auth/register', { method: 'POST', body: { email: 'code3@x.com', password: 'password1', name: 'X', inviteCode: 'kingdom-2026' } })).status, 403);
  await alice('/api/invite-code', { method: 'PUT', body: { code: 'faith' } });
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

async function googleSignIn({ invite = '', code = '', claims, state: badState }) {
  const query = code ? `?code=${code}` : invite ? `?invite=${invite}` : '';
  const start = await fetch(`${base}/api/auth/google/start${query}`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const oauthCookie = start.headers.get('set-cookie').split(';')[0];
  googleClaims = { aud: 'test-client', email_verified: true, ...claims };
  const state = badState ?? location.searchParams.get('state');
  const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual', headers: { cookie: oauthCookie } });
  const session = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('aen_session=') && !c.startsWith('aen_session=;'));
  return { start: location, status: res.status, location: res.headers.get('location'), cookie: session?.split(';')[0] };
}

test('Google sign-in: invite required for new members, links existing emails', async () => {
  assert.equal((await (await fetch(`${base}/api/config`)).json()).googleEnabled, true);

  const tampered = await googleSignIn({ invite: 'whatever', claims: { sub: 'g-x', email: 'x@x.com' }, state: 'forged' });
  assert.equal(tampered.location, '/?auth_error=google');
  assert.equal(tampered.cookie, undefined);

  const noInvite = await googleSignIn({ claims: { sub: 'g-dana', email: 'dana@x.com', name: 'Dana Lee' } });
  assert.equal(noInvite.location, '/?auth_error=not-member');
  const badInvite = await googleSignIn({ invite: 'not-a-real-token', claims: { sub: 'g-dana', email: 'dana@x.com' } });
  assert.equal(badInvite.location, '/?auth_error=invite');

  const danaToken = await invite('Dana', 'dana@x.com');
  const dana = await googleSignIn({ invite: danaToken, claims: { sub: 'g-dana', email: 'Dana@x.com', name: 'Dana Lee' } });
  assert.equal(dana.start.origin, 'https://accounts.google.com');
  assert.equal(dana.start.searchParams.get('client_id'), 'test-client');
  assert.equal(dana.start.searchParams.get('redirect_uri'), `${base}/api/auth/google/callback`);
  assert.equal(dana.location, '/');
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: dana.cookie } })).json();
  assert.equal(me.user.name, 'Dana Lee');
  assert.equal(me.user.email, 'dana@x.com');
  assert.equal(me.user.role, 'member');

  // Returning Google members don't need the invite code again.
  const again = await googleSignIn({ claims: { sub: 'g-dana', email: 'dana@x.com' } });
  assert.equal(again.location, '/');

  // An existing email/password member signing in with Google lands in the same account.
  const alice = await googleSignIn({ claims: { sub: 'g-alice', email: 'a@x.com', name: 'Someone Else' } });
  const aliceMe = await (await fetch(`${base}/api/me`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(aliceMe.user.id, 1);
  assert.equal(aliceMe.user.name, 'Alice');

  // The group code works for Google sign-up too.
  const viaCode = await googleSignIn({ claims: { sub: 'g-code', email: 'gcode@x.com', name: 'Code Person' }, code: 'faith' });
  assert.equal(viaCode.location, '/');

  const wrongAudience = await googleSignIn({ invite: await invite('Y', 'y@x.com'), claims: { sub: 'g-y', email: 'y@x.com', aud: 'other-app' } });
  assert.equal(wrongAudience.location, '/?auth_error=google');

  // Google-only accounts have no password to guess.
  assert.equal((await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dana@x.com', password: '' }),
  })).status, 401);
});

test('admins can remove a member, which signs them out everywhere', async () => {
  const token = await invite('Temp', 'temp@x.com');
  const temp = client();
  await temp('/api/auth/register', { method: 'POST', body: { email: 'temp@x.com', password: 'password1', name: 'Temp', inviteToken: token } });
  const id = (await temp('/api/me')).data.user.id;
  assert.equal((await bob(`/api/users/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await alice('/api/users/1', { method: 'DELETE' })).status, 400, 'admins cannot remove themselves');
  assert.equal((await alice(`/api/users/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await temp('/api/me')).status, 401);
});

// A fake browser subscription whose private key lets the test decrypt pushes (RFC 8291).
function fakeDevice(path) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = {
    endpoint: `http://127.0.0.1:${pushStub.address().port}${path}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const decrypt = (body) => {
    const salt = body.subarray(0, 16);
    const idLen = body[20];
    const asPublic = body.subarray(21, 21 + idLen);
    const ciphertext = body.subarray(21 + idLen);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'last-record delimiter');
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { subscription, decrypt };
}

function verifyVapid(headers, endpoint) {
  const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization);
  const [h, c, sig] = jwt.split('.');
  const raw = Buffer.from(key, 'base64url');
  const publicKey = crypto.createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url'),
  } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.match(claims.sub, /^mailto:/);
}

const waitForPush = async (path, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = pushes.find((p) => p.path === path);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test('push notifications: private messages and @mentions reach closed apps, encrypted', async () => {
  const key = await alice('/api/push/key');
  assert.match(key.data.publicKey, /^[\w-]{80,}$/);
  assert.equal((await alice('/api/push/subscribe', { method: 'POST', body: { endpoint: 'ftp://x', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);

  const device = fakeDevice('/push/alice');
  assert.equal((await alice('/api/push/subscribe', { method: 'POST', body: device.subscription })).status, 200);

  // A private message from Bob.
  const { data } = await bob('/api/conversations', { method: 'POST', body: { userId: 1 } });
  await bob(`/api/rooms/${data.conversation.room}/messages`, { method: 'POST', body: { body: 'Can we pray before the launch?' } });
  const dm = await waitForPush('/push/alice');
  assert.ok(dm, 'push delivered');
  assert.equal(dm.headers['content-encoding'], 'aes128gcm');
  verifyVapid(dm.headers, device.subscription.endpoint);
  const dmPayload = device.decrypt(dm.body);
  assert.equal(dmPayload.title, 'Bob');
  assert.equal(dmPayload.body, 'Can we pray before the launch?');
  assert.equal(dmPayload.url, `/#/${data.conversation.room.replace(':', '/')}`);

  // Channel messages only notify people who are @mentioned.
  pushes.length = 0;
  const general = (await bob('/api/bootstrap')).data.channels.find((c) => c.name === 'general');
  await bob(`/api/rooms/${general.room}/messages`, { method: 'POST', body: { body: 'No mention here' } });
  await bob(`/api/rooms/${general.room}/messages`, { method: 'POST', body: { body: 'Thoughts on this, @alice?' } });
  const mention = await waitForPush('/push/alice');
  assert.equal(device.decrypt(mention.body).title, 'Bob in #general');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(pushes.length, 1, 'only the mention notified');

  // No push while the app is open on screen.
  pushes.length = 0;
  const ws = new WebSocket(`ws://localhost:${port}/api/ws`, { headers: { cookie: alice.cookie() } });
  await new Promise((resolve) => { ws.onopen = resolve; });
  ws.send(JSON.stringify({ type: 'active', active: true }));
  await new Promise((r) => setTimeout(r, 200));
  await bob(`/api/rooms/${data.conversation.room}/messages`, { method: 'POST', body: { body: 'You there?' } });
  assert.equal(await waitForPush('/push/alice', 1000), null, 'skipped while active');
  ws.send(JSON.stringify({ type: 'active', active: false }));
  await new Promise((r) => setTimeout(r, 200));
  await bob(`/api/rooms/${data.conversation.room}/messages`, { method: 'POST', body: { body: 'Ping' } });
  assert.ok(await waitForPush('/push/alice'), 'sent once the app is in the background');
  ws.close();

  // Devices the push service says are gone get cleaned up; unsubscribed devices get nothing.
  pushes.length = 0;
  const gone = fakeDevice('/push/gone');
  await carol('/api/push/subscribe', { method: 'POST', body: gone.subscription });
  const carolDm = (await bob('/api/conversations', { method: 'POST', body: { userId: 3 } })).data.conversation.room;
  await bob(`/api/rooms/${carolDm}/messages`, { method: 'POST', body: { body: 'hi' } });
  assert.ok(await waitForPush('/push/gone'));
  pushes.length = 0;
  await bob(`/api/rooms/${carolDm}/messages`, { method: 'POST', body: { body: 'hi again' } });
  assert.equal(await waitForPush('/push/gone', 1000), null, 'expired device removed');

  await alice('/api/push/unsubscribe', { method: 'POST', body: { endpoint: device.subscription.endpoint } });
  pushes.length = 0;
  await bob(`/api/rooms/${data.conversation.room}/messages`, { method: 'POST', body: { body: 'after unsubscribe' } });
  assert.equal(await waitForPush('/push/alice', 1000), null);
});

test('push notifications: a reminder before each community call', async () => {
  const device = fakeDevice('/push/bob-calls');
  await bob('/api/push/subscribe', { method: 'POST', body: device.subscription });
  const start = new Date(Date.now() + 10 * 60_000);
  const call = await alice('/api/calls', {
    method: 'POST',
    body: { title: 'Prayer Call', frequency: 'once', startDate: start.toISOString().slice(0, 10), startTime: start.toISOString().slice(11, 16), timezone: 'UTC', durationMin: 30 },
  });
  assert.equal(call.status, 200);
  // Any live connection starts the reminder check.
  const ws = new WebSocket(`ws://localhost:${port}/api/ws`, { headers: { cookie: carol.cookie() } });
  await new Promise((resolve) => { ws.onopen = resolve; });
  const reminder = await waitForPush('/push/bob-calls', 8000);
  ws.close();
  assert.ok(reminder, 'reminder sent');
  const payload = device.decrypt(reminder.body);
  assert.match(payload.title, /^Prayer Call starts in (9|10) min$/);
  assert.equal(payload.url, '/#/calls');
  // Only once per call.
  const count = () => pushes.filter((p) => p.path === '/push/bob-calls').length;
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(count(), 1);
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

test('new members start by experiencing the group; admins mark them committed', async () => {
  assert.equal((await alice('/api/me')).data.user.stage, 'member', 'the founding admin is a member');
  const me = (await bob('/api/me')).data.user;
  assert.equal(me.stage, 'guest');
  assert.equal((await bob(`/api/users/${me.id}/stage`, { method: 'PATCH', body: { stage: 'member' } })).status, 403);
  const res = await alice(`/api/users/${me.id}/stage`, { method: 'PATCH', body: { stage: 'member', committedOn: '2026-11-01' } });
  assert.equal(res.data.user.stage, 'member');
  assert.equal(res.data.user.committedOn, '2026-11-01');
  const back = await alice(`/api/users/${me.id}/stage`, { method: 'PATCH', body: { stage: 'guest' } });
  assert.equal(back.data.user.committedOn, null);
  const boot = await carol('/api/bootstrap');
  assert.equal(boot.data.users.find((u) => u.id === me.id).stage, 'guest');
  assert.ok(boot.data.channels.some((c) => c.name === 'next-steps'), 'the #next-steps channel exists');
});

test('my five: up to five people, private to each member, with time logged', async () => {
  for (const name of ['Dan', 'Eli', 'Finn', 'Gus', 'Hal']) {
    assert.equal((await bob('/api/five', { method: 'POST', body: { name, context: 'client' } })).status, 200);
  }
  const sixth = await bob('/api/five', { method: 'POST', body: { name: 'Ian' } });
  assert.equal(sixth.status, 400);
  let five = (await bob('/api/five')).data;
  assert.equal(five.people.length, 5);
  const dan = five.people[0];

  five = (await bob(`/api/five/${dan.id}/meetings`, { method: 'POST', body: { metOn: '2026-10-20', note: 'Coffee', nextStep: false } })).data;
  five = (await bob(`/api/five/${dan.id}/meetings`, { method: 'POST', body: { metOn: '2026-10-27', note: 'Asked to read John together', nextStep: true } })).data;
  const meetings = five.people.find((p) => p.id === dan.id).meetings;
  assert.deepEqual(meetings.map((m) => [m.metOn, m.nextStep]), [['2026-10-27', true], ['2026-10-20', false]]);

  // Nobody else can see, change, or log against Bob's list.
  assert.equal((await carol('/api/five')).data.people.length, 0);
  assert.equal((await carol(`/api/five/${dan.id}`, { method: 'PATCH', body: { name: 'X' } })).status, 404);
  assert.equal((await carol(`/api/five/${dan.id}/meetings`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await carol(`/api/five/meetings/${meetings[0].id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await alice(`/api/five/${dan.id}`, { method: 'DELETE' })).status, 404, 'not even admins');

  five = (await bob(`/api/five/meetings/${meetings[1].id}`, { method: 'DELETE' })).data;
  assert.equal(five.people.find((p) => p.id === dan.id).meetings.length, 1);
  five = (await bob(`/api/five/${dan.id}`, { method: 'DELETE' })).data;
  assert.equal(five.people.length, 4);
  assert.equal((await bob('/api/five', { method: 'POST', body: { name: 'Ian' } })).status, 200, 'room for someone new');
});

test('quarterly gatherings repeat every three months on the same day', () => {
  const call = { start_date: '2026-01-31', start_time: '18:00', timezone: 'America/Los_Angeles', frequency: 'quarterly', duration_min: 180 };
  const occ = upcomingOccurrences(call, Date.parse('2026-03-01T00:00:00Z'), 3);
  assert.deepEqual(occ.map((o) => o.occurrence), ['2026-04-30', '2026-07-31', '2026-10-31']);
});
