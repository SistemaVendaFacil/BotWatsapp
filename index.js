const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const wppconnect = require('@wppconnect-team/wppconnect');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();

// Configuração do banco de dados direta
const dbConfig = {
  host: process.env.DB_HOST || 'srv881.hstgr.io', // <-- Host oficial da Hostinger
  user: process.env.DB_USER || 'u490253103_automacao',
  password: process.env.DB_PASSWORD || 'Y4m4t02@12345',
  database: process.env.DB_NAME || 'u490253103_automacao',
  charset: 'utf8mb4',
  timezone: '-03:00'
};

// Variáveis de controle do agendador
let agendamentoAtivo = false;
let intervaloVerificacao = null;

app.use(cors({
    origin: ['http://localhost', 'http://127.0.0.1', 'http://192.168.15.100:8080', 'https://sistemavendafacil.com'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware CORS para todas as respostas
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

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

app.post('/api/send-message', async (req, res) => {
  const { sessionId, phone, message } = req.body || {};

  if (!sessionId || !phone || !message) {
    return res.status(400).json({ success: false, message: 'sessionId, phone e message são obrigatórios.' });
  }

  const sessionData = sessions.get(sessionId);
  if (!sessionData) {
    return res.status(404).json({ success: false, message: 'Sessão não encontrada.' });
  }

  if (!['CONECTADO', 'SYNCING'].includes(sessionData.status) || !sessionData.client) {
    return res.status(503).json({ success: false, message: 'Sessão não está conectada.' });
  }

  const isGroup = String(phone).includes('@g.us');
  let chatId;

  if (isGroup) {
    chatId = String(phone).trim();
  } else {
    const digits = String(phone).replace(/\D/g, '');
    const phoneIntl = digits.startsWith('55') ? digits : `55${digits}`;
    chatId = `${phoneIntl}@c.us`;
  }

  try {
    await sessionData.client.sendText(chatId, message);
    return res.json({ success: true, message: 'Mensagem enviada com sucesso.' });
  } catch (error) {
    console.error(`Erro ao enviar mensagem na sessão ${sessionId}:`, error.message);
    return res.status(500).json({ success: false, message: error.message || 'Erro ao enviar mensagem.' });
  }
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

app.listen(PORT, () => {
  console.log(`Servidor WPPConnect ouvindo na porta ${PORT}`);
  restorePersistedSessions();
  // Inicia o verificador de agendamentos
  iniciarVerificadorAgendamentos();
});

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

async function restorePersistedSessions() {
  const tokensDir = path.join(__dirname, 'tokens');

  let entries;
  try {
    entries = await fs.promises.readdir(tokensDir, { withFileTypes: true });
  } catch {
    return;
  }

  const sessionDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('session_'));

  if (!sessionDirs.length) {
    console.log('[Restore] Nenhuma sessão persistida encontrada.');
    return;
  }

  console.log(`[Restore] Restaurando ${sessionDirs.length} sessão(ões)...`);

  for (const dir of sessionDirs) {
    const sessionId = dir.name;

    if (sessions.has(sessionId)) {
      continue;
    }

    const phoneIntl = sessionId.replace('session_', '');
    const phoneLocal = phoneIntl.startsWith('55') ? phoneIntl.slice(2) : phoneIntl;

    const sessionData = {
      sessionId,
      phone: phoneLocal,
      phoneIntl,
      company: '',
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
        logQR: false,
        puppeteerOptions: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        catchQR: (base64Qr, asciiQR) => {
          console.log(`[Restore] Sessão ${sessionId} expirou, QR Code necessário.`);
          updateQrCode(sessionId, base64Qr, asciiQR);
        },
        statusFind: (statusSession) => handleStatusChange(sessionId, statusSession),
      })
      .then((client) => {
        sessionData.client = client;
        registerClientEvents(sessionId, client);
        sessionData.updatedAt = new Date().toISOString();
        console.log(`[Restore] Sessão ${sessionId} restaurada com sucesso.`);
      })
      .catch((error) => {
        sessionData.status = 'ERRO';
        sessionData.error = error.message || 'Falha ao restaurar sessão';
        sessionData.updatedAt = new Date().toISOString();
        console.error(`[Restore] Erro ao restaurar sessão ${sessionId}:`, error.message);
      });
  }
}

// Sistema de verificação de agendamentos
async function iniciarVerificadorAgendamentos() {
  if (agendamentoAtivo) {
    console.log('[Agendador] Verificador já está ativo.');
    return;
  }

  agendamentoAtivo = true;
  console.log('[Agendador] Iniciando verificador de agendamentos...');

  // Executa a primeira verificação imediatamente
  await verificarAgendamentos();

  // Configura para verificar a cada 5 minutos (300000ms)
  intervaloVerificacao = setInterval(async () => {
    try {
      await verificarAgendamentos();
    } catch (error) {
      console.error('[Agendador] Erro na verificação:', error.message);
    }
  }, 300000); // 5 minutos

  console.log('[Agendador] Verificador configurado para rodar a cada 5 minutos.');
}

async function verificarAgendamentos() {
  console.log('[Agendador] Verificando agendamentos...');
  
  let connection;
  try {
    console.log('[Agendador] Conectando ao banco de dados...');
    connection = await mysql.createConnection(dbConfig);
    console.log('[Agendador] Conectado ao banco com sucesso!');
    
    // Define fuso horário de Brasília igual ao arquivo PHP
    await connection.execute("SET time_zone = '-03:00'");
    console.log('[Agendador] Timezone configurado para -03:00');
    
    // Busca agendamentos que precisam de notificação
    console.log('[Agendador] Executando query de agendamentos...');
    const [agendamentos] = await connection.execute(`
      SELECT 
        t.id,
        t.usuario,
        c.nome_cliente,
        c.telefone_cliente,
        t.setor,
        t.assunto,
        t.descricao,
        t.agendamento,
        t.whatsapp_enviado,
        t.whatsapp_grupo_enviado,
        t.responsavel_finalizacao as grupo_whatsapp
      FROM tickets t
      LEFT JOIN clientes c ON t.usuario = c.id_memocash
      WHERE DATE(t.agendamento) = CURDATE()
      AND t.agendamento IS NOT NULL
      AND (
        (t.whatsapp_enviado IS NULL AND TIMESTAMPDIFF(MINUTE, NOW(), t.agendamento) = 60)
        OR 
        (t.whatsapp_grupo_enviado IS NULL AND TIMESTAMPDIFF(MINUTE, NOW(), t.agendamento) = 30)
      )
      ORDER BY t.agendamento
    `);

    console.log(`[Agendador] Query executada. Encontrados ${agendamentos.length} agendamentos.`);

    if (agendamentos.length === 0) {
      console.log('[Agendador] Nenhum agendamento para notificar no momento.');
      return;
    }

    console.log(`[Agendador] Encontrados ${agendamentos.length} agendamentos para processar.`);

    for (const agendamento of agendamentos) {
      console.log(`[Agendador] Processando agendamento #${agendamento.id}...`);
      const agora = new Date();
      const dataHoraAgendamento = new Date(agendamento.agendamento);
      const minutosRestantes = Math.floor((dataHoraAgendamento - agora) / (1000 * 60));

      console.log(`[Agendador] Agendamento #${agendamento.id}: ${minutosRestantes} minutos restantes`);

      // Envia mensagem individual 1 hora antes
      if (minutosRestantes <= 60 && minutosRestantes > 59 && !agendamento.whatsapp_enviado) {
        console.log(`[Agendador] Enviando mensagem individual para #${agendamento.id}...`);
        await enviarMensagemIndividual(connection, agendamento);
      }

      // Envia mensagem no grupo 30 minutos antes
      if (minutosRestantes <= 30 && minutosRestantes > 29 && !agendamento.whatsapp_grupo_enviado) {
        console.log(`[Agendador] Enviando mensagem de grupo para #${agendamento.id}...`);
        await enviarMensagemGrupo(connection, agendamento);
      }
    }

  } catch (error) {
    console.error('[Agendador] Erro detalhado ao verificar agendamentos:', error);
    console.error('[Agendador] Stack trace:', error.stack);
  } finally {
    if (connection) {
      try {
        await connection.end();
        console.log('[Agendador] Conexão com banco fechada.');
      } catch (closeError) {
        console.error('[Agendador] Erro ao fechar conexão:', closeError);
      }
    }
  }
}

async function enviarMensagemIndividual(connection, agendamento) {
  try {
    // Pega a primeira sessão conectada disponível
    const sessaoConectada = Array.from(sessions.values()).find(s => s.status === 'CONECTADO' && s.client);
    
    if (!sessaoConectada) {
      console.log('[Agendador] Nenhuma sessão conectada disponível para enviar mensagem individual.');
      return false;
    }

    const mensagem = `📅 *LEMBRETE DE AGENDAMENTO* 📅\n\n` +
      `Olá, ${agendamento.nome_cliente || 'Cliente'}! 👋\n\n` +
      `Você tem um agendamento hoje:\n` +
      `🕐 *Horário:* ${new Date(agendamento.agendamento).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}\n` +
      `📋 *Assunto:* ${agendamento.assunto}\n` +
      `🏢 *Setor:* ${agendamento.setor}\n` +
      `📝 *Descrição:* ${agendamento.descricao}\n\n` +
      `Por favor, prepare-se para o atendimento. Estamos aguardando você! 😊\n\n` +
      `*Atenciosamente,*\n*Equipe Memocash*`;

    // Envia mensagem se tiver telefone disponível
    if (agendamento.telefone_cliente) {
      const telefoneLimpo = agendamento.telefone_cliente.replace(/\D/g, '');
      const telefoneIntl = telefoneLimpo.startsWith('55') ? telefoneLimpo : `55${telefoneLimpo}`;
      const chatId = `${telefoneIntl}@c.us`;

      await sessaoConectada.client.sendText(chatId, mensagem);
      console.log(`[Agendador] Mensagem individual enviada para ${agendamento.nome_cliente} (${agendamento.telefone_cliente})`);
    } else {
      console.log(`[Agendador] Cliente ${agendamento.nome_cliente || agendamento.usuario} não possui telefone cadastrado`);
      console.log(`[Agendador] Conteúdo da mensagem: ${mensagem.replace(/\*/g, '').replace(/\n/g, ' | ')}`);
    }
    
    // Marca como enviado no banco
    await connection.execute(
      'UPDATE tickets SET whatsapp_enviado = NOW() WHERE id = ?',
      [agendamento.id]
    );

    console.log(`[Agendador] Ticket #${agendamento.id} marcado como notificado individualmente`);
    return true;

  } catch (error) {
    console.error(`[Agendador] Erro ao enviar mensagem individual para ${agendamento.nome_cliente}:`, error.message);
    return false;
  }
}

async function enviarMensagemGrupo(connection, agendamento) {
  try {
    // Pega a primeira sessão conectada disponível
    const sessaoConectada = Array.from(sessions.values()).find(s => s.status === 'CONECTADO' && s.client);
    
    if (!sessaoConectada) {
      console.log('[Agendador] Nenhuma sessão conectada disponível para enviar mensagem no grupo.');
      return false;
    }

    if (!agendamento.grupo_whatsapp) {
      console.log(`[Agendador] Agendamento ${agendamento.id} não possui grupo WhatsApp definido.`);
      return false;
    }

    const mensagem = `🚨 *AGENDAMENTO IMINENTE* 🚨\n\n` +
      `⏰ *FALTAM 30 MINUTOS!* ⏰\n\n` +
      `🎫 *Ticket ID:* ${agendamento.id}\n` +
      `� *Usuário:* ${agendamento.nome_cliente}\n` +
      `🏢 *Setor:* ${agendamento.setor}\n` +
      `📋 *Assunto:* ${agendamento.assunto}\n` +
      `� *Descrição:* ${agendamento.descricao}\n` +
      `�� *Horário:* ${new Date(agendamento.agendamento).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}\n\n` +
      `🏃‍♂️ Preparem-se! O atendimento está próximo! 🏃‍♀️\n\n` +
      `🔔 *Não se esqueçam de verificar:* 🔔\n` +
      `✅ Materiais necessários\n` +
      `✅ Espaço preparado\n` +
      `✅ Sistema online\n\n` +
      `*Boa sorte, equipe!* 💪🎉`;

    // OBSERVAÇÃO: Você precisa configurar o grupo WhatsApp no campo responsavel_finalizacao
    // Formato esperado: 5511999998888@g.us
    if (!agendamento.grupo_whatsapp) {
      console.log(`[Agendador] Ticket #${agendamento.id} não possui grupo WhatsApp definido no campo responsavel_finalizacao`);
      return false;
    }

    await sessaoConectada.client.sendText(agendamento.grupo_whatsapp, mensagem);
    
    // Marca como enviado no banco
    await connection.execute(
      'UPDATE tickets SET whatsapp_grupo_enviado = NOW() WHERE id = ?',
      [agendamento.id]
    );

    console.log(`[Agendador] Mensagem de grupo enviada para o ticket #${agendamento.id}`);
    return true;

  } catch (error) {
    console.error(`[Agendador] Erro ao enviar mensagem no grupo para ${agendamento.nome_cliente}:`, error.message);
    return false;
  }
}

// Função para parar o verificador (útil para manutenção)
function pararVerificadorAgendamentos() {
  if (intervaloVerificacao) {
    clearInterval(intervaloVerificacao);
    intervaloVerificacao = null;
    agendamentoAtivo = false;
    console.log('[Agendador] Verificador de agendamentos parado.');
  }
}

// Endpoint para controlar o agendador manualmente
app.post('/api/agendador/parar', (req, res) => {
  pararVerificadorAgendamentos();
  return res.json({ success: true, message: 'Verificador de agendamentos parado.' });
});

app.post('/api/agendador/iniciar', (req, res) => {
  if (!agendamentoAtivo) {
    iniciarVerificadorAgendamentos();
    return res.json({ success: true, message: 'Verificador de agendamentos iniciado.' });
  }
  return res.json({ success: true, message: 'Verificador já está ativo.' });
});

app.get('/api/agendador/status', (req, res) => {
  return res.json({ 
    success: true, 
    ativo: agendamentoAtivo,
    proximaVerificacao: agendamentoAtivo ? '5 minutos' : 'Não agendado'
  });
});

// Endpoint para testar conexão com banco
app.get('/api/test-db', async (req, res) => {
  let connection;
  try {
    console.log('[Test DB] Configuração:', dbConfig);
    connection = await mysql.createConnection(dbConfig);
    await connection.execute("SET time_zone = '-03:00'");
    
    // Testa query simples
    const [result] = await connection.execute('SELECT 1 as test');
    
    // Testa query de agendamentos
    const [agendamentos] = await connection.execute(`
      SELECT COUNT(*) as total FROM tickets 
      WHERE agendamento IS NOT NULL 
      AND DATE(agendamento) = CURDATE()
    `);
    
    await connection.end();
    
    return res.json({
      success: true,
      message: 'Conexão com banco funcionando!',
      dbConfig: {
        host: dbConfig.host,
        database: dbConfig.database,
        user: dbConfig.user
      },
      agendamentosHoje: agendamentos[0].total
    });
    
  } catch (error) {
    console.error('[Test DB] Erro:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (e) {}
    }
  }
});
