// AI Christian Entrepreneurs — single-page client.

const VERSES = [
  ['Whatever you do, work heartily, as for the Lord and not for men.', 'Colossians 3:23'],
  ['Go therefore and make disciples of all nations…', 'Matthew 28:19'],
  ['Commit your work to the Lord, and your plans will be established.', 'Proverbs 16:3'],
  ['Let us not grow weary of doing good, for in due season we will reap.', 'Galatians 6:9'],
  ['Two are better than one, because they have a good reward for their toil.', 'Ecclesiastes 4:9'],
  ['Iron sharpens iron, and one man sharpens another.', 'Proverbs 27:17'],
  ['Unless the Lord builds the house, those who build it labor in vain.', 'Psalm 127:1'],
  ['Therefore encourage one another and build one another up.', '1 Thessalonians 5:11'],
];

const STATUS_LABELS = { looking: 'Looking for help', 'in-progress': 'In progress', launched: 'Launched', paused: 'Paused' };
const REVENUE_LABELS = {
  '': 'Prefer not to say', 'pre-revenue': 'Pre-revenue', 'under-1k': 'Under $1k/mo',
  '1k-5k': '$1k–5k/mo', '5k-10k': '$5k–10k/mo', '10k-plus': '$10k+/mo',
};
const SUGGESTION_LABELS = { open: 'Open', planned: 'Planned', done: 'Done', 'not-now': 'Not now' };
const FREQ_LABELS = { weekly: 'Every week', biweekly: 'Every other week', quarterly: 'Every three months', once: 'One time' };
const AVATAR_COLORS = ['#b9802a', '#2c5aa0', '#2f8a5b', '#8a3f8f', '#b3412f', '#1f7a83', '#5b5fc7', '#9a6a1f'];

const state = {
  config: null,
  me: null,
  users: new Map(),
  channels: [],
  conversations: [],
  online: new Set(),
  reactions: [],
  rooms: new Map(), // room -> { messages, hasMore, loaded }
  typing: new Map(), // room -> Map(userId -> timeout)
  projects: null,
  suggestions: null,
  playbooks: null,
  calls: null,
  route: { name: 'home' },
  socket: null,
  editing: null, // message id being edited
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Escapes first, then applies a tiny safe subset of formatting.
function formatText(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return s;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toast-root').append(el);
  setTimeout(() => el.remove(), 3500);
}

const userName = (id) => state.users.get(id)?.name ?? 'Former member';
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function avatar(userId, size = '') {
  const name = userName(userId);
  return h('div', {
    class: `avatar ${size}`, title: name,
    style: `background:${AVATAR_COLORS[userId % AVATAR_COLORS.length]}`,
  }, initials(name));
}

function relTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function shortDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function verseOfDay() {
  const day = Math.floor(Date.now() / 86_400_000);
  return VERSES[day % VERSES.length];
}

function roomInfo(room) {
  if (room.startsWith('c:')) {
    const c = state.channels.find((x) => x.room === room);
    return c && { kind: 'channel', title: `# ${c.name}`, sub: c.description, channel: c };
  }
  const c = state.conversations.find((x) => x.room === room);
  return c && { kind: 'dm', title: userName(c.otherUserId), sub: state.users.get(c.otherUserId)?.headline || 'Private conversation', convo: c };
}

// ---------- modal ----------

let modalKeyHandler = null;

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  if (modalKeyHandler) document.removeEventListener('keydown', modalKeyHandler);
  modalKeyHandler = null;
}

// Replaces any open modal. `onClose` runs only when the user dismisses it.
function openModal(title, body, { wide = false, onClose } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  const close = () => { closeModal(); onClose?.(); };
  modalKeyHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', modalKeyHandler);
  root.append(h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('h2', { class: 'serif' }, title),
        h('button', { class: 'modal-close', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body))));
  root.querySelector('input, textarea, select')?.focus();
  return close;
}

function formError() {
  return h('p', { class: 'error-text hidden' });
}
function showFormError(el, err) {
  el.textContent = err.message;
  el.classList.remove('hidden');
}

// Builds a form; `onSubmit(values)` may throw to show an error.
function form(fields, { submitLabel = 'Save', onSubmit, extra = [] }) {
  const err = formError();
  const el = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = el.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(el)));
      } catch (error) {
        showFormError(err, error);
      } finally {
        btn.disabled = false;
      }
    },
  }, err, fields, h('div', { class: 'modal-foot' }, extra, h('button', { class: 'btn primary', type: 'submit' }, submitLabel)));
  return el;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));
}

// ---------- routing ----------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'c' || parts[0] === 'd') return { name: 'room', room: `${parts[0]}:${parts[1]}` };
  if (parts[0] === 'projects') return { name: 'projects', id: parts[1] && Number(parts[1]) };
  if (parts[0] === 'calls') return { name: 'calls' };
  if (parts[0] === 'working') return { name: 'working', tab: parts[1] === 'blueprints' ? 'blueprints' : 'cases', id: parts[2] && Number(parts[2]) };
  if (parts[0] === 'suggestions') return { name: 'suggestions', id: parts[1] && Number(parts[1]) };
  if (parts[0] === 'members') return { name: 'members' };
  if (parts[0] === 'vision') return { name: 'vision' };
  if (parts[0] === 'discipling' || parts[0] === 'five') return { name: 'discipling' };
  if (parts[0] === 'real-estate') return { name: 'realestate', id: parts[1] && Number(parts[1]) };
  if (parts[0] === 'offers') return { name: 'offers', tab: ['offers', 'get-leads'].includes(parts[1]) ? parts[1] : 'leads' };
  if (parts[0] === 'pipeline' && parts[1] === 'deals') return { name: 'realestate', id: parts[2] && Number(parts[2]) };
  if (parts[0] === 'pipeline') return { name: 'pipeline' };
  if (parts[0] === 'tour') return { name: 'tour', step: Math.max(0, (Number(parts[1]) || 1) - 1) };
  if (parts[0] === 'chat') return { name: 'chat' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };
const roomHash = (room) => `#/${room.replace(':', '/')}`;

window.addEventListener('hashchange', () => {
  const joinToken = /^#\/join\/([\w-]+)/.exec(location.hash)?.[1];
  if (!state.me && joinToken) return renderJoin(joinToken);
  if (!state.me) return;
  state.route = parseRoute();
  document.querySelector('.shell')?.classList.remove('nav-open');
  renderShell();
});

// ---------- auth screens ----------

const GOOGLE_MARK = '<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

const AUTH_ERRORS = {
  invite: 'That invite link is not valid. It may have expired or already been used. Ask the person who invited you for a new one.',
  'not-member': 'We couldn’t find an ACE account for that Google account. ACE is invite-only, so use the personal invite link you were sent.',
  google: 'Google sign-in did not finish. Please try again.',
};

// "ACE" with what it stands for directly underneath.
function aceMark({ small = false } = {}) {
  return h('div', { class: `ace-mark ${small ? 'small' : ''}` },
    h('div', { class: 'ace-word serif' }, 'ACE'),
    h('div', { class: 'ace-spelled' },
      h('b', {}, 'A'), 'I ', h('b', {}, 'C'), 'hristian ', h('b', {}, 'E'), 'ntrepreneurs'));
}

function googleButton(label, invite = '') {
  return state.config.googleEnabled && h('a', {
    class: 'btn google-btn',
    href: `/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`,
  }, h('span', { class: 'g-mark', 'aria-hidden': 'true', html: GOOGLE_MARK }), label);
}

// mode: 'login', 'join' (personal invite link), 'code' (group invite code), or 'setup' (the first admin).
function renderAuth(mode = 'login', errorMessage = '', invite = null) {
  const [verse, ref] = verseOfDay();
  const app = document.getElementById('app');
  app.innerHTML = '';
  const joining = mode === 'join' || mode === 'setup' || mode === 'code';
  const authError = h('p', { class: `error-text ${errorMessage ? '' : 'hidden'}`, role: 'alert' }, errorMessage);
  // From the shareable join link the code is already known, so the field stays hidden.
  const presetCode = mode === 'code' ? invite?.code : null;
  const codeInput = mode === 'code' && h('input', {
    type: presetCode ? 'hidden' : 'text', id: 'invite-code', name: 'inviteCode', required: !presetCode,
    autocomplete: 'off', autocapitalize: 'none', value: presetCode,
  });
  const fields = joining
    ? [
        field('Full name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name', value: invite?.name })),
        field('Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', value: invite?.email })),
        field('Create a password', h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters'),
      ]
    : [
        field('Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
      ];
  const heading = {
    login: 'Welcome back', join: `You’re invited${invite?.name ? `, ${invite.name.split(' ')[0]}` : ''}`,
    code: presetCode ? 'You’re invited to ACE' : 'Join with your invite code', setup: 'Set up ACE',
  }[mode];
  const intro = {
    login: 'Sign in to continue the conversation.',
    join: 'Someone in ACE invited you personally. Create your account to join.',
    code: presetCode ? 'Create your account to join. It only takes a minute.' : 'Enter the invite code you were given, then create your account.',
    setup: 'You’re the first one here. Create the admin account, then invite members one by one.',
  }[mode];
  const google = codeInput
    ? state.config.googleEnabled && h('button', {
      type: 'button', class: 'btn google-btn',
      onclick: () => {
        if (!codeInput.value.trim()) {
          authError.textContent = 'Enter your invite code first.';
          authError.classList.remove('hidden');
          return codeInput.focus();
        }
        location.href = `/api/auth/google/start?code=${encodeURIComponent(codeInput.value.trim())}`;
      },
    }, h('span', { class: 'g-mark', 'aria-hidden': 'true', html: GOOGLE_MARK }), 'Sign up with Google')
    : googleButton(joining ? 'Sign up with Google' : 'Continue with Google', invite?.token);

  app.append(h('div', { class: 'auth' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'brand-mark' }, '✝'),
      aceMark(),
      h('p', {}, 'A private, invite-only fellowship of Christians using AI to build businesses that give back time, not to hustle or chase wealth, but to have more of our lives for God, family, serving, and making disciples.'),
      h('ul', {},
        h('li', {}, 'Channels for encouragement, prayer, ideas and content'),
        h('li', {}, 'Private messages with any member'),
        h('li', {}, 'Projects, working businesses and blueprints to learn from'),
        h('li', {}, 'Weekly community calls')),
      h('blockquote', {}, `“${verse}” — ${ref}`),
      h('p', { class: 'auth-vision' }, h('strong', {}, 'Our vision: '), VISION.statement, ' ', h('a', { href: '/vision', class: 'auth-vision-link' }, 'Read the full vision →'))),
    h('section', { class: 'auth-panel' },
      h('div', { class: 'auth-card' },
        h('h2', { class: 'serif' }, heading),
        h('p', { class: 'muted' }, intro),
        authError,
        codeInput && (presetCode ? codeInput : field('Invite code', codeInput, 'From the person who invited you')),
        google,
        google && h('div', { class: 'or' }, joining ? 'or sign up with email' : 'or sign in with email'),
        form(fields, {
          submitLabel: joining ? 'Create my account' : 'Sign in',
          onSubmit: async (values) => {
            if (invite?.token) values.inviteToken = invite.token;
            if (codeInput) values.inviteCode = codeInput.value;
            await api(joining ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: values });
            // Keep the page they were headed to, except the one-time invite link.
            if (location.hash.startsWith('#/join/')) history.replaceState(null, '', '/#/home');
            await start();
            if (joining) openProfileEditor(true);
          },
        }),
        mode === 'login' && h('p', { class: 'auth-switch muted small' },
          'ACE is invite-only. If someone invited you, open the personal link they sent you',
          state.config.codeEnabled ? [' or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth('code'); } }, 'join with an invite code'), '.'] : '.'),
        mode === 'code' && h('p', { class: 'auth-switch muted small' },
          'Already a member? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth('login'); } }, 'Sign in'))))));
  ((presetCode ? null : codeInput) || app.querySelector('input:not([type=hidden])'))?.focus();
}

// Opens a personal invite link (#/join/<token>).
async function renderJoin(token) {
  try {
    const { invite } = await api(`/api/invites/${encodeURIComponent(token)}`);
    renderAuth('join', '', { ...invite, token });
  } catch (err) {
    history.replaceState(null, '', '/');
    renderAuth('login', err.status === 404 ? AUTH_ERRORS.invite : err.message);
  }
}

// ---------- shell ----------

function navItem({ href, icon, label, active, unread, extra }) {
  return h('a', { class: `nav-item ${active ? 'active' : ''} ${unread ? 'unread' : ''}`, href },
    icon, h('span', { class: 'label' }, label), unread ? h('span', { class: 'badge' }, unread) : null, extra);
}

function renderSidebar() {
  const r = state.route;
  const isAdmin = state.me.role === 'admin';
  const helpCount = (state.projects || []).filter((p) => p.status === 'looking').length;
  const openSuggestions = (state.suggestions || []).filter((x) => x.status === 'open').length;
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-head' },
      h('div', { class: 'brand-mark' }, '✝'),
      h('div', {}, h('strong', {}, 'ACE'), h('span', {}, 'AI Christian Entrepreneurs'))),
    h('nav', { class: 'sidebar-scroll' },
      navItem({ href: '#/home', icon: h('span', { class: 'icon' }, '⌂'), label: 'Home', active: r.name === 'home' }),
      navItem({ href: '#/tour', icon: h('span', { class: 'icon' }, '➜'), label: 'Start here', active: r.name === 'tour' }),
      navItem({ href: '#/vision', icon: h('span', { class: 'icon' }, '✝'), label: 'Our vision', active: r.name === 'vision' }),
      navItem({ href: '#/discipling', icon: h('span', { class: 'icon' }, '♡'), label: 'Who I’m discipling', active: r.name === 'discipling' }),
      navItem({ href: '#/pipeline', icon: h('span', { class: 'icon' }, '↗'), label: 'Pipeline', active: r.name === 'pipeline' }),
      navItem({ href: '#/offers', icon: h('span', { class: 'icon' }, '◎'), label: 'Offers & leads', active: r.name === 'offers' }),
      navItem({ href: '#/real-estate', icon: h('span', { class: 'icon' }, '⌂'), label: 'Real estate', active: r.name === 'realestate', extra: state.deals?.length ? h('span', { class: 'small', style: 'opacity:.7' }, `${state.deals.length} deal${state.deals.length === 1 ? '' : 's'}`) : null }),
      navItem({ href: '#/projects', icon: h('span', { class: 'icon' }, '◆'), label: 'Projects', active: r.name === 'projects', unread: 0, extra: helpCount ? h('span', { class: 'small', style: 'opacity:.7' }, `${helpCount} need help`) : null }),
      navItem({ href: '#/working', icon: h('span', { class: 'icon' }, '▲'), label: 'What’s working', active: r.name === 'working' }),
      navItem({ href: '#/suggestions', icon: h('span', { class: 'icon' }, '✦'), label: 'Suggestions', active: r.name === 'suggestions', extra: openSuggestions ? h('span', { class: 'small', style: 'opacity:.7' }, `${openSuggestions} open`) : null }),
      navItem({ href: '#/calls', icon: h('span', { class: 'icon' }, '☏'), label: 'Community calls', active: r.name === 'calls' }),
      navItem({ href: '#/members', icon: h('span', { class: 'icon' }, '☺'), label: 'Members', active: r.name === 'members' }),
      isAdmin && h('button', { class: 'nav-item', type: 'button', onclick: openInviteForm },
        h('span', { class: 'icon' }, '＋'), h('span', { class: 'label' }, 'Invite someone')),
      h('button', { class: 'nav-item', type: 'button', onclick: openNotificationSettings },
        h('span', { class: 'icon' }, '🔔'), h('span', { class: 'label' }, 'Notifications'),
        pushState === 'on' ? h('span', { class: 'small', style: 'opacity:.7' }, 'On') : null),
      canInstall() && h('button', { class: 'nav-item', type: 'button', onclick: installApp },
        h('span', { class: 'icon' }, '⤓'), h('span', { class: 'label' }, 'Install the app')),
      h('div', { class: 'nav-section' },
        h('div', { class: 'nav-section-title' }, 'Channels',
          isAdmin && h('button', { title: 'New channel', onclick: openNewChannel }, '+')),
        state.channels.map((c) => navItem({
          href: roomHash(c.room), icon: h('span', { class: 'icon' }, '#'), label: c.name,
          active: r.room === c.room, unread: r.room === c.room ? 0 : c.unread,
        }))),
      h('div', { class: 'nav-section' },
        h('div', { class: 'nav-section-title' }, 'Direct messages',
          h('button', { title: 'New message', onclick: openNewDm }, '+')),
        state.conversations.length === 0 && h('p', { class: 'small', style: 'padding:0 8px;color:var(--sidebar-muted)' }, 'Start a private conversation with any member.'),
        state.conversations.map((c) => navItem({
          href: roomHash(c.room),
          icon: h('span', { class: `dot ${state.online.has(c.otherUserId) ? 'on' : ''}` }),
          label: userName(c.otherUserId), active: r.room === c.room, unread: r.room === c.room ? 0 : c.unread,
        })))),
    h('div', { class: 'sidebar-foot' },
      avatar(state.me.id),
      h('div', { class: 'who', onclick: () => openProfileEditor(), title: 'Edit your profile' },
        h('strong', {}, state.me.name), h('span', {}, isAdmin ? 'Admin · edit profile' : 'Edit profile')),
      h('button', { onclick: logout }, 'Sign out')));
}

function topbar(title, sub, actions = [], { back } = {}) {
  return h('header', { class: 'topbar' },
    back && h('a', { class: 'back-btn', href: back, 'aria-label': 'Back' }, '‹'),
    h('button', { class: 'menu-btn', 'aria-label': 'Open menu', onclick: () => document.querySelector('.shell').classList.toggle('nav-open') }, '☰'),
    h('div', { class: 'grow' }, h('h1', {}, title), sub && h('div', { class: 'sub' }, sub)),
    actions);
}

function renderShell() {
  const app = document.getElementById('app');
  const prevShell = app.querySelector('.shell');
  const navOpen = prevShell?.classList.contains('nav-open');
  const main = renderMain();
  app.innerHTML = '';
  const inRoom = state.route.name === 'room' || state.route.name === 'tour';
  app.append(h('div', { class: `shell ${navOpen ? 'nav-open' : ''} ${inRoom ? 'in-room' : ''}`, onclick: (e) => {
    if (e.target.classList.contains('shell')) e.currentTarget.classList.remove('nav-open');
  } }, renderSidebar(), main, renderTabBar()));
  afterRender();
}

const totalUnread = () => [...state.channels, ...state.conversations].reduce((n, c) => n + (c.unread || 0), 0);

const TAB_ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
  chat: '<path d="M4 5.5h16v10H9l-5 4z"/>',
  build: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  calls: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
// SVG needs its own namespace, so the icon is parsed from markup rather than built with h().
const tabIcon = (name) => h('span', {
  class: 'svg-icon',
  html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[name]}</svg>`,
});

// Bottom navigation shown only on phones (see styles.css).
function renderTabBar() {
  const r = state.route.name;
  const unread = totalUnread();
  const tab = (href, icon, label, active, badge) => h('a', { class: `tabbar-item ${active ? 'on' : ''}`, href, 'aria-current': active ? 'page' : null },
    h('span', { class: 'tabbar-icon', 'aria-hidden': 'true' }, icon, badge ? h('span', { class: 'badge' }, badge > 99 ? '99+' : badge) : null),
    h('span', {}, label));
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    tab('#/home', tabIcon('home'), 'Home', r === 'home'),
    tab('#/chat', tabIcon('chat'), 'Chat', r === 'chat' || r === 'room', unread),
    tab('#/working', tabIcon('build'), 'Build', ['working', 'projects', 'suggestions', 'pipeline', 'realestate', 'offers'].includes(r)),
    tab('#/calls', tabIcon('calls'), 'Calls', r === 'calls'),
    h('button', { class: 'tabbar-item', type: 'button', onclick: () => document.querySelector('.shell').classList.add('nav-open') },
      h('span', { class: 'tabbar-icon', 'aria-hidden': 'true' }, tabIcon('more')), h('span', {}, 'More')));
}

// Phone chat list: every channel and private conversation in one place.
function renderChatList() {
  const row = (c, icon, label, sub) => h('a', { class: `chat-row ${c.unread ? 'unread' : ''}`, href: roomHash(c.room) },
    icon, h('div', { class: 'chat-row-text' }, h('strong', {}, label), sub && h('span', { class: 'muted small' }, sub)),
    c.unread ? h('span', { class: 'badge' }, c.unread) : null);
  return [
    topbar('Chat', 'Channels and private messages', [h('button', { class: 'btn small', onclick: openNewDm }, '+ Message')]),
    h('div', { class: 'page' }, h('div', { class: 'page-inner chat-list' },
      h('h2', { class: 'list-title' }, 'Channels'),
      h('div', { class: 'card list-card' }, state.channels.map((c) => row(c, h('span', { class: 'chat-icon' }, '#'), c.name, c.description))),
      h('h2', { class: 'list-title' }, 'Private messages'),
      state.conversations.length
        ? h('div', { class: 'card list-card' }, state.conversations.map((c) => row(c, avatar(c.otherUserId),
          userName(c.otherUserId), state.online.has(c.otherUserId) ? 'Online' : '')))
        : h('div', { class: 'card empty' }, 'No private messages yet. Tap “+ Message” to start one.'))),
  ];
}

function refreshTabBar() {
  const old = document.querySelector('.tabbar');
  if (old) old.replaceWith(renderTabBar());
  updateAppBadge();
}

// ---------- installable app (PWA) ----------

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canInstall = () => !isStandalone();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (state.me) renderShell();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (state.me) renderShell();
  toast('App installed');
});

const ICON_SHARE = '<svg class="inline-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>';
const ICON_PLUS = '<svg class="inline-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Add"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>';
const ICON_DOTS = '<b class="kbd" aria-label="menu">⋮</b>';

// Step-by-step install instructions for each device and browser.
const INSTALL_GUIDES = {
  'ios-safari': {
    label: 'iPhone · Safari',
    steps: [
      `Tap the <strong>Share</strong> button ${ICON_SHARE} at the bottom of the screen (at the top on iPad). On newer iPhones, tap <strong>•••</strong> first, then <strong>Share</strong>.`,
      `Scroll down and tap <strong>Add to Home Screen</strong> ${ICON_PLUS}.`,
      'Tap <strong>Add</strong> in the top-right corner.',
      'Open <strong>ACE</strong> from your Home Screen. It opens full-screen like an app.',
    ],
  },
  'ios-chrome': {
    label: 'iPhone · Chrome',
    steps: [
      `Tap the <strong>Share</strong> button ${ICON_SHARE} at the right end of the address bar.`,
      `Tap <strong>Add to Home Screen</strong> ${ICON_PLUS}. (If you don’t see it, open this page in Safari instead.)`,
      'Tap <strong>Add</strong>.',
      'Open <strong>ACE</strong> from your Home Screen.',
    ],
  },
  'ios-inapp': {
    label: 'Opened from another app',
    steps: [
      `You opened this inside another app (like Facebook, Instagram, or Messages). Tap <strong>•••</strong> or ${ICON_SHARE} and choose <strong>Open in Safari</strong> (or <strong>Open in browser</strong>).`,
      `In Safari, tap <strong>Share</strong> ${ICON_SHARE}, then <strong>Add to Home Screen</strong>.`,
      'Tap <strong>Add</strong>.',
    ],
  },
  'android-chrome': {
    label: 'Android · Chrome',
    steps: [
      `Tap the menu ${ICON_DOTS} in the top-right corner.`,
      'Tap <strong>Install app</strong> (on some phones it says <strong>Add to Home screen</strong>).',
      'Tap <strong>Install</strong> to confirm.',
      'Open <strong>ACE</strong> from your home screen or app drawer.',
    ],
  },
  'android-samsung': {
    label: 'Android · Samsung Internet',
    steps: [
      'Tap the menu <b class="kbd">≡</b> at the bottom right.',
      'Tap <strong>Add page to</strong>, then <strong>Home screen</strong>.',
      'Tap <strong>Add</strong>.',
    ],
  },
  'android-firefox': {
    label: 'Android · Firefox',
    steps: [
      `Tap the menu ${ICON_DOTS}.`,
      'Tap <strong>Install</strong> (or <strong>Add to Home screen</strong>).',
      'Tap <strong>Add</strong> to confirm.',
    ],
  },
  'desktop-chrome': {
    label: 'Computer · Chrome or Edge',
    steps: [
      'Look for the <strong>install icon</strong> (a small screen with a down arrow) at the right end of the address bar, and click it.',
      `No icon? Open the menu ${ICON_DOTS} and choose <strong>Cast, save, and share → Install page as app</strong> (Chrome) or <strong>Apps → Install this site as an app</strong> (Edge).`,
      'Click <strong>Install</strong>. The network opens in its own window and appears with your other apps.',
    ],
  },
  'mac-safari': {
    label: 'Mac · Safari',
    steps: [
      'In the menu bar, click <strong>File → Add to Dock</strong>.',
      'Click <strong>Add</strong>. The network appears in your Dock like an app.',
    ],
  },
  'desktop-firefox': {
    label: 'Computer · Firefox',
    steps: [
      'Firefox on a computer can’t install web apps.',
      'Open this page in <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Safari</strong> and follow the steps for that browser.',
      'Or bookmark this page so it’s one click away.',
    ],
  },
};
const GUIDE_TABS = [['ios-safari', 'iPhone'], ['android-chrome', 'Android'], ['desktop-chrome', 'Computer']];

function detectInstallGuide() {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    if (/FBAN|FBAV|Instagram|Line\/|Twitter|LinkedInApp|GSA\//.test(ua)) return 'ios-inapp';
    if (/CriOS|EdgiOS/.test(ua)) return 'ios-chrome';
    return 'ios-safari';
  }
  if (/android/i.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return 'android-samsung';
    if (/Firefox/.test(ua)) return 'android-firefox';
    return 'android-chrome';
  }
  if (/Firefox/.test(ua)) return 'desktop-firefox';
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'mac-safari';
  return 'desktop-chrome';
}

const GUIDE_SNOOZE_DAYS = 14;
let guideOpen = false;
let guideChoice = null;
let guideSnoozedUntil = 0;
try { guideSnoozedUntil = Number(localStorage.getItem('install-guide-snoozed-until')) || 0; } catch { /* storage blocked */ }

// Opens the install guide from the menu, even if it was dismissed.
function installApp() {
  guideOpen = true;
  guideSnoozedUntil = 0;
  document.querySelector('.shell')?.classList.remove('nav-open');
  if (state.route.name === 'room') go('#/home'); else renderShell();
  requestAnimationFrame(() => document.querySelector('.install-guide')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  renderShell();
}

// A collapsible "Get the app" dropdown shown to members who haven't installed the app.
function installGuide() {
  if (!canInstall() || Date.now() < guideSnoozedUntil) return null;
  const detected = detectInstallGuide();
  const key = guideChoice ?? detected;
  const guide = INSTALL_GUIDES[key];
  const rerender = () => document.querySelector('.install-guide')?.replaceWith(installGuide() ?? '');
  const tabKey = (k) => (k.startsWith('ios') ? 'ios-safari' : k.startsWith('android') ? 'android-chrome' : 'desktop-chrome');
  const variants = Object.keys(INSTALL_GUIDES).filter((k) => tabKey(k) === tabKey(key) && k !== key && k !== 'ios-inapp');

  return h('section', { class: `install-guide ${guideOpen ? 'open' : ''}` },
    h('div', { class: 'install-guide-bar' },
      h('button', {
        class: 'install-guide-toggle', type: 'button', 'aria-expanded': String(guideOpen), 'aria-controls': 'install-guide-body',
        onclick: () => { guideOpen = !guideOpen; rerender(); },
      },
        h('img', { src: '/icons/icon-192.png', alt: '', width: 28, height: 28 }),
        h('span', { class: 'grow' }, h('strong', {}, 'Get the app'), h('span', { class: 'muted' }, guideOpen ? ' · how to install' : ' · tap to see how')),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '▾')),
      h('button', {
        class: 'install-guide-close', type: 'button', 'aria-label': `Hide for ${GUIDE_SNOOZE_DAYS} days`, title: `Hide for ${GUIDE_SNOOZE_DAYS} days`,
        onclick: () => {
          guideOpen = false;
          guideSnoozedUntil = Date.now() + GUIDE_SNOOZE_DAYS * 86_400_000;
          try { localStorage.setItem('install-guide-snoozed-until', String(guideSnoozedUntil)); } catch { /* storage blocked */ }
          rerender();
          toast('Hidden for two weeks. You can install anytime from the menu.');
        },
      }, '×')),
    guideOpen && h('div', { class: 'install-guide-body', id: 'install-guide-body' },
      h('p', { class: 'small muted', style: 'margin:0' }, 'Installing puts the network on your home screen with its own icon. It opens full-screen, like any other app.'),
      installPrompt && h('button', { class: 'btn primary install-now', type: 'button', onclick: promptInstall }, 'Install now (one tap)'),
      h('div', { class: 'tags', role: 'tablist', 'aria-label': 'Choose your device' }, GUIDE_TABS.map(([k, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(tabKey(key) === k),
        class: `btn small ${tabKey(key) === k ? 'on' : ''}`,
        onclick: () => { guideChoice = k === tabKey(detected) ? detected : k; rerender(); },
      }, label))),
      h('div', { class: 'guide-label small' }, guide.label, key === detected && h('span', { class: 'muted' }, ' · detected')),
      h('ol', { class: 'guide-steps' }, guide.steps.map((step) => h('li', { html: step }))),
      variants.length > 0 && h('div', { class: 'small muted' }, 'Using a different browser? ',
        variants.map((k, i) => [i ? ' · ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); guideChoice = k; rerender(); } }, INSTALL_GUIDES[k].label.split(' · ')[1])]))));
}

// Shows the unread count on the installed app's icon where supported.
function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = state.me ? totalUnread() : 0;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------- push notifications ----------

// 'on' | 'off' | 'denied' | 'needs-install' (iPhone in Safari) | 'unsupported'
let pushState = 'off';
const isIosDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function computePushState(subscription) {
  if (isIosDevice() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

const urlB64ToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
};

// Re-registers this device after sign-in so the server knows who it belongs to.
async function syncPushSubscription() {
  try {
    const sub = await currentSubscription();
    pushState = computePushState(sub);
    if (pushState === 'on') await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  } catch {
    pushState = computePushState(null);
  }
  refreshSidebar();
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    pushState = computePushState(null);
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for this site. Turn them on in your browser or phone settings, then try again.'
      : 'Notifications were not turned on.');
  }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  pushState = 'on';
}

async function disablePush({ quiet = false } = {}) {
  const sub = await currentSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  pushState = computePushState(null);
  if (!quiet) toast('Notifications turned off on this device');
}

function openNotificationSettings() {
  document.querySelector('.shell')?.classList.remove('nav-open');
  const what = h('ul', { class: 'notify-list' },
    h('li', {}, 'Private messages sent to you'),
    h('li', {}, 'When someone @mentions you in a channel'),
    h('li', {}, 'A reminder 15 minutes before each community call'));
  const body = () => {
    if (pushState === 'needs-install') {
      return [
        h('p', {}, 'On iPhone and iPad, notifications only work once ACE is on your Home Screen. That is an Apple rule.'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Add ACE to your Home Screen (the “Get the app” steps).'),
          h('li', {}, 'Open ACE from the Home Screen icon.'),
          h('li', {}, 'Come back here and tap ', h('strong', {}, 'Turn on notifications'), '.')),
        h('button', { class: 'btn primary', onclick: () => { closeModal(); installApp(); } }, 'Show me how to install'),
      ];
    }
    if (pushState === 'unsupported') return [h('p', {}, 'This browser can’t show notifications. Try Chrome, Edge, Firefox, or Safari, or install ACE on your phone.')];
    if (pushState === 'denied') {
      return [h('p', {}, 'Notifications are blocked for ACE on this device. To allow them, open your browser or phone ',
        h('strong', {}, 'Settings → Notifications'), ', find ACE (or this website), and turn them on. Then come back here.')];
    }
    return [
      h('p', { style: 'margin-top:0' }, pushState === 'on' ? 'Notifications are on for this device. You’ll get:' : 'Get a notification on this device, even when ACE is closed, for:'),
      what,
      pushState === 'on'
        ? h('button', { class: 'btn', onclick: async () => { await disablePush(); closeModal(); refreshSidebar(); } }, 'Turn off on this device')
        : h('button', { class: 'btn primary', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await enablePush();
            closeModal();
            refreshSidebar();
            renderShell();
            toast('Notifications are on');
          } catch (err) {
            toast(err.message, 'error');
            e.currentTarget.disabled = false;
          }
        } }, 'Turn on notifications'),
      h('p', { class: 'muted small' }, 'You won’t get notifications while you have ACE open on screen. Turn them on separately on each phone or computer you use.'),
    ];
  };
  openModal('Notifications', h('div', { class: 'notify-settings' }, ...body()));
}

// A small prompt on the home page until notifications are on (or dismissed).
let notifyCardDismissed = false;
try { notifyCardDismissed = localStorage.getItem('notify-card-dismissed') === '1'; } catch { /* storage blocked */ }

function notifyCard() {
  if (notifyCardDismissed || !['off', 'needs-install'].includes(pushState)) return null;
  const card = h('div', { class: 'card notify-card' },
    h('span', { class: 'notify-bell', 'aria-hidden': 'true' }, '🔔'),
    h('div', { class: 'grow' }, h('strong', {}, 'Don’t miss a message'),
      h('div', { class: 'muted small' }, pushState === 'needs-install'
        ? 'Install ACE on your Home Screen to get notifications for messages and call reminders.'
        : 'Get notified about private messages, @mentions, and call reminders.')),
    h('button', { class: 'btn primary small', onclick: openNotificationSettings }, pushState === 'needs-install' ? 'How' : 'Turn on'),
    h('button', { class: 'modal-close', 'aria-label': 'Dismiss', onclick: () => {
      notifyCardDismissed = true;
      try { localStorage.setItem('notify-card-dismissed', '1'); } catch { /* storage blocked */ }
      card.remove();
    } }, '×'));
  return card;
}

function refreshSidebar() {
  const old = document.querySelector('.sidebar');
  if (old) old.replaceWith(renderSidebar());
  refreshTabBar();
  if (state.route.name === 'chat' && !document.querySelector('.modal-backdrop')) {
    document.querySelector('.main')?.replaceWith(renderMain());
  }
}

function renderMain() {
  const r = state.route;
  const main = h('main', { class: 'main' });
  if (r.name === 'room') main.append(...renderRoom(r.room));
  else if (r.name === 'projects') main.append(...renderProjects());
  else if (r.name === 'calls') main.append(...renderCalls());
  else if (r.name === 'suggestions') main.append(...renderSuggestions());
  else if (r.name === 'working') main.append(...renderWorking());
  else if (r.name === 'chat') main.append(...renderChatList());
  else if (r.name === 'members') main.append(...renderMembers());
  else if (r.name === 'vision') main.append(...renderVision());
  else if (r.name === 'discipling') main.append(...renderDiscipling());
  else if (r.name === 'pipeline') main.append(...renderPipeline());
  else if (r.name === 'realestate') main.append(...renderRealEstate());
  else if (r.name === 'offers') main.append(...renderOffers());
  else if (r.name === 'tour') main.append(...renderTour(r.step));
  else main.append(...renderHome());
  // The install dropdown sits under the page title everywhere except inside a conversation.
  const guide = r.name !== 'room' && r.name !== 'tour' && installGuide();
  if (guide) main.children[0].after(guide);
  return main;
}

let afterRenderHooks = [];
function afterRender() {
  const hooks = afterRenderHooks;
  afterRenderHooks = [];
  hooks.forEach((fn) => fn());
}

// ---------- home ----------

function renderHome() {
  const [verse, ref] = verseOfDay();
  const nextCall = (state.calls || []).flatMap((c) => c.occurrences.slice(0, 1).map((o) => ({ call: c, o })))
    .sort((a, b) => a.o.startsAt.localeCompare(b.o.startsAt))[0];
  const needHelp = (state.projects || []).filter((p) => p.status === 'looking').slice(0, 3);
  const firstName = state.me.name.split(' ')[0];

  return [
    topbar('Home', 'Build with excellence. Free up time. Make disciples.'),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('section', { class: 'hero-card' },
        h('h1', { class: 'serif' }, `Welcome, ${firstName}.`),
        h('p', {}, 'We are Christians using AI to build businesses that give us back our time, not to hustle harder or chase wealth, but to have more of our lives for loving God, our families, serving others, and making disciples. Encourage someone today, share what you are learning, and ask for help where you need it.'),
        h('div', { class: 'verse' }, `“${verse}” — ${ref}`),
        h('div', { class: 'hero-links' },
          h('a', { class: 'hero-link', href: '#/tour' }, 'Take the walkthrough →'),
          h('a', { class: 'hero-link', href: '#/vision' }, 'Read our vision →'))),

      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, state.users.size), h('span', {}, 'members')),
        h('div', { class: 'stat' }, h('b', {}, state.online.size), h('span', {}, 'online now')),
        h('div', { class: 'stat' }, h('b', {}, (state.projects || []).length), h('span', {}, 'projects shared')),
        h('div', { class: 'stat' }, h('b', {}, (state.projects || []).filter((p) => p.status === 'launched').length), h('span', {}, 'launched'))),

      state.me.stage === 'guest' && guestCard(),
      notifyCard(),
      disciplingSummary(),
      h('div', { class: 'section-head' }, h('h2', {}, 'Next community call'), h('a', { href: '#/calls', class: 'small' }, 'All calls →')),
      nextCall ? callCard(nextCall.call, { limit: 1 })
        : h('div', { class: 'card empty' }, state.me.role === 'admin'
          ? h('div', {}, 'No calls scheduled yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openCallEditor(); } }, 'Schedule the weekly call'))
          : 'No calls scheduled yet — check back soon.'),

      h('div', { class: 'section-head' }, h('h2', {}, 'Real estate we’re looking at'),
        h('a', { href: '#/real-estate', class: 'small' }, 'All deals →')),
      (state.deals || []).filter((d) => d.status !== 'passed').length
        ? h('div', { class: 'grid deal-grid' }, state.deals.filter((d) => d.status !== 'passed').slice(0, 3).map(dealCard))
        : h('div', { class: 'card empty' }, 'No deals yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDealEditor(); } }, 'Add a property worth a look'), ' and run the numbers together.'),

      h('div', { class: 'section-head' }, h('h2', {}, 'Projects looking for help'),
        h('button', { class: 'btn small', onclick: () => openProjectEditor() }, '+ Share a project')),
      needHelp.length ? h('div', { class: 'grid' }, needHelp.map(projectCard))
        : h('div', { class: 'card empty' }, 'No open requests right now. Working on something? Share it and invite collaborators.'),

      h('div', { class: 'section-head home-channels' }, h('h2', {}, 'Jump into a channel')),
      h('div', { class: 'grid home-channels' }, state.channels.map((c) => h('a', { class: 'card', href: roomHash(c.room), style: 'text-decoration:none;color:inherit' },
        h('h3', { style: 'font-size:15px' }, `# ${c.name}`, c.unread ? h('span', { class: 'badge', style: 'margin-left:8px' }, c.unread) : null),
        h('p', { class: 'muted small', style: 'margin:4px 0 0' }, c.description))))))
  ];
}

