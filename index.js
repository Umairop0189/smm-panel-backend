const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DATA_FILE = './data.json';
const TPL_FILE = './templates.json';

function readData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  return { clients: [] };
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function readTemplates() {
  try { if (fs.existsSync(TPL_FILE)) return JSON.parse(fs.readFileSync(TPL_FILE, 'utf8')); } catch (e) {}
  return getDefaultTemplates();
}
function writeTemplates(tpls) { fs.writeFileSync(TPL_FILE, JSON.stringify(tpls, null, 2)); }
function getDefaultTemplates() {
  return [
    { id: 'expired', name: 'Panel Expire Ho Gaya', type: 'expired', msg: 'Assalam o Alaikum {naam} bhai! 👋\n\nAapka *SMM Panel* expire ho gaya hai.\n📅 Expiry: {expiry}\n\nPanel dobara activate karwane ke liye rabta karein.\n\nShukriya! 🙏\n— SMM Panel Team' },
    { id: 'expiring', name: 'Expiry Reminder', type: 'expiring', msg: 'Assalam o Alaikum {naam} bhai! ⚠️\n\nAapka *SMM Panel* sirf *{din} din* mein expire hone wala hai!\n📅 Expiry: {expiry}\n\nAbhi renew karwain warna panel band ho jaayega.\n\nShukria! 🙏\n— SMM Panel Team' },
    { id: 'activated', name: 'Plan Active Ho Gaya', type: 'activated', msg: 'Assalam o Alaikum {naam} bhai! 🎉\n\nAapka *SMM Panel* successfully activate ho gaya hai!\n📅 Expiry: {expiry}\n\n✅ Aap ab apna panel use kar sakte hain.\n\nShukria! 🙏\n— SMM Panel Team' }
  ];
}

// ===== WHATSAPP =====
let waClient = null;
let waStatus = 'disconnected';
let lastQR = null;

function initWhatsApp() {
  console.log('WhatsApp client starting...');

  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--single-process'
  ];

  // Chromium executable path dhundo
  const possiblePaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser', 
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/nix/store/*/bin/chromium'
  ];

  let execPath = undefined;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) { execPath = p; break; }
  }

  const clientConfig = {
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
    }
  };

  if (execPath) {
    clientConfig.puppeteer.executablePath = execPath;
    console.log('Chromium found at:', execPath);
  } else {
    console.log('Using bundled Chromium...');
  }

  waClient = new Client(clientConfig);

  waClient.on('qr', (qr) => {
    waStatus = 'qr';
    lastQR = qr;
    console.log('QR Code ready!');
    qrcode.generate(qr, { small: true });
  });

  waClient.on('ready', () => {
    waStatus = 'connected';
    lastQR = null;
    console.log('WhatsApp connected!');
  });

  waClient.on('auth_failure', () => {
    waStatus = 'disconnected';
    console.log('Auth failed — retry...');
    setTimeout(initWhatsApp, 10000);
  });

  waClient.on('disconnected', (reason) => {
    waStatus = 'disconnected';
    console.log('Disconnected:', reason);
    setTimeout(initWhatsApp, 10000);
  });

  waClient.initialize().catch(err => {
    console.error('WA init error:', err.message);
    waStatus = 'disconnected';
    setTimeout(initWhatsApp, 15000);
  });
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
  const [y, m, dd] = d.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${dd} ${months[+m-1]} ${y}`;
}
function fillTemplate(tpl, client) {
  const st = statusOf(client.expiry);
  return tpl.replace(/{naam}/g, client.name).replace(/{expiry}/g, formatDate(client.expiry)).replace(/{din}/g, Math.abs(st.days));
}
function cleanNumber(num) {
  if (!num) return null;
  let n = num.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '92' + n.slice(1);
  return n + '@c.us';
}
async function sendWAMessage(number, message) {
  if (waStatus !== 'connected' || !waClient) {
    console.log('WA not connected — skipping');
    return false;
  }
  try {
    const chatId = cleanNumber(number);
    if (!chatId) return false;
    await waClient.sendMessage(chatId, message);
    console.log('Message sent to:', number);
    return true;
  } catch (e) {
    console.error('Send error:', e.message);
    return false;
  }
}

// ===== SCHEDULER — Roz 9 baje Pakistan time =====
cron.schedule('0 9 * * *', async () => {
  console.log('Scheduler running...');
  const data = readData();
  const tpls = readTemplates();
  const expiredTpl = tpls.find(t => t.id === 'expired');
  const expiringTpl = tpls.find(t => t.id === 'expiring');

  for (const client of data.clients) {
    if (!client.contact) continue;
    const st = statusOf(client.expiry);
    if (st.type === 'expired' && st.days === -1) {
      await sendWAMessage(client.contact, fillTemplate(expiredTpl.msg, client));
    }
    if (st.type === 'expiring' && [7, 3, 1].includes(st.days)) {
      await sendWAMessage(client.contact, fillTemplate(expiringTpl.msg, client));
    }
  }
}, { timezone: 'Asia/Karachi' });

// ===== API =====
app.get('/', (req, res) => res.json({ status: 'SMM Panel Backend Running ✅', whatsapp: waStatus, time: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) }));
app.get('/api/status', (req, res) => res.json({ waStatus, connected: waStatus === 'connected' }));
app.get('/api/qr', (req, res) => res.json({ qr: lastQR, status: waStatus }));
app.get('/api/clients', (req, res) => res.json(readData().clients));
app.post('/api/clients', (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid' });
  writeData({ clients }); res.json({ success: true });
});
app.post('/api/clients/add', async (req, res) => {
  const data = readData();
  const client = { ...req.body, id: Date.now() };
  data.clients.push(client);
  writeData(data);
  if (client.contact) {
    const tpls = readTemplates();
    const tpl = tpls.find(t => t.id === 'activated');
    if (tpl) await sendWAMessage(client.contact, fillTemplate(tpl.msg, client));
  }
  res.json({ success: true, client });
});
app.put('/api/clients/:id', (req, res) => {
  const data = readData();
  const idx = data.clients.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.clients[idx] = { ...data.clients[idx], ...req.body };
  writeData(data); res.json({ success: true });
});
app.delete('/api/clients/:id', (req, res) => {
  const data = readData();
  data.clients = data.clients.filter(c => c.id !== parseInt(req.params.id));
  writeData(data); res.json({ success: true });
});
app.get('/api/templates', (req, res) => res.json(readTemplates()));
app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  if (!Array.isArray(templates)) return res.status(400).json({ error: 'Invalid' });
  writeTemplates(templates); res.json({ success: true });
});
app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: 'number aur message zaroori' });
  const sent = await sendWAMessage(number, message);
  res.json({ success: sent });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
