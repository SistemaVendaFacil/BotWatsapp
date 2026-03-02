const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const wppconnect = require('@wppconnect-team/wppconnect');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();

// Configuração do banco de dados com pool de conexões
const dbConfig = {
  host: process.env.DB_HOST || 'srv881.hstgr.io',
  user: process.env.DB_USER || 'u490253103_automacao',
  password: process.env.DB_PASSWORD || 'Y4m4t02@12345',
  database: process.env.DB_NAME || 'u490253103_automacao',
  charset: 'utf8mb4',
  timezone: '-03:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// Pool de conexões MySQL
let dbPool = null;

// Variáveis de controle do agendador
let agendamentoAtivo = false;
let intervaloVerificacao = null;
let intervaloKeepAlive = null;

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

app.listen(PORT, async () => {
  console.log(`Servidor WPPConnect ouvindo na porta ${PORT}`);
  
  // Inicializa pool de conexões
  try {
    dbPool = mysql.createPool(dbConfig);
    await dbPool.execute("SET time_zone = '-03:00'");
    console.log('[DB Pool] Pool de conexões MySQL criado com sucesso');
  } catch (error) {
    console.error('[DB Pool] Erro ao criar pool:', error.message);
  }
  
  restorePersistedSessions();
  iniciarVerificadorAgendamentos();
  iniciarKeepAlive();
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
    // Verifica se é mensagem de grupo
    const isGroup = message.from.includes('@g.us');
    
    // Verifica se é mensagem de status (ignora completamente)
    const isStatus = message.from.includes('@broadcast') || 
                    (message.type && message.type === 'status') ||
                    (message.isStatus === true);
    
    // Se for grupo ou status, ignora completamente (não responde nada)
    if (isGroup || isStatus) {
      return;
    }
    
    // Comando de teste ping
    if (message.body?.trim() === '!ping') {
      await client.sendText(message.from, 'pong');
      return;
    }
    
    const mensagemLimpa = message.body?.trim();
    
    // Resposta para opção 1 (apenas se for exatamente "1")
    if (mensagemLimpa === '1') {
      await client.sendText(message.from, '🎉 *Que ótima escolha!* Estou muito feliz em ajudar! 😊\n\n📞 *Vou te passar o contato de nosso consultor:*\n\n👨‍💼 **Alex**\n📱 (12) 99792-3453\n\n🚀 Ele entrará em contato com você o mais rápido possível para tirar todas as dúvidas! ✨\n\nAgradecemos seu interesse! 💚');
      return;
    }
    
    // Resposta para opção 2 (apenas se for exatamente "2")
    if (mensagemLimpa === '2') {
      await client.sendText(message.from, '😔 *Sentimos muito por estar tomando seu tempo* 🕒\n\nCaso mude de ideia, basta digitar **1** que estaremos aqui para ajudar! 💚✨');
      return;
    }
    
    // Resposta para qualquer outra mensagem que não seja "1" ou "2"
    if (mensagemLimpa && mensagemLimpa !== '1' && mensagemLimpa !== '2') {
      await client.sendText(message.from, '🤖 *Infelizmente sou um robô* e não entendo o que você está me falando! 🤖\n\n');
      return;
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

function getConnectedSessionByConfig(sessionId) {
  const sessionIdConfigurada = String(sessionId || '').trim();

  if (sessionIdConfigurada) {
    const sessao = sessions.get(sessionIdConfigurada);
    if (sessao && ['CONECTADO', 'SYNCING'].includes(sessao.status) && sessao.client) {
      return sessao;
    }
    return null;
  }

  return Array.from(sessions.values()).find(
    (sessao) => ['CONECTADO', 'SYNCING'].includes(sessao.status) && sessao.client
  ) || null;
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

  // Configura para verificar a cada 2 minutos (120000ms)
  intervaloVerificacao = setInterval(async () => {
    try {
      await verificarAgendamentos();
    } catch (error) {
      console.error('[Agendador] Erro na verificação:', error.message);
    }
  }, 120000); // 2 minutos

  console.log('[Agendador] Verificador configurado para rodar a cada 2 minutos.');
}

async function verificarAgendamentos() {
  console.log('[Agendador] Verificando agendamentos...');
  
  if (!dbPool) {
    console.error('[Agendador] Pool de conexões não está disponível');
    return;
  }
  
  try {
    
    // Busca agendamentos que precisam de notificação
    console.log('[Agendador] Executando query de agendamentos...');
    const [agendamentos] = await dbPool.execute(`
      SELECT 
        t.id,
        t.usuario,
        t.status,
        c.nome_cliente,
        c.telefone_cliente,
        c.rua_cliente,
        c.numero_cliente,
        c.complemento_cliente,
        c.bairro_cliente,
        c.cidade_cliente,
        c.cep_cliente,
        t.setor,
        t.assunto,
        t.descricao,
        t.agendamento,
        t.whatsapp_enviado,
        t.whatsapp_grupo_enviado,
        cfg.whatsapp_sessao,
        cfg.whatsapp_grupo,
        cfg.whatsapp_agendamento_individual,
        cfg.whatsapp_agendamento_grupo
      FROM tickets t
      LEFT JOIN clientes c ON t.usuario = c.id_memocash
      LEFT JOIN configuracoes cfg ON cfg.id = 1
      WHERE DATE(t.agendamento) = CURDATE()
      AND t.agendamento IS NOT NULL
      AND (
        (t.whatsapp_enviado IS NULL AND TIMESTAMPDIFF(MINUTE, NOW(), t.agendamento) <= 60)
        OR 
        (t.whatsapp_grupo_enviado IS NULL AND TIMESTAMPDIFF(MINUTE, NOW(), t.agendamento) <= 60)
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
      console.log(`[Agendador] Processando agendamento #${agendamento.id} (Status: ${agendamento.status})...`);
      
      // Verificar se o ticket está finalizado (case insensitive)
      if (agendamento.status && agendamento.status.toLowerCase() === 'finalizado') {
        console.log(`[Agendador] Ticket #${agendamento.id} está finalizado. Marcando campos de WhatsApp como 0 para não enviar.`);
        await dbPool.execute(
          'UPDATE tickets SET whatsapp_enviado = 0, whatsapp_grupo_enviado = 0 WHERE id = ?',
          [agendamento.id]
        );
        continue;
      }

      // Verificar se o ticket está aberto (case insensitive)
      if (!agendamento.status || agendamento.status.toLowerCase() !== 'aberto') {
        console.log(`[Agendador] Ticket #${agendamento.id} não está aberto (Status: ${agendamento.status}). Pulando envio.`);
        continue;
      }

      const agora = new Date();
      const dataHoraAgendamento = new Date(agendamento.agendamento);
      const minutosRestantes = Math.floor((dataHoraAgendamento - agora) / (1000 * 60));

      console.log(`[Agendador] Agendamento #${agendamento.id}: ${minutosRestantes} minutos restantes`);

      // Só envia individual se AMBOS os campos forem NULL
      if (!agendamento.whatsapp_enviado && !agendamento.whatsapp_grupo_enviado && minutosRestantes <= 60) {
        console.log(`[Agendador] Tentando enviar mensagem individual para #${agendamento.id}...`);
        const enviouIndividual = await enviarMensagemIndividual(null, agendamento);
        
        // Se conseguiu enviar individual, tenta enviar grupo também
        if (enviouIndividual) {
          console.log(`[Agendador] Individual enviado! Tentando enviar para grupo também...`);
          await enviarMensagemGrupo(null, agendamento);
        } else {
          // Se falhou individual, tenta grupo como alternativa
          console.log(`[Agendador] Falhou individual. Tentando enviar para grupo como alternativa...`);
          await enviarMensagemGrupo(null, agendamento);
        }
      }
    }

  } catch (error) {
    console.error('[Agendador] Erro detalhado ao verificar agendamentos:', error);
    console.error('[Agendador] Stack trace:', error.stack);
  }
}

async function enviarMensagemIndividual(_, agendamento) {
  try {
    const sessaoConectada = getConnectedSessionByConfig(agendamento.whatsapp_sessao);
    
    if (!sessaoConectada) {
      console.log('[Agendador] Sessão configurada não está conectada para enviar mensagem individual.');
      return false;
    }

    // Corrigir fuso horário para Brasil
    const dataAgendamento = new Date(agendamento.agendamento);
    const horario = dataAgendamento.toLocaleTimeString('pt-BR', { 
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const templateIndividual = String(agendamento.whatsapp_agendamento_individual || '').trim();

    if (!templateIndividual) {
      console.log(`[Agendador] Template whatsapp_agendamento_individual não configurado para o ticket #${agendamento.id}.`);
      return false;
    }

    // Monta endereço completo
    const enderecoPartes = [
      agendamento.rua_cliente,
      agendamento.numero_cliente,
      agendamento.complemento_cliente,
      agendamento.bairro_cliente,
      agendamento.cidade_cliente
    ].filter(Boolean);
    const enderecoCompleto = enderecoPartes.length > 0 ? enderecoPartes.join(', ') : '';

    const variaveis = {
      '{NOME_CLIENTE}': agendamento.nome_cliente || 'Cliente',
      '{nome_cliente}': agendamento.nome_cliente || 'Cliente',
      '{TELEFONE}': agendamento.telefone_cliente || '',
      '{telefone}': agendamento.telefone_cliente || '',
      '{ENDERECO}': enderecoCompleto,
      '{endereco}': enderecoCompleto,
      '{HORARIO}': horario,
      '{horario}': horario,
      '{HORA}': horario,
      '{hora}': horario,
      '{ASSUNTO}': agendamento.assunto || '',
      '{assunto}': agendamento.assunto || '',
      '{SETOR}': agendamento.setor || '',
      '{setor}': agendamento.setor || '',
      '{DESCRICAO}': agendamento.descricao || '',
      '{descricao}': agendamento.descricao || '',
    };

    const mensagem = Object.entries(variaveis).reduce(
      (texto, [chave, valor]) => texto.split(chave).join(String(valor)),
      templateIndividual
    );

    // Envia mensagem se tiver telefone disponível
    if (agendamento.telefone_cliente) {
      const telefoneStr = String(agendamento.telefone_cliente || '').trim();
      const telefoneLimpo = telefoneStr.replace(/\D/g, '');
      const telefoneIntl = telefoneLimpo.startsWith('55') ? telefoneLimpo : `55${telefoneLimpo}`;
      const chatId = `${telefoneIntl}@c.us`;
      
      console.log(`[Agendador] Enviando para chatId: ${chatId}`);

      await sessaoConectada.client.sendText(chatId, mensagem);
      console.log(`[Agendador] Mensagem individual enviada para ${agendamento.nome_cliente} (${agendamento.telefone_cliente})`);
    } else {
      console.log(`[Agendador] Cliente ${agendamento.nome_cliente || agendamento.usuario} não possui telefone cadastrado`);
      console.log(`[Agendador] Conteúdo da mensagem: ${mensagem.replace(/\*/g, '').replace(/\n/g, ' | ')}`);
    }
    
    // Marca como enviado no banco
    await dbPool.execute(
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

async function enviarMensagemGrupo(_, agendamento) {
  try {
    const sessaoConectada = getConnectedSessionByConfig(agendamento.whatsapp_sessao);
    
    if (!sessaoConectada) {
      console.log('[Agendador] Sessão configurada não está conectada para enviar mensagem no grupo.');
      return false;
    }

    const grupoWhatsapp = String(agendamento.whatsapp_grupo || '').trim();

    if (!grupoWhatsapp) {
      console.log(`[Agendador] Agendamento ${agendamento.id} não possui grupo WhatsApp definido.`);
      return false;
    }
    
    // Validar formato do ID do grupo
    if (!grupoWhatsapp.includes('@g.us')) {
      console.log(`[Agendador] Formato inválido de grupo WhatsApp: ${grupoWhatsapp}`);
      return false;
    }
    
    console.log(`[Agendador] Enviando para grupo: ${grupoWhatsapp}`);

    // Corrigir fuso horário para Brasil
    const dataAgendamento = new Date(agendamento.agendamento);
    const horario = dataAgendamento.toLocaleTimeString('pt-BR', { 
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const templateGrupo = String(agendamento.whatsapp_agendamento_grupo || '').trim();

    if (!templateGrupo) {
      console.log(`[Agendador] Template whatsapp_agendamento_grupo não configurado para o ticket #${agendamento.id}.`);
      return false;
    }

    // Monta endereço completo
    const enderecoPartes = [
      agendamento.rua_cliente,
      agendamento.numero_cliente,
      agendamento.complemento_cliente,
      agendamento.bairro_cliente,
      agendamento.cidade_cliente
    ].filter(Boolean);
    const enderecoCompleto = enderecoPartes.length > 0 ? enderecoPartes.join(', ') : '';

    const variaveis = {
      '{ID}': agendamento.id || '',
      '{id}': agendamento.id || '',
      '{TICKET_ID}': agendamento.id || '',
      '{ticket_id}': agendamento.id || '',
      '{NOME_CLIENTE}': agendamento.nome_cliente || '',
      '{nome_cliente}': agendamento.nome_cliente || '',
      '{TELEFONE}': agendamento.telefone_cliente || '',
      '{telefone}': agendamento.telefone_cliente || '',
      '{ENDERECO}': enderecoCompleto,
      '{endereco}': enderecoCompleto,
      '{SETOR}': agendamento.setor || '',
      '{setor}': agendamento.setor || '',
      '{ASSUNTO}': agendamento.assunto || '',
      '{assunto}': agendamento.assunto || '',
      '{DESCRICAO}': agendamento.descricao || '',
      '{descricao}': agendamento.descricao || '',
      '{HORARIO}': horario,
      '{horario}': horario,
      '{HORA}': horario,
      '{hora}': horario,
    };

    const mensagem = Object.entries(variaveis).reduce(
      (texto, [chave, valor]) => texto.split(chave).join(String(valor)),
      templateGrupo
    );

    await sessaoConectada.client.sendText(String(grupoWhatsapp), String(mensagem));
    
    // Marca como enviado no banco
    await dbPool.execute(
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

// Sistema de Keep-Alive para manter sessões ativas
function iniciarKeepAlive() {
  console.log('[Keep-Alive] Iniciando sistema de keep-alive...');
  
  // Verifica saúde das sessões a cada 5 minutos
  intervaloKeepAlive = setInterval(async () => {
    try {
      const sessionsArray = Array.from(sessions.values());
      const sessoesConectadas = sessionsArray.filter(s => s.status === 'CONECTADO' && s.client);
      
      console.log(`[Keep-Alive] Verificando ${sessoesConectadas.length} sessão(ões) conectada(s)...`);
      
      for (const session of sessoesConectadas) {
        try {
          // Tenta obter estado da conexão
          const state = await session.client.getConnectionState();
          console.log(`[Keep-Alive] Sessão ${session.sessionId}: ${state}`);
          
          // Se desconectado, atualiza status
          if (state === 'DISCONNECTED' || state === 'TIMEOUT') {
            session.status = 'DESCONECTADO';
            session.updatedAt = new Date().toISOString();
            console.log(`[Keep-Alive] Sessão ${session.sessionId} foi desconectada`);
          }
        } catch (error) {
          console.error(`[Keep-Alive] Erro ao verificar sessão ${session.sessionId}:`, error.message);
        }
      }
      
      // Testa pool de conexões MySQL
      if (dbPool) {
        try {
          await dbPool.execute('SELECT 1');
          console.log('[Keep-Alive] Pool MySQL está ativo');
        } catch (error) {
          console.error('[Keep-Alive] Erro no pool MySQL:', error.message);
        }
      }
    } catch (error) {
      console.error('[Keep-Alive] Erro geral:', error.message);
    }
  }, 300000); // 5 minutos
  
  console.log('[Keep-Alive] Sistema configurado para rodar a cada 5 minutos.');
}

// Endpoint para testar conexão com banco
app.get('/api/test-db', async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(500).json({
        success: false,
        error: 'Pool de conexões não inicializado'
      });
    }
    
    // Testa query simples
    const [result] = await dbPool.execute('SELECT 1 as test');
    
    // Testa query de agendamentos
    const [agendamentos] = await dbPool.execute(`
      SELECT COUNT(*) as total FROM tickets 
      WHERE agendamento IS NOT NULL 
      AND DATE(agendamento) = CURDATE()
    `);
    
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
  }
});

// Endpoint para verificar saúde do sistema
app.get('/api/health', async (req, res) => {
  const sessionsArray = Array.from(sessions.values());
  const sessoesConectadas = sessionsArray.filter(s => s.status === 'CONECTADO');
  
  return res.json({
    success: true,
    uptime: process.uptime(),
    sessoes: {
      total: sessions.size,
      conectadas: sessoesConectadas.length
    },
    agendador: {
      ativo: agendamentoAtivo
    },
    keepAlive: {
      ativo: intervaloKeepAlive !== null
    },
    database: {
      poolAtivo: dbPool !== null
    }
  });
});
