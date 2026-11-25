// reddit-chat-cleaner: delete your OWN Reddit Chat messages in bulk, from your own logged-in browser.
// MIT licence. https://github.com/zed-dz/reddit-chat-cleaner
//
// How to run: open https://www.reddit.com/chat/ and log in, press F12, open the Console tab,
// paste this whole file and press Enter. Then:
//
//   await rc.list()                          table of your chats: number, who, your messages, their messages
//   await rc.wipe(['name1'], {dryRun: true})  shows what would be deleted, deletes nothing
//   await rc.wipe(['name1', 3])               deletes every message YOU sent in those chats, then hides them
//   await rc.wipe('all')                      same for every chat
//   await rc.wipe(['name1'], {hide: false})   delete your messages but keep the chat in your list
//   rc.stop()                                 stop a run after the current message
//
// Before it deletes, it asks you to confirm. Add {yes: true} to skip that question.
// Limits set by Reddit: you can only delete your own messages. The other person keeps theirs.
// "Hide" removes the chat from your list only. Deleting cannot be undone.
//
// Reddit Chat runs on Matrix (matrix.redditspace.com). The page stores your chat session token in
// localStorage under "chat:access-token". This script reads it there, uses it only for requests to
// that server, and never sends it anywhere else. Nothing is saved.

