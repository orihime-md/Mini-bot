import 'dotenv/config';
import express from 'express';
import axios from 'axios';

// ---- Config -----------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Accepts a bare "host:port" too (e.g. Render's fromService "hostport"
// value), not just a full URL — prepend http:// if no scheme was given.
function normalizeWahaUrl(raw) {
  const trimmed = (raw || 'http://127.0.0.1:3000').replace(/\/$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
const WAHA_URL = normalizeWahaUrl(process.env.WAHA_URL);
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me';
const SESSION_NAME = process.env.SESSION_NAME || 'default';
const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID || '120363429763384848@g.us';

// ---- Tiny WAHA API client ----------------------------------------------
function headers() {
  return WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
}

async function waha(method, url, data) {
  const res = await axios({ method, url: `${WAHA_URL}${url}`, data, headers: headers(), timeout: 30000 });
  return res.data;
}

// message.any is required so the bot sees messages typed from the linked
// number itself (fromMe: true) — WAHA's plain 'message' event only covers
// messages received from other people, never the linked account's own.
function webhookConfig() {
  return {
    webhooks: [
      {
        url: `${PUBLIC_BASE_URL}/webhooks/waha?secret=${encodeURIComponent(WEBHOOK_SECRET)}`,
        events: ['message.any']
      }
    ]
  };
}

async function ensureSession() {
  try {
    await waha('post', '/api/sessions', { name: SESSION_NAME, start: false, config: webhookConfig() });
  } catch (err) {
    // Session probably already exists — push current webhook config to it
    // anyway so a redeploy always re-applies the latest secret/events.
    try { await waha('put', `/api/sessions/${SESSION_NAME}`, { config: webhookConfig() }); } catch {}
  }
  await waha('post', `/api/sessions/${SESSION_NAME}/start`, {});
}

async function getMe() {
  return waha('get', `/api/sessions/${SESSION_NAME}/me`);
}

async function getSessionStatus() {
  const data = await waha('get', `/api/sessions/${SESSION_NAME}`);
  return data?.status || 'UNKNOWN';
}

async function requestPairingCode(phoneNumber) {
  return waha('post', `/api/${SESSION_NAME}/auth/request-code`, { phoneNumber });
}

async function sendText(chatId, text) {
  return waha('post', '/api/sendText', { session: SESSION_NAME, chatId, text });
}

async function demoteSelf(groupId, myJid) {
  return waha('post', `/api/${SESSION_NAME}/groups/${encodeURIComponent(groupId)}/admin/demote`, {
    participants: [myJid]
  });
}

// ---- Webhook server ------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname)); // serves public/index.html at "/"

// Pairing page ("public/index.html") calls these two:
app.get('/api/status', async (_req, res) => {
  try {
    res.json({ status: await getSessionStatus() });
  } catch (err) {
    const message = err?.response?.data?.message || err?.message || 'status check failed';
    console.error('[minibot] /api/status failed:', {
      message,
      httpStatus: err?.response?.status,
      wahaUrl: WAHA_URL,
      wahaBody: err?.response?.data
    });
    res.status(500).json({ error: message });
  }
});

app.post('/api/pair', async (req, res) => {
  const phoneNumber = String(req.body?.phoneNumber || '').replace(/[^0-9]/g, '');
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required (digits only, with country code, no +)' });
  try {
    console.log(`[minibot] /api/pair requested for ${phoneNumber} via ${WAHA_URL}`);
    const result = await requestPairingCode(phoneNumber);
    const code = result?.code || result;
    console.log('[minibot] /api/pair succeeded:', code);
    res.json({ code });
  } catch (err) {
    const message = err?.response?.data?.message || err?.message || 'pairing request failed';
    console.error('[minibot] /api/pair failed:', {
      message,
      httpStatus: err?.response?.status,
      wahaUrl: WAHA_URL,
      wahaBody: err?.response?.data
    });
    res.status(500).json({ error: message });
  }
});

app.post('/webhooks/waha', async (req, res) => {
  const secret = String(req.query.secret || '');
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'invalid secret' });
  res.sendStatus(200); // ack immediately, process after

  try {
    const event = req.body?.event;
    const payload = req.body?.payload;
    if (event !== 'message.any' && event !== 'message') return;
    if (!payload?.fromMe) return; // only react to the linked account's own messages

    const body = String(payload.body || '').trim();

    // .pair 234xxxxxxxxxx
    // Request a WhatsApp pairing code from WAHA and return it to the same chat
    // where the linked account typed the command. This deliberately follows the
    // existing fromMe-only command model, so the command can only be triggered
    // by the linked account itself.
    const pairMatch = body.match(/^\.pair(?:\s+([+0-9\s()\-]+))?$/i);
    if (pairMatch) {
      const rawPhoneNumber = String(pairMatch[1] || '').trim();
      const phoneNumber = rawPhoneNumber.replace(/\D/g, '');
      const replyChatId = payload.to || payload.chatId || payload.from;

      if (!rawPhoneNumber || !phoneNumber) {
        if (replyChatId) {
          await sendText(replyChatId, '❌ Usage: .pair 2348163201351\nUse the full number with country code, without +.');
        }
        return;
      }

      if (phoneNumber.length < 10 || phoneNumber.length > 15) {
        if (replyChatId) {
          await sendText(replyChatId, '❌ Invalid phone number. Use the full international number, digits only (10–15 digits).');
        }
        return;
      }

      console.log(`[minibot] .pair received — requesting pairing code for ${phoneNumber}`);

      try {
        const result = await requestPairingCode(phoneNumber);
        const code = typeof result === 'string' ? result : result?.code;

        if (!code) {
          throw new Error('WAHA did not return a pairing code');
        }

        if (replyChatId) {
          await sendText(
            replyChatId,
            `🔐 *WhatsApp Pairing Code*\n\n*Number:* ${phoneNumber}\n*Code:* \`${code}\`\n\nOpen WhatsApp → Linked Devices → Link a Device → Link with phone number instead, then enter the code.`
          );
        }

        console.log(`[minibot] pairing code generated successfully for ${phoneNumber}`);
      } catch (err) {
        const message = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'pairing request failed';
        console.error('[minibot] .pair failed:', err?.response?.data || err?.message || err);
        if (replyChatId) {
          await sendText(replyChatId, `❌ Pairing failed: ${message}`);
        }
      }
      return;
    }

    if (!/^\.menu$/i.test(body)) return;

    console.log('[minibot] .menu received from linked account — starting self-demote sequence');

    await sendText(TARGET_GROUP_ID, 'Demoting in progress');

    const me = await getMe();
    const myJid = me?.id || me?.wid;
    if (!myJid) {
      console.error('[minibot] could not resolve own jid — aborting demote');
      return;
    }

    await demoteSelf(TARGET_GROUP_ID, myJid);
    console.log('[minibot] self-demote request sent for', myJid, 'in', TARGET_GROUP_ID);
  } catch (err) {
    console.error('[minibot] error handling webhook:', err?.response?.data || err?.message || err);
  }
});

app.listen(PORT, async () => {
  console.log(`[minibot] listening on ${PORT}`);
  console.log('[minibot] config:', {
    WAHA_URL,
    WAHA_API_KEY_set: Boolean(WAHA_API_KEY),
    PUBLIC_BASE_URL,
    SESSION_NAME
  });
  try {
    await ensureSession();
    console.log('[minibot] WAHA session ensured/started:', SESSION_NAME);
  } catch (err) {
    console.error('[minibot] failed to start WAHA session:', {
      message: err?.message,
      httpStatus: err?.response?.status,
      wahaBody: err?.response?.data
    });
  }
});
