const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE"], allowedHeaders: ["Content-Type"] }));
app.use(bodyParser.json());

// ===== FILES =====
const DATA_FILE = './data.json';
const TPL_FILE = './templates.json';
const SESSION_DIR = './wa-session';

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

function readData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e){}
  return { clients: [] };
}
function writeData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function readTemplates() {
  try { if (fs.existsSync(TPL_FILE)) return JSON.parse(fs.readFileSync(TPL_FILE, 'utf8')); } catch(e){}
  return defaultTemplates();
}
function writeTemplates(t) { fs.writeFileSync(TPL_FILE, JSON.stringify(t, null, 2)); }

function defaultTemplates() {
  return [
    {
      id: 'expired', name: 'Panel Expire Ho Gaya', type: 'expired', icon: 'fa-circle-xmark',
      msg: 'Assalam o Alaikum *{naam}* bhai! 👋\n\nAapka *SMM Panel* expire ho gaya hai.\n📅 Expiry: {expiry}\n\nPanel dobara activate karwane ke liye abhi rabta karein.\n\nShukriya! 🙏\n— SMM Panel Team'
    },
    {
      id: 'expiring', name: 'Expiry Reminder', type: 'expiring', icon: 'fa-clock',
      msg: 'Assalam o Alaikum *{naam}* bhai! ⚠️\n\nAapka *SMM Panel* sirf *{din} din* mein expire hone wala hai!\n📅 Expiry: {expiry}\n\nAbhi renew karwain warna panel band ho jaayega.\n\nShukria! 🙏\n— SMM Panel Team'
    },
    {
      id: 'activated', name: 'Plan Active Ho Gaya', type: 'activated', icon: 'fa-circle-check',
      msg: 'Assalam o Alaikum *{naam}* bhai! 🎉\n\nAapka *SMM Panel* successfully activate ho gaya hai!\n📅 Expiry: {expiry}\n\n✅ Aap ab apna panel use kar sakte hain.\n\nShukria! 🙏\n— SMM Panel Team'
    }
  ];
}

// ===== WHATSAPP =====
let sock = null;
let waStatus = 'disconnected';
let lastQRCode = null;
let reconnectTimer = null;

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['SMM Panel', 'Chrome', '1.0'],
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waStatus = 'qr';
        try {
          lastQRCode = await QRCode.toDataURL(qr);
          console.log('QR Code ready — scan karo!');
        } catch(e) {
          lastQRCode = null;
        }
      }

      if (connection === 'open') {
        waStatus = 'connected';
        lastQRCode = null;
        console.log('✅ WhatsApp connected!');
      }

      if (connection === 'close') {
        waStatus = 'disconnected';
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('Disconnected. Code:', code, '| Reconnect:', shouldReconnect);
        if (shouldReconnect) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectWhatsApp, 5000);
        } else {
          // Logged out — session delete karo
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR); } catch(e){}
          setTimeout(connectWhatsApp, 3000);
        }
      }
    });

  } catch(err) {
    console.error('WA connect error:', err.message);
    waStatus = 'disconnected';
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWhatsApp, 10000);
  }
}

// ===== HELPERS =====
function statusOf(expiry) {
  const today = new Date(); today.setHours(0,0,0,0);
  const exp = new Date(expiry); exp.setHours(0,0,0,0);
  const diff = Math.round((exp - today) / 86400000);
  if (diff < 0) return { type: 'expired', days: diff };
  if (diff <= 7) return { type: 'expiring', days: diff };
  return { type: 'active', days: diff };
}
function formatDate(d) {
  if (!d) return '—';
  const [y,m,dd] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${dd} ${months[+m-1]} ${y}`;
}
function fillTpl(tpl, client) {
  const st = statusOf(client.expiry);
  return tpl
    .replace(/{naam}/g, client.name)
    .replace(/{expiry}/g, formatDate(client.expiry))
    .replace(/{din}/g, Math.abs(st.days));
}
function cleanNumber(num) {
  if (!num) return null;
  let n = num.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '92' + n.slice(1);
  if (!n.includes('@')) n = n + '@s.whatsapp.net';
  return n;
}

async function sendMsg(number, message) {
  if (waStatus !== 'connected' || !sock) {
    console.log('WA not connected — message skip');
    return false;
  }
  try {
    const jid = cleanNumber(number);
    if (!jid) return false;
    await sock.sendMessage(jid, { text: message });
    console.log('✅ Message sent to:', number);
    return true;
  } catch(e) {
    console.error('Send error:', e.message);
    return false;
  }
}

// ===== SCHEDULER — Roz 9 baje Pakistan time =====
cron.schedule('0 9 * * *', async () => {
  console.log('⏰ Scheduler running — checking clients...');
  const data = readData();
  const tpls = readTemplates();
  const expiredTpl = tpls.find(t => t.id === 'expired');
  const expiringTpl = tpls.find(t => t.id === 'expiring');

  for (const client of data.clients) {
    if (!client.contact) continue;
    const st = statusOf(client.expiry);

    // Expire hone ki agli subah
    if (st.type === 'expired' && st.days === -1) {
      const msg = fillTpl(expiredTpl.msg, client);
      await sendMsg(client.contact, msg);
      console.log('Expired msg:', client.name);
    }

    // 7, 3, 1 din pehle reminder
    if (st.type === 'expiring' && [7, 3, 1].includes(st.days)) {
      const msg = fillTpl(expiringTpl.msg, client);
      await sendMsg(client.contact, msg);
      console.log(`${st.days}-day reminder:`, client.name);
    }
  }
}, { timezone: 'Asia/Karachi' });

// ===== API ROUTES =====
app.get('/', (req, res) => {
  res.json({
    status: '✅ SMM Panel Backend Running',
    whatsapp: waStatus,
    time: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
  });
});

app.get('/api/status', (req, res) => {
  res.json({ waStatus, connected: waStatus === 'connected' });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: lastQRCode, status: waStatus });
});

app.get('/api/clients', (req, res) => {
  res.json(readData().clients);
});

app.post('/api/clients', (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid' });
  writeData({ clients });
  res.json({ success: true, count: clients.length });
});

app.post('/api/clients/add', async (req, res) => {
  const data = readData();
  const client = { ...req.body, id: Date.now() };
  data.clients.push(client);
  writeData(data);
  // Activation message
  if (client.contact) {
    const tpls = readTemplates();
    const tpl = tpls.find(t => t.id === 'activated');
    if (tpl) await sendMsg(client.contact, fillTpl(tpl.msg, client));
  }
  res.json({ success: true, client });
});

app.put('/api/clients/:id', (req, res) => {
  const data = readData();
  const idx = data.clients.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.clients[idx] = { ...data.clients[idx], ...req.body };
  writeData(data);
  res.json({ success: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const data = readData();
  data.clients = data.clients.filter(c => c.id !== parseInt(req.params.id));
  writeData(data);
  res.json({ success: true });
});

app.get('/api/templates', (req, res) => res.json(readTemplates()));

app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  if (!Array.isArray(templates)) return res.status(400).json({ error: 'Invalid' });
  writeTemplates(templates);
  res.json({ success: true });
});

app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: 'number aur message zaroori hai' });
  const sent = await sendMsg(number, message);
  res.json({ success: sent, waStatus });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); fs.mkdirSync(SESSION_DIR); } catch(e){}
    waStatus = 'disconnected';
    setTimeout(connectWhatsApp, 2000);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  connectWhatsApp();
});
