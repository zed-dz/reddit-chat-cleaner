// reddit-chat-cleaner: delete your OWN Reddit Chat messages in bulk, from your own logged-in browser.
// MIT licence. https://github.com/zed-dz/reddit-chat-cleaner
//
// How to run: open https://www.reddit.com/chat/ and log in, press F12, open the Console tab,
// paste this whole file and press Enter. Then:
//
//   await rc.list()                          table of your chats: who, your messages, their messages
//   await rc.wipe(['name1'], {dryRun: true})  shows what would be deleted, deletes nothing
//   await rc.wipe(['name1', 'name2'])         deletes every message YOU sent in those chats, then hides them
//   await rc.wipe('all')                      same for every chat
//   await rc.wipe(['name1'], {hide: false})   delete your messages but keep the chat in your list
//
// Limits set by Reddit: you can only delete your own messages. The other person keeps theirs.
// "Hide" removes the chat from your list only. Deleting cannot be undone.
//
// Reddit Chat runs on Matrix (matrix.redditspace.com). The page stores your chat session token in
// localStorage under "chat:access-token". This script reads it there, uses it only for requests to
// that server, and never sends it anywhere else. Nothing is saved.

window.rc = (() => {
  const HS = 'https://matrix.redditspace.com';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const token = () => {
    const raw = localStorage.getItem('chat:access-token');
    if (!raw) throw new Error('No chat session found. Open https://www.reddit.com/chat/ while logged in, then try again.');
    return JSON.parse(raw).token;
  };
  const call = async (method, path, body) => {
    for (let a = 0; a < 8; a++) {
      const r = await fetch(HS + path, { method, headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body });
      if (r.ok) return r.json();
      if (r.status === 429) { // Reddit asked us to slow down: wait the time it gives
        let w = 2000;
        try { w = (await r.json()).retry_after_ms || 2000; } catch (e) { /* keep default */ }
        await sleep(w);
        continue;
      }
      throw new Error(method + ' ' + path.slice(0, 50) + ' -> HTTP ' + r.status);
    }
    throw new Error('Too many retries for ' + path.slice(0, 50));
  };
  let me = null;
  let inv = null;

  async function list() {
    me = (await call('GET', '/_matrix/client/v3/account/whoami')).user_id;
    const rooms = (await call('GET', '/_matrix/client/v3/joined_rooms')).joined_rooms;
    inv = [];
    let i = 0;
    const scan = async (rid) => {
      const enc = encodeURIComponent(rid);
      const mem = await call('GET', `/_matrix/client/v3/rooms/${enc}/members`);
      const others = (mem.chunk || []).filter((e) => e.state_key !== me);
      const who = [...new Set(others.map((e) => (e.content && e.content.displayname) || e.state_key))].join(', ') || '(unknown)';
      let from = null;
      const mine = [];
      let theirs = 0;
      let last = 0;
      for (let p = 0; p < 60; p++) {
        const r = await call('GET', `/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=500` + (from ? `&from=${encodeURIComponent(from)}` : ''));
        for (const ev of r.chunk || []) {
          if (ev.type !== 'm.room.message' || !ev.content || !Object.keys(ev.content).length) continue; // skip already deleted
          if (ev.sender === me) mine.push(ev.event_id); else theirs++;
          last = Math.max(last, ev.origin_server_ts || 0);
        }
        if (!r.end || r.end === from || !(r.chunk || []).length) break;
        from = r.end;
      }
      inv.push({ rid, who, mine, theirs, last: last ? new Date(last).toISOString().slice(0, 10) : '' });
    };
    // 4 chats at a time
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < rooms.length) {
        const rid = rooms[i++];
        try { await scan(rid); } catch (e) { inv.push({ rid, who: 'ERROR ' + e.message, mine: [], theirs: 0, last: '' }); }
      }
    }));
    inv.sort((a, b) => b.last.localeCompare(a.last));
    console.table(inv.map((r, n) => ({ n: n + 1, who: r.who, you: r.mine.length, them: r.theirs, last: r.last })));
    return inv.length + ' chats, ' + inv.reduce((s, r) => s + r.mine.length, 0) + ' messages from you';
  }

  async function wipe(users, opts = {}) {
    const dryRun = !!opts.dryRun;
    const hide = opts.hide !== false;
    if (users !== 'all' && !Array.isArray(users)) throw new Error('Use rc.wipe("all") or rc.wipe(["name1", "name2"]).');
    if (!inv) await list();
    const wanted = users === 'all' ? null : users.map((u) => String(u).toLowerCase());
    const pick = wanted ? inv.filter((r) => wanted.includes(r.who.toLowerCase())) : inv;
    if (wanted) {
      const missing = wanted.filter((u) => !inv.some((r) => r.who.toLowerCase() === u));
      if (missing.length) console.warn('No chat found for: ' + missing.join(', ') + ' (names must match the "who" column)');
    }
    if (dryRun) {
      console.table(pick.map((r) => ({ who: r.who, wouldDelete: r.mine.length, wouldHide: hide })));
      return { dryRun: true, chats: pick.length, messages: pick.reduce((s, r) => s + r.mine.length, 0) };
    }
    let deleted = 0, failed = 0, hidden = 0;
    for (const r of pick) {
      const enc = encodeURIComponent(r.rid);
      for (const ev of r.mine) {
        const txn = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
        try { await call('PUT', `/_matrix/client/v3/rooms/${enc}/redact/${encodeURIComponent(ev)}/${txn}`, '{}'); deleted++; }
        catch (e) { failed++; console.warn(r.who, e.message); }
      }
      if (hide) {
        try { await call('PUT', `/_matrix/client/v3/user/${encodeURIComponent(me)}/rooms/${enc}/account_data/com.reddit.hidden_chat`, '{"hidden":true}'); hidden++; }
        catch (e) { console.warn('hide', r.who, e.message); }
      }
      console.log(`${r.who}: ${r.mine.length} deleted${hide ? ', chat hidden' : ''}`);
      await sleep(300);
    }
    inv = null; // force a fresh list next time
    return { chats: pick.length, deleted, failed, hidden, next: 'Run await rc.list() to check what is left.' };
  }

  return { list, wipe };
})();
'rc ready. Next: await rc.list()';
