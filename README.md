# minibot

Minimal WhatsApp bot on WAHA. The linked number can use:

- `.pair 2348163201351` — requests a WAHA WhatsApp pairing code for that number and sends the code back to the same chat.
- `.menu` — sends "Demoting in progress" to `TARGET_GROUP_ID`, then demotes the linked account from admin in that group.

Commands are processed from `message.any` and require `fromMe: true`, so they are triggered only by the linked account itself.

Includes a simple web page to pair your WhatsApp number (no curl needed).

## Deploy on Render (one step)

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint** → pick that repo. Render reads
   `render.yaml` and creates both services for you:
   - `waha` — the WhatsApp engine (private, no public URL)
   - `minibot` — this bot (public URL, serves the pairing page)
3. Once both show **Live**, open the `minibot` service's URL in a browser.

## Pairing your number

Open the bot's URL — you'll see a page with a phone number field:
1. Enter your number, digits only, with country code (e.g. `15551234567`).
2. Click **Get pairing code**.
3. On your phone: **WhatsApp → Linked Devices → Link a Device → Link with
   phone number instead** → enter the code shown.
4. The page polls session status automatically and shows **"Linked and
   running"** once it's connected.

## Test it

From that same (now linked) number, type `.menu` in any chat. The bot will
message the group in `TARGET_GROUP_ID` and demote itself there.

## Run locally instead

```bash
docker compose up --build
```
Then open http://localhost:3001 for the same pairing page (the bot is
mapped to port 3001 locally; see `docker-compose.yml`).

## Config (env vars)

| Var | Default | What it's for |
|---|---|---|
| `WAHA_URL` | `http://127.0.0.1:3000` | Where WAHA's API is reachable. On Render this is set automatically by `render.yaml`. Accepts a bare `host:port` too. |
| `WAHA_API_KEY` | (none) | Only if your WAHA instance requires one |
| `PUBLIC_BASE_URL` | (falls back to `RENDER_EXTERNAL_URL`, then `http://localhost:PORT`) | This bot's own public URL, so WAHA's webhook can reach it |
| `WEBHOOK_SECRET` | `change-me` | Shared secret checked on incoming webhook calls. On Render, `render.yaml` generates a random one automatically. |
| `SESSION_NAME` | `default` | WAHA session name |
| `TARGET_GROUP_ID` | `120363429763384848@g.us` | The group the bot demotes itself in |
| `PORT` | `3000` | Port this bot listens on |

## How it works, in one paragraph

`index.js` does four things: (1) serves a small pairing page (`public/
index.html`) with two endpoints behind it — `/api/pair` (calls WAHA's
phone-number pairing endpoint) and `/api/status` (polls the session's
current status). (2) On boot, it creates/starts a WAHA session and tells
WAHA to POST every message — including ones sent from the linked number
itself — to `/webhooks/waha`; WAHA's `message` event only covers messages
received from *other* people, so `message.any` is required to see the
linked account's own `.menu` command. (3) The webhook handler ignores
everything except messages where `fromMe` is true and the body is exactly
`.menu`. (4) On a match, it sends the group a text, looks up its own JID
via `/api/sessions/{name}/me`, and calls WAHA's demote-participant endpoint
with its own JID as the target.