// Shown to someone still experiencing the group, before committing for a year.
function guestCard() {
  return h('section', { class: 'card guest-card' },
    h('h2', { class: 'serif' }, 'You’re experiencing the group'),
    h('p', { class: 'muted' }, 'Come to three calls over the next six weeks and get to know the men here. If the group is a fit, talk with an admin about committing for a year.'),
    planPath(1),
    h('p', { class: 'small muted', style: 'margin:0' }, PLAN.commitment));
}

// ---------- who I'm discipling: people each member prays for and pursues ----------

const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
const todayLocal = () => new Date().toLocaleDateString('en-CA');

function disciplingStats() {
  const people = state.five?.people ?? [];
  const meetings = people.flatMap((p) => p.meetings);
  const year = String(new Date().getFullYear());
  return {
    people: people.length,
    month: meetings.filter((m) => m.metOn.startsWith(thisMonth())).length,
    steps: meetings.filter((m) => m.nextStep && m.metOn.startsWith(year)).length,
  };
}

function disciplingStatsRow() {
  const st = disciplingStats();
  const stat = (n, label) => h('div', { class: 'five-stat' }, h('b', {}, `${n}`), h('span', {}, label));
  return h('div', { class: 'five-meter' },
    stat(st.people, st.people === 1 ? 'person' : 'people'),
    stat(st.month, 'times together this month'),
    stat(st.steps, 'next steps this year'));
}

function disciplingSummary() {
  const st = disciplingStats();
  return h('section', { class: 'card five-summary' },
    h('div', { class: 'section-head', style: 'margin:0 0 10px' },
      h('h2', {}, 'Who am I discipling?'), h('a', { href: '#/discipling', class: 'small' }, st.people ? 'Open →' : 'Start your list →')),
    st.people ? disciplingStatsRow()
      : h('p', { class: 'muted', style: 'margin:0' }, PLAN.discipling));
}

async function fiveRequest(path, method, body) {
  try {
    state.five = await api(path, { method, body });
    renderShell();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function renderDiscipling() {
  const people = state.five?.people ?? [];
  return [
    topbar('Who am I discipling?', 'People I’m praying for and pursuing',
      [h('button', { class: 'btn primary', onclick: () => openPersonEditor() }, '+ Add someone')]),
    h('div', { class: 'page' }, h('div', { class: 'page-inner five-page' },
      h('section', { class: 'card five-intro' },
        h('p', { style: 'margin:0' }, PLAN.discipling),
        people.length > 0 && disciplingStatsRow(),
        h('p', { class: 'small muted', style: 'margin:0' }, '🔒 Only you can see this list. When someone takes a next step toward God, you can choose to tell the story in #next-steps.')),
      h('div', { class: 'five-grid' },
        people.map(personCard),
        h('button', { class: 'card five-empty', onclick: () => openPersonEditor() },
          h('span', { class: 'five-slot' }, '+'), people.length ? 'Add someone else' : 'Add someone you’re praying for and pursuing')),
      h('section', { class: 'card five-measure' },
        h('h3', { class: 'serif' }, PLAN.measure.question),
        h('p', { class: 'muted' }, PLAN.measure.text),
        h('a', { class: 'btn small', href: nextStepsHash() }, 'Read the stories in #next-steps')))),
  ];
}

function personCard(p) {
  const last = p.meetings[0];
  const steps = p.meetings.filter((m) => m.nextStep).length;
  return h('article', { class: 'card person-card' },
    h('div', { class: 'person-head' },
      h('div', { class: 'person-initial', 'aria-hidden': 'true' }, p.name.trim()[0]?.toUpperCase() ?? '?'),
      h('div', { class: 'grow' },
        h('h3', {}, p.name),
        p.context && h('div', { class: 'small muted' }, p.context)),
      h('button', { class: 'btn small ghost', onclick: () => openPersonEditor(p) }, 'Edit')),
    p.notes && h('p', { class: 'person-notes' }, p.notes),
    h('div', { class: 'small muted' },
      last ? `Last met ${shortDate(last.metOn + 'T12:00:00')}` : 'Not met yet',
      steps ? ` · ${steps} next step${steps > 1 ? 's' : ''} 🙌` : ''),
    p.meetings.length > 0 && h('ul', { class: 'meet-list' }, p.meetings.slice(0, 3).map((m) => h('li', {},
      h('span', { class: 'meet-date' }, shortDate(m.metOn + 'T12:00:00')),
      h('span', { class: 'grow' }, m.nextStep && h('span', { class: 'chip launched' }, 'Next step'), ' ', m.note || h('span', { class: 'muted' }, 'Met')),
      h('button', { class: 'meet-del', title: 'Delete', 'aria-label': 'Delete this entry', onclick: () => {
        if (confirm('Delete this entry?')) fiveRequest(`/api/five/meetings/${m.id}`, 'DELETE');
      } }, '×')))),
    h('div', { class: 'person-actions' },
      h('button', { class: 'btn small primary', onclick: () => openMeetingForm(p) }, 'Log time together')));
}

function openPersonEditor(p) {
  const close = openModal(p ? `Edit ${p.name}` : 'Add someone', form([
    field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 80, value: p?.name, placeholder: 'First name is fine' })),
    field('How you know them', h('input', { type: 'text', name: 'context', maxlength: 200, value: p?.context, placeholder: 'e.g. client, neighbor, BNI group, gym' })),
    field('How to pray for them', h('textarea', { name: 'notes', rows: 3, maxlength: 2000, value: p?.notes, placeholder: 'What’s going on in their life, questions they’re asking, where they are with God…' })),
  ], {
    submitLabel: p ? 'Save' : 'Add',
    onSubmit: async (data) => {
      if (await fiveRequest(p ? `/api/five/${p.id}` : '/api/five', p ? 'PATCH' : 'POST', data)) close();
    },
    extra: p ? [h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
      if (!confirm(`Remove ${p.name} from your list? Your notes about them will be deleted.`)) return;
      if (await fiveRequest(`/api/five/${p.id}`, 'DELETE')) close();
    } }, 'Remove')] : [],
  }));
}

function openMeetingForm(p) {
  const share = h('input', { type: 'checkbox', name: 'share', checked: true });
  const shareRow = h('label', { class: 'check-row hidden' }, share,
    h('span', {}, 'Share this story in #next-steps', h('span', { class: 'small muted', style: 'display:block' }, 'Leave out last names or anything private.')));
  const stepBox = h('input', { type: 'checkbox', name: 'nextStep', onchange: () => shareRow.classList.toggle('hidden', !stepBox.checked) });
  const close = openModal(`Time with ${p.name}`, form([
    field('When', h('input', { type: 'date', name: 'metOn', required: true, value: todayLocal(), max: todayLocal() })),
    field('What happened?', h('textarea', { name: 'note', rows: 4, maxlength: 2000, placeholder: 'Where you met, what you talked about, what to follow up on…' })),
    h('label', { class: 'check-row' }, stepBox, h('span', {}, 'They took a next step toward God')),
    shareRow,
  ], {
    submitLabel: 'Save',
    onSubmit: async (data) => {
      const nextStep = stepBox.checked;
      if (!(await fiveRequest(`/api/five/${p.id}/meetings`, 'POST', { metOn: data.metOn, note: data.note, nextStep }))) return;
      close();
      const channel = nextStepsChannel();
      if (nextStep && share.checked && channel) {
        const story = data.note?.trim() || 'Someone I’ve been praying for took a next step toward God.';
        try {
          await api(`/api/rooms/${channel.room}/messages`, { method: 'POST', body: { body: `🙌 A next step toward God: ${story}` } });
          toast('Saved, and shared in #next-steps');
        } catch (err) { toast(err.message, 'error'); }
      } else toast('Saved');
    },
  }));
}

