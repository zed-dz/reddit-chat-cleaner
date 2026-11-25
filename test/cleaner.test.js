// Run: node --test
// Nothing here touches Reddit. fetch is a pretend chat server kept in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'reddit_chat_cleaner.js'), 'utf8');
const ME = '@me:reddit.com';

function msg(id, sender, extra = {}) {
  return { event_id: id, sender, type: 'm.room.message', content: { body: 'hi' }, origin_server_ts: 1700000000000, ...extra };
}

// rooms: { roomId: { name, events: [...], pageSize } }
function makeServer(rooms, over = {}) {
  const s = { calls: [], rooms, deleted: [], hidden: [], user: ME, confirms: [], answer: true };
  s.fetch = async (url, init) => {
    s.calls.push({ url, ...init });
    const u = new URL(url);
    assert.equal(u.origin, 'https://matrix.redditspace.com', 'token sent to another server');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer TOKEN');
    const special = over.hook && over.hook(u, init, s);
    if (special) return special;
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const p = decodeURIComponent(u.pathname).replace('/_matrix/client/v3/', '');
    if (p === 'account/whoami') return json({ user_id: s.user });
    if (p === 'joined_rooms') return json({ joined_rooms: Object.keys(rooms) });
    let m = p.match(/^rooms\/(.+?)\/members$/);
    if (m) return json({ chunk: [{ state_key: ME, content: { displayname: 'me' } }, { state_key: '@x:r', content: { displayname: rooms[m[1]].name } }] });
    m = p.match(/^rooms\/(.+?)\/messages$/);
    if (m) {
      const all = rooms[m[1]].events.filter((e) => !s.deleted.includes(e.event_id));
      const size = rooms[m[1]].pageSize || 500;
      const at = Number(u.searchParams.get('from') || 0);
      const end = at + size < all.length ? String(at + size) : undefined;
      return json({ chunk: all.slice(at, at + size), end });
    }
    m = p.match(/^rooms\/(.+?)\/redact\/(.+)\/(.+)$/);
    if (m && init.method === 'PUT') {
      const ev = rooms[m[1]].events.find((e) => e.event_id === m[2]);
      if (ev.sender !== s.user) return json({}, 403);
      s.deleted.push(m[2]);
      return json({ event_id: 'x' });
    }
    m = p.match(/^user\/(.+?)\/rooms\/(.+?)\/account_data\/com\.reddit\.hidden_chat$/);
    if (m && init.method === 'PUT') { s.hidden.push(m[2]); return json({}); }
    throw new Error('unexpected call ' + p);
  };
  return s;
}

function load(server, storage = { 'chat:access-token': '{"token":"TOKEN"}' }) {
  const logs = [];
  const ctx = {
    fetch: server.fetch,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null) },
    setTimeout: (fn, ms) => { server.waits = (server.waits || []).concat(ms); return setTimeout(fn, 0); },
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), table: (t) => logs.push(t) },
    encodeURIComponent,
  };
  ctx.window = { confirm: (t) => { server.confirms.push(t); return server.answer; } };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { rc: ctx.window.rc, logs, ctx };
}

const twoRooms = () => ({
  '!a:r': { name: 'Blue Lamp', events: [msg('$1', ME), msg('$2', '@x:r'), msg('$3', ME), msg('$4', ME, { content: {} })] },
  '!b:r': { name: 'Old Desk', events: [msg('$5', ME), msg('$6', '@x:r')] },
});
const puts = (s) => s.calls.filter((c) => c.method !== 'GET');

test('loading the script calls nothing', () => {
  const s = makeServer(twoRooms());
  load(s);
  assert.equal(s.calls.length, 0);
});

test('list only reads, and skips messages already deleted', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  assert.equal(await rc.list(), '2 chats, 3 messages from you');
  assert.equal(puts(s).length, 0);
});

test('a dry run deletes and hides nothing, and asks nothing', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  const r = await rc.wipe('all', { dryRun: true });
  assert.deepEqual({ ...r }, { dryRun: true, chats: 2, messages: 3 });
  assert.equal(puts(s).length + s.confirms.length, 0);
});

test('wipe deletes only my messages in the chosen chat', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  const r = await rc.wipe(['blue lamp']);
  assert.deepEqual(s.deleted.sort(), ['$1', '$3']);
  assert.deepEqual(s.hidden, ['!a:r']);
  assert.equal(r.deleted, 2);
  assert.match(s.confirms[0], /Delete 2 of your messages in 1 chats/);
  assert.equal(await rc.list(), '2 chats, 1 messages from you');
});

test('saying no at the question deletes nothing', async () => {
  const s = makeServer(twoRooms());
  s.answer = false;
  const { rc } = load(s);
  assert.equal((await rc.wipe('all')).cancelled, true);
  assert.equal(puts(s).length, 0);
});

test('keep the chat in the list', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  await rc.wipe('all', { hide: false, yes: true });
  assert.equal(s.deleted.length, 3);
  assert.equal(s.hidden.length, 0);
});

