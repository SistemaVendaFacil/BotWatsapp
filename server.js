require('dotenv').config();
const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');

// Forçar uso do Chrome padrão do Puppeteer (não usar sistema)
delete process.env.PUPPETEER_EXECUTABLE_PATH;
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'false';

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.Bot_whatsapp || 'Svfa123';
const SESSION_NAME = process.env.SESSION_NAME || 'memocash-session';

app.use(cors());
app.use(express.json());

let clienteWpp = null;
let statusBot = 'desconectado';
let qrCodeAtual = null;

// Middleware de autenticação
function autenticar(req, res, next) {
    const token = req.headers['x-api-secret'] || req.query.secret;
    if (token !== API_SECRET) {
        return res.status(401).json({ success: false, message: 'Não autorizado.' });
    }
    next();
}

// Inicializar WPPConnect
function iniciarBot() {
    statusBot = 'iniciando';
    console.log('[Memocash] Iniciando WPPConnect...');

    wppconnect.create({
        session: SESSION_NAME,
        catchQR: (base64Qr, asciiQR) => {
            statusBot = 'aguardando_qr';
            qrCodeAtual = base64Qr;
            console.log('[Memocash] QR Code gerado. Acesse /qrcode para escanear.');
            console.log(asciiQR);
        },
        statusFind: (statusSession, session) => {
            console.log('[Memocash] Status:', statusSession, session);
            if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
                statusBot = 'conectado';
                qrCodeAtual = null;
            } else if (statusSession === 'notLogged' || statusSession === 'browserClose' || statusSession === 'desconnectedMobile') {
                statusBot = 'desconectado';
                clienteWpp = null;
                console.log('[Memocash] Desconectado. Reiniciando em 10s...');
                setTimeout(iniciarBot, 10000);
            }
        },
        headless: true,
        devtools: false,
        useChrome: false,
        debug: false,
        logQR: true,
        browserArgs: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        autoClose: 0,
        tokenStore: 'file',
        folderNameToken: './tokens'
    })
    .then((client) => {
        clienteWpp = client;
        statusBot = 'conectado';
        qrCodeAtual = null;
        console.log('[Memocash] WPPConnect conectado com sucesso!');

        client.onStateChange((state) => {
            console.log('[Memocash] Estado mudou:', state);
            if (state === 'CONFLICT') {
                client.useHere();
            }
            if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
                statusBot = 'desconectado';
                clienteWpp = null;
                setTimeout(iniciarBot, 10000);
            }
        });
    })
    .catch((err) => {
        console.error('[Memocash] Erro ao iniciar:', err.message);
        statusBot = 'erro';
        setTimeout(iniciarBot, 15000);
    });
}

// ========================
// ROTAS DA API
// ========================

// Health check público (Railway)
app.get('/', (req, res) => {
    res.json({ success: true, service: 'Memocash WhatsApp API' });
});

// Status do bot
app.get('/status', autenticar, (req, res) => {
    res.json({
        success: true,
        status: statusBot,
        conectado: statusBot === 'conectado'
    });
});

// QR Code para escanear (retorna imagem base64)
app.get('/qrcode', autenticar, (req, res) => {
    if (statusBot === 'conectado') {
        return res.json({ success: true, message: 'Bot já está conectado.' });
    }
    if (!qrCodeAtual) {
        return res.json({ success: false, message: 'QR Code ainda não gerado. Aguarde.' });
    }
    res.json({ success: true, qrcode: qrCodeAtual });
});

// Enviar mensagem para um número
app.post('/enviar', autenticar, async (req, res) => {
    const { telefone, mensagem } = req.body;

    if (!telefone || !mensagem) {
        return res.status(400).json({ success: false, message: 'Telefone e mensagem são obrigatórios.' });
    }

    if (statusBot !== 'conectado' || !clienteWpp) {
        return res.status(503).json({ success: false, message: 'Bot não está conectado.' });
    }

    try {
        const numero = formatarNumero(telefone);
        await clienteWpp.sendText(numero, mensagem);
        console.log(`[Memocash] Mensagem enviada para ${numero}`);
        res.json({ success: true, message: 'Mensagem enviada com sucesso.' });
    } catch (err) {
        console.error('[Memocash] Erro ao enviar:', err.message);
        res.status(500).json({ success: false, message: 'Erro ao enviar mensagem.', erro: err.message });
    }
});

// Enviar cobrança em lote
app.post('/enviar-lote', autenticar, async (req, res) => {
    const { clientes, mensagem } = req.body;

    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
        return res.status(400).json({ success: false, message: 'Lista de clientes inválida.' });
    }

    if (!mensagem) {
        return res.status(400).json({ success: false, message: 'Mensagem é obrigatória.' });
    }

    if (statusBot !== 'conectado' || !clienteWpp) {
        return res.status(503).json({ success: false, message: 'Bot não está conectado.' });
    }

    const resultados = [];

    for (const cliente of clientes) {
        const { id, nome, telefone } = cliente;

        if (!telefone) {
            resultados.push({ id, nome, sucesso: false, erro: 'Telefone não informado.' });
            continue;
        }

        try {
            const numero = formatarNumero(telefone);
            const mensagemPersonalizada = mensagem.replace(/\{nome\}/g, nome || 'Cliente');
            await clienteWpp.sendText(numero, mensagemPersonalizada);
            resultados.push({ id, nome, sucesso: true });
            console.log(`[Memocash] Cobrança enviada para ${nome} (${numero})`);
            await delay(2000);
        } catch (err) {
            console.error(`[Memocash] Erro ao enviar para ${nome}:`, err.message);
            resultados.push({ id, nome, sucesso: false, erro: err.message });
        }
    }

    const enviados = resultados.filter(r => r.sucesso).length;
    const falhas = resultados.filter(r => !r.sucesso).length;

    res.json({
        success: true,
        total: clientes.length,
        enviados,
        falhas,
        resultados
    });
});

// Desconectar bot
app.post('/desconectar', autenticar, async (req, res) => {
    if (!clienteWpp) {
        return res.json({ success: false, message: 'Bot não está conectado.' });
    }
    try {
        await clienteWpp.close();
        clienteWpp = null;
        statusBot = 'desconectado';
        res.json({ success: true, message: 'Bot desconectado.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao desconectar.', erro: err.message });
    }
});

// ========================
// FUNÇÕES AUXILIARES
// ========================

function formatarNumero(telefone) {
    const digits = telefone.replace(/\D/g, '');
    if (digits.startsWith('55')) {
        return digits + '@c.us';
    }
    return '55' + digits + '@c.us';
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================
// INICIAR SERVIDOR
// ========================

app.listen(PORT, () => {
    console.log(`[Memocash] Servidor rodando na porta ${PORT}`);
    iniciarBot();
});