// ---------- vision ----------

const VISION = {
  statement: 'Use AI to build businesses that give us back our time, for loving God, our families, and making disciples.',
  why: 'Many of us feel called to ministry but spend most of our hours earning a living. AI has changed what one person can build. We believe God can use these tools to help us create ventures that run with less of our time, so we have more of it for worship, our families, serving our churches and neighbors, and the Great Commission, including full-time ministry for some.',
  notThis: [
    ['Not hustle culture', 'We are not here to work more hours, grind harder, or build an identity around business. The goal is fewer hours, not more.'],
    ['Not getting rich for its own sake', 'Income is a tool, not the prize. We measure success by the time and freedom given back to God, family, and serving others.'],
    ['Not at the cost of what matters most', 'No venture is worth losing time with the Lord, your spouse, or your children. Sabbath rest is part of the plan, not an obstacle to it.'],
  ],
  pillars: [
    ['Encourage', 'Build one another up. Share wins, scripture, and what God is doing. Pray for each other by name in #prayer-requests.'],
    ['Share', 'Pass on the tools, prompts, tutorials, and lessons that are working for you, so no one has to learn everything alone.'],
    ['Collaborate', 'Post the project you are building and the help you need. Offer your skills to someone else’s venture.'],
    ['Gather', 'Meet on Zoom every other week and at quarterly gatherings to pray, workshop business problems, celebrate progress, and follow up on what happened since the last call.'],
    ['Provide', 'Follow the pipeline: build with AI, grow steady income, set aside, and invest in income-producing real estate, so our families are provided for with as little of our time as possible.'],
    ['Disciple', 'Pray for and pursue the people God has put in your life. Keep track of who you’re discipling, and tell the story in #next-steps when someone takes a step toward God.'],
  ],
  values: [
    ['Kingdom first', 'The business serves the mission, not the other way around. “Seek first the kingdom of God.” (Matthew 6:33)'],
    ['Family and rest', 'Protect time with your family and keep a rhythm of Sabbath. Freed time is meant for people, not for the next project.'],
    ['Excellence', '“Whatever you do, work heartily, as for the Lord and not for men.” (Colossians 3:23)'],
    ['Generosity', 'Give help freely, share credit gladly, and assume the best of each other.'],
    ['Integrity', 'Build honest products, make honest claims, and treat customers the way Christ would.'],
    ['Iron sharpens iron', 'Speak truth in love. Ask hard questions and receive them well. (Proverbs 27:17)'],
  ],
};

// How the community works: the plan every member signs up for.
const PLAN = {
  title: 'One integrated life.',
  sub: 'A covocational community of business leaders',
  intro: 'We are forming a community of men who help one another build sustainable businesses and invest deeply in people. Our work gives us a genuine place among business leaders, where trusted relationships can open honest conversations about God and life. We listen, ask questions, and walk with people toward a next step with God, without pressure or manipulation.',
  facts: ['10–12 men', 'One year', 'No financial commitment'],
  parts: [
    {
      n: '01', title: 'The people',
      text: [
        'Entrepreneurs, business owners, and executives with meaningful control over their schedules. Men willing to create margin, put people ahead of additional financial gain, and make sacrifices for Jesus.',
        'Different life stages mean different capacities.',
      ],
      here: ['Get to know the members', '#/members'],
    },
    {
      n: '02', title: 'The work',
      text: [
        'We help one another find the right customers and problems to solve, choose opportunities wisely, and build repeatable businesses that use time well. We learn each other’s work so we can refer opportunities and collaborate.',
        'Through business networks, shared interests, and one-on-one time, we pursue relationships beyond the need for another client.',
      ],
      here: ['Share a project or see what’s working', '#/projects'],
    },
    {
      n: '03', title: 'The rhythm',
      text: [
        'Zoom calls every other week and quarterly gatherings. We explore big questions about God and life, workshop business problems and real conversations, pray, and encourage our own growth in Christ.',
        'Between calls, the channels here are our thread for anyone to contribute. At the next call, we follow up on what happened.',
      ],
      here: ['See the next call', '#/calls'],
    },
  ],
  priorities: ['Time with God and His calling', 'Family and personal life', 'Business'],
  discipling: 'Each of us prays for and pursues people God has put in our lives (clients, neighbors, friends), spending time with them and walking with them toward a next step with God.',
  measure: {
    question: 'Did anyone take a next step toward God?',
    text: 'If so, how? Tell the story. We reflect and celebrate what God is doing, so we notice what is happening now rather than focusing only on future plans.',
  },
  realEstate: 'Real estate is where the pipeline leads. Income from our AI work is set aside and put into property that provides for our families with little of our time, often bought together with other members. We look at deals as a group, run the numbers honestly, and never let a deal cost us our first priorities.',
  // What we're learning as we go.
  learnings: [
    ['Be the one who introduces people to AI',
      'Most business owners know they should be using AI but don’t know where to start. When we’re the ones who walk them through it, we become their trusted AI expert, and that gives us a genuine place in their lives.'],
    ['Relationships are key',
      'The business, the referrals, and the conversations about God all grow out of trusted relationships. We invest in people first, not just in the next client.'],
  ],
  path: [
    ['Meet one-on-one', 'Talk with a current member.'],
    ['Experience the group', 'Three calls over six weeks.'],
    ['Commit for a year', 'Join if the group is a fit.'],
  ],
  commitment: 'Attend all quarterly gatherings and at least 80% of calls. No financial commitment.',
};

const VISION_URL = () => `${location.origin}/vision`;

async function shareVision() {
  const url = VISION_URL();
  const text = 'ACE (AI Christian Entrepreneurs): using AI to build businesses that give back our time for loving God, our families, and making disciples.';
  // Phones open their share sheet; computers copy the link.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'The ACE vision', text, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  copyText(url);
}

function renderVision() {
  return [
    topbar('Our vision', 'Why this network exists and how we build together',
      [h('button', { class: 'btn small', onclick: shareVision }, 'Share vision')]),
    h('div', { class: 'page' }, visionContent()),
  ];
}

// Public page at /vision that anyone can open, no account needed.
function renderPublicVision() {
  document.title = 'The ACE vision · AI Christian Entrepreneurs';
  const signedIn = Boolean(state.me);
  document.getElementById('app').replaceChildren(h('div', { class: 'public-vision' },
    h('header', { class: 'public-bar' },
      h('a', { class: 'public-brand', href: '/' }, h('span', { class: 'brand-mark' }, '✝'),
        h('span', {}, h('strong', {}, 'ACE'), h('small', {}, 'AI Christian Entrepreneurs'))),
      h('div', { class: 'public-actions' },
        h('button', { class: 'btn small', onclick: shareVision }, 'Share'),
        h('a', { class: 'btn small primary', href: '/' }, signedIn ? 'Open ACE' : 'Sign in'))),
    h('main', { class: 'public-main' },
      visionContent({ isPublic: true }),
      !signedIn && h('section', { class: 'card public-join' },
        h('h2', { class: 'serif' }, 'Want to be part of ACE?'),
        h('p', { class: 'muted' }, 'It begins with a conversation. Reach out to the person who shared this page with you to meet one-on-one. If you’ve been given an invite link or code, you can use it to join and experience the group.'),
        h('div', { class: 'public-join-actions' },
          state.config?.codeEnabled && h('a', { class: 'btn primary', href: '/#/join-code' }, 'Join with an invite code'),
          h('a', { class: 'btn', href: '/' }, 'I’m already a member'))))));
  window.scrollTo(0, 0);
}

// "Here on ACE" links only make sense to members, so the public page leaves them out.
function planHere(here, isPublic) {
  return !isPublic && here && h('a', { class: 'plan-here', href: here[1] }, `${here[0]} →`);
}

function visionContent({ isPublic = false } = {}) {
  return h('div', { class: 'page-inner vision' },
      h('section', { class: 'hero-card' },
        h('div', { class: 'eyebrow' }, 'The vision'),
        h('h1', { class: 'serif' }, PLAN.title),
        h('p', { class: 'plan-sub' }, `${PLAN.sub}, using AI to build businesses that give us back our time for loving God, our families, and making disciples.`),
        h('ul', { class: 'plan-facts' }, PLAN.facts.map((f) => h('li', {}, f))),
        h('div', { class: 'verse' }, '“Go therefore and make disciples of all nations…” — Matthew 28:19')),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'Who we are'),
        h('p', {}, PLAN.intro)),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'How the community works'),
        h('div', { class: 'plan-grid' },
          PLAN.parts.map((part) => h('article', { class: 'card plan-part' },
            h('div', { class: 'plan-num' }, part.n),
            h('h3', {}, part.title),
            part.text.map((t) => h('p', {}, t)),
            planHere(part.here, isPublic)))),
        h('div', { class: 'plan-pair' },
          h('article', { class: 'card plan-part plan-five' },
            h('div', { class: 'plan-big' }, '♡'),
            h('h3', {}, 'Who am I discipling?'),
            h('p', {}, PLAN.discipling),
            planHere(['Open your list', '#/discipling'], isPublic)),
          h('article', { class: 'card plan-part plan-measure' },
            h('div', { class: 'plan-num' }, '04'),
            h('h3', {}, 'The measure'),
            h('p', { class: 'plan-question serif' }, PLAN.measure.question),
            h('p', {}, PLAN.measure.text),
            planHere(['Tell a story in #next-steps', nextStepsHash()], isPublic)))),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'Real estate'),
        h('p', {}, PLAN.realEstate),
        planHere(['Look at the deals', '#/real-estate'], isPublic)),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'What we’re learning'),
        h('div', { class: 'plan-pair learnings' }, PLAN.learnings.map(([title, text], i) => h('article', { class: 'card plan-part' },
          h('div', { class: 'plan-num' }, `Lesson ${i + 1}`),
          h('h3', {}, title),
          h('p', {}, text))))),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'First things first'),
        h('p', {}, 'We calendar time in this order:'),
        h('ol', { class: 'plan-priorities' }, PLAN.priorities.map((p) => h('li', {}, p)))),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'Why we exist'),
        h('p', {}, VISION.why)),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'What this is not'),
        h('div', { class: 'pillars not-this' }, VISION.notThis.map(([title, text]) =>
          h('div', { class: 'card' }, h('h3', {}, title), h('p', { class: 'muted' }, text)))),
        h('p', { class: 'vision-quote' }, '“For what does it profit a man to gain the whole world and forfeit his soul?” — Mark 8:36')),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'What we do here'),
        h('div', { class: 'pillars' }, VISION.pillars.map(([title, text]) =>
          h('div', { class: 'card' }, h('h3', {}, title), h('p', { class: 'muted' }, text))))),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'How we treat one another'),
        h('dl', { class: 'values' }, VISION.values.map(([title, text]) => [h('dt', {}, title), h('dd', {}, text)]))),
      h('section', { class: 'card vision-win' },
        h('h3', {}, 'The win'),
        h('p', {}, 'The win is not a bigger number. It is an evening home with your kids, a morning in the Word, a week spent serving, or a step into full-time ministry. When your business gives you time back, share it in #wins so we can celebrate what God is doing.')),
      h('section', { class: 'vision-sending' },
        h('div', { class: 'eyebrow' }, 'Where it all leads'),
        h('h2', { class: 'serif' }, 'Enjoying the Lord, and seeing His kingdom built'),
        h('p', {}, 'Freed-up time is for our families, and above all it is for enjoying the Lord, pursuing Him, and seeing God’s kingdom built and established.'),
        h('ol', { class: 'reach', 'aria-label': 'Where we hope to see the kingdom established' },
          h('li', {}, h('strong', {}, 'LA Metro'), h('span', {}, 'Where we live and work')),
          h('li', {}, h('strong', {}, 'Across the U.S.'), h('span', {}, 'Wherever our members are')),
          h('li', {}, h('strong', {}, 'The ends of the earth'), h('span', {}, 'Every nation'))),
        h('p', {}, 'Full-time ministry is not a requirement for anyone in ACE. But ultimately we are all focused on making disciples: raising up people who love Jesus and want to pursue God.'),
        h('div', { class: 'verse' }, '“You will be my witnesses in Jerusalem and in all Judea and Samaria, and to the end of the earth.” — Acts 1:8')),
      h('section', { class: 'vision-block' },
        h('h2', { class: 'serif' }, 'Begin with a conversation'),
        planPath(),
        h('p', { class: 'plan-commit' }, PLAN.commitment)));
}

// The three steps into the group. `at` highlights where someone is (0-based).
function planPath(at = -1) {
  return h('ol', { class: 'plan-path' }, PLAN.path.map(([title, text], i) => h('li', { class: i === at ? 'here' : i < at ? 'done' : '' },
    h('span', { class: 'plan-step' }, i < at ? '✓' : `0${i + 1}`),
    h('div', {}, h('strong', {}, title), h('span', {}, text)))));
}

const nextStepsChannel = () => (state.channels || []).find((c) => c.name === 'next-steps');
const nextStepsHash = () => (nextStepsChannel() ? roomHash(nextStepsChannel().room) : '#/chat');

// ---------- start here: a walkthrough of the vision ----------

// Each step explains part of the vision and the place in ACE that serves it.
const TOUR = [
  {
    icon: '✝', kicker: 'Welcome to ACE', title: 'AI Christian Entrepreneurs',
    body: [
      'One integrated life. ACE is a small, private, covocational community of business leaders who help one another build sustainable businesses, using AI, and invest deeply in people.',
      'Not to hustle harder or chase wealth, but to give us back our time: for loving God, our families, and making disciples.',
    ],
    verse: '“Seek first the kingdom of God and his righteousness.” — Matthew 6:33',
  },
  {
    icon: '⏳', kicker: 'The heart of it', title: 'Fewer hours, not more',
    body: [
      'Many of us feel called to ministry but spend most of our hours earning a living. AI has changed what one person can build.',
      'The goal is businesses that run with less of our time. Success here is measured in time given back, not in a bigger number.',
      'We’re learning that being the one who introduces people to AI earns trust, and that relationships are key: the business and the conversations about God both grow out of them.',
    ],
    note: 'This is not hustle culture, and no venture is worth losing time with the Lord or your family. Sabbath rest is part of the plan.',
  },
  {
    icon: '#', kicker: 'Encourage one another', title: 'Channels',
    body: [
      'Group conversations for the whole network: #encouragement for scripture and wins, #prayer-requests to pray for one another by name, #ai-tools-and-content to pass on what’s working, and more.',
      'Type @ and someone’s name to get their attention. They’ll get a notification.',
    ],
    action: ['Open the channels', '#/chat'],
  },
  {
    icon: '✉', kicker: 'Go deeper', title: 'Private messages',
    body: ['Message any member one-on-one: to ask a question, follow up after a call, or pray together. Only the two of you can see it.'],
    action: ['See members', '#/members'],
  },
  {
    icon: '◆', kicker: 'Build together', title: 'Projects',
    body: [
      'Share what you’re building and what help you need. Others can tap “I can help”, comment, and message you.',
      'Iron sharpens iron: offering your skills to someone else’s venture is part of the vision too.',
    ],
    action: ['Browse projects', '#/projects'],
  },
  {
    icon: '▲', kicker: 'Learn from each other', title: 'What’s working',
    body: [
      'Members share businesses that are working, including hours per week and where the freed-up time goes, so we can learn what gives back the most time.',
      'Blueprints walk through the structure of a working AI business, step by step.',
    ],
    action: ['See what’s working', '#/working'],
  },
  {
    icon: '⌂', kicker: 'Provide', title: 'Real estate',
    body: [
      'Real estate is where the pipeline leads: income from AI work, set aside and put into property that provides for our families with little of our time.',
      'Post a property you’re looking at and the numbers are worked out for you. Others can weigh in or say they’d like to partner, and #real-estate is where we talk it through.',
    ],
    action: ['Look at the deals', '#/real-estate'],
  },
  {
    icon: '☏', kicker: 'Gather', title: 'Community calls',
    body: [
      'We meet on Zoom every other week and gather in person every quarter, to explore big questions about God and life, workshop real business problems, pray, and follow up on what happened since last time.',
      'RSVP from the Calls page and tap Join call when it starts. You’ll get a reminder 15 minutes before.',
    ],
    note: 'We also have a workspace to meet in person: 43 Post, Irvine, CA 92618. Ask Jake about hours and access.',
    action: ['See the next call', '#/calls'],
  },
  {
    icon: '♡', kicker: 'Invest in people', title: 'Who am I discipling?',
    body: [
      'Each of us prays for and pursues people God has put in our lives: clients, neighbors, friends.',
      'Keep your list under Who I’m discipling (only you can see it). The measure: did anyone take a next step toward God? When they do, tell the story in #next-steps.',
    ],
    action: ['Open your list', '#/discipling'],
  },
  {
    icon: '✦', kicker: 'Shape the network', title: 'Suggestions',
    body: ['Have an idea for something we could do together? Post it, vote for the ideas you want, and see what’s planned.'],
    action: ['Open suggestions', '#/suggestions'],
  },
  {
    icon: '🌍', orbit: true, kicker: 'Where it all leads', title: 'His kingdom, here and to the ends of the earth',
    body: [
      'Freed-up time is for our families, and above all for enjoying the Lord, pursuing Him, and seeing His kingdom built: in LA Metro, across the U.S., and to the ends of the earth.',
      'Full-time ministry isn’t a requirement for anyone. But we are all ultimately focused on making disciples: raising up people who love Jesus and want to pursue God.',
    ],
    verse: '“You will be my witnesses … to the end of the earth.” — Acts 1:8',
  },
  {
    icon: '✓', kicker: 'Your next steps', title: 'Get settled in', checklist: true,
  },
];

function tourChecklist() {
  const first = state.channels.find((c) => c.name === 'general') ?? state.channels[0];
  const me = state.me;
  const items = [
    ['Fill out your profile', Boolean(me.headline || me.bio || me.skills || me.ministry), () => openProfileEditor()],
    ['Say hello in #general', false, () => first && go(roomHash(first.room))],
    ['RSVP to the next community call', (state.calls || []).some((c) => c.occurrences[0]?.rsvps.includes(me.id)), () => go('#/calls')],
    ['Add someone you’re discipling', (state.five?.people.length ?? 0) > 0, () => go('#/discipling')],
    ['Put ACE on your home screen', isStandalone(), () => installApp()],
    ['Turn on notifications', pushState === 'on', () => openNotificationSettings()],
    ['Read the full vision', false, () => go('#/vision')],
  ];
  return h('ul', { class: 'tour-checklist' }, items.map(([label, done, act]) => h('li', { class: done ? 'done' : '' },
    h('span', { class: 'tick', 'aria-hidden': 'true' }, done ? '✓' : ''),
    h('span', { class: 'grow' }, label),
    done ? h('span', { class: 'small muted' }, 'Done') : h('button', { class: 'btn small', onclick: act }, 'Go'))));
}

// Short labels for the slider tabs at the top of the walkthrough.
const TOUR_TABS = ['Welcome', 'The heart', 'Channels', 'Messages', 'Projects', 'What’s working', 'Real estate', 'Calls', 'Discipling', 'Suggestions', 'Where it leads', 'Next steps'];

// A slowly turning 3D block with the step's icon on its faces.
function tourCube(icon) {
  const face = (side) => h('div', { class: `cube-face ${side}` }, side === 'front' || side === 'back' ? icon : '');
  return h('div', { class: 'cube-scene', 'aria-hidden': 'true' },
    h('div', { class: 'cube' }, ['front', 'back', 'right', 'left', 'top', 'bottom'].map(face)),
    h('div', { class: 'cube-shadow' }));
}

// Tilted orbits: LA Metro at the center, then the U.S., then the ends of the earth.
function tourOrbit() {
  return h('div', { class: 'orbit-scene', 'aria-hidden': 'true' },
    h('div', { class: 'orbit-plane' },
      [1, 2, 3].map((n) => h('div', { class: `orbit-ring r${n}` }, h('span', { class: 'orbit-dot' })))),
    h('div', { class: 'orbit-core' }, '✝'),
    h('div', { class: 'orbit-labels' },
      h('span', { class: 'l1' }, 'LA Metro'), h('span', { class: 'l2' }, 'Across the U.S.'), h('span', { class: 'l3' }, 'The ends of the earth')));
}

let tourKeysBound = false;
let tourInput = null; // the open walkthrough's controls, for the keyboard handler

