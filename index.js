const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONNECTED_STATES = ['islogged', 'qrreadsuccess', 'inchat', 'connected', 'open'];
const DISCONNECTED_STATES = ['qrreadfail', 'notlogged', 'desconnectedmobile', 'browserclose', 'autoclosecalled', 'disconnected'];

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/session', (req, res) => {
  const sanitized = sanitizePhone(req.body?.phone);
  const localDigits = normalizeLocalPhone(sanitized);
  const companyRaw = (req.body?.company || '').toString().trim();
  const companyName = companyRaw.slice(0, 50);

  if (localDigits.length < 10) {
    return res.status(400).json({ success: false, message: 'Telefone inválido. Informe DDD + número.' });
  }

  const internationalDigits = ensureCountryCode(localDigits);
  const sessionId = `session_${internationalDigits}`;
  const existingSession = sessions.get(sessionId);

  if (existingSession && existingSession.status === 'CONECTADO') {
    return res.status(400).json({
      success: false,
      message: 'Número já conectado. Desconecte o aparelho antes de gerar um novo QR.',
    });
  }

  const sessionData = existingSession || createSession(sessionId, internationalDigits, localDigits, companyName);

  if (companyName && sessionData) {
    sessionData.company = companyName;
  }

  return res.json({ success: true, session: serializeSession(sessionData) });
});

app.get('/api/session/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionData = sessions.get(sessionId);

  if (!sessionData) {
    return res.status(404).json({ success: false, message: 'Sessão não encontrada.' });
  }

  if (sessionData.status === 'CONECTADO' && (!sessionData.devices || sessionData.devices.length === 0)) {
    await fetchDeviceInfo(sessionId);
  }

  return res.json({ success: true, session: serializeSession(sessionData) });
});

app.get('/api/sessions', async (_req, res) => {
  const entries = Array.from(sessions.entries());
  await Promise.all(
    entries.map(async ([sessionId, data]) => {
      if (data.status === 'CONECTADO' && (!data.devices || data.devices.length === 0)) {
        await fetchDeviceInfo(sessionId);
      }
    })
  );
  const payload = entries.map(([, data]) => serializeSession(data));
  return res.json({ success: true, sessions: payload });
});

app.delete('/api/session/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionData = sessions.get(sessionId);

  if (!sessionData) {
    return res.status(404).json({ success: false, message: 'Sessão não encontrada.' });
  }

  try {
    if (sessionData.client) {
      await sessionData.client.close();
    }
  } catch (error) {
    console.error(`Erro ao encerrar sessão ${sessionId}:`, error);
  }

  sessions.delete(sessionId);
  await deleteSessionArtifacts(sessionId);
  return res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor WPPConnect ouvindo na porta ${PORT}`));

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function createSession(sessionId, phoneIntl, phoneLocal, company = '') {
  const sessionData = {
    sessionId,
    phone: phoneLocal,
    phoneIntl,
    company,
    status: 'AGUARDANDO_QR',
    qrCode: null,
    qrCodeAscii: null,
    updatedAt: new Date().toISOString(),
    connectedAt: null,
    devices: [],
    rawStatus: null,
    error: null,
    client: null,
  };

  sessions.set(sessionId, sessionData);

  wppconnect
    .create({
      session: sessionId,
      autoClose: 0,
      headless: true,
      devtools: false,
      useChrome: true,
      logQR: true,
      puppeteerOptions: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      },
      catchQR: (base64Qr, asciiQR) => updateQrCode(sessionId, base64Qr, asciiQR),
      statusFind: (statusSession) => handleStatusChange(sessionId, statusSession),
    })
    .then((client) => {
      sessionData.client = client;
      registerClientEvents(sessionId, client);
      sessionData.updatedAt = new Date().toISOString();
    })
    .catch((error) => {
      sessionData.status = 'ERRO';
      sessionData.error = error.message || 'Falha ao iniciar sessão';
      sessionData.updatedAt = new Date().toISOString();
      console.error(`Erro ao iniciar sessão ${sessionId}:`, error);
    });

  return sessionData;
}

function updateQrCode(sessionId, base64Qr, asciiQr) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  if (base64Qr) {
    const formatted = base64Qr.startsWith('data:')
      ? base64Qr
      : `data:image/png;base64,${base64Qr}`;
    sessionData.qrCode = formatted;
  }

  if (asciiQr) {
    sessionData.qrCodeAscii = asciiQr;
  }

  if (base64Qr || asciiQr) {
    sessionData.status = 'AGUARDANDO_LEITURA';
    sessionData.updatedAt = new Date().toISOString();
  }
}

function handleStatusChange(sessionId, statusSession) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) {
    return;
  }

  const normalized = normalizeStatus(statusSession);
  sessionData.rawStatus = statusSession;
  sessionData.status = normalized;
  sessionData.updatedAt = new Date().toISOString();

  if (normalized === 'CONECTADO') {
    sessionData.connectedAt = sessionData.connectedAt || sessionData.updatedAt;
    sessionData.qrCode = null;
    fetchDeviceInfo(sessionId);
  }
}

function normalizeStatus(statusSession) {
  if (!statusSession) {
    return 'DESCONHECIDO';
  }

  const value = statusSession.toString().toLowerCase();

  if (CONNECTED_STATES.includes(value)) {
    return 'CONECTADO';
  }

  if (DISCONNECTED_STATES.includes(value)) {
    return 'DESCONECTADO';
  }

  return statusSession.toString().toUpperCase();
}

function registerClientEvents(sessionId, client) {
  client.onStateChange((state) => handleStatusChange(sessionId, state));

  client.onMessage(async (message) => {
    if (message.body?.trim() === '!ping') {
      await client.sendText(message.from, 'pong');
    }
  });
}

async function fetchDeviceInfo(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData?.client) {
    return;
  }

  try {
    const device = await sessionData.client.getHostDevice();
    if (!device) {
      return;
    }

    sessionData.devices = [
      {
        id: device.wid?.user || sessionData.phoneIntl,
        pushName: device.pushname || 'Sem nome',
        battery: typeof device.battery === 'number' ? `${device.battery}%` : null,
        plugged: device.plugged ?? null,
        platform: device.platform || null,
      },
    ];
    sessionData.updatedAt = new Date().toISOString();
  } catch (error) {
    console.error(`Erro ao obter aparelho da sessão ${sessionId}:`, error.message);
  }
}

function serializeSession(sessionData) {
  if (!sessionData) {
    return null;
  }

  return {
    sessionId: sessionData.sessionId,
    phone: sessionData.phone,
    phoneIntl: sessionData.phoneIntl,
    company: sessionData.company,
    status: sessionData.status,
    qrCode: sessionData.qrCode,
    qrCodeAscii: sessionData.qrCodeAscii,
    updatedAt: sessionData.updatedAt,
    connectedAt: sessionData.connectedAt,
    devices: sessionData.devices || [],
    error: sessionData.error,
  };
}

function normalizeLocalPhone(digits) {
  if (!digits) {
    return '';
  }

  if (digits.startsWith('55') && digits.length > 11) {
    return digits.slice(2);
  }

  return digits;
}

function ensureCountryCode(localDigits) {
  if (!localDigits) {
    return '';
  }

  return localDigits.startsWith('55') ? localDigits : `55${localDigits}`;
}

async function deleteSessionArtifacts(sessionId) {
  const dirPath = path.join(__dirname, 'tokens', sessionId);

  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.error(`Erro ao remover pasta da sessão ${sessionId}:`, error.message);
  }
}
