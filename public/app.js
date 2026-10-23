// AI Entrepreneur Network — single-page client.

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
const FREQ_LABELS = { weekly: 'Every week', biweekly: 'Every other week', once: 'One time' };
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
  if (parts[0] === 'chat') return { name: 'chat' };
  return { name: 'home' };
}
const go = (hash) => { location.hash = hash; };
const roomHash = (room) => `#/${room.replace(':', '/')}`;

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  state.route = parseRoute();
  document.querySelector('.shell')?.classList.remove('nav-open');
  renderShell();
});

// ---------- auth screens ----------

const GOOGLE_MARK = '<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

const AUTH_ERRORS = {
  invite: 'To join with Google, enter the invite code first, then choose Continue with Google.',
  google: 'Google sign-in did not finish. Please try again.',
};

function renderAuth(mode = 'login', errorMessage = '') {
  const [verse, ref] = verseOfDay();
  const isRegister = mode === 'register';
  const app = document.getElementById('app');
  app.innerHTML = '';
  const needsInvite = isRegister && state.config.inviteRequired;
  // The invite code is shared by Google sign-up and the email form, so it sits above both.
  const inviteInput = needsInvite && h('input', { type: 'text', id: 'invite-code', name: 'inviteCode', required: true, autocomplete: 'off' });
  const authError = h('p', { class: `error-text ${errorMessage ? '' : 'hidden'}`, role: 'alert' }, errorMessage);
  const googleButton = state.config.googleEnabled && h('button', {
    type: 'button', class: 'btn google-btn',
    onclick: () => {
      const invite = inviteInput ? inviteInput.value.trim() : '';
      if (inviteInput && !invite) {
        authError.textContent = 'Enter the invite code first.';
        authError.classList.remove('hidden');
        inviteInput.focus();
        return;
      }
      location.href = `/api/auth/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;
    },
  }, h('span', { class: 'g-mark', 'aria-hidden': 'true', html: GOOGLE_MARK }), isRegister ? 'Sign up with Google' : 'Continue with Google');
  const fields = isRegister
    ? [
        field('Full name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name' })),
        field('Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters'),
      ]
    : [
        field('Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
      ];

  app.append(h('div', { class: 'auth' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'brand-mark' }, '✝'),
      h('h1', { class: 'serif' }, 'AI Entrepreneur Network'),
      h('p', {}, 'A community of Christian builders using AI to create ventures that give back time, not to hustle or chase wealth, but to have more of our lives for God, family, serving, and making disciples.'),
      h('ul', {},
        h('li', {}, 'Group channels for encouragement, prayer, ideas and content'),
        h('li', {}, 'Private messages with any member'),
        h('li', {}, 'A project board to ask for help and collaborate'),
        h('li', {}, 'Weekly and bi-weekly community calls')),
      h('blockquote', {}, `“${verse}” — ${ref}`),
      h('p', { class: 'auth-vision' }, h('strong', {}, 'Our vision: '), VISION.statement)),
    h('section', { class: 'auth-panel' },
      h('div', { class: 'auth-card' },
        h('h2', { class: 'serif' }, isRegister ? 'Join the network' : 'Welcome back'),
        h('p', { class: 'muted' }, isRegister ? 'Create your account to start connecting.' : 'Sign in to continue the conversation.'),
        authError,
        inviteInput && field('Invite code', inviteInput, 'Ask the person who invited you'),
        googleButton,
        googleButton && h('div', { class: 'or' }, isRegister ? 'or sign up with email' : 'or sign in with email'),
        form(fields, {
          submitLabel: isRegister ? 'Create account' : 'Sign in',
          onSubmit: async (values) => {
            if (inviteInput) values.inviteCode = inviteInput.value;
            await api(isRegister ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: values });
            await start();
            if (isRegister) openProfileEditor(true);
          },
        }),
        h('p', { class: 'auth-switch muted' },
          isRegister ? 'Already a member? ' : 'New here? ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(isRegister ? 'login' : 'register'); } },
            isRegister ? 'Sign in' : 'Create an account'))))));
  app.querySelector('input').focus();
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
      h('div', {}, h('strong', {}, 'AI Entrepreneur Network'), h('span', {}, `${state.users.size} members · ${state.online.size} online`))),
    h('nav', { class: 'sidebar-scroll' },
      navItem({ href: '#/home', icon: h('span', { class: 'icon' }, '⌂'), label: 'Home', active: r.name === 'home' }),
      navItem({ href: '#/vision', icon: h('span', { class: 'icon' }, '✝'), label: 'Our vision', active: r.name === 'vision' }),
      navItem({ href: '#/projects', icon: h('span', { class: 'icon' }, '◆'), label: 'Projects', active: r.name === 'projects', unread: 0, extra: helpCount ? h('span', { class: 'small', style: 'opacity:.7' }, `${helpCount} need help`) : null }),
      navItem({ href: '#/working', icon: h('span', { class: 'icon' }, '▲'), label: 'What’s working', active: r.name === 'working' }),
      navItem({ href: '#/suggestions', icon: h('span', { class: 'icon' }, '✦'), label: 'Suggestions', active: r.name === 'suggestions', extra: openSuggestions ? h('span', { class: 'small', style: 'opacity:.7' }, `${openSuggestions} open`) : null }),
      navItem({ href: '#/calls', icon: h('span', { class: 'icon' }, '☏'), label: 'Community calls', active: r.name === 'calls' }),
      navItem({ href: '#/members', icon: h('span', { class: 'icon' }, '☺'), label: 'Members', active: r.name === 'members' }),
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
  const inRoom = state.route.name === 'room';
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
    tab('#/working', tabIcon('build'), 'Build', ['working', 'projects', 'suggestions'].includes(r)),
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
  else main.append(...renderHome());
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
        h('a', { class: 'hero-link', href: '#/vision' }, 'Read our vision →')),

      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, state.users.size), h('span', {}, 'members')),
        h('div', { class: 'stat' }, h('b', {}, state.online.size), h('span', {}, 'online now')),
        h('div', { class: 'stat' }, h('b', {}, (state.projects || []).length), h('span', {}, 'projects shared')),
        h('div', { class: 'stat' }, h('b', {}, (state.projects || []).filter((p) => p.status === 'launched').length), h('span', {}, 'launched'))),

      h('div', { class: 'section-head' }, h('h2', {}, 'Next community call'), h('a', { href: '#/calls', class: 'small' }, 'All calls →')),
      nextCall ? callCard(nextCall.call, { limit: 1 })
        : h('div', { class: 'card empty' }, state.me.role === 'admin'
          ? h('div', {}, 'No calls scheduled yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openCallEditor(); } }, 'Schedule the weekly call'))
          : 'No calls scheduled yet — check back soon.'),

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
    ['Gather', 'Meet on the weekly or bi-weekly community call to pray, celebrate progress, learn together, and stay accountable.'],
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

function renderVision() {
  return [
    topbar('Our vision', 'Why this network exists and how we build together'),
    h('div', { class: 'page' }, h('div', { class: 'page-inner vision' },
      h('section', { class: 'hero-card' },
        h('div', { class: 'eyebrow' }, 'The vision'),
        h('h1', { class: 'serif' }, VISION.statement),
        h('div', { class: 'verse' }, '“Go therefore and make disciples of all nations…” — Matthew 28:19')),
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
        h('p', {}, 'The win is not a bigger number. It is an evening home with your kids, a morning in the Word, a week spent serving, or a step into full-time ministry. When your business gives you time back, share it in #wins so we can celebrate what God is doing.')))),
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
  if (m.userId !== state.me.id && (document.hidden || state.route.room !== m.room)) notify(m);
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

function notify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const info = roomInfo(m.room);
  const isDm = m.room.startsWith('d:');
  const mentioned = m.body.toLowerCase().includes(`@${state.me.name.split(' ')[0].toLowerCase()}`);
  if (!isDm && !mentioned) return;
  const n = new Notification(isDm ? userName(m.userId) : `${userName(m.userId)} in ${info?.title ?? 'a channel'}`, { body: m.body.slice(0, 140) });
  n.onclick = () => { window.focus(); go(roomHash(m.room)); };
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
          call.frequency === 'once'
            ? d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
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
    topbar('Community calls', 'Weekly and bi-weekly gatherings to pray, share wins, and learn together.',
      isAdmin ? [h('button', { class: 'btn primary', onclick: () => openCallEditor() }, '+ Schedule call')] : []),
    h('div', { class: 'page' }, h('div', { class: 'page-inner', style: 'display:grid;gap:16px' },
      calls.length ? calls.map((c) => callCard(c))
        : h('div', { class: 'card empty' }, isAdmin ? 'No calls scheduled yet. Use “Schedule call” to set up the weekly or bi-weekly gathering.' : 'No calls scheduled yet. An admin will post the next one soon.'))),
  ];
}

function openCallEditor(call) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserTz];
  const tz = call?.timezone ?? browserTz;
  if (!zones.includes(tz)) zones.unshift(tz);
  const today = new Date().toLocaleDateString('en-CA');

  const close = openModal(call ? 'Edit call' : 'Schedule a call', form([
    field('Title', h('input', { type: 'text', name: 'title', required: true, maxlength: 120, value: call?.title ?? 'Weekly Community Call' })),
    field('Description', h('textarea', { name: 'description', maxlength: 2000, rows: 3, value: call?.description, placeholder: 'Prayer, member wins, a short teaching on an AI tool, and open Q&A.' })),
    h('div', { class: 'row' },
      field('Repeats', h('select', { name: 'frequency' }, Object.entries(FREQ_LABELS).map(([value, label]) => h('option', { value, selected: (call?.frequency ?? 'weekly') === value }, label)))),
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
        h('h3', {}, u.name, state.online.has(u.id) && h('span', { class: 'dot on', title: 'Online' }), u.role === 'admin' && h('span', { class: 'chip' }, 'Admin')),
        u.headline && h('p', { class: 'muted' }, u.headline),
        u.skills && h('p', { class: 'small' }, h('b', {}, 'Skills: '), u.skills),
        u.ministry && h('p', { class: 'small' }, h('b', {}, 'Ministry: '), u.ministry)))) : [h('div', { class: 'card empty' }, 'No members match your search.')]));
  };
  search.addEventListener('input', () => { memberQuery = search.value; draw(); });
  draw();
  return [
    topbar('Members', `${state.users.size} believers building together`),
    h('div', { class: 'page' }, h('div', { class: 'page-inner' }, h('div', { style: 'margin-bottom:16px' }, search), grid)),
  ];
}

function openMemberProfile(userId) {
  const u = state.users.get(userId);
  if (!u) return;
  const isMe = u.id === state.me.id;
  const projects = (state.projects || []).filter((p) => p.userId === u.id);
  const close = openModal(u.name, h('div', {},
    h('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:16px' }, avatar(u.id, 'lg'),
      h('div', {}, u.headline && h('div', {}, u.headline),
        h('div', { class: 'muted small' }, state.online.has(u.id) ? '● Online now' : 'Offline', ` · joined ${shortDate(u.createdAt)}`, u.role === 'admin' ? ' · Admin' : ''))),
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
      extra: isNew ? [h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, 'Skip for now')] : [],
      onSubmit: async (values) => {
        const { user } = await api('/api/me', { method: 'PATCH', body: values });
        state.me = user;
        state.users.set(user.id, user);
        close();
        renderShell();
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

  open() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    let opened = false;
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      this.ping = setInterval(() => ws.send('ping'), 30_000);
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
  if (!silent) await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.socket?.disconnect();
  state.socket = null;
  state.me = null;
  state.rooms.clear();
  renderAuth('login');
}

async function start() {
  applyBootstrap(await api('/api/bootstrap'));
  const [projects, suggestions, playbooks] = await Promise.all([
    api('/api/projects'), api('/api/suggestions'), api('/api/playbooks'), loadCalls(),
  ]);
  state.projects = projects.projects;
  state.suggestions = suggestions.suggestions;
  state.playbooks = playbooks.playbooks;
  state.route = parseRoute();
  renderShell();
  connectSocket();
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.route.name === 'room') renderMessages(state.route.room);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker') && !e.target.closest('.actions')) {
    document.querySelectorAll('.picker').forEach((p) => p.classList.add('hidden'));
  }
});

(async function boot() {
  state.config = await api('/api/config');
  // Google sign-in returns here with ?auth_error=… when it could not finish.
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) history.replaceState(null, '', location.pathname + location.hash);
  try {
    await start();
  } catch (err) {
    if (err.status === 401) renderAuth(authError === 'invite' ? 'register' : 'login', AUTH_ERRORS[authError] ?? '');
    else document.getElementById('app').textContent = 'Could not load the network. Please refresh.';
  }
})();