// One continuous 3D scene: a lit path the camera travels down, with a stop for each part of the vision.
function renderTour(stepIndex = 0) {
  const count = TOUR.length;
  const GAP = 1500; // distance between stops along the path
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let target = Math.min(stepIndex, count - 1);
  let p = target; // the camera's position along the path, in stops
  let shown = -1;
  let running = false;
  let wide = true;

  const stationX = (i) => (wide ? (i % 2 ? 1 : -1) * 260 : 0);
  const stationY = (i) => (wide ? [0, -30, 20, -10][i % 4] : 0);

  const stations = TOUR.map((step, i) => {
    const card = h('article', { class: 'stop-card', 'aria-label': `${i + 1} of ${count}: ${step.title}` },
      h('div', { class: 'stop-art', 'aria-hidden': 'true' }, step.orbit ? tourOrbit() : tourCube(step.icon)),
      h('div', { class: 'stop-body' },
        h('div', { class: 'tour-kicker' }, `${i + 1} of ${count} · ${step.kicker}`),
        h('h2', { class: 'serif' }, step.title),
        (step.body || []).map((t) => h('p', {}, t)),
        step.note && h('p', { class: 'tour-note' }, step.note),
        step.verse && h('div', { class: 'tour-verse' }, step.verse),
        step.checklist && [h('p', {}, 'A few things that will help you get the most out of ACE:'), tourChecklist()],
        step.action && h('a', { class: 'btn tour-action', href: step.action[1] }, `${step.action[0]} →`)));
    return h('div', { class: 'stop' }, card);
  });
  // Lanterns line the path; the ground itself is one plane that scrolls beneath us.
  const floor = h('div', { class: 'scene-floor' });
  const lanterns = TOUR.flatMap(() => [h('div', { class: 'lantern' }), h('div', { class: 'lantern' })]);
  const motes = Array.from({ length: 46 }, () => ({
    el: h('div', { class: 'mote' }),
    x: (Math.random() - 0.5) * 2400, y: (Math.random() - 0.7) * 900, z: -Math.random() * GAP * (count + 0.5) + GAP * 0.4,
  }));
  const world = h('div', { class: 'world' }, lanterns, motes.map((m) => m.el), stations);
  const stage = h('div', { class: 'scene-stage' }, h('div', { class: 'scene-sky' }), floor, world);

  const segments = TOUR.map((_, i) => h('button', {
    class: 'tour-seg', 'aria-label': `Go to stop ${i + 1}: ${TOUR[i].title}`, onclick: () => goTo(i),
  }, h('span', { class: 'tour-seg-fill' })));
  const tabs = TOUR_TABS.map((label, i) => h('button', { class: 'tour-tab', role: 'tab', onclick: () => goTo(i) }, label));
  const tabRow = h('div', { class: 'tour-tabs', role: 'tablist', 'aria-label': 'Walkthrough stops' }, tabs);
  const back = h('button', { class: 'btn tour-back', onclick: () => goTo(Math.round(target) - 1) }, '← Back');
  const next = h('button', { class: 'btn primary tour-next', onclick: () => (Math.round(target) >= count - 1 ? go('#/home') : goTo(Math.round(target) + 1)) });
  const hint = h('span', { class: 'tour-hint' });

  function placeStatic() {
    wide = stage.clientWidth > 760;
    stations.forEach((el, i) => {
      el.style.transform = `translate3d(${stationX(i)}px, ${stationY(i)}px, ${-i * GAP}px)`;
    });
    lanterns.forEach((el, k) => {
      const i = Math.floor(k / 2);
      const side = k % 2 ? 1 : -1;
      el.style.transform = `translate3d(${stationX(i) * 0.6 + side * (wide ? 520 : 230)}px, ${wide ? 150 : 170}px, ${-i * GAP - GAP * 0.25}px)`;
    });
    motes.forEach((m) => { m.el.style.transform = `translate3d(${m.x}px, ${m.y}px, ${m.z}px)`; });
  }

  const smooth = (t) => t * t * (3 - 2 * t);

  // Moves the camera to position p and fades things that are behind it or far ahead.
  function draw() {
    const i0 = Math.floor(p);
    const t = p - i0;
    const i1 = Math.min(count - 1, i0 + 1);
    const camX = stationX(i0) + (stationX(i1) - stationX(i0)) * smooth(t);
    const camY = stationY(i0) + (stationY(i1) - stationY(i0)) * smooth(t);
    // Turn slightly toward the next stop while traveling, like walking a winding path.
    const turn = wide ? Math.sin(Math.PI * t) * Math.sign(stationX(i1) - stationX(i0)) * -9 : 0;
    world.style.transform = `rotateY(${turn}deg) translate3d(${-camX}px, ${-camY}px, ${p * GAP}px)`;

    stations.forEach((el, i) => {
      const d = i - p; // > 0: ahead of us, < 0: already passed
      const opacity = d < 0 ? Math.max(0, 1 + d * 2.6) : Math.max(0, 1 - d * 0.45);
      el.style.opacity = String(opacity);
      el.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
      const near = Math.abs(d) < 0.35;
      el.classList.toggle('near', near);
      el.inert = !near;
    });
    floor.style.backgroundPosition = `${-camX * 0.5}px ${p * GAP * 0.4}px`;
    lanterns.forEach((el, k) => { el.style.opacity = String(Math.floor(k / 2) - p < -0.1 ? 0 : 1); });
    motes.forEach((m) => {
      const rel = m.z + p * GAP;
      m.el.style.opacity = rel > 300 ? '0' : rel < -GAP * 3 ? '0' : '1';
    });
    segments.forEach((seg, i) => {
      seg.firstChild.style.width = `${Math.max(0, Math.min(1, p - i + 1)) * 100}%`;
    });

    const nearest = Math.round(p);
    if (nearest !== shown) {
      shown = nearest;
      tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === nearest)));
      const tab = tabs[nearest];
      tabRow.scrollTo({ left: tab.offsetLeft - (tabRow.clientWidth - tab.offsetWidth) / 2, behavior: reduceMotion ? 'auto' : 'smooth' });
      back.style.visibility = nearest === 0 ? 'hidden' : 'visible';
      next.textContent = nearest === 0 ? 'Begin the journey →' : nearest === count - 1 ? 'Finish' : 'Next →';
      hint.textContent = wide ? 'Scroll, drag, or use the arrow keys to move along the path' : 'Swipe to move along the path';
      history.replaceState(null, '', `#/tour/${nearest + 1}`);
      state.route = parseRoute();
    }
  }

  function loop() {
    if (!stage.isConnected) { running = false; return; }
    const delta = target - p;
    p = reduceMotion || Math.abs(delta) < 0.0008 ? target : p + delta * 0.075;
    draw();
    if (p !== target) requestAnimationFrame(loop); else running = false;
  }
  function kick() {
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function goTo(n) {
    target = Math.max(0, Math.min(count - 1, n));
    kick();
  }

  // Settles on a stop after a scroll or drag: even a small push carries on to the next one.
  function land(from) {
    const moved = target - from;
    let stop = Math.round(target);
    if (stop === Math.round(from) && Math.abs(moved) > 0.12) stop += Math.sign(moved);
    goTo(stop);
  }

  // Scrolling moves along the path, then settles.
  let settleTimer;
  let wheelFrom = null;
  stage.addEventListener('wheel', (e) => {
    const body = e.target.closest('.stop-body');
    if (body && body.scrollHeight > body.clientHeight + 4) return;
    e.preventDefault();
    if (wheelFrom === null) wheelFrom = target;
    target = Math.max(0, Math.min(count - 1, target + e.deltaY / 650));
    kick();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { land(wheelFrom); wheelFrom = null; }, 220);
  }, { passive: false });

  // Dragging or swiping (either direction) also moves along the path.
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, button, input, textarea')) return;
    const body = e.target.closest('.stop-body');
    if (body && body.scrollHeight > body.clientHeight + 4 && e.pointerType !== 'mouse') return; // let a long card scroll
    drag = { x: e.clientX, y: e.clientY, from: target };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const amount = (Math.abs(dx) > Math.abs(dy) ? -dx : -dy) / (wide ? 520 : 300);
    target = Math.max(0, Math.min(count - 1, drag.from + amount));
    kick();
  });
  const endDrag = () => {
    if (!drag) return;
    const from = drag.from;
    drag = null;
    land(from);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  tourInput = { goTo, current: () => Math.round(target) };
  if (!tourKeysBound) {
    tourKeysBound = true;
    document.addEventListener('keydown', (e) => {
      if (state.route.name !== 'tour' || !tourInput || document.querySelector('.modal-backdrop') || e.target.closest('input, textarea')) return;
      const forward = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key);
      const backward = ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key);
      if (!forward && !backward) return;
      e.preventDefault();
      tourInput.goTo(tourInput.current() + (forward ? 1 : -1));
    });
  }

  afterRenderHooks.push(() => {
    placeStatic();
    draw();
    new ResizeObserver(() => { placeStatic(); draw(); }).observe(stage);
  });

  return [
    topbar('Start here', 'A journey through the vision of ACE', [], { back: '#/home' }),
    h('div', { class: 'page tour-page' }, h('div', { class: 'tour-scene' },
      stage,
      h('div', { class: 'tour-top' }, h('div', { class: 'tour-segments' }, segments), tabRow),
      h('div', { class: 'tour-controls' }, back, hint, next))),
  ];
}

// ---------- rooms (channels + DMs) ----------

function renderRoom(room) {
  const info = roomInfo(room);
  if (!info) {
    return [topbar('Not found'), h('div', { class: 'page' }, h('div', { class: 'empty' }, 'This conversation does not exist or you do not have access.'))];
  }
  const actions = [];
  if (info.kind === 'dm') {
    actions.push(h('button', { class: 'btn small', onclick: () => openMemberProfile(info.convo.otherUserId) }, 'View profile'));
  } else if (state.me.role === 'admin') {
    actions.push(h('button', { class: 'btn small ghost danger', onclick: () => deleteChannel(info.channel) }, 'Delete channel'));
  }

  const list = h('div', { class: 'messages', id: 'messages' });
  const typing = h('div', { class: 'typing', id: 'typing' });
  const input = h('textarea', {
    rows: 1, placeholder: info.kind === 'channel' ? `Message #${info.channel.name}` : `Message ${info.title}`,
    'aria-label': 'Message',
  });
  let lastTyping = 0;
  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    autosize(input);
    try {
      const { message } = await api(`/api/rooms/${room}/messages`, { method: 'POST', body: { body } });
      addMessage(message);
    } catch (err) {
      input.value = body;
      toast(err.message, 'error');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    autosize(input);
    if (Date.now() - lastTyping > 2500) { lastTyping = Date.now(); state.socket?.emit('typing', room); }
  });

  afterRenderHooks.push(async () => {
    try {
      if (!state.rooms.get(room)?.loaded) await loadRoom(room);
    } catch (err) {
      return toast(err.message, 'error');
    }
    renderMessages(room, { scroll: 'bottom' });
    renderTyping(room);
    input.focus();
  });

  return [
    topbar(info.title, info.sub, actions, { back: '#/chat' }),
    h('div', { class: 'chat' }, list,
      h('div', { class: 'composer' },
        h('div', { class: 'composer-box' }, input, h('button', { class: 'btn primary', onclick: send }, 'Send')),
        typing)),
  ];
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

async function loadRoom(room, { older = false } = {}) {
  const data = state.rooms.get(room) || { messages: [], hasMore: false, loaded: false };
  const before = older && data.messages[0] ? `?before=${data.messages[0].id}` : '';
  const res = await api(`/api/rooms/${room}/messages${before}`);
  data.messages = older ? [...res.messages, ...data.messages] : mergeMessages(data.messages, res.messages);
  data.hasMore = res.hasMore;
  data.loaded = true;
  state.rooms.set(room, data);
}

function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function renderMessages(room, { scroll } = {}) {
  const list = document.getElementById('messages');
  if (!list || state.route.room !== room) return;
  const data = state.rooms.get(room) || { messages: [] };
  const info = roomInfo(room);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const prevHeight = list.scrollHeight;

  const children = [];
  if (data.hasMore) {
    children.push(h('div', { class: 'load-more' }, h('button', { class: 'btn small', onclick: async () => {
      await loadRoom(room, { older: true });
      renderMessages(room, { scroll: 'keep' });
    } }, 'Load earlier messages')));
  } else if (info) {
    children.push(h('div', { class: 'welcome-room' },
      info.kind === 'channel'
        ? [h('h2', { class: 'serif' }, `Welcome to #${info.channel.name}`), h('p', { class: 'muted' }, info.channel.description || 'This is the start of the channel.')]
        : [h('h2', { class: 'serif' }, userName(info.convo.otherUserId)), h('p', { class: 'muted' }, 'This is the beginning of your private conversation. Only the two of you can see it.')]));
  }

  let prev = null;
  for (const m of data.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (!prev || new Date(prev.createdAt).toDateString() !== day) {
      children.push(h('div', { class: 'day-divider' }, dayLabel(m.createdAt)));
      prev = null;
    }
    const cont = prev && prev.userId === m.userId && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60_000;
    children.push(messageEl(m, cont));
    prev = m;
  }
  list.replaceChildren(...children);

  if (scroll === 'bottom' || (scroll !== 'keep' && nearBottom)) list.scrollTop = list.scrollHeight;
  else if (scroll === 'keep') list.scrollTop = list.scrollHeight - prevHeight + list.scrollTop;

  const last = data.messages[data.messages.length - 1];
  if (last) markRead(room, last.id);
}

function messageEl(m, cont) {
  const mine = m.userId === state.me.id;
  const canDelete = mine || (state.me.role === 'admin' && m.room.startsWith('c:'));
  const el = h('div', { class: `msg ${cont ? 'cont' : ''}`, tabindex: '0', 'data-id': m.id });

  let body;
  if (state.editing === m.id) {
    const ta = h('textarea', { value: m.body });
    const save = async () => {
      try {
        const { message } = await api(`/api/messages/${m.id}`, { method: 'PATCH', body: { body: ta.value } });
        state.editing = null;
        updateMessage(message);
      } catch (err) { toast(err.message, 'error'); }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { state.editing = null; renderMessages(m.room); }
    });
    body = h('div', { class: 'edit-box' }, ta,
      h('div', { style: 'display:flex;gap:6px' },
        h('button', { class: 'btn small primary', onclick: save }, 'Save'),
        h('button', { class: 'btn small', onclick: () => { state.editing = null; renderMessages(m.room); } }, 'Cancel')));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  } else {
    body = h('div', { class: 'body', html: formatText(m.body) });
  }

  const picker = h('div', { class: 'picker hidden' }, state.reactions.map((emoji) =>
    h('button', { title: `React ${emoji}`, onclick: () => { picker.classList.add('hidden'); react(m, emoji); } }, emoji)));

  el.append(
    avatar(m.userId),
    h('div', { class: 'content' },
      !cont && h('div', { class: 'meta' },
        h('strong', { onclick: () => openMemberProfile(m.userId) }, userName(m.userId)),
        h('time', { datetime: m.createdAt, title: new Date(m.createdAt).toLocaleString() }, relTime(m.createdAt))),
      body,
      m.editedAt && state.editing !== m.id && h('span', { class: 'edited' }, '(edited)'),
      m.reactions.length > 0 && h('div', { class: 'reactions' }, m.reactions.map((r) => h('button', {
        class: `reaction ${r.userIds.includes(state.me.id) ? 'mine' : ''}`,
        title: r.userIds.map(userName).join(', '),
        onclick: () => react(m, r.emoji),
      }, r.emoji, h('span', {}, r.userIds.length))))),
    h('div', { class: 'actions' },
      h('button', { title: 'Pray / Amen', onclick: () => react(m, '🙏') }, '🙏'),
      h('button', { title: 'Add reaction', onclick: (e) => { e.stopPropagation(); picker.classList.toggle('hidden'); } }, '☺'),
      mine && h('button', { title: 'Edit', onclick: () => { state.editing = m.id; renderMessages(m.room); } }, '✎'),
      canDelete && h('button', { title: 'Delete', onclick: () => deleteMessage(m) }, '🗑')),
    picker);
  return el;
}

async function react(m, emoji) {
  try {
    const { message } = await api(`/api/messages/${m.id}/reactions`, { method: 'POST', body: { emoji } });
    updateMessage(message);
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteMessage(m) {
  if (!confirm('Delete this message?')) return;
  try {
    await api(`/api/messages/${m.id}`, { method: 'DELETE' });
    removeMessage({ id: m.id, room: m.room });
  } catch (err) { toast(err.message, 'error'); }
}

function addMessage(m) {
  const data = state.rooms.get(m.room);
  if (data?.loaded) data.messages = mergeMessages(data.messages, [m]);
  clearTyping(m.room, m.userId);
  if (state.route.room === m.room && document.hasFocus()) {
    renderMessages(m.room, { scroll: m.userId === state.me.id ? 'bottom' : undefined });
  } else if (state.route.room === m.room) {
    renderMessages(m.room);
  }
  const holder = m.room.startsWith('c:') ? state.channels.find((c) => c.room === m.room) : state.conversations.find((c) => c.room === m.room);
  if (holder) {
    if (m.userId !== state.me.id && state.route.room !== m.room) holder.unread += 1;
    if (!m.room.startsWith('c:')) {
      holder.lastMessageAt = m.createdAt;
      state.conversations.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    }
  }
  refreshSidebar();
}

function updateMessage(m) {
  const data = state.rooms.get(m.room);
  if (!data) return;
  data.messages = data.messages.map((x) => (x.id === m.id ? m : x));
  if (state.route.room === m.room && state.editing !== m.id) renderMessages(m.room);
}

function removeMessage({ id, room }) {
  const data = state.rooms.get(room);
  if (!data) return;
  data.messages = data.messages.filter((x) => x.id !== id);
  if (state.route.room === room) renderMessages(room);
}

const readTimers = new Map();
function markRead(room, lastId) {
  const holder = room.startsWith('c:') ? state.channels.find((c) => c.room === room) : state.conversations.find((c) => c.room === room);
  if (holder && holder.unread) { holder.unread = 0; refreshSidebar(); }
  clearTimeout(readTimers.get(room));
  readTimers.set(room, setTimeout(() => {
    api(`/api/rooms/${room}/read`, { method: 'POST', body: { lastReadId: lastId } }).catch(() => {});
  }, 400));
}

function renderTyping(room) {
  const el = document.getElementById('typing');
  if (!el || state.route.room !== room) return;
  const ids = [...(state.typing.get(room)?.keys() || [])].filter((id) => id !== state.me.id);
  el.textContent = ids.length === 0 ? '' : ids.length === 1 ? `${userName(ids[0])} is typing…` : `${ids.map(userName).join(', ')} are typing…`;
}

function clearTyping(room, userId) {
  const map = state.typing.get(room);
  if (!map?.has(userId)) return;
  clearTimeout(map.get(userId));
  map.delete(userId);
  renderTyping(room);
}

function openNewChannel() {
  const close = openModal('New channel', form([
    field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 40, placeholder: 'e.g. marketing-automation' }), 'Lowercase letters, numbers and dashes'),
    field('Description', h('input', { type: 'text', name: 'description', maxlength: 200, placeholder: 'What is this channel for?' })),
  ], {
    submitLabel: 'Create channel',
    onSubmit: async (values) => {
      const { channel } = await api('/api/channels', { method: 'POST', body: values });
      if (!state.channels.some((c) => c.id === channel.id)) state.channels.push(channel);
      close();
      go(roomHash(channel.room));
    },
  }));
}

async function deleteChannel(channel) {
  if (!confirm(`Delete #${channel.name} and all of its messages? This cannot be undone.`)) return;
  try {
    await api(`/api/channels/${channel.id}`, { method: 'DELETE' });
    go('#/home');
  } catch (err) { toast(err.message, 'error'); }
}

function openNewDm() {
  const search = h('input', { type: 'search', placeholder: 'Search members…' });
  const list = h('div', { style: 'display:grid;gap:4px;margin-top:12px;max-height:360px;overflow:auto' });
  const draw = () => {
    const q = search.value.toLowerCase();
    const people = [...state.users.values()].filter((u) => u.id !== state.me.id && u.name.toLowerCase().includes(q));
    list.replaceChildren(...(people.length ? people.map((u) => h('button', {
      class: 'btn ghost', style: 'justify-content:flex-start;gap:10px;padding:8px', onclick: () => { close(); startDm(u.id); },
    }, avatar(u.id, 'sm'), h('span', {}, u.name), h('span', { class: 'muted small' }, u.headline))) : [h('p', { class: 'muted' }, 'No members found.')]));
  };
  search.addEventListener('input', draw);
  draw();
  const close = openModal('New direct message', h('div', {}, search, list));
}

async function startDm(userId) {
  try {
    const { conversation } = await api('/api/conversations', { method: 'POST', body: { userId } });
    if (!state.conversations.some((c) => c.id === conversation.id)) state.conversations.unshift(conversation);
    closeModal();
    go(roomHash(conversation.room));
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- projects ----------

let projectFilter = 'all';

function projectCard(p) {
  return h('article', { class: 'card project-card', onclick: () => go(`#/projects/${p.id}`) },
    h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:flex-start' },
      h('h3', {}, p.title), h('span', { class: `chip ${p.status}` }, STATUS_LABELS[p.status])),
    p.description && h('div', { class: 'desc' }, p.description),
    p.helpNeeded && p.status !== 'launched' && h('div', { class: 'help' }, h('b', {}, 'Help wanted: '), p.helpNeeded.length > 140 ? `${p.helpNeeded.slice(0, 140)}…` : p.helpNeeded),
    p.tags && h('div', { class: 'tags' }, p.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => h('span', { class: 'chip' }, t))),
    h('div', { class: 'foot' }, avatar(p.userId, 'sm'), h('span', { style: 'flex:1' }, userName(p.userId)),
      h('span', {}, `🤝 ${p.helpers.length}`), h('span', {}, `💬 ${p.commentCount}`)));
}

function renderProjects() {
  const projects = state.projects || [];
  const shown = projects.filter((p) => projectFilter === 'all' || (projectFilter === 'mine' ? p.userId === state.me.id : p.status === projectFilter));
  const filters = [['all', 'All'], ['looking', 'Looking for help'], ['in-progress', 'In progress'], ['launched', 'Launched'], ['mine', 'Mine']];
  if (state.route.id) afterRenderHooks.push(() => openProject(state.route.id));
  return [
    topbar('Projects', 'Share what you are building, ask for help, and collaborate.',
      [h('button', { class: 'btn primary', onclick: () => openProjectEditor() }, '+ Share a project')]),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('div', { class: 'tags', style: 'margin-bottom:16px' }, filters.map(([key, label]) => h('button', {
        class: `btn small ${projectFilter === key ? 'on' : ''}`,
        onclick: () => { projectFilter = key; renderShell(); },
      }, label))),
      shown.length ? h('div', { class: 'grid' }, shown.map(projectCard))
        : h('div', { class: 'card empty' }, projects.length ? 'No projects match this filter.' : 'No projects yet. Be the first to share what you are building!'))),
  ];
}

function openProjectEditor(project) {
  const statusSelect = h('select', { name: 'status' }, Object.entries(STATUS_LABELS).map(([value, label]) =>
    h('option', { value, selected: (project?.status ?? 'looking') === value }, label)));
  const close = openModal(project ? 'Edit project' : 'Share a project', form([
    field('Project name', h('input', { type: 'text', name: 'title', required: true, maxlength: 120, value: project?.title, placeholder: 'e.g. AI intake assistant for church counseling ministries' })),
    field('What are you building?', h('textarea', { name: 'description', maxlength: 4000, rows: 4, value: project?.description, placeholder: 'The problem, who it serves, and where it is at today' })),
    field('What help do you need?', h('textarea', { name: 'helpNeeded', maxlength: 2000, rows: 3, value: project?.helpNeeded, placeholder: 'e.g. Someone experienced with n8n automations, feedback on pricing, a beta tester…' })),
    h('div', { class: 'row' },
      field('Tags', h('input', { type: 'text', name: 'tags', maxlength: 200, value: project?.tags, placeholder: 'automation, saas, content' }), 'Comma-separated'),
      field('Status', statusSelect)),
  ], {
    submitLabel: project ? 'Save changes' : 'Share project',
    onSubmit: async (values) => {
      const res = project
        ? await api(`/api/projects/${project.id}`, { method: 'PATCH', body: values })
        : await api('/api/projects', { method: 'POST', body: values });
      upsertProject(res.project);
      close();
      go(`#/projects/${res.project.id}`);
    },
  }), { wide: true });
}

