# reddit-chat-cleaner

Delete your own Reddit Chat messages in bulk. Reddit only lets you delete chat messages one at a time. This script removes every message you sent in the chats you pick, then hides those chats from your list.

It runs in your own browser, inside the Reddit tab where you are already logged in. No password, no app key, no server.

## Who it is for

Anyone with years of Reddit Chat history who wants their side of it gone, without tapping "delete" thousands of times.

## What it covers

- Yes: Reddit **Chat** (the chat bubble, `reddit.com/chat`).
- No: the old **Messages** inbox (`reddit.com/message/inbox`).
- No: posts or comments.
- Only **your** messages. Reddit does not let anyone delete the other person's messages, and this script does not try.

## Requirements

- A desktop browser: Chrome, Firefox, Brave or Edge.
- You are logged in to Reddit in that browser.

## Download

[Download the ZIP](https://github.com/zed-dz/reddit-chat-cleaner/archive/refs/heads/main.zip) and unzip it, or open `reddit_chat_cleaner.js` on GitHub and copy its content.

## How to use

1. Open https://www.reddit.com/chat/ and log in.
2. Press **F12** and click the **Console** tab.
3. Paste the whole content of `reddit_chat_cleaner.js` and press **Enter**.
   Chrome may first ask you to type `allow pasting`. Type it, press Enter, then paste again.
4. List your chats:

   ```js
   await rc.list()
   ```

   You get a table: the other person's name, how many messages you sent, how many they sent, and the date of the last message.

5. Check what would go, without deleting anything:

   ```js
   await rc.wipe(['name1', 'name2'], { dryRun: true })
   ```

6. Delete your messages in those chats and hide the chats:

   ```js
   await rc.wipe(['name1', 'name2'])
   ```

   Or every chat at once:

   ```js
   await rc.wipe('all')
   ```

   To delete your messages but keep the chat in your list, add `{ hide: false }`.

7. Run `await rc.list()` again to see what is left.

Names must match the `who` column of the table (not case sensitive). The script deletes one message at a time. When Reddit says "slow down", it waits the time Reddit asks for and continues.

## Safety notes

- **Deleting is permanent.** There is no undo. Use `{ dryRun: true }` first.
- Only paste code you have read. This file is short on purpose: read it before you run it.
- The script reads your chat session token from the page's own storage, uses it only to talk to Reddit's chat server, and never sends it anywhere else. It saves nothing.
- The other person keeps their copy of the chat, including your messages until Reddit removes them from their view.
- "Hide" only removes the chat from your list. Reddit has no "leave" option for one-to-one chats.

## How to undo

Deleted messages cannot be brought back. A hidden chat comes back to your list when someone sends a new message in it.

## How it works

Reddit Chat runs on Matrix, an open chat protocol, hosted at `matrix.redditspace.com`. The script uses standard Matrix calls: list your rooms, read message history, redact (delete) each of your own messages, and set Reddit's "hidden chat" flag on the room.

## Licence

MIT. See [LICENSE](LICENSE).

---

Made by Amine Hammou. Custom tools: https://aminehammou.vercel.app/tools.html