window.rc = (() => {
  const HS = 'https://matrix.redditspace.com';
  const MAX_PAGES = 2000; // a chat longer than this is reported as "not complete", never hidden
  const MINE = ['m.room.message', 'm.sticker', 'm.room.encrypted'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let me = null;
  let inv = null;
  let stopped = false;

  class Stop extends Error {} // ends the whole run, not only one message

  const token = () => {
    const raw = localStorage.getItem('chat:access-token');
    if (!raw) throw new Stop('No chat session found. Open https://www.reddit.com/chat/ while logged in, then try again.');
    let t;
    try { t = JSON.parse(raw).token; } catch (e) { /* handled below */ }
    if (!t) throw new Stop('The chat session could not be read. Reload https://www.reddit.com/chat/ and try again.');
    return t;
  };

  const call = async (method, path, body) => {
    const name = method + ' ' + path.slice(0, 50);
    let why = '';
    for (let a = 0; a < 8; a++) {
      let r;
      try {
        // redirect: 'error' so the token can never follow a redirect to another server
        r = await fetch(HS + path, { method, redirect: 'error', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body });
      } catch (e) {
        if (e instanceof Stop) throw e;
        why = 'network error';
        await sleep(1000 * 2 ** Math.min(a, 5));
        continue;
      }
      if (r.ok) return r.json();
      if (r.status === 401) throw new Stop('Reddit says your chat session has ended. Reload the page, paste the script again and run it once more.');
      if (r.status === 429) { // Reddit asked us to slow down: wait the time it gives, at most 5 minutes
        let w = 2000;
        try { w = Number((await r.json()).retry_after_ms) || 2000; } catch (e) { /* keep default */ }
        why = 'slow down';
        await sleep(Math.min(Math.max(w, 500), 300000));
        continue;
      }
      if (r.status >= 500) {
        why = 'HTTP ' + r.status;
        await sleep(1000 * 2 ** Math.min(a, 5));
        continue;
      }
      throw new Error(name + ' -> HTTP ' + r.status);
    }
    throw new Error('Too many retries (' + why + ') for ' + name);
  };

  const whoami = async () => {
    const id = (await call('GET', '/_matrix/client/v3/account/whoami')).user_id;
    if (!id) throw new Stop('Reddit did not say who you are. Nothing was deleted.');
    return id;
  };

  async function scan(rid) {
    const enc = encodeURIComponent(rid);
    const mem = await call('GET', `/_matrix/client/v3/rooms/${enc}/members`);
    const others = (mem.chunk || []).filter((e) => e.state_key !== me);
    const who = [...new Set(others.map((e) => (e.content && e.content.displayname) || e.state_key))].join(', ') || '(unknown)';
    const mine = new Set();
    let from = null;
    let theirs = 0;
    let last = 0;
    let complete = false;
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await call('GET', `/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=500` + (from ? `&from=${encodeURIComponent(from)}` : ''));
      for (const ev of r.chunk || []) {
        if (!MINE.includes(ev.type) || !ev.content || !Object.keys(ev.content).length) continue; // skip already deleted
        if (ev.sender === me) mine.add(ev.event_id); else theirs++;
        last = Math.max(last, ev.origin_server_ts || 0);
      }
      if (!r.end || r.end === from) { complete = true; break; }
      from = r.end;
    }
    return { rid, who, mine: [...mine], theirs, complete, error: '', last: last ? new Date(last).toISOString().slice(0, 10) : '' };
  }

  async function list() {
    me = await whoami();
    const rooms = (await call('GET', '/_matrix/client/v3/joined_rooms')).joined_rooms || [];
    const found = [];
    let i = 0;
    // 4 chats at a time
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < rooms.length) {
        const rid = rooms[i++];
        try { found.push(await scan(rid)); } catch (e) {
          if (e instanceof Stop) throw e;
          found.push({ rid, who: '(could not read)', mine: [], theirs: 0, complete: false, error: e.message, last: '' });
        }
      }
    }));
    found.sort((a, b) => b.last.localeCompare(a.last));
    inv = found;
    console.table(inv.map((r, n) => ({ n: n + 1, who: r.who, you: r.mine.length, them: r.theirs, last: r.last, note: r.error || (r.complete ? '' : 'not complete') })));
    return inv.length + ' chats, ' + inv.reduce((s, r) => s + r.mine.length, 0) + ' messages from you';
  }

  // Turn names and numbers into chats. A name shared by two chats is refused: anyone can copy a display name.
  function choose(users) {
    if (users === 'all') return inv.filter((r) => !r.error);
    if (!Array.isArray(users) || !users.length) throw new Error('Use rc.wipe("all") or rc.wipe(["name1", 2]).');
    const pick = new Set();
    for (const u of users) {
      if (typeof u === 'number') {
        const r = inv[u - 1];
        if (!r) throw new Error('There is no chat number ' + u + '. Nothing was deleted.');
        pick.add(r);
        continue;
      }
      const same = inv.filter((r) => r.who.toLowerCase() === String(u).toLowerCase());
      if (same.length > 1) {
        throw new Error('"' + u + '" is the name of ' + same.length + ' chats. Use their numbers from the table: ' + same.map((r) => inv.indexOf(r) + 1).join(', ') + '. Nothing was deleted.');
      }
      if (!same.length) console.warn('No chat found for: ' + u + ' (names must match the "who" column)');
      else pick.add(same[0]);
    }
    return [...pick].filter((r) => !r.error);
  }

  async function wipe(users, opts = {}) {
    const dryRun = !!opts.dryRun;
    const hide = opts.hide !== false;
    if (!inv) await list();
    const unread = inv.filter((r) => r.error).length;
    if (unread) console.warn(unread + ' chats could not be read. They are left alone.');
    const pick = choose(users);
    const total = pick.reduce((s, r) => s + r.mine.length, 0);
    if (dryRun) {
      console.table(pick.map((r) => ({ who: r.who, wouldDelete: r.mine.length, wouldHide: hide && r.complete })));
      return { dryRun: true, chats: pick.length, messages: total };
    }
    if (!pick.length) return { chats: 0, deleted: 0, failed: 0, hidden: 0, next: 'Nothing matched.' };
    if (await whoami() !== me) {
      inv = null;
      throw new Stop('You are logged in as someone else now. Nothing was deleted. Run await rc.list() again.');
    }
    if (opts.yes !== true && !window.confirm('Delete ' + total + ' of your messages in ' + pick.length + ' chats' + (hide ? ' and hide those chats' : '') + '? This cannot be undone.')) {
      return { cancelled: true, deleted: 0 };
    }
    stopped = false;
    let deleted = 0;
    let failed = 0;
    let hidden = 0;
    let halted = '';
    try {
      for (const r of pick) {
        if (stopped) break;
        const enc = encodeURIComponent(r.rid);
        let done = 0;
        for (const ev of r.mine) {
          if (stopped) break;
          const txn = 't' + Date.now() + Math.random().toString(36).slice(2, 8);
          try { await call('PUT', `/_matrix/client/v3/rooms/${enc}/redact/${encodeURIComponent(ev)}/${txn}`, '{}'); done++; deleted++; } catch (e) {
            if (e instanceof Stop) throw e;
            failed++;
            console.warn(r.who, e.message);
          }
        }
        const clean = done === r.mine.length && r.complete; // hide only a chat that is really empty of you
        let wasHidden = false;
        if (hide && clean) {
          try { await call('PUT', `/_matrix/client/v3/user/${encodeURIComponent(me)}/rooms/${enc}/account_data/com.reddit.hidden_chat`, '{"hidden":true}'); hidden++; wasHidden = true; } catch (e) {
            if (e instanceof Stop) throw e;
            console.warn('hide', r.who, e.message);
          }
        }
        console.log(`${r.who}: ${done} of ${r.mine.length} deleted${wasHidden ? ', chat hidden' : ''}`);
        await sleep(300);
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      halted = e.message;
      console.warn(halted);
    } finally {
      inv = null; // force a fresh list next time
    }
    const out = { chats: pick.length, deleted, failed, hidden, next: 'Run await rc.list() to check what is left.' };
    if (stopped) out.stopped = true;
    if (halted) out.halted = halted;
    return out;
  }

  function stop() { stopped = true; return 'Stopping after the current message.'; }

  return { list, wipe, stop };
})();
'rc ready. Next: await rc.list()';