function upsertProject(p) {
  if (!state.projects) return;
  if (p.deleted) state.projects = state.projects.filter((x) => x.id !== p.id);
  else {
    const { comments, ...summary } = p;
    const i = state.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) state.projects[i] = summary; else state.projects.unshift(summary);
    state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

async function openProject(id) {
  let project;
  try {
    ({ project } = await api(`/api/projects/${id}`));
  } catch (err) {
    toast(err.message, 'error');
    return go('#/projects');
  }
  const isOwner = project.userId === state.me.id;
  const myHelp = project.helpers.find((x) => x.userId === state.me.id);

  const refresh = (p) => { upsertProject(p); openProject(p.id); };
  const helpForm = !isOwner && h('div', { class: 'card', style: 'background:var(--accent-soft);border:0;box-shadow:none;margin-bottom:18px' },
    myHelp
      ? h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
          h('span', { style: 'flex:1' }, '🤝 You offered to help on this project.'),
          h('button', { class: 'btn small', onclick: () => startDm(project.userId) }, `Message ${userName(project.userId).split(' ')[0]}`),
          h('button', { class: 'btn small ghost', onclick: async () => refresh((await api(`/api/projects/${id}/helpers`, { method: 'DELETE' })).project) }, 'Withdraw'))
      : form([field('Can you help?', h('input', { type: 'text', name: 'note', maxlength: 500, placeholder: 'How you could help (optional)' }))], {
          submitLabel: '🤝 I can help',
          onSubmit: async (values) => refresh((await api(`/api/projects/${id}/helpers`, { method: 'POST', body: values })).project),
        }));

  const commentInput = h('textarea', { name: 'body', rows: 2, required: true, maxlength: 2000, placeholder: 'Encourage, ask a question, or share an idea…' });

  const close = openModal(project.title, h('div', {},
    h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap' },
      h('span', { class: `chip ${project.status}` }, STATUS_LABELS[project.status]),
      avatar(project.userId, 'sm'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); close(); openMemberProfile(project.userId); } }, userName(project.userId)),
      h('span', { class: 'muted small' }, `· updated ${shortDate(project.updatedAt)}`)),
    project.description && h('div', { class: 'detail-block' }, h('h4', {}, 'About'), h('p', { html: formatText(project.description) })),
    project.helpNeeded && h('div', { class: 'detail-block' }, h('h4', {}, 'Help wanted'), h('p', { html: formatText(project.helpNeeded) })),
    project.tags && h('div', { class: 'detail-block tags' }, project.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => h('span', { class: 'chip' }, t))),
    helpForm,
    h('div', { class: 'detail-block' }, h('h4', {}, `Offers to help (${project.helpers.length})`),
      project.helpers.length === 0 ? h('p', { class: 'muted' }, 'No one yet.') : project.helpers.map((x) => h('div', { class: 'helper' },
        avatar(x.userId, 'sm'),
        h('div', { style: 'flex:1' }, h('strong', {}, userName(x.userId)), x.note && h('div', { class: 'small muted' }, x.note)),
        isOwner && h('button', { class: 'btn small', onclick: () => startDm(x.userId) }, 'Message')))),
    h('div', { class: 'detail-block' }, h('h4', {}, `Discussion (${project.comments.length})`),
      project.comments.map((c) => h('div', { class: 'comment' }, avatar(c.userId, 'sm'),
        h('div', {}, h('strong', {}, userName(c.userId)), h('span', { class: 'muted small' }, ` · ${shortDate(c.createdAt)}`),
          h('p', { html: formatText(c.body) })))),
      form([commentInput], {
        submitLabel: 'Comment',
        onSubmit: async (values) => refresh((await api(`/api/projects/${id}/comments`, { method: 'POST', body: values })).project),
      })),
    (isOwner || state.me.role === 'admin') && h('div', { class: 'modal-foot', style: 'border-top:1px solid var(--border);padding-top:14px' },
      h('button', { class: 'btn danger ghost', onclick: async () => {
        if (!confirm('Delete this project?')) return;
        await api(`/api/projects/${id}`, { method: 'DELETE' });
        upsertProject({ id, deleted: true });
        close();
        renderShell();
      } }, 'Delete'),
      h('span', { class: 'spacer' }),
      isOwner && h('button', { class: 'btn', onclick: () => { close(); openProjectEditor(project); } }, 'Edit project'))),
  {
    wide: true,
    // Dismissing the project returns to the board URL without re-rendering it.
    onClose: () => {
      if (location.hash === `#/projects/${id}`) history.replaceState(null, '', '#/projects');
      state.route = parseRoute();
    },
  });
}

// ---------- pipeline: from building with AI to investing in real estate ----------

const PIPELINE = [
  {
    key: 'build', title: 'Build with AI', icon: '⚙',
    text: 'Be the one who introduces the people and businesses around you to AI. Help them first; the trust you earn becomes relationships, and a business that solves real problems grows from there.',
    ready: ['People come to you as their go-to for AI', 'You have paying customers', 'The work is repeatable, not one-off'],
    links: [['Your offer & leads', '#/offers'], ['How to get leads', '#/offers/get-leads'], ['See what’s working', '#/working']],
  },
  {
    key: 'generate', title: 'Generate income', icon: '◎',
    text: 'Grow it into steady income that doesn’t need all your hours, using systems, automation, and the right people.',
    ready: ['Income is steady month to month', 'It runs on fewer of your hours each month'],
    links: [['Your offer & leads', '#/offers'], ['Blueprints', '#/working/blueprints']],
  },
  {
    key: 'set-aside', title: 'Set aside', icon: '▣',
    text: 'Give first, keep a reserve, and save toward a down payment instead of raising your lifestyle.',
    ready: ['Giving comes first', 'You have several months of reserves', 'You’ve saved toward a down payment'],
    links: [],
  },
  {
    key: 'invest', title: 'Invest in real estate', icon: '⌂',
    text: 'Buy property that produces income, on your own or with partners from the group. Look at deals together before anyone buys.',
    ready: ['Your property pays for itself and then some', 'You know how it will be managed without taking your time'],
    links: [['Look at deals', '#/real-estate']],
  },
  {
    // Stored as 'freed' for members who already picked this step.
    key: 'freed', title: 'Provided for', icon: '◇',
    text: 'Income from work and property that need little of your time provides for your family and supports the work of the kingdom.',
    ready: [],
    links: [],
  },
];

const DEAL_STATUS_LABELS = { looking: 'Looking', analyzing: 'Running numbers', offer: 'Offer made', owned: 'Bought', passed: 'Passed' };
const PROPERTY_LABELS = { 'single-family': 'Single-family', 'multi-family': 'Multi-family', condo: 'Condo / townhome', commercial: 'Commercial', land: 'Land', other: 'Other' };

const money = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—');
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—');

// The usual rental math: loan payment, monthly cash flow, cap rate, and cash-on-cash return.
function dealMath(d) {
  const price = Number(d.price) || 0;
  const down = price * (Number(d.downPct) || 0) / 100;
  const loan = price - down;
  const r = (Number(d.rate) || 0) / 100 / 12;
  const n = (Number(d.years) || 30) * 12;
  const payment = loan <= 0 ? 0 : r ? (loan * r) / (1 - (1 + r) ** -n) : loan / n;
  const cashIn = down + price * (Number(d.closingPct) || 0) / 100;
  const rent = Number(d.rent) || 0;
  const expenses = Number(d.expenses) || 0;
  const cashFlow = rent - expenses - payment;
  return {
    down, loan, payment, cashIn, cashFlow,
    capRate: price ? ((rent - expenses) * 12) / price : NaN,
    cashOnCash: cashIn ? (cashFlow * 12) / cashIn : NaN,
  };
}

function upsertDeal(d) {
  if (!state.deals) return;
  if (d.deleted) state.deals = state.deals.filter((x) => x.id !== d.id);
  else {
    const { comments, ...summary } = d;
    const i = state.deals.findIndex((x) => x.id === d.id);
    if (i >= 0) state.deals[i] = summary; else state.deals.unshift(summary);
    state.deals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

let pipelineOpen = null; // the step shown in detail

async function setPipelineStage(key) {
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { pipelineStage: key } });
    state.me = user;
    state.users.set(user.id, { ...state.users.get(user.id), ...user });
    pipelineOpen = key;
    renderShell();
    toast(`You’re on “${PIPELINE.find((x) => x.key === key).title}”`);
  } catch (err) { toast(err.message, 'error'); }
}

function renderPipeline() {
  return [
    topbar('Pipeline', 'From building with AI to investing in real estate',
      [h('a', { class: 'btn', href: '#/real-estate' }, 'Real estate →')]),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' }, pipelineProcess())),
  ];
}

// Common ways members can start investing. General education, not advice.
const RE_STRATEGIES = [
  ['House hacking', 'Low', 'Buy a 2–4 unit property, live in one unit, and rent the others. Owner-occupied loans can allow a smaller down payment, and the rents help cover the mortgage.'],
  ['Long-term rental', 'Low', 'A single-family home or condo rented on a yearly lease. Simple to understand, and a property manager can keep it light on your time.'],
  ['Small multifamily', 'Low–medium', 'Two to four units under one roof and one loan. Several rents mean one vacancy doesn’t wipe out the cash flow.'],
  ['Invest together', 'Low', 'Pool money with other members on one property, with a written agreement on who puts in what, who manages it, and how cash flow and profit are shared.'],
  ['Out-of-area rentals', 'Low–medium', 'Southern California prices make cash flow hard. Many investors buy in more affordable markets and hire a trusted local property manager.'],
  ['BRRRR', 'High', 'Buy below value, rehab, rent, refinance to pull your cash back out, and repeat. It can grow faster, but the rehab takes real time and carries more risk.'],
];

function renderRealEstate() {
  const deals = state.deals || [];
  if (state.route.id) afterRenderHooks.push(() => openDeal(state.route.id));
  const watching = deals.filter((d) => d.status !== 'passed');
  return [
    topbar('Real estate', 'Properties we’re looking at together',
      [h('button', { class: 'btn primary', onclick: () => openDealEditor() }, '+ Add a deal')]),
    h('div', { class: 'page' }, h('div', { class: 'page-inner re-page' },
      h('section', { class: 'card re-intro' },
        h('div', {},
          h('h2', { class: 'serif' }, 'Provision that needs little of our time'),
          h('p', {}, PLAN.realEstate),
          h('a', { class: 'plan-here', href: '#/pipeline' }, 'Where this fits in the pipeline →')),
        h('div', { class: 're-stats' },
          h('div', {}, h('b', {}, watching.length), h('span', {}, 'deals we’re looking at')),
          h('div', {}, h('b', {}, deals.filter((d) => d.status === 'owned').length), h('span', {}, 'bought')),
          h('div', {}, h('b', {}, [...state.users.values()].filter((u) => u.pipelineStage === 'invest').length), h('span', {}, 'members investing')))),
      h('div', { class: 'section-head' }, h('h2', {}, 'Deals'),
        nextChannelLink('real-estate', 'Talk in #real-estate →')),
      dealsBoard(),
      h('div', { class: 'section-head' }, h('h2', {}, 'Ways to invest')),
      h('div', { class: 'grid re-strategies' }, RE_STRATEGIES.map(([title, time, text]) => h('article', { class: 'card' },
        h('div', { class: 'deal-head' }, h('h3', {}, title), h('span', { class: 'chip' }, `Time: ${time}`)),
        h('p', { class: 'muted small', style: 'margin:6px 0 0' }, text)))),
      h('p', { class: 'small muted deal-disclaimer' }, 'This is general education to help us think, not financial, legal, or tax advice. Check the numbers with a lender, agent, or CPA before you buy.'))),
  ];
}

function nextChannelLink(name, label) {
  const c = (state.channels || []).find((x) => x.name === name);
  return c ? h('a', { class: 'small', href: roomHash(c.room) }, label) : null;
}

function pipelineProcess() {
  const mine = state.me.pipelineStage ?? 'build';
  const open = pipelineOpen ?? mine;
  const myIndex = PIPELINE.findIndex((x) => x.key === mine);
  const people = [...state.users.values()];
  const step = PIPELINE.find((x) => x.key === open);
  const onStep = people.filter((u) => (u.pipelineStage ?? 'build') === open);
  return h('div', { class: 'pipeline' },
    h('p', { class: 'muted intro' }, 'We seek first the kingdom at every step, not just at the end. The pipeline is how we provide for our families and support the work of the kingdom with as little of our time as possible. Mark the step you’re on so we can help each other along.'),
    h('ol', { class: 'pipe-steps' }, PIPELINE.map((x, i) => {
      const here = people.filter((u) => (u.pipelineStage ?? 'build') === x.key);
      return h('li', {},
        h('button', {
          class: `pipe-step ${x.key === open ? 'open' : ''} ${x.key === mine ? 'mine' : ''} ${i < myIndex ? 'past' : ''}`,
          'aria-pressed': String(x.key === open),
          onclick: () => {
            pipelineOpen = x.key;
            renderShell();
            // On phones the steps stack, so bring the step's details into view.
            if (innerWidth <= 900) document.querySelector('.pipe-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
          h('span', { class: 'pipe-icon', 'aria-hidden': 'true' }, i < myIndex ? '✓' : x.icon),
          h('span', { class: 'pipe-num' }, `Step ${i + 1}`),
          h('strong', {}, x.title),
          h('span', { class: 'pipe-who' },
            here.length ? h('span', { class: 'avatars' }, here.slice(0, 4).map((u) => avatar(u.id, 'sm'))) : null,
            here.length ? `${here.length}` : h('span', { class: 'muted' }, 'No one yet')),
          x.key === mine && h('span', { class: 'pipe-you' }, 'You’re here')));
    })),
    h('section', { class: 'card pipe-detail' },
      h('div', { class: 'pipe-detail-head' },
        h('div', {}, h('div', { class: 'plan-num' }, `Step ${PIPELINE.indexOf(step) + 1} of ${PIPELINE.length}`), h('h2', { class: 'serif' }, step.title)),
        step.key === mine ? h('span', { class: 'chip launched' }, 'Your step')
          : h('button', { class: 'btn small', onclick: () => setPipelineStage(step.key) }, 'I’m on this step')),
      h('p', {}, step.text),
      step.ready.length > 0 && h('div', {}, h('h4', {}, 'Ready for the next step when…'),
        h('ul', { class: 'pipe-ready' }, step.ready.map((t) => h('li', {}, t)))),
      step.links.length > 0 && h('div', { class: 'pipe-links' }, step.links.map(([label, href]) => h('a', { class: 'btn small', href }, `${label} →`))),
      h('div', {}, h('h4', {}, `On this step (${onStep.length})`),
        onStep.length ? h('div', { class: 'pipe-people' }, onStep.map((u) => h('button', { class: 'pipe-person', onclick: () => openMemberProfile(u.id) }, avatar(u.id, 'sm'), u.name)))
          : h('p', { class: 'muted small', style: 'margin:0' }, 'No one is on this step yet.'))));
}

function dealsBoard() {
  const deals = state.deals || [];
  return h('div', { class: 'deals' },
    h('p', { class: 'muted intro' }, 'Add a property you’re considering and the numbers are worked out for you. Others can weigh in or say they’d like to partner.'),
    deals.length ? h('div', { class: 'grid deal-grid' }, deals.map(dealCard))
      : h('div', { class: 'card empty' }, 'No deals yet. Found a property worth a look? Tap “+ Add a deal” and run the numbers together.'));
}

function dealCard(d) {
  const m = dealMath(d);
  return h('article', { class: 'card deal-card', onclick: () => go(`#/real-estate/${d.id}`) },
    h('div', { class: 'deal-head' },
      h('h3', {}, d.title), h('span', { class: `chip deal-${d.status}` }, DEAL_STATUS_LABELS[d.status])),
    h('div', { class: 'small muted' }, [PROPERTY_LABELS[d.propertyType], d.location].filter(Boolean).join(' · ')),
    h('div', { class: 'deal-nums' },
      h('div', {}, h('b', {}, money(d.price)), h('span', {}, 'price')),
      h('div', { class: m.cashFlow >= 0 ? 'pos' : 'neg' }, h('b', {}, money(m.cashFlow)), h('span', {}, 'cash flow / mo')),
      h('div', {}, h('b', {}, pct(m.capRate)), h('span', {}, 'cap rate')),
      h('div', {}, h('b', {}, pct(m.cashOnCash)), h('span', {}, 'cash-on-cash'))),
    h('div', { class: 'deal-foot small muted' }, avatar(d.userId, 'sm'), userName(d.userId),
      d.partners.length ? ` · ${d.partners.length} interested` : '', d.commentCount ? ` · ${d.commentCount} comments` : ''));
}

function dealNumbers(d) {
  const m = dealMath(d);
  const row = (label, value, cls = '') => h('div', { class: `deal-row ${cls}` }, h('span', {}, label), h('b', {}, value));
  return h('div', { class: 'deal-calc' },
    row('Price', money(Number(d.price))),
    row(`Down payment (${Number(d.downPct) || 0}%)`, money(m.down)),
    row(`Loan payment (${Number(d.rate) || 0}%, ${Number(d.years) || 30} yrs)`, `${money(m.payment)} / mo`),
    row('Rent', `${money(Number(d.rent))} / mo`),
    row('Expenses', `${money(Number(d.expenses))} / mo`),
    row('Cash flow', `${money(m.cashFlow)} / mo`, m.cashFlow >= 0 ? 'pos total' : 'neg total'),
    row(`Cash to buy (with ${Number(d.closingPct) || 0}% closing)`, money(m.cashIn)),
    row('Cap rate', pct(m.capRate)),
    row('Cash-on-cash return', pct(m.cashOnCash)));
}

function openDealEditor(deal) {
  const v = deal ?? { downPct: 25, rate: 7, years: 30, closingPct: 3, status: 'looking', propertyType: 'single-family' };
  const preview = h('div', {});
  const numberField = (label, name, attrs = {}, hint) => field(label, h('input', { type: 'number', name, value: v[name], min: 0, step: 'any', inputmode: 'decimal', ...attrs }), hint);
  const formEl = form([
    field('Title', h('input', { type: 'text', name: 'title', required: true, maxlength: 120, value: v.title, placeholder: 'e.g. Duplex near downtown Santa Ana' })),
    h('div', { class: 'row' },
      field('Location', h('input', { type: 'text', name: 'location', maxlength: 200, value: v.location, placeholder: 'City or neighborhood' })),
      field('Type', h('select', { name: 'propertyType' }, Object.entries(PROPERTY_LABELS).map(([value, label]) => h('option', { value, selected: v.propertyType === value }, label))))),
    h('div', { class: 'row' },
      numberField('Price ($)', 'price', { required: true, step: 1000 }),
      numberField('Rent ($ / month)', 'rent', { step: 50 })),
    numberField('Expenses ($ / month)', 'expenses', { step: 25 }, 'Taxes, insurance, HOA, repairs, vacancy, and management.'),
    h('div', { class: 'row' },
      numberField('Down payment (%)', 'downPct', { max: 100 }),
      numberField('Interest rate (%)', 'rate', { max: 30, step: 0.125 })),
    h('div', { class: 'row' },
      numberField('Loan (years)', 'years', { min: 1, max: 40, step: 1 }),
      numberField('Closing costs (%)', 'closingPct', { max: 20, step: 0.5 })),
    h('h4', { class: 'deal-preview-title' }, 'The numbers'),
    preview,
    h('div', { class: 'row' },
      field('Status', h('select', { name: 'status' }, Object.entries(DEAL_STATUS_LABELS).map(([value, label]) => h('option', { value, selected: v.status === value }, label)))),
      field('Listing link', h('input', { type: 'url', name: 'link', maxlength: 500, value: v.link, placeholder: 'https://…' }))),
    field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 4000, value: v.notes, placeholder: 'Why it’s interesting, questions, what you’d need from partners…' })),
  ], {
    submitLabel: deal ? 'Save' : 'Add deal',
    onSubmit: async (data) => {
      const body = { ...data };
      for (const k of ['price', 'rent', 'expenses', 'downPct', 'rate', 'years', 'closingPct']) body[k] = Number(data[k] || 0);
      for (const k of ['price', 'rent', 'expenses', 'years']) body[k] = Math.round(body[k]);
      const res = await api(deal ? `/api/deals/${deal.id}` : '/api/deals', { method: deal ? 'PATCH' : 'POST', body });
      upsertDeal(res.deal);
      close();
      go(`#/real-estate/${res.deal.id}`);
      renderShell();
    },
  });
  const update = () => preview.replaceChildren(dealNumbers(Object.fromEntries(new FormData(formEl))));
  formEl.addEventListener('input', update);
  update();
  const close = openModal(deal ? 'Edit deal' : 'Add a deal', formEl, { wide: true });
}

async function openDeal(id) {
  let deal;
  try {
    ({ deal } = await api(`/api/deals/${id}`));
  } catch (err) {
    toast(err.message, 'error');
    return go('#/real-estate');
  }
  const isOwner = deal.userId === state.me.id;
  const interested = deal.partners.includes(state.me.id);
  const refresh = (d) => { upsertDeal(d); close(); openDeal(d.id); };
  const close = openModal(deal.title, h('div', {},
    h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap' },
      h('span', { class: `chip deal-${deal.status}` }, DEAL_STATUS_LABELS[deal.status]),
      h('span', { class: 'muted small' }, [PROPERTY_LABELS[deal.propertyType], deal.location].filter(Boolean).join(' · ')),
      h('span', { class: 'spacer' }),
      avatar(deal.userId, 'sm'), h('span', { class: 'small' }, userName(deal.userId))),
    h('div', { class: 'detail-block' }, h('h4', {}, 'The numbers'), dealNumbers(deal),
      h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Estimates only, not financial advice.')),
    deal.link && h('div', { class: 'detail-block' }, h('a', { href: deal.link, target: '_blank', rel: 'noopener noreferrer' }, 'View the listing →')),
    deal.notes && h('div', { class: 'detail-block' }, h('h4', {}, 'Notes'), h('p', { html: formatText(deal.notes) })),
    h('div', { class: 'detail-block' }, h('h4', {}, `Interested in partnering (${deal.partners.length})`),
      deal.partners.length ? h('div', { class: 'pipe-people' }, deal.partners.map((uid) => h('button', { class: 'pipe-person', onclick: () => { close(); startDm(uid); } }, avatar(uid, 'sm'), userName(uid))))
        : h('p', { class: 'muted', style: 'margin:0' }, 'No one yet.'),
      !isOwner && h('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
        h('button', { class: `btn small ${interested ? 'on' : 'primary'}`, onclick: async () => {
          try { refresh((await api(`/api/deals/${id}/partner`, { method: 'POST', body: { interested: !interested } })).deal); } catch (err) { toast(err.message, 'error'); }
        } }, interested ? '✓ You’re interested' : '🤝 I’d like to partner'),
        h('button', { class: 'btn small', onclick: () => { close(); startDm(deal.userId); } }, `Message ${userName(deal.userId).split(' ')[0]}`))),
    h('div', { class: 'detail-block' }, h('h4', {}, `Discussion (${deal.comments.length})`),
      deal.comments.map((c) => h('div', { class: 'comment' }, avatar(c.userId, 'sm'),
        h('div', {}, h('strong', {}, userName(c.userId)), h('span', { class: 'muted small' }, ` · ${shortDate(c.createdAt)}`),
          h('p', { html: formatText(c.body) })))),
      form([h('textarea', { name: 'body', rows: 2, required: true, maxlength: 2000, placeholder: 'Ask about the numbers, the area, or the plan…' })], {
        submitLabel: 'Comment',
        onSubmit: async (values) => refresh((await api(`/api/deals/${id}/comments`, { method: 'POST', body: values })).deal),
      })),
    (isOwner || state.me.role === 'admin') && h('div', { class: 'modal-foot', style: 'border-top:1px solid var(--border);padding-top:14px' },
      h('button', { class: 'btn danger ghost', onclick: async () => {
        if (!confirm('Delete this deal?')) return;
        await api(`/api/deals/${id}`, { method: 'DELETE' });
        upsertDeal({ id, deleted: true });
        close();
        renderShell();
      } }, 'Delete'),
      h('span', { class: 'spacer' }),
      isOwner && h('button', { class: 'btn', onclick: () => { close(); openDealEditor(deal); } }, 'Edit deal'))),
  {
    wide: true,
    onClose: () => {
      if (location.hash === `#/real-estate/${id}`) history.replaceState(null, '', '#/real-estate');
      state.route = parseRoute();
    },
  });
}

// ---------- offers & leads: from first conversation to client ----------

const LEAD_STAGES = [
  ['lead', 'New people', 'Someone you’ve met or been introduced to'],
  ['conversation', 'Talking', 'Coffee, a call, or a free AI look at what they do'],
  ['proposal', 'Offer made', 'You’ve shared how you could help and what it costs'],
  ['client', 'Working together', 'They said yes'],
  ['referral', 'Referring others', 'Happy, and introducing you to people they know'],
  ['not-now', 'Not now', 'Still a relationship, just not a client yet'],
];
const LEAD_LABELS = Object.fromEntries(LEAD_STAGES.map(([k, l]) => [k, l]));
const OPEN_STAGES = ['lead', 'conversation', 'proposal'];

