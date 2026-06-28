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

// ===== DATA FILE =====
const DATA_FILE = './data.json';
const TPL_FILE = './templates.json';

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { clients: [] };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readTemplates() {
  try {
    if (fs.existsSync(TPL_FILE)) return JSON.parse(fs.readFileSync(TPL_FILE, 'utf8'));
  } catch (e) {}
  return getDefaultTemplates();
}

function writeTemplates(tpls) {
  fs.writeFileSync(TPL_FILE, JSON.stringify(tpls, null, 2));
}

function getDefaultTemplates() {
  return [
    {
      id: 'expired',
      name: 'Panel Expire Ho Gaya',
      type: 'expired',
      msg: 'Assalam o Alaikum {naam} bhai! 👋\n\nAapka *SMM Panel* expire ho gaya hai.\n📅 Expiry: {expiry}\n\nPanel dobara activate karwane ke liye rabta karein.\n\nShukriya! 🙏\n— SMM Panel Team'
    },
    {
      id: 'expiring',
      name: 'Expiry Reminder',
      type: 'expiring',
      msg: 'Assalam o Alaikum {naam} bhai! ⚠️\n\nAapka *SMM Panel* sirf *{din} din* mein expire hone wala hai!\n📅 Expiry: {expiry}\n\nAbhi renew karwain warna panel band ho jaayega.\n\nShukria! 🙏\n— SMM Panel Team'
    },
    {
      id: 'activated',
      name: 'Plan Active Ho Gaya',
      type: 'activated',
      msg: 'Assalam o Alaikum {naam} bhai! 🎉\n\nAapka *SMM Panel* successfully activate ho gaya hai!\n📅 Expiry: {expiry}\n\n✅ Aap ab apna panel use kar sakte hain.\n\nShukria! 🙏\n— SMM Panel Team'
    }
  ];
}

// ===== WHATSAPP CLIENT =====
let waClient = null;
let waStatus = 'disconnected'; // disconnected | qr | connected
let lastQR = null;

function initWhatsApp() {
  console.log('WhatsApp client starting...');
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      headless: true
    }
  });

  waClient.on('qr', (qr) => {
    waStatus = 'qr';
    lastQR = qr;
    console.log('QR Code ready — scan karo!');
    qrcode.generate(qr, { small: true });
  });

  waClient.on('ready', () => {
    waStatus = 'connected';
    lastQR = null;
    console.log('WhatsApp connected!');
  });

  waClient.on('disconnected', (reason) => {
    waStatus = 'disconnected';
    console.log('WhatsApp disconnected:', reason);
    setTimeout(initWhatsApp, 5000);
  });

  waClient.initialize();
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
  return tpl
    .replace(/{naam}/g, client.name)
    .replace(/{expiry}/g, formatDate(client.expiry))
    .replace(/{din}/g, Math.abs(st.days));
}

function cleanNumber(num) {
  if (!num) return null;
  let n = num.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '92' + n.slice(1);
  return n + '@c.us';
}

async function sendWAMessage(number, message) {
  if (waStatus !== 'connected' || !waClient) {
    console.log('WhatsApp not connected — message not sent');
    return false;
  }
  try {
    const chatId = cleanNumber(number);
    if (!chatId) return false;
    await waClient.sendMessage(chatId, message);
    console.log(`Message sent to ${number}`);
    return true;
  } catch (e) {
    console.error('Send error:', e.message);
    return false;
  }
}

// ===== SCHEDULER =====
// Roz subah 9 baje check kare
cron.schedule('0 9 * * *', async () => {
  console.log('Scheduler running — checking expiry...');
  const data = readData();
  const tpls = readTemplates();
  const expiredTpl = tpls.find(t => t.id === 'expired');
  const expiringTpl = tpls.find(t => t.id === 'expiring');

  for (const client of data.clients) {
    if (!client.contact) continue;
    const st = statusOf(client.expiry);

    // Expired clients — ek baar message (jis din expire hua)
    if (st.type === 'expired' && st.days === -1) {
      const msg = fillTemplate(expiredTpl.msg, client);
      await sendWAMessage(client.contact, msg);
      console.log(`Expired msg sent: ${client.name}`);
    }

    // 7 din pehle reminder
    if (st.type === 'expiring' && st.days === 7) {
      const msg = fillTemplate(expiringTpl.msg, client);
      await sendWAMessage(client.contact, msg);
      console.log(`7-day reminder sent: ${client.name}`);
    }

    // 3 din pehle reminder
    if (st.type === 'expiring' && st.days === 3) {
      const msg = fillTemplate(expiringTpl.msg, client);
      await sendWAMessage(client.contact, msg);
      console.log(`3-day reminder sent: ${client.name}`);
    }

    // 1 din pehle reminder
    if (st.type === 'expiring' && st.days === 1) {
      const msg = fillTemplate(expiringTpl.msg, client);
      await sendWAMessage(client.contact, msg);
      console.log(`1-day reminder sent: ${client.name}`);
    }
  }
}, { timezone: 'Asia/Karachi' });

// ===== API ROUTES =====

// Status
app.get('/api/status', (req, res) => {
  res.json({ waStatus, connected: waStatus === 'connected' });
});

// QR Code
app.get('/api/qr', (req, res) => {
  if (waStatus === 'qr' && lastQR) {
    res.json({ qr: lastQR, status: 'qr' });
  } else {
    res.json({ qr: null, status: waStatus });
  }
});

// Get all clients
app.get('/api/clients', (req, res) => {
  const data = readData();
  res.json(data.clients);
});

// Save all clients
app.post('/api/clients', (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: 'Invalid data' });
  writeData({ clients });
  res.json({ success: true, count: clients.length });
});

// Add single client
app.post('/api/clients/add', async (req, res) => {
  const data = readData();
  const client = req.body;
  client.id = Date.now();
  data.clients.push(client);
  writeData(data);

  // Plan activate message bhejna
  if (client.contact) {
    const tpls = readTemplates();
    const activeTpl = tpls.find(t => t.id === 'activated');
    if (activeTpl) {
      const msg = fillTemplate(activeTpl.msg, client);
      await sendWAMessage(client.contact, msg);
    }
  }
  res.json({ success: true, client });
});

// Update client
app.put('/api/clients/:id', (req, res) => {
  const data = readData();
  const id = parseInt(req.params.id);
  const idx = data.clients.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.clients[idx] = { ...data.clients[idx], ...req.body };
  writeData(data);
  res.json({ success: true });
});

// Delete client
app.delete('/api/clients/:id', (req, res) => {
  const data = readData();
  const id = parseInt(req.params.id);
  data.clients = data.clients.filter(c => c.id !== id);
  writeData(data);
  res.json({ success: true });
});

// Get templates
app.get('/api/templates', (req, res) => {
  res.json(readTemplates());
});

// Save templates
app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  if (!Array.isArray(templates)) return res.status(400).json({ error: 'Invalid' });
  writeTemplates(templates);
  res.json({ success: true });
});

// Manual send message
app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: 'number aur message zaroori hai' });
  const sent = await sendWAMessage(number, message);
  res.json({ success: sent });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SMM Panel Backend Running',
    whatsapp: waStatus,
    time: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
  });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