test('two chats with the same name are refused, numbers work', async () => {
  const rooms = twoRooms();
  rooms['!b:r'].name = 'BLUE LAMP';
  const s = makeServer(rooms);
  const { rc } = load(s);
  await assert.rejects(rc.wipe(['Blue Lamp'], { yes: true }), /name of 2 chats/);
  assert.equal(puts(s).length, 0);
  await rc.wipe([1], { yes: true });
  assert.equal(s.hidden.length, 1);
});

test('bad input deletes nothing', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  for (const bad of ['Blue Lamp', undefined, [], null, {}, 'ALL']) await assert.rejects(rc.wipe(bad, { yes: true }), /Use rc.wipe/);
  await assert.rejects(rc.wipe([99], { yes: true }), /no chat number 99/);
  assert.equal((await rc.wipe(['nobody'], { yes: true })).deleted, 0);
  assert.equal(puts(s).length, 0);
});

test('reads every page, however small the server makes them', async () => {
  const events = Array.from({ length: 450 }, (_, i) => msg('$' + i, ME));
  const s = makeServer({ '!a:r': { name: 'Long', events, pageSize: 5 } });
  const { rc } = load(s);
  assert.equal(await rc.list(), '1 chats, 450 messages from you');
});

test('a chat that cannot be read is never hidden', async () => {
  const s = makeServer(twoRooms(), { hook: (u) => decodeURIComponent(u.pathname).includes('!a:r/messages') && { ok: false, status: 403, json: async () => ({}) } });
  const { rc } = load(s);
  const r = await rc.wipe('all', { yes: true });
  assert.deepEqual(s.hidden, ['!b:r']);
  assert.equal(r.chats, 1);
});

test('a chat with a failed delete is not hidden, and the count is true', async () => {
  const s = makeServer(twoRooms(), { hook: (u) => decodeURIComponent(u.pathname).includes('redact/$3') && { ok: false, status: 400, json: async () => ({}) } });
  const { rc, logs } = load(s);
  const r = await rc.wipe(['Blue Lamp'], { yes: true });
  assert.equal(r.deleted, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(s.hidden, []);
  assert.ok(logs.some((l) => String(l).includes('1 of 2 deleted')));
});

test('waits as long as Reddit asks, within limits', async () => {
  let n = 0;
  const s = makeServer(twoRooms(), {
    hook: (u) => (u.pathname.includes('joined_rooms') && n++ < 2
      ? { ok: false, status: 429, json: async () => ({ retry_after_ms: n === 1 ? 7000 : 9e9 }) } : null),
  });
  const { rc } = load(s);
  await rc.list();
  assert.deepEqual(s.waits.slice(0, 2), [7000, 300000]);
});

test('a lost connection and a server error are tried again', async () => {
  let n = 0;
  const s = makeServer(twoRooms(), {
    hook: (u) => {
      if (!u.pathname.includes('joined_rooms')) return null;
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');
      return n === 2 ? { ok: false, status: 502, json: async () => ({}) } : null;
    },
  });
  const { rc } = load(s);
  assert.equal(await rc.list(), '2 chats, 3 messages from you');
});

test('an ended session stops the whole run', async () => {
  let n = 0;
  const s = makeServer(twoRooms(), { hook: (u) => u.pathname.includes('/redact/') && n++ >= 1 && { ok: false, status: 401, json: async () => ({}) } });
  const { rc } = load(s);
  const r = await rc.wipe('all', { yes: true });
  assert.equal(r.deleted, 1);
  assert.match(r.halted, /session has ended/);
  assert.equal(s.calls.filter((c) => c.url.includes('/redact/')).length, 2);
  assert.deepEqual(s.hidden, []);
});

test('a different account after the list deletes nothing', async () => {
  const s = makeServer(twoRooms());
  const { rc } = load(s);
  await rc.list();
  s.user = '@other:reddit.com';
  await assert.rejects(rc.wipe('all', { yes: true }), /someone else/);
  assert.equal(puts(s).length, 0);
});

test('rc.stop ends the run and hides nothing unfinished', async () => {
  const s = makeServer(twoRooms(), { hook: (u, i, srv) => { if (u.pathname.includes('/redact/')) srv.rc.stop(); return null; } });
  const { rc } = load(s);
  s.rc = rc;
  const r = await rc.wipe('all', { yes: true });
  assert.equal(r.deleted, 1);
  assert.equal(r.stopped, true);
  assert.deepEqual(s.hidden.filter((h) => h === '!a:r'), []);
});

test('the token is never printed', async () => {
  const s = makeServer(twoRooms(), { hook: (u) => u.pathname.includes('/redact/') && { ok: false, status: 400, json: async () => ({}) } });
  const { rc, logs } = load(s);
  const r = await rc.wipe('all', { yes: true });
  assert.ok(!JSON.stringify([logs, r]).includes('TOKEN'));
});

test('no session, or a broken one, gives a clear message', async () => {
  for (const st of [{}, { 'chat:access-token': 'not json' }, { 'chat:access-token': '{}' }]) {
    const { rc } = load(makeServer(twoRooms()), st);
    await assert.rejects(rc.list(), /session/);
  }
});