// How we get leads: relationship first, by being the person who helps people with AI.
const LEAD_WAYS = [
  ['Start with people you know', 'Tell 20 people in your life what you now help with: friends, church, neighbors, past coworkers. Most first clients come from relationships you already have.'],
  ['Teach for free', 'Host a 45-minute “AI for everyday life and work” session at your church, a chamber of commerce, a library, or the Irvine workspace. Teaching makes you the AI person in the room.'],
  ['Share one helpful tip a week', 'Post something short and practical where people already are: LinkedIn, Instagram, Facebook groups, Nextdoor. Show, don’t hype.'],
  ['Offer a free AI look', 'Spend 30 minutes with someone looking at their week or their business and find three things AI could take off their plate. Many of these become clients, and all of them become relationships.'],
  ['Ask for introductions', 'Every person you help knows others like them. Ask, “Who else do you know who’s buried in this?”'],
  ['Refer each other', 'Know what the other members offer, and send people their way. Their offers are on the Offers tab.'],
];
const BRAND_TIPS = [
  'Be known for one thing first: “the AI guy for contractors in Orange County” is easier to remember than “I do AI stuff.”',
  'Use the same headline everywhere (LinkedIn, Instagram, your ACE profile, your email signature).',
  'Collect short stories: “He got 3 hours a week back.” Stories travel further than features.',
  'Be generous. Answer questions for free, and teach in public. Trust comes before the sale.',
];

// Ready-to-use examples members can copy and make their own.
const CONTENT_EXAMPLES = [
  {
    kind: 'LinkedIn or Facebook post', title: 'Hours back every week',
    text: `Last month a local contractor told me he spends every Sunday night writing estimates.

We set up a simple AI assistant that drafts them from his notes in a few minutes. He reviews, tweaks, and sends.

That's about 3 hours back every week, and he's spending them with his kids.

You don't need to be technical to use AI. You need someone to show you where it fits.

If you run a business and want to know where AI could save you time, send me a message. I'm happy to take a look, no charge.`,
  },
  {
    kind: 'Post for everyone', title: 'AI for everyday life',
    text: `Three ways I've seen AI help regular people this month (no tech skills needed):

1. A mom planned two weeks of dinners and a grocery list around her family's allergies in 5 minutes.
2. A friend rewrote his résumé for a specific job and landed the interview.
3. A retiree finally understood a confusing medical bill by asking AI to explain it in plain English.

If you've been curious about AI but don't know where to start, I'd love to show you. Message me, or come to the free session I'm hosting next week.`,
  },
  {
    kind: 'Free session invite', title: 'AI made simple',
    text: `Free session: AI made simple
[Day, date] · [time] · 43 Post, Irvine (or on Zoom)

In 45 minutes you'll see:
• 3 everyday tasks AI can take off your plate this week
• Which tools are worth using (and which aren't)
• A live demo, with your questions answered

For business owners, parents, and anyone curious. No tech background needed.
Reply or message me to save a seat.`,
  },
  {
    kind: '60-second video', title: 'Same five questions',
    text: `HOOK: "If you're still answering the same five questions by hand every day, watch this."

SHOW: Screen-record setting up an AI assistant that answers those questions from your own notes or website, in under a minute.

POINT: "That's about an hour a day back."

CALL: "Want me to look at where AI could help you? Message me."`,
  },
  {
    kind: 'Message to someone you know', title: 'Coffee, no pitch',
    text: `Hey [Name], hope you and the family are doing well. I've been helping people use AI to cut down on busywork (things like follow-ups, scheduling, and writing). Thought of you since you mentioned how much time [task] takes. Want to grab coffee and I'll show you what it could look like for you? No pitch, just ideas.`,
  },
  {
    kind: 'Follow-up after a free AI look', title: 'Three ideas',
    text: `Thanks for the time today, [Name]. Here are the three places I think AI could save you the most time:

1. ___
2. ___
3. ___

I'm happy to help you set up any of them. It usually takes about [timeframe] and costs [price]. Either way, I hope this helps.`,
  },
  {
    kind: 'Asking for an introduction', title: 'Who else?',
    text: `I'm really glad [result] is working for you. I'm looking to help a couple more people like you this month. Who's one person you know who's buried in [task]? A quick intro by text is perfect.`,
  },
];

async function leadRequest(path, method, body) {
  try {
    state.leads = (await api(path, { method, body })).leads;
    renderShell();
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function renderOffers() {
  const r = state.route;
  const tab = (key, href, label) => h('a', { class: `tab ${r.tab === key ? 'on' : ''}`, href, role: 'tab', 'aria-selected': String(r.tab === key) }, label);
  const actions = r.tab === 'leads' ? [h('button', { class: 'btn primary', onclick: () => openLeadEditor() }, '+ Add someone')]
    : r.tab === 'offers' ? [h('button', { class: 'btn primary', onclick: () => openOfferEditor() }, '+ Share an offer')] : [];
  return [
    topbar('Offers & leads', 'Help people with AI, build relationships, and grow from there', actions),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('div', { class: 'tabs', role: 'tablist' },
        tab('leads', '#/offers', 'My leads'), tab('offers', '#/offers/offers', 'Offers'), tab('get-leads', '#/offers/get-leads', 'Get leads')),
      r.tab === 'offers' ? offersBoard() : r.tab === 'get-leads' ? getLeadsGuide() : leadsBoard())),
  ];
}

function leadsBoard() {
  const leads = state.leads || [];
  const open = leads.filter((l) => OPEN_STAGES.includes(l.stage));
  const working = leads.filter((l) => l.stage === 'client' || l.stage === 'referral');
  const sum = (list) => list.reduce((n, l) => n + (l.value || 0), 0);
  const today = todayLocal();
  const due = leads.filter((l) => l.nextDate && l.nextDate <= today && l.stage !== 'not-now').length;
  const myOffers = (state.offers || []).filter((o) => o.userId === state.me.id);
  const card = (l) => {
    const i = LEAD_STAGES.findIndex(([k]) => k === l.stage);
    const next = LEAD_STAGES[i + 1] && i < 4 ? LEAD_STAGES[i + 1] : null;
    return h('article', { class: 'card lead-card', onclick: () => openLeadEditor(l) },
      h('strong', {}, l.name),
      (l.company || l.source) && h('div', { class: 'small muted' }, [l.company, l.source && `via ${l.source}`].filter(Boolean).join(' · ')),
      l.value > 0 && h('div', { class: 'small lead-value' }, money(l.value)),
      l.nextStep && h('div', { class: `small lead-next ${l.nextDate && l.nextDate <= today ? 'due' : ''}` },
        '→ ', l.nextStep, l.nextDate ? ` · ${shortDate(l.nextDate + 'T12:00:00')}` : ''),
      next && h('button', { class: 'btn small ghost lead-move', onclick: (e) => {
        e.stopPropagation();
        leadRequest(`/api/leads/${l.id}`, 'PATCH', { stage: next[0] });
      } }, `Move to ${next[1]} →`));
  };
  return h('div', { class: 'leads' },
    h('p', { class: 'muted intro' }, 'The people you’re helping with AI, from first conversation to working together. Relationships come first: every person here is someone to serve, not just a sale. 🔒 Only you can see this list.'),
    !myOffers.length && h('div', { class: 'card offer-nudge' },
      h('span', {}, 'Start by writing down your offer: who you help, the problem you solve, and what it costs.'),
      h('button', { class: 'btn small primary', onclick: () => openOfferEditor() }, 'Write your offer')),
    h('div', { class: 'five-meter' },
      h('div', { class: 'five-stat' }, h('b', {}, open.length), h('span', {}, 'in progress')),
      h('div', { class: 'five-stat' }, h('b', {}, money(sum(leads.filter((l) => l.stage === 'proposal')))), h('span', {}, 'in offers made')),
      h('div', { class: 'five-stat' }, h('b', {}, working.length), h('span', {}, 'working together')),
      h('div', { class: `five-stat ${due ? 'due' : ''}` }, h('b', {}, due), h('span', {}, 'follow-ups due'))),
    h('div', { class: 'lead-board' }, LEAD_STAGES.map(([key, label, hint]) => {
      const list = leads.filter((l) => l.stage === key);
      return h('section', { class: `lead-col ${key === 'not-now' ? 'quiet' : ''}` },
        h('div', { class: 'lead-col-head' }, h('strong', {}, label), h('span', { class: 'muted small' }, list.length)),
        h('div', { class: 'small muted lead-hint' }, hint),
        list.map(card),
        key === 'lead' && h('button', { class: 'card five-empty lead-add', onclick: () => openLeadEditor() }, '+ Add someone'));
    })));
}

function openLeadEditor(l) {
  const formEl = form([
    h('div', { class: 'row' },
      field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 120, value: l?.name })),
      field('Business or role', h('input', { type: 'text', name: 'company', maxlength: 120, value: l?.company, placeholder: 'Optional' }))),
    h('div', { class: 'row' },
      field('Where you met', h('input', { type: 'text', name: 'source', maxlength: 120, value: l?.source, placeholder: 'e.g. church, referral from Mark, workshop' })),
      field('Stage', h('select', { name: 'stage' }, LEAD_STAGES.map(([value, label]) => h('option', { value, selected: (l?.stage ?? 'lead') === value }, label))))),
    h('div', { class: 'row' },
      field('Next step', h('input', { type: 'text', name: 'nextStep', maxlength: 300, value: l?.nextStep, placeholder: 'e.g. Coffee to show the AI demo' })),
      field('By when', h('input', { type: 'date', name: 'nextDate', value: l?.nextDate ?? '' }))),
    field('Value ($)', h('input', { type: 'number', name: 'value', min: 0, step: 50, value: l?.value || '', placeholder: 'What the work is worth, if it goes ahead' })),
    field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 4000, value: l?.notes, placeholder: 'What they need, what you talked about, how to pray for them…' })),
  ], {
    submitLabel: l ? 'Save' : 'Add',
    onSubmit: async (data) => {
      const body = { ...data, value: Math.round(Number(data.value) || 0) };
      if (await leadRequest(l ? `/api/leads/${l.id}` : '/api/leads', l ? 'PATCH' : 'POST', body)) close();
    },
    extra: l ? [
      h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
        if (!confirm(`Remove ${l.name} from your leads?`)) return;
        if (await leadRequest(`/api/leads/${l.id}`, 'DELETE')) close();
      } }, 'Remove'),
      h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
        if (await fiveRequest('/api/five', 'POST', { name: l.name, context: l.company || l.source })) toast(`${l.name} is on your discipling list too`);
      } }, '♡ Also pray for & pursue'),
    ] : [],
  });
  const close = openModal(l ? l.name : 'Add someone', formEl);
}

function offersBoard() {
  const offers = state.offers || [];
  const mine = offers.filter((o) => o.userId === state.me.id);
  const others = offers.filter((o) => o.userId !== state.me.id);
  const card = (o) => h('article', { class: 'card offer-card', onclick: () => openOffer(o) },
    h('div', { class: 'deal-head' }, h('h3', {}, o.title), o.price && h('span', { class: 'chip' }, o.price)),
    o.audience && h('div', { class: 'small' }, h('b', {}, 'For: '), o.audience),
    o.result && h('p', { class: 'muted small', style: 'margin:0' }, o.result),
    h('div', { class: 'deal-foot small muted' }, avatar(o.userId, 'sm'), userName(o.userId)));
  return h('div', { class: 'offers' },
    h('p', { class: 'muted intro' }, 'What each of us offers. Know each other’s work so you can send people their way.'),
    h('h2', { class: 'section-title' }, 'Your offer'),
    mine.length ? h('div', { class: 'grid deal-grid' }, mine.map(card))
      : h('div', { class: 'card offer-nudge' },
        h('span', {}, 'A clear offer makes it easy for people to say yes, and for the group to refer you. For example: “I set up an AI assistant that answers your customers’ common questions and books appointments, so you get 5+ hours back a week. $1,500 setup.”'),
        h('button', { class: 'btn small primary', onclick: () => openOfferEditor() }, 'Write your offer')),
    h('h2', { class: 'section-title' }, 'Offers from the group'),
    others.length ? h('div', { class: 'grid deal-grid' }, others.map(card))
      : h('div', { class: 'card empty' }, 'No one else has shared an offer yet.'));
}

function openOffer(o) {
  const isMine = o.userId === state.me.id;
  const block = (title, text) => text && h('div', { class: 'detail-block' }, h('h4', {}, title), h('p', { html: formatText(text) }));
  const close = openModal(o.title, h('div', {},
    h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap' },
      o.price && h('span', { class: 'chip' }, o.price), avatar(o.userId, 'sm'), h('span', { class: 'small' }, userName(o.userId))),
    block('Who it’s for', o.audience), block('The problem', o.problem), block('The result', o.result), block('Details', o.details),
    h('div', { class: 'modal-foot' },
      (isMine || state.me.role === 'admin') && h('button', { class: 'btn ghost danger', onclick: async () => {
        if (!confirm('Delete this offer?')) return;
        try {
          await api(`/api/offers/${o.id}`, { method: 'DELETE' });
          state.offers = state.offers.filter((x) => x.id !== o.id);
          close();
          renderShell();
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Delete'),
      h('span', { class: 'spacer' }),
      isMine ? h('button', { class: 'btn primary', onclick: () => { close(); openOfferEditor(o); } }, 'Edit')
        : h('button', { class: 'btn primary', onclick: () => { close(); startDm(o.userId); } }, `Refer someone to ${userName(o.userId).split(' ')[0]}`))));
}

function openOfferEditor(o) {
  const formEl = form([
    field('Your offer in a few words', h('input', { type: 'text', name: 'title', required: true, maxlength: 120, value: o?.title, placeholder: 'e.g. AI front desk for small businesses' })),
    field('Who it’s for', h('input', { type: 'text', name: 'audience', maxlength: 300, value: o?.audience, placeholder: 'e.g. Home service businesses in Orange County' })),
    field('The problem you solve', h('textarea', { name: 'problem', rows: 2, maxlength: 1000, value: o?.problem, placeholder: 'e.g. Missed calls and slow replies cost them jobs and evenings' })),
    field('The result they get', h('textarea', { name: 'result', rows: 2, maxlength: 1000, value: o?.result, placeholder: 'e.g. Every call answered and booked, and 5+ hours back a week' })),
    field('Price', h('input', { type: 'text', name: 'price', maxlength: 120, value: o?.price, placeholder: 'e.g. $1,500 setup + $200/mo' })),
    field('Details', h('textarea', { name: 'details', rows: 3, maxlength: 4000, value: o?.details, placeholder: 'What’s included, how long it takes, any guarantee…' })),
  ], {
    submitLabel: o ? 'Save' : 'Share offer',
    onSubmit: async (data) => {
      const { offer } = await api(o ? `/api/offers/${o.id}` : '/api/offers', { method: o ? 'PATCH' : 'POST', body: data });
      state.offers = [offer, ...(state.offers || []).filter((x) => x.id !== offer.id)];
      close();
      renderShell();
    },
  });
  const close = openModal(o ? 'Edit your offer' : 'Share your offer', formEl);
}

function getLeadsGuide() {
  return h('div', { class: 'get-leads' },
    h('section', { class: 'card re-intro get-leads-intro' },
      h('div', {},
        h('h2', { class: 'serif' }, 'Be the one who introduces people to AI'),
        h('p', {}, 'Most people, in business and in everyday life, know AI matters but don’t know where to start. When you’re the one who helps them, you become their trusted AI expert. The relationships come first, and the leads follow.'))),
    h('h2', { class: 'section-title' }, 'Ways to get leads'),
    h('div', { class: 'grid re-strategies' }, LEAD_WAYS.map(([title, text], i) => h('article', { class: 'card' },
      h('div', { class: 'plan-num' }, `0${i + 1}`), h('h3', { style: 'font-size:15px;margin-top:4px' }, title),
      h('p', { class: 'muted small', style: 'margin:6px 0 0' }, text)))),
    h('h2', { class: 'section-title' }, 'Be known as the AI expert'),
    h('ul', { class: 'card brand-tips' }, BRAND_TIPS.map((t) => h('li', {}, t))),
    h('h2', { class: 'section-title' }, 'Content you can use'),
    h('p', { class: 'muted intro' }, 'Copy one, make it yours, and post it this week. Swap in real stories as soon as you have them.'),
    h('div', { class: 'content-grid' }, CONTENT_EXAMPLES.map((c) => {
      const pre = h('pre', { class: 'content-text' }, c.text);
      return h('article', { class: 'card content-card' },
        h('div', { class: 'deal-head' }, h('div', {}, h('div', { class: 'plan-num' }, c.kind), h('h3', { style: 'font-size:15px' }, c.title)),
          h('button', { class: 'btn small', onclick: () => copyText(c.text) }, 'Copy')),
        pre);
    })),
    h('p', { class: 'small muted' }, 'Have a post or invite that worked? Share it in #ai-tools-and-content so others can use it too.'));
}

// ---------- suggestions ----------

let suggestionSort = 'top';
let suggestionFilter = 'active';

function upsertSuggestion(x) {
  if (!state.suggestions) return;
  if (x.deleted) {
    state.suggestions = state.suggestions.filter((s) => s.id !== x.id);
    return;
  }
  const { comments, ...summary } = x;
  const i = state.suggestions.findIndex((s) => s.id === x.id);
  // Broadcasts don't know who is viewing, so work out "voted" locally.
  const merged = { ...summary, voted: summary.voters.includes(state.me.id) };
  if (i >= 0) state.suggestions[i] = merged; else state.suggestions.unshift(merged);
}

async function voteSuggestion(x) {
  try {
    const { suggestion } = await api(`/api/suggestions/${x.id}/vote`, { method: 'POST', body: { vote: !x.voted } });
    upsertSuggestion(suggestion);
    if (!document.querySelector('.modal-backdrop')) renderShell();
    return suggestion;
  } catch (err) { toast(err.message, 'error'); }
}

function voteButton(x, onVoted) {
  return h('button', {
    class: `vote ${x.voted ? 'on' : ''}`, 'aria-pressed': x.voted ? 'true' : 'false',
    title: x.voted ? 'Remove your vote' : 'Vote for this',
    onclick: async (e) => { e.stopPropagation(); const updated = await voteSuggestion(x); if (updated) onVoted?.(updated); },
  }, h('span', { class: 'arrow' }, '▲'), h('span', {}, x.votes));
}

function suggestionRow(x) {
  return h('article', { class: 'card suggestion', onclick: () => go(`#/suggestions/${x.id}`) },
    voteButton(x),
    h('div', { class: 'suggestion-main' },
      h('div', { class: 'suggestion-head' }, h('h3', {}, x.title), h('span', { class: `chip s-${x.status}` }, SUGGESTION_LABELS[x.status])),
      x.details && h('p', { class: 'muted' }, x.details.length > 180 ? `${x.details.slice(0, 180)}…` : x.details),
      h('div', { class: 'foot' }, avatar(x.userId, 'sm'), h('span', {}, userName(x.userId)),
        h('span', {}, `· ${shortDate(x.createdAt)}`), h('span', { class: 'grow' }), h('span', {}, `💬 ${x.commentCount}`))));
}

function renderSuggestions() {
  const all = state.suggestions || [];
  const filters = [['active', 'Open & planned'], ['done', 'Done'], ['not-now', 'Not now'], ['all', 'All']];
  const shown = all
    .filter((x) => suggestionFilter === 'all' || (suggestionFilter === 'active' ? ['open', 'planned'].includes(x.status) : x.status === suggestionFilter))
    .sort((a, b) => (suggestionSort === 'top' ? b.votes - a.votes || b.id - a.id : b.id - a.id));
  if (state.route.id) afterRenderHooks.push(() => openSuggestion(state.route.id));

  const title = h('input', { type: 'text', name: 'title', id: 'suggestion-title', required: true, maxlength: 140, placeholder: 'e.g. Monthly prayer and fasting day for our businesses' });
  const details = h('textarea', { name: 'details', id: 'suggestion-details', rows: 2, maxlength: 2000, placeholder: 'Add details (optional)' });

  return [
    topbar('Suggestions', 'Ideas for what we could do together. Vote up the ones you want to see.'),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      h('div', { class: 'card suggest-box' },
        h('h2', { style: 'font-size:16px;margin-bottom:10px' }, 'Have an idea for the network?'),
        form([title, details], {
          submitLabel: 'Post suggestion',
          onSubmit: async (values) => {
            const { suggestion } = await api('/api/suggestions', { method: 'POST', body: values });
            upsertSuggestion(suggestion);
            suggestionFilter = 'active';
            suggestionSort = 'new';
            renderShell();
            toast('Suggestion posted');
          },
        })),
      h('div', { class: 'toolbar' },
        h('div', { class: 'tags' }, filters.map(([key, label]) => h('button', {
          class: `btn small ${suggestionFilter === key ? 'on' : ''}`, onclick: () => { suggestionFilter = key; renderShell(); },
        }, label))),
        h('div', { class: 'tags' }, [['top', 'Most votes'], ['new', 'Newest']].map(([key, label]) => h('button', {
          class: `btn small ghost ${suggestionSort === key ? 'on' : ''}`, onclick: () => { suggestionSort = key; renderShell(); },
        }, label)))),
      shown.length ? h('div', { class: 'suggestion-list' }, shown.map(suggestionRow))
        : h('div', { class: 'card empty' }, all.length ? 'Nothing here yet.' : 'No suggestions yet. Share the first idea above!'))),
  ];
}

async function openSuggestion(id) {
  let x;
  try {
    ({ suggestion: x } = await api(`/api/suggestions/${id}`));
  } catch (err) {
    toast(err.message, 'error');
    return go('#/suggestions');
  }
  const isOwner = x.userId === state.me.id;
  const isAdmin = state.me.role === 'admin';
  const refresh = (updated) => { upsertSuggestion(updated); openSuggestion(updated.id); };

  const statusPicker = isAdmin && h('div', { class: 'detail-block' }, h('h4', {}, 'Status (admins)'),
    h('div', { class: 'tags' }, Object.entries(SUGGESTION_LABELS).map(([value, label]) => h('button', {
      class: `btn small ${x.status === value ? 'on' : ''}`,
      onclick: async () => {
        try {
          refresh((await api(`/api/suggestions/${id}`, { method: 'PATCH', body: { status: value } })).suggestion);
        } catch (err) { toast(err.message, 'error'); }
      },
    }, label))));

  const close = openModal(x.title, h('div', {},
    h('div', { class: 'suggestion-meta' },
      voteButton(x, refresh),
      h('span', { class: `chip s-${x.status}` }, SUGGESTION_LABELS[x.status]),
      avatar(x.userId, 'sm'), h('span', {}, userName(x.userId)), h('span', { class: 'muted small' }, `· ${shortDate(x.createdAt)}`)),
    x.details && h('div', { class: 'detail-block' }, h('p', { html: formatText(x.details) })),
    x.voters.length > 0 && h('div', { class: 'detail-block' }, h('h4', {}, `Supported by (${x.voters.length})`),
      h('div', { class: 'small muted' }, x.voters.map(userName).join(', '))),
    statusPicker,
    h('div', { class: 'detail-block' }, h('h4', {}, `Discussion (${x.comments.length})`),
      x.comments.map((c) => h('div', { class: 'comment' }, avatar(c.userId, 'sm'),
        h('div', {}, h('strong', {}, userName(c.userId)), h('span', { class: 'muted small' }, ` · ${shortDate(c.createdAt)}`),
          h('p', { html: formatText(c.body) })))),
      form([h('textarea', { name: 'body', rows: 2, required: true, maxlength: 2000, placeholder: 'Add a thought or a way to make this happen…' })], {
        submitLabel: 'Comment',
        onSubmit: async (values) => refresh((await api(`/api/suggestions/${id}/comments`, { method: 'POST', body: values })).suggestion),
      })),
    (isOwner || isAdmin) && h('div', { class: 'modal-foot', style: 'border-top:1px solid var(--border);padding-top:14px' },
      h('button', { class: 'btn danger ghost', onclick: async () => {
        if (!confirm('Delete this suggestion?')) return;
        await api(`/api/suggestions/${id}`, { method: 'DELETE' });
        upsertSuggestion({ id, deleted: true });
        close();
        renderShell();
      } }, 'Delete'),
      h('span', { class: 'spacer' }),
      isOwner && h('button', { class: 'btn', onclick: () => editSuggestion(x) }, 'Edit'))),
  {
    wide: true,
    onClose: () => {
      if (location.hash === `#/suggestions/${id}`) history.replaceState(null, '', '#/suggestions');
      state.route = parseRoute();
      renderShell();
    },
  });
}

function editSuggestion(x) {
  openModal('Edit suggestion', form([
    field('Suggestion', h('input', { type: 'text', name: 'title', id: 'edit-suggestion-title', required: true, maxlength: 140, value: x.title })),
    field('Details', h('textarea', { name: 'details', id: 'edit-suggestion-details', rows: 4, maxlength: 2000, value: x.details })),
  ], {
    submitLabel: 'Save',
    onSubmit: async (values) => {
      const { suggestion } = await api(`/api/suggestions/${x.id}`, { method: 'PATCH', body: values });
      upsertSuggestion(suggestion);
      openSuggestion(x.id);
    },
  }));
}

// ---------- what's working ----------

// A built-in framework shown above members' blueprints.
const ANATOMY = [
  ['A real problem and a clear customer', 'Who pays, and what pain are you removing? Narrow beats broad: “dental offices that miss calls” beats “small businesses.”'],
  ['A simple offer and price', 'One thing you sell, priced so a few customers cover your needs. Recurring (monthly) pricing buys back the most time.'],
  ['One reliable way to find customers', 'Referrals, one content channel, partnerships, or direct outreach. Master one before adding another.'],
  ['Delivery that AI and automation do most of', 'Map every step of delivering the work. Let AI draft, automations move data, and keep your judgment for review.'],
  ['Systems that run without you', 'Written processes, templates, and help where needed, so the business does not stop when you step away for church, family, or rest.'],
  ['Know your numbers, especially hours', 'Track monthly revenue, costs, and hours per week. The number that matters most here is hours.'],
  ['Redeem the time on purpose', 'Decide ahead of time where freed hours go: God, family, serving, ministry. Otherwise the business quietly takes them back.'],
];
const MODELS = [
  ['AI automation for local businesses', 'Set up AI receptionists, follow-ups, and booking flows for service businesses on a monthly retainer.'],
  ['Content repurposing service', 'Turn one sermon, podcast, or video into clips, posts, and newsletters for churches, ministries, or creators.'],
  ['Niche micro-tool or SaaS', 'A small, focused app that solves one job for one audience and runs mostly on its own.'],
  ['Done-for-you chatbots', 'Custom assistants trained on an organization’s own material for churches, nonprofits, or clinics.'],
  ['Courses and templates', 'Package what you know into a course, prompt pack, or template library that sells while you sleep.'],
];

let workingSort = 'helpful';

function upsertPlaybook(x) {
  if (!state.playbooks) return;
  if (x.deleted) {
    state.playbooks = state.playbooks.filter((p) => p.id !== x.id);
    return;
  }
  const { comments, ...summary } = x;
  const merged = { ...summary, voted: summary.voters.includes(state.me.id) };
  const i = state.playbooks.findIndex((p) => p.id === x.id);
  if (i >= 0) state.playbooks[i] = merged; else state.playbooks.unshift(merged);
}

function helpfulButton(x, onVoted) {
  return h('button', {
    class: `btn small helpful ${x.voted ? 'on' : ''}`, 'aria-pressed': x.voted ? 'true' : 'false',
    onclick: async (e) => {
      e.stopPropagation();
      try {
        const { playbook } = await api(`/api/playbooks/${x.id}/vote`, { method: 'POST', body: { vote: !x.voted } });
        upsertPlaybook(playbook);
        if (onVoted) onVoted(playbook); else renderShell();
      } catch (err) { toast(err.message, 'error'); }
    },
  }, `🙌 Helpful · ${x.votes}`);
}

function caseStats(x) {
  return h('div', { class: 'stat-chips' },
    x.hoursPerWeek != null && h('span', { class: 'stat-chip hours' }, h('b', {}, x.hoursPerWeek), ' hrs/week'),
    x.revenue && h('span', { class: 'stat-chip' }, REVENUE_LABELS[x.revenue]),
    x.customer && h('span', { class: 'stat-chip' }, `For: ${x.customer}`));
}

function playbookCard(x) {
  const tab = x.kind === 'blueprint' ? 'blueprints' : 'cases';
  const steps = x.steps.split('\n').map((t) => t.trim()).filter(Boolean);
  return h('article', { class: 'card playbook-card', onclick: () => go(`#/working/${tab}/${x.id}`) },
    h('h3', {}, x.title),
    x.kind === 'case' && caseStats(x),
    x.summary && h('p', { class: 'muted desc' }, x.summary),
    x.kind === 'blueprint' && steps.length > 0 && h('p', { class: 'small muted' }, `${steps.length} steps`),
    x.timeFreed && h('div', { class: 'freed' }, h('b', {}, 'Time given back: '), x.timeFreed),
    h('div', { class: 'foot' }, avatar(x.userId, 'sm'), h('span', { class: 'grow' }, userName(x.userId)),
      helpfulButton(x), h('span', {}, `💬 ${x.commentCount}`)));
}

function renderWorking() {
  const r = state.route;
  const tab = r.tab;
  const items = (state.playbooks || []).filter((x) => x.kind === (tab === 'blueprints' ? 'blueprint' : 'case'));
  const sorters = {
    helpful: (a, b) => b.votes - a.votes || b.id - a.id,
    newest: (a, b) => b.id - a.id,
    hours: (a, b) => (a.hoursPerWeek ?? 999) - (b.hoursPerWeek ?? 999),
  };
  const sorts = tab === 'cases' ? [['helpful', 'Most helpful'], ['hours', 'Fewest hours'], ['newest', 'Newest']] : [['helpful', 'Most helpful'], ['newest', 'Newest']];
  if (!sorts.some(([k]) => k === workingSort)) workingSort = 'helpful';
  items.sort(sorters[workingSort]);
  if (r.id) afterRenderHooks.push(() => openPlaybook(r.id));

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('a', { class: `tab ${tab === 'cases' ? 'on' : ''}`, href: '#/working', role: 'tab', 'aria-selected': String(tab === 'cases') }, 'Working businesses'),
    h('a', { class: `tab ${tab === 'blueprints' ? 'on' : ''}`, href: '#/working/blueprints', role: 'tab', 'aria-selected': String(tab === 'blueprints') }, 'Blueprints'));

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'tags' }, sorts.map(([key, label]) => h('button', {
      class: `btn small ghost ${workingSort === key ? 'on' : ''}`, onclick: () => { workingSort = key; renderShell(); },
    }, label))),
    h('button', { class: 'btn primary', onclick: () => openPlaybookEditor(tab === 'blueprints' ? 'blueprint' : 'case') },
      tab === 'blueprints' ? '+ Share a blueprint' : '+ Share a working business'));

  const casesIntro = h('p', { class: 'muted intro' },
    'Real ventures from members that are working. Every one lists hours per week, because the point is time given back, not just income.');
  const blueprintIntro = [
    h('section', { class: 'card anatomy' },
      h('h2', { class: 'serif' }, 'Anatomy of a working AI business'),
      h('p', { class: 'muted' }, 'The structure most working ventures in this network share. Use it as a checklist for your own.'),
      h('ol', {}, ANATOMY.map(([t, d]) => h('li', {}, h('strong', {}, t), h('span', { class: 'muted' }, d))))),
    h('section', {},
      h('h2', { class: 'section-title' }, 'Common models to study'),
      h('div', { class: 'grid models' }, MODELS.map(([t, d]) => h('div', { class: 'card' }, h('h3', {}, t), h('p', { class: 'muted small' }, d))))),
    h('h2', { class: 'section-title' }, 'Blueprints from members'),
  ];

  return [
    topbar('What’s working', 'Working businesses and the structures behind them'),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      tabs,
      tab === 'cases' ? casesIntro : blueprintIntro,
      toolbar,
      items.length ? h('div', { class: 'grid' }, items.map(playbookCard))
        : h('div', { class: 'card empty' }, tab === 'cases'
          ? 'No working businesses shared yet. If yours is working, even a little, share it so others can learn.'
          : 'No member blueprints yet. Share the step-by-step process behind something that works for you.'))),
  ];
}

function openPlaybookEditor(kind, x) {
  const isCase = kind === 'case';
  const fields = isCase ? [
    field('Business name or one-line description', h('input', { type: 'text', id: 'pb-title', name: 'title', required: true, maxlength: 120, value: x?.title, placeholder: 'e.g. AI receptionist for dental offices' })),
    field('How it works', h('textarea', { id: 'pb-summary', name: 'summary', rows: 3, maxlength: 2000, value: x?.summary, placeholder: 'What you do, and what AI handles for you' })),
    h('div', { class: 'row' },
      field('Who pays', h('input', { type: 'text', id: 'pb-customer', name: 'customer', maxlength: 300, value: x?.customer, placeholder: 'e.g. Small dental practices' })),
      field('Offer and price', h('input', { type: 'text', id: 'pb-offer', name: 'offer', maxlength: 500, value: x?.offer, placeholder: 'e.g. $300/month setup + support' }))),
    field('How customers find you', h('input', { type: 'text', id: 'pb-acq', name: 'acquisition', maxlength: 500, value: x?.acquisition, placeholder: 'e.g. Referrals and local Facebook groups' })),
    field('Tools you use', h('input', { type: 'text', id: 'pb-tools', name: 'tools', maxlength: 300, value: x?.tools, placeholder: 'e.g. ChatGPT, Zapier, Vapi, Stripe' })),
    h('div', { class: 'row' },
      field('Hours per week', h('input', { type: 'number', id: 'pb-hours', name: 'hoursPerWeek', min: 0, max: 100, value: x?.hoursPerWeek ?? '', placeholder: 'e.g. 6' }), 'Your own time, roughly'),
      field('Monthly revenue', h('select', { id: 'pb-revenue', name: 'revenue' }, Object.entries(REVENUE_LABELS).map(([v, l]) => h('option', { value: v, selected: (x?.revenue ?? '') === v }, l))), 'Optional')),
    field('Where the freed time goes', h('input', { type: 'text', id: 'pb-freed', name: 'timeFreed', maxlength: 500, value: x?.timeFreed, placeholder: 'e.g. Home by 3pm with my kids, leading a Tuesday Bible study' })),
    field('Steps to replicate it (one per line)', h('textarea', { id: 'pb-steps', name: 'steps', rows: 4, maxlength: 4000, value: x?.steps }), 'Optional'),
  ] : [
    field('Blueprint name', h('input', { type: 'text', id: 'pb-title', name: 'title', required: true, maxlength: 120, value: x?.title, placeholder: 'e.g. Landing your first 3 local clients' })),
    field('What it helps you do', h('textarea', { id: 'pb-summary', name: 'summary', rows: 2, maxlength: 2000, value: x?.summary })),
    field('Steps (one per line)', h('textarea', { id: 'pb-steps', name: 'steps', rows: 8, maxlength: 4000, required: true, value: x?.steps, placeholder: 'Pick one niche you already know\nInterview 5 owners about their biggest time drain\n…' })),
    field('Tools', h('input', { type: 'text', id: 'pb-tools', name: 'tools', maxlength: 300, value: x?.tools })),
  ];
  const close = openModal(x ? 'Edit' : isCase ? 'Share a working business' : 'Share a blueprint', form(fields, {
    submitLabel: x ? 'Save changes' : 'Share',
    onSubmit: async (values) => {
      const body = { ...values, kind };
      const res = x
        ? await api(`/api/playbooks/${x.id}`, { method: 'PATCH', body })
        : await api('/api/playbooks', { method: 'POST', body });
      upsertPlaybook(res.playbook);
      close();
      const path = `#/working/${isCase ? 'cases' : 'blueprints'}/${res.playbook.id}`;
      if (location.hash === path) openPlaybook(res.playbook.id); else go(path);
    },
  }), { wide: true });
}

async function openPlaybook(id) {
  let x;
  try {
    ({ playbook: x } = await api(`/api/playbooks/${id}`));
  } catch (err) {
    toast(err.message, 'error');
    return go('#/working');
  }
  const isOwner = x.userId === state.me.id;
  const refresh = (updated) => { upsertPlaybook(updated); openPlaybook(updated.id); };
  const steps = x.steps.split('\n').map((t) => t.trim()).filter(Boolean);
  const detail = (label, value) => value && h('div', { class: 'detail-block' }, h('h4', {}, label), h('p', { html: formatText(value) }));
  const tabPath = x.kind === 'blueprint' ? '#/working/blueprints' : '#/working';

  const close = openModal(x.title, h('div', {},
    h('div', { class: 'suggestion-meta' },
      h('span', { class: 'chip' }, x.kind === 'blueprint' ? 'Blueprint' : 'Working business'),
      avatar(x.userId, 'sm'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); close(); openMemberProfile(x.userId); } }, userName(x.userId)),
      h('span', { class: 'muted small' }, `· updated ${shortDate(x.updatedAt)}`)),
    x.kind === 'case' && caseStats(x),
    detail(x.kind === 'case' ? 'How it works' : 'What it helps you do', x.summary),
    detail('Offer and price', x.offer),
    detail('How customers find them', x.acquisition),
    detail('Tools', x.tools),
    x.timeFreed && h('div', { class: 'freed', style: 'margin-bottom:18px' }, h('b', {}, 'Time given back: '), x.timeFreed),
    steps.length > 0 && h('div', { class: 'detail-block' }, h('h4', {}, 'Steps'), h('ol', { class: 'steps' }, steps.map((t) => h('li', {}, t)))),
    h('div', { class: 'detail-block', style: 'display:flex;gap:8px;flex-wrap:wrap' },
      helpfulButton(x, refresh),
      !isOwner && h('button', { class: 'btn small', onclick: () => startDm(x.userId) }, `Message ${userName(x.userId).split(' ')[0]}`)),
    h('div', { class: 'detail-block' }, h('h4', {}, `Questions & discussion (${x.comments.length})`),
      x.comments.map((c) => h('div', { class: 'comment' }, avatar(c.userId, 'sm'),
        h('div', {}, h('strong', {}, userName(c.userId)), h('span', { class: 'muted small' }, ` · ${shortDate(c.createdAt)}`),
          h('p', { html: formatText(c.body) })))),
      form([h('textarea', { name: 'body', rows: 2, required: true, maxlength: 2000, placeholder: 'Ask how they did it, or share what worked for you…' })], {
        submitLabel: 'Comment',
        onSubmit: async (values) => refresh((await api(`/api/playbooks/${id}/comments`, { method: 'POST', body: values })).playbook),
      })),
    (isOwner || state.me.role === 'admin') && h('div', { class: 'modal-foot', style: 'border-top:1px solid var(--border);padding-top:14px' },
      h('button', { class: 'btn danger ghost', onclick: async () => {
        if (!confirm('Delete this?')) return;
        await api(`/api/playbooks/${id}`, { method: 'DELETE' });
        upsertPlaybook({ id, deleted: true });
        close();
      } }, 'Delete'),
      h('span', { class: 'spacer' }),
      isOwner && h('button', { class: 'btn', onclick: () => openPlaybookEditor(x.kind, x) }, 'Edit'))),
  {
    wide: true,
    onClose: () => {
      if (location.hash.startsWith('#/working/') && /\/\d+$/.test(location.hash)) history.replaceState(null, '', tabPath);
      state.route = parseRoute();
      renderShell();
    },
  });
}

// ---------- calls ----------

function callCard(call, { limit = 3 } = {}) {
  const isAdmin = state.me.role === 'admin';
  const next = call.occurrences[0];
  const d = new Date(next.startsAt);
  return h('article', { class: 'card call-card' },
    h('div', { class: 'call-when' },
      h('div', { class: 'cal' }, h('div', { class: 'm' }, d.toLocaleDateString([], { month: 'short' })), h('div', { class: 'd' }, d.getDate())),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', { style: 'font-size:17px' }, call.title),
        h('div', { class: 'muted small' }, [
          call.frequency === 'once' || call.frequency === 'quarterly'
            ? `${call.frequency === 'quarterly' ? 'Every three months · next ' : ''}${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`
            : `${FREQ_LABELS[call.frequency]} · ${d.toLocaleDateString([], { weekday: 'long' })}s`,
          ` at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} · ${call.durationMin} min`,
        ].join(''))),
      isAdmin && h('button', { class: 'btn small ghost', onclick: () => openCallEditor(call) }, 'Edit')),
    call.description && h('p', { style: 'margin:0', html: formatText(call.description) }),
    h('div', { class: 'occ-list' }, call.occurrences.slice(0, limit).map((o) => {
      const going = o.rsvps.includes(state.me.id);
      const start = new Date(o.startsAt);
      const live = Date.now() >= start && Date.now() <= start.getTime() + call.durationMin * 60_000;
      return h('div', { class: 'occ' },
        h('div', { class: 'grow' },
          live && h('span', { class: 'live' }, '● Live now '),
          h('strong', {}, start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })),
          h('span', { class: 'muted' }, ` · ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
          o.rsvps.length > 0 && h('div', { class: 'small muted', style: 'display:flex;align-items:center;gap:6px;margin-top:4px' },
            h('div', { class: 'avatars' }, o.rsvps.slice(0, 6).map((id) => avatar(id, 'sm'))),
            `${o.rsvps.length} going`)),
        h('button', { class: `btn small ${going ? 'on' : ''}`, onclick: () => rsvp(call, o, !going) }, going ? '✓ Going' : 'RSVP'),
        call.link && h('a', { class: `btn small ${live ? 'primary' : ''}`, href: call.link, target: '_blank', rel: 'noopener noreferrer' }, 'Join call'));
    })));
}

async function rsvp(call, o, going) {
  try {
    const res = await api(`/api/calls/${call.id}/rsvp`, { method: 'POST', body: { occurrence: o.occurrence, going } });
    state.calls = state.calls.map((c) => (c.id === call.id ? res.call : c));
    renderShell();
  } catch (err) { toast(err.message, 'error'); }
}

function renderCalls() {
  const calls = state.calls || [];
  const isAdmin = state.me.role === 'admin';
  return [
    topbar('Community calls', 'Zoom calls every other week and quarterly gatherings.',
      isAdmin ? [h('button', { class: 'btn primary', onclick: () => openCallEditor() }, '+ Schedule call')] : []),
    h('div', { class: 'page' }, h('div', { class: 'page-inner', style: 'display:grid;gap:16px' },
      rhythmCard(),
      calls.length ? calls.map((c) => callCard(c))
        : h('div', { class: 'card empty' }, isAdmin ? 'No calls scheduled yet. Use “Schedule call” to set up the every-other-week call and the quarterly gatherings.' : 'No calls scheduled yet. An admin will post the next one soon.'),
      workspaceCard())),
  ];
}

function rhythmCard() {
  return h('section', { class: 'card rhythm-card' },
    h('h3', {}, 'Our rhythm'),
    h('p', {}, 'We explore big questions about God and life, workshop business problems and real conversations, pray, and encourage our own growth in Christ. Between calls, keep the conversation going in the channels, and at the next call we follow up on what happened.'),
    h('p', { class: 'small muted' }, PLAN.commitment));
}

// Where we can meet in person.
const WORKSPACE_ADDRESS = '43 Post, Irvine, CA 92618';

function workspaceCard() {
  return h('div', { class: 'card workspace-card' },
    h('div', { class: 'workspace-icon', 'aria-hidden': 'true' }, '⌂'),
    h('div', { class: 'grow' },
      h('h3', {}, 'Our workspace'),
      h('p', {}, 'A place to meet and work together in person: ', h('strong', {}, WORKSPACE_ADDRESS), '.'),
      h('p', { class: 'muted small' }, 'Ask Jake about hours and access.')),
    h('a', {
      class: 'btn small', target: '_blank', rel: 'noopener',
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(WORKSPACE_ADDRESS)}`,
    }, 'Directions'));
}

function openCallEditor(call) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserTz];
  const tz = call?.timezone ?? browserTz;
  if (!zones.includes(tz)) zones.unshift(tz);
  const today = new Date().toLocaleDateString('en-CA');

  const close = openModal(call ? 'Edit call' : 'Schedule a call', form([
    field('Title', h('input', { type: 'text', name: 'title', required: true, maxlength: 120, value: call?.title ?? 'Community Call' })),
    field('Description', h('textarea', { name: 'description', maxlength: 2000, rows: 3, value: call?.description, placeholder: 'Prayer, member wins, a short teaching on an AI tool, and open Q&A.' })),
    h('div', { class: 'row' },
      field('Repeats', h('select', { name: 'frequency' }, Object.entries(FREQ_LABELS).map(([value, label]) => h('option', { value, selected: (call?.frequency ?? 'biweekly') === value }, label)))),
      field('Length (minutes)', h('input', { type: 'number', name: 'durationMin', min: 5, max: 600, value: call?.durationMin ?? 60, required: true }))),
    h('div', { class: 'row' },
      field('First call date', h('input', { type: 'date', name: 'startDate', required: true, value: call?.startDate ?? today })),
      field('Time', h('input', { type: 'time', name: 'startTime', required: true, value: call?.startTime ?? '19:00' }))),
    field('Timezone', h('select', { name: 'timezone' }, zones.map((z) => h('option', { value: z, selected: z === tz }, z.replace(/_/g, ' '))))),
    field('Meeting link', h('input', { type: 'url', name: 'link', maxlength: 500, value: call?.link, placeholder: 'https://zoom.us/j/… or https://meet.google.com/…' })),
  ], {
    submitLabel: call ? 'Save call' : 'Schedule call',
    extra: call ? [h('button', { type: 'button', class: 'btn danger ghost', onclick: async () => {
      if (!confirm('Delete this call series?')) return;
      await api(`/api/calls/${call.id}`, { method: 'DELETE' });
      await loadCalls();
      close();
      renderShell();
    } }, 'Delete'), h('span', { class: 'spacer' })] : [],
    onSubmit: async (values) => {
      values.durationMin = Number(values.durationMin);
      await api(call ? `/api/calls/${call.id}` : '/api/calls', { method: call ? 'PATCH' : 'POST', body: values });
      await loadCalls();
      close();
      if (state.route.name !== 'calls') go('#/calls'); else renderShell();
    },
  }));
}

async function loadCalls() {
  state.calls = (await api('/api/calls')).calls;
}

// ---------- members ----------

let memberQuery = '';

function renderMembers() {
  const search = h('input', { type: 'search', placeholder: 'Search by name, skill, or ministry…', value: memberQuery });
  const grid = h('div', { class: 'grid' });
  const draw = () => {
    const q = memberQuery.toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => [u.name, u.headline, u.skills, u.ministry, u.bio].join(' ').toLowerCase().includes(q))
      .sort((a, b) => Number(state.online.has(b.id)) - Number(state.online.has(a.id)) || a.name.localeCompare(b.name));
    grid.replaceChildren(...(people.length ? people.map((u) => h('article', { class: 'card member-card', onclick: () => openMemberProfile(u.id) },
      avatar(u.id),
      h('div', { style: 'min-width:0' },
        h('h3', {}, u.name, state.online.has(u.id) && h('span', { class: 'dot on', title: 'Online' }), u.role === 'admin' && h('span', { class: 'chip' }, 'Admin'),
          u.stage === 'guest' && h('span', { class: 'chip s-open' }, 'Experiencing the group')),
        u.headline && h('p', { class: 'muted' }, u.headline),
        u.skills && h('p', { class: 'small' }, h('b', {}, 'Skills: '), u.skills),
        u.ministry && h('p', { class: 'small' }, h('b', {}, 'Ministry: '), u.ministry)))) : [h('div', { class: 'card empty' }, 'No members match your search.')]));
  };
  search.addEventListener('input', () => { memberQuery = search.value; draw(); });
  draw();
  const isAdmin = state.me.role === 'admin';
  const invites = isAdmin && h('section', { class: 'invites', id: 'invites' }, h('p', { class: 'muted small' }, 'Loading invites…'));
  if (isAdmin) afterRenderHooks.push(loadInvites);
  return [
    topbar('Members', memberCounts(),
      isAdmin ? [h('button', { class: 'btn primary', onclick: openInviteForm }, '+ Invite someone')] : []),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' },
      invites,
      h('div', { style: 'margin-bottom:16px' }, search), grid)),
  ];
}

function memberCounts() {
  const guests = [...state.users.values()].filter((u) => u.stage === 'guest').length;
  const committed = state.users.size - guests;
  return `${committed} committed for the year${guests ? ` · ${guests} experiencing the group` : ''} · invite-only`;
}

// ---------- invites (admins) ----------

const inviteUrl = (token) => `${location.origin}/#/join/${token}`;

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    input?.select();
    toast('Press and hold to copy');
  }
}

async function loadInvites() {
  const box = document.getElementById('invites');
  if (!box) return;
  let invites;
  try {
    ({ invites } = await api('/api/invites'));
  } catch (err) {
    box.replaceChildren(h('p', { class: 'error-text' }, err.message));
    return;
  }
  let groupCode = '';
  try { ({ code: groupCode } = await api('/api/invite-code')); } catch { /* shown as off */ }
  const pending = invites.filter((i) => i.status === 'pending');
  const past = invites.filter((i) => i.status !== 'pending').slice(0, 10);
  const statusText = { joined: 'Joined', expired: 'Expired', cancelled: 'Cancelled' };
  const codeCard = h('div', { class: 'card code-card' },
    h('div', { class: 'grow' },
      h('strong', {}, 'Group join link'),
      groupCode
        ? [h('div', { class: 'small muted' }, 'Anyone with this link can join. No code to type, they just create an account.'),
          h('div', { class: 'join-link' }, joinLinkFor(groupCode)),
          h('div', { class: 'small muted' }, 'Code: ', h('code', { class: 'invite-code-value' }, groupCode))]
        : h('div', { class: 'small muted' }, 'Off. People can only join with a personal invite link.')),
    groupCode && h('button', { class: 'btn small primary', onclick: () => shareJoinLink(groupCode) }, 'Share link'),
    groupCode && h('button', { class: 'btn small', onclick: () => copyText(joinLinkFor(groupCode)) }, 'Copy link'),
    h('button', { class: 'btn small', onclick: () => editInviteCode(groupCode) }, groupCode ? 'Change' : 'Turn on'),
    groupCode && h('button', { class: 'btn small ghost danger', onclick: async () => {
      if (!confirm('Turn off the group invite code? People who have it won’t be able to join with it anymore. Personal invite links keep working.')) return;
      try {
        await api('/api/invite-code', { method: 'PUT', body: { code: '' } });
        state.config.codeEnabled = false;
        toast('Invite code turned off');
        loadInvites();
      } catch (err) { toast(err.message, 'error'); }
    } }, 'Turn off'));
  box.replaceChildren(...[
    codeCard,
    h('div', { class: 'section-head' }, h('h2', {}, `Pending invites (${pending.length})`)),
    pending.length
      ? h('div', { class: 'card list-card' }, pending.map((i) => h('div', { class: 'invite-row' },
        h('div', { class: 'grow' }, h('strong', {}, i.name), h('div', { class: 'muted small' }, `${i.email ? `${i.email} · ` : ''}expires ${shortDate(i.expiresAt)}`)),
        h('button', { class: 'btn small', onclick: () => copyText(inviteUrl(i.token)) }, 'Copy link'),
        h('button', { class: 'btn small ghost danger', onclick: async () => {
          if (!confirm(`Cancel ${i.name}’s invite? The link will stop working.`)) return;
          try {
            await api(`/api/invites/${i.token}`, { method: 'DELETE' });
            loadInvites();
          } catch (err) { toast(err.message, 'error'); }
        } }, 'Cancel'))))
      : h('p', { class: 'muted small' }, 'No pending invites. Use “Invite someone” to send a personal link.'),
    past.length > 0 && h('details', { class: 'past-invites' }, h('summary', { class: 'small muted' }, 'Past invites'),
      h('div', { class: 'card list-card' }, past.map((i) => h('div', { class: 'invite-row' },
        h('div', { class: 'grow' }, h('strong', {}, i.name), i.email && h('div', { class: 'muted small' }, i.email)),
        h('span', { class: `chip ${i.status === 'joined' ? 'launched' : ''}` }, statusText[i.status]))))),
  ].filter(Boolean));
}

const joinLinkFor = (code) => `${location.origin}/i/${encodeURIComponent(code)}`;

async function shareJoinLink(code) {
  const url = joinLinkFor(code);
  const text = 'You’re invited to ACE (AI Christian Entrepreneurs), a small, private group of Christians using AI to build businesses that give back time for God, family, and ministry. Join here:';
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Join ACE', text, url });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  copyText(`${text} ${url}`);
}

// Opens the shareable join link: checks the code, then shows a simple sign-up form.
async function openJoinLink(code) {
  try {
    await api('/api/me');
    history.replaceState(null, '', '/#/home');
    await start();
    return toast('You’re already a member of ACE.');
  } catch { /* not signed in */ }
  let valid = false;
  try { ({ valid } = await api(`/api/invite-code/check?code=${encodeURIComponent(code)}`)); } catch { /* treated as invalid */ }
  history.replaceState(null, '', '/');
  if (!valid) return renderAuth('login', 'That invite link isn’t active anymore. Ask the person who sent it for a new one.');
  renderAuth('code', '', { code });
}

function editInviteCode(current) {
  const close = openModal(current ? 'Change the invite code' : 'Turn on an invite code', h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, current
      ? 'The old code stops working right away. Anyone who already joined stays a member.'
      : 'Anyone with this code can join ACE, so only share it with people you’ve vetted.'),
    form([field('Invite code', h('input', { type: 'text', id: 'new-invite-code', name: 'code', required: true, minlength: 4, maxlength: 60, value: current, autocapitalize: 'none' }), 'At least 4 characters. Not case-sensitive.')], {
      submitLabel: 'Save code',
      onSubmit: async (values) => {
        await api('/api/invite-code', { method: 'PUT', body: values });
        state.config.codeEnabled = true;
        close();
        toast('Invite code saved');
        loadInvites();
      },
    })));
}

function openInviteForm() {
  document.querySelector('.shell')?.classList.remove('nav-open');
  const more = h('div', { class: 'hidden' },
    field('Their email (optional)', h('input', { type: 'email', id: 'invite-email', name: 'email', maxlength: 200 }), 'Fills it in for them when they sign up'),
    field('Note to yourself (optional)', h('input', { type: 'text', id: 'invite-note', name: 'note', maxlength: 300, placeholder: 'e.g. Met at church, building an AI bookkeeping service' })));
  const close = openModal('Invite someone', h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, 'Type their name and get a personal link to send them. It works once and expires in 14 days.'),
    form([
      field('Their name', h('input', { type: 'text', id: 'invite-name', name: 'name', required: true, maxlength: 80, autocomplete: 'off' })),
      h('button', { type: 'button', class: 'btn small ghost', style: 'margin:-6px 0 8px', onclick: (e) => { more.classList.remove('hidden'); e.currentTarget.remove(); } }, '+ Add email or a note'),
      more,
    ], {
      submitLabel: 'Create link',
      onSubmit: async (values) => {
        const { invite } = await api('/api/invites', { method: 'POST', body: values });
        close();
        showInviteLink(invite);
        loadInvites();
      },
    })));
}

function showInviteLink(invite) {
  const url = inviteUrl(invite.token);
  const first = invite.name.split(' ')[0];
  const message = `Hi ${first}, I’d love to invite you to ACE (AI Christian Entrepreneurs), a small, private group of Christians using AI to build businesses that give back time for God, family, and ministry. Here’s your personal invite link (it works once and expires in 14 days):\n${url}`;
  const linkInput = h('input', { type: 'text', id: 'invite-link', readonly: true, value: url });
  const messageInput = h('textarea', { id: 'invite-message', rows: 6, readonly: true, value: message });
  const share = async () => {
    try {
      await navigator.share({ title: 'Join ACE', text: message.replace(`\n${url}`, ''), url });
    } catch (err) {
      if (err?.name !== 'AbortError') copyText(message, messageInput);
    }
  };
  openModal(`Link ready for ${first}`, h('div', { class: 'invite-share' },
    h('p', { class: 'muted', style: 'margin-top:0' }, `Send this to ${invite.name} by text or email. It works once, for them, and expires in 14 days.`),
    field('Personal invite link', linkInput),
    h('div', { class: 'invite-share-actions' },
      navigator.share && h('button', { class: 'btn primary', onclick: share }, 'Share'),
      h('button', { class: `btn ${navigator.share ? '' : 'primary'}`, onclick: () => copyText(url, linkInput) }, 'Copy link'),
      h('button', { class: 'btn ghost', onclick: () => { closeModal(); openInviteForm(); } }, 'Invite another')),
    field('Or copy a ready-to-send message', messageInput),
    h('button', { class: 'btn', onclick: () => copyText(message, messageInput) }, 'Copy message')));
}

function openMemberProfile(userId) {
  const u = state.users.get(userId);
  if (!u) return;
  const isMe = u.id === state.me.id;
  const projects = (state.projects || []).filter((p) => p.userId === u.id);
  const close = openModal(u.name, h('div', {},
    h('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:16px' }, avatar(u.id, 'lg'),
      h('div', {}, u.headline && h('div', {}, u.headline),
        h('div', { class: 'muted small' }, state.online.has(u.id) ? '● Online now' : 'Offline', ` · joined ${shortDate(u.createdAt)}`, u.role === 'admin' ? ' · Admin' : ''),
        h('div', { class: 'small', style: 'margin-top:2px' }, 'Pipeline: ', (PIPELINE.find((x) => x.key === (u.pipelineStage ?? 'build')) ?? PIPELINE[0]).title),
        h('div', { class: 'small', style: 'margin-top:2px' }, u.stage === 'guest' ? 'Experiencing the group'
          : u.committedOn ? `Committed for the year since ${shortDate(u.committedOn + 'T12:00:00')}` : 'Committed member'))),
    u.bio && h('div', { class: 'detail-block' }, h('h4', {}, 'About'), h('p', {}, u.bio)),
    u.skills && h('div', { class: 'detail-block' }, h('h4', {}, 'Skills & tools'), h('p', {}, u.skills)),
    u.ministry && h('div', { class: 'detail-block' }, h('h4', {}, 'Ministry focus'), h('p', {}, u.ministry)),
    projects.length > 0 && h('div', { class: 'detail-block' }, h('h4', {}, 'Projects'),
      projects.map((p) => h('div', {}, h('a', { href: `#/projects/${p.id}`, onclick: () => close() }, p.title), ' ', h('span', { class: `chip ${p.status}` }, STATUS_LABELS[p.status])))),
    h('div', { class: 'modal-foot' },
      state.me.role === 'admin' && !isMe && h('button', { class: 'btn ghost', onclick: async () => {
        try {
          const { user } = await api(`/api/users/${u.id}/role`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } });
          state.users.set(user.id, user);
          close();
          openMemberProfile(user.id);
        } catch (err) { toast(err.message, 'error'); }
      } }, u.role === 'admin' ? 'Remove admin' : 'Make admin'),
      state.me.role === 'admin' && h('button', { class: 'btn ghost', onclick: async () => {
        try {
          const { user } = await api(`/api/users/${u.id}/stage`, { method: 'PATCH', body: { stage: u.stage === 'guest' ? 'member' : 'guest' } });
          state.users.set(user.id, user);
          if (user.id === state.me.id) Object.assign(state.me, { stage: user.stage, committedOn: user.committedOn });
          close();
          openMemberProfile(user.id);
          toast(user.stage === 'guest' ? `${user.name} is experiencing the group` : `${user.name} is committed for the year 🙌`);
        } catch (err) { toast(err.message, 'error'); }
      } }, u.stage === 'guest' ? 'Mark committed for the year' : 'Move to experiencing'),
      state.me.role === 'admin' && !isMe && h('button', { class: 'btn ghost danger', onclick: async () => {
        if (!confirm(`Remove ${u.name} from ACE? They will be signed out and their account, messages, and posts will be deleted.`)) return;
        try {
          await api(`/api/users/${u.id}`, { method: 'DELETE' });
          close();
          toast(`${u.name} was removed`);
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Remove from ACE'),
      h('span', { class: 'spacer' }),
      isMe ? h('button', { class: 'btn primary', onclick: () => { close(); openProfileEditor(); } }, 'Edit profile')
        : h('button', { class: 'btn primary', onclick: () => { close(); startDm(u.id); } }, 'Send message'))));
}

function openProfileEditor(isNew = false) {
  const me = state.me;
  const close = openModal(isNew ? 'Welcome! Tell us about yourself' : 'Your profile', h('div', {},
    isNew && h('p', { class: 'muted', style: 'margin-top:0' }, 'A short profile helps others know how to pray for you and where you could collaborate.'),
    form([
      field('Name', h('input', { type: 'text', name: 'name', required: true, maxlength: 80, value: me.name })),
      field('Headline', h('input', { type: 'text', name: 'headline', maxlength: 120, value: me.headline, placeholder: 'e.g. Building AI automations for small churches' })),
      field('About you', h('textarea', { name: 'bio', maxlength: 1000, rows: 3, value: me.bio, placeholder: 'Your story, your family, what you are building…' })),
      field('Skills & tools', h('input', { type: 'text', name: 'skills', maxlength: 300, value: me.skills, placeholder: 'e.g. Copywriting, Zapier, Python, sales, video' })),
      field('Ministry focus', h('input', { type: 'text', name: 'ministry', maxlength: 300, value: me.ministry, placeholder: 'e.g. College discipleship, church planting in Ohio' }), 'Where do you want your freed-up time to go?'),
    ], {
      submitLabel: 'Save profile',
      extra: isNew ? [h('button', { type: 'button', class: 'btn ghost', onclick: () => { close(); go('#/tour'); } }, 'Skip for now')] : [],
      onSubmit: async (values) => {
        const { user } = await api('/api/me', { method: 'PATCH', body: values });
        state.me = user;
        state.users.set(user.id, user);
        close();
        // New members continue into the walkthrough of the vision.
        if (isNew) go('#/tour'); else renderShell();
        toast('Profile saved');
      },
    })));
}

// ---------- realtime ----------

// Minimal socket.io-style wrapper around a reconnecting WebSocket.
class Realtime {
  constructor() {
    this.handlers = new Map();
    this.retry = 0;
    this.closed = false;
    this.open();
  }

  on(event, fn) { this.handlers.set(event, fn); }

  fire(event, data) { this.handlers.get(event)?.(data); }

  emit(type, room) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, room }));
  }

  // Lets the server skip push notifications while the app is open on screen.
  sendActive() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'active', active: !document.hidden }));
  }

  open() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      this.ping = setInterval(() => ws.send('ping'), 30_000);
      this.sendActive();
      this.fire('connect');
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const { event, data } = JSON.parse(e.data);
        this.fire(event, data);
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.closed) return;
      if (!opened) this.fire('connect_error');
      this.timer = setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** this.retry++));
    };
  }

  disconnect() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.ws?.close();
  }
}

function connectSocket() {
  state.socket?.disconnect();
  const socket = new Realtime();
  state.socket = socket;

  socket.on('connect', async () => {
    // Catch up on anything missed while disconnected.
    try {
      const data = await api('/api/bootstrap');
      applyBootstrap(data);
      for (const room of state.rooms.keys()) {
        if (state.route.room === room) await loadRoom(room); else state.rooms.delete(room);
      }
      if (state.route.name !== 'room') renderShell();
      else { refreshSidebar(); renderMessages(state.route.room); }
    } catch { /* handled by next reconnect */ }
  });
  socket.on('connect_error', () => {
    api('/api/me').catch((err) => { if (err.status === 401) logout(true); });
  });

  socket.on('message:new', addMessage);
  socket.on('message:update', updateMessage);
  socket.on('message:delete', removeMessage);

  socket.on('conversation:upsert', (c) => {
    const i = state.conversations.findIndex((x) => x.id === c.id);
    if (i < 0) { state.conversations.unshift({ ...c, unread: 0 }); refreshSidebar(); }
  });

  socket.on('channel:new', (c) => {
    if (!state.channels.some((x) => x.id === c.id)) { state.channels.push(c); refreshSidebar(); }
  });
  socket.on('channel:deleted', ({ room }) => {
    state.channels = state.channels.filter((c) => c.room !== room);
    state.rooms.delete(room);
    if (state.route.room === room) go('#/home'); else refreshSidebar();
  });

  socket.on('presence', ({ userId, online }) => {
    if (online) state.online.add(userId); else state.online.delete(userId);
    if (state.route.name === 'members' || state.route.name === 'home') renderShell(); else refreshSidebar();
  });

  socket.on('user:removed', ({ id }) => {
    if (id === state.me.id) return logout(true);
    state.users.delete(id);
    state.online.delete(id);
    state.conversations = state.conversations.filter((c) => c.otherUserId !== id);
    if (state.route.name === 'members' && !document.querySelector('.modal-backdrop')) renderShell(); else refreshSidebar();
  });

  socket.on('user:updated', (u) => {
    state.users.set(u.id, u);
    if (u.id === state.me.id) state.me = { ...state.me, ...u };
    refreshSidebar();
  });

  socket.on('typing', ({ room, userId }) => {
    if (userId === state.me.id) return;
    if (!state.typing.has(room)) state.typing.set(room, new Map());
    const map = state.typing.get(room);
    clearTimeout(map.get(userId));
    map.set(userId, setTimeout(() => clearTyping(room, userId), 4000));
    renderTyping(room);
  });

  socket.on('project:changed', (p) => {
    upsertProject(p);
    const modalOpen = document.querySelector('.modal-backdrop');
    if (!modalOpen && (state.route.name === 'projects' || state.route.name === 'home')) renderShell();
    else refreshSidebar();
  });

  socket.on('deal:changed', (d) => {
    upsertDeal(d);
    if (!document.querySelector('.modal-backdrop') && ['realestate', 'home'].includes(state.route.name)) renderShell();
  });

  socket.on('offer:changed', (o) => {
    if (!state.offers) return;
    state.offers = state.offers.filter((x) => x.id !== o.id);
    if (!o.deleted) state.offers.unshift(o);
    if (!document.querySelector('.modal-backdrop') && state.route.name === 'offers') renderShell();
  });

  socket.on('suggestion:changed', (x) => {
    upsertSuggestion(x);
    const modalOpen = document.querySelector('.modal-backdrop');
    if (!modalOpen && state.route.name === 'suggestions') renderShell();
    else refreshSidebar();
  });

  socket.on('playbook:changed', (x) => {
    upsertPlaybook(x);
    if (!document.querySelector('.modal-backdrop') && state.route.name === 'working') renderShell();
  });

  socket.on('calls:changed', async () => {
    await loadCalls();
    const modalOpen = document.querySelector('.modal-backdrop');
    if (!modalOpen && (state.route.name === 'calls' || state.route.name === 'home')) renderShell();
  });
}

function applyBootstrap(data) {
  state.me = data.user;
  state.users = new Map(data.users.map((u) => [u.id, u]));
  state.channels = data.channels;
  state.conversations = data.conversations;
  state.online = new Set(data.online);
  state.reactions = data.reactions;
}

// ---------- lifecycle ----------

async function logout(silent = false) {
  // Stop this device getting the signed-out member's notifications.
  if (!silent) await disablePush({ quiet: true }).catch(() => {});
  if (!silent) await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.socket?.disconnect();
  state.socket = null;
  state.me = null;
  state.rooms.clear();
  renderAuth('login');
}

async function start() {
  applyBootstrap(await api('/api/bootstrap'));
  const [projects, suggestions, playbooks, five, deals, offers, leads] = await Promise.all([
    api('/api/projects'), api('/api/suggestions'), api('/api/playbooks'), api('/api/five'), api('/api/deals'),
    api('/api/offers'), api('/api/leads'), loadCalls(),
  ]);
  state.offers = offers.offers;
  state.leads = leads.leads;
  state.five = five;
  state.deals = deals.deals;
  state.projects = projects.projects;
  state.suggestions = suggestions.suggestions;
  state.playbooks = playbooks.playbooks;
  state.route = parseRoute();
  renderShell();
  connectSocket();
  syncPushSubscription();
}

document.addEventListener('visibilitychange', () => {
  state.socket?.sendActive();
  if (!document.hidden && state.route.name === 'room') renderMessages(state.route.room);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker') && !e.target.closest('.actions')) {
    document.querySelectorAll('.picker').forEach((p) => p.classList.add('hidden'));
  }
});

(async function boot() {
  window.addEventListener('online', () => { if (!state.me) location.reload(); });
  try {
    state.config = await api('/api/config');
  } catch {
    state.config = { reactions: [] };
  }
  // The public vision page works without an account.
  const joinCode = /^\/i\/([^/]+)\/?$/.exec(location.pathname)?.[1];
  if (joinCode) return openJoinLink(decodeURIComponent(joinCode));
  if (/^\/vision\/?$/.test(location.pathname)) {
    try { state.me = (await api('/api/me')).user; } catch { /* not signed in */ }
    return renderPublicVision();
  }
  // Google sign-in returns here with ?auth_error=… when it could not finish.
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) history.replaceState(null, '', location.pathname + location.hash);
  const joinToken = /^#\/join\/([\w-]+)/.exec(location.hash)?.[1];
  try {
    await start();
    if (joinToken) {
      toast('You’re already signed in to ACE.');
      go('#/home');
    }
  } catch (err) {
    if (err.status === 401 && joinToken) renderJoin(joinToken);
    else if (err.status === 401 && location.hash === '#/join-code' && state.config.codeEnabled) renderAuth('code');
    else if (err.status === 401) renderAuth(state.config.setupNeeded ? 'setup' : 'login', AUTH_ERRORS[authError] ?? '');
    else document.getElementById('app').replaceChildren(h('div', { class: 'offline' },
      h('img', { src: '/icons/icon-192.png', alt: '', width: 72, height: 72 }),
      h('h2', { class: 'serif' }, navigator.onLine ? 'Could not load the network' : 'You’re offline'),
      h('p', { class: 'muted' }, navigator.onLine ? 'Something went wrong. Please try again.' : 'Reconnect to see new messages and updates.'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again')));
  }
})();
