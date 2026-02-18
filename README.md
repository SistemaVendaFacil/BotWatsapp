# Memocash WhatsApp Bot - WPPConnect + Render.com

Bot WhatsApp para envio de cobranças usando WPPConnect Server hospedado gratuitamente no Render.com.

---

## Estrutura

```
api/whatsapp/
├── server.js         # Servidor Node.js + WPPConnect
├── enviar.php        # Endpoint PHP → Render.com
├── package.json      # Dependências Node.js
├── .env.example      # Modelo de variáveis de ambiente
├── .htaccess         # Proteção de arquivos sensíveis
└── README.md         # Este arquivo
```

---

## Deploy no Render.com (gratuito)

### 1. Criar repositório no GitHub
- Suba apenas os arquivos: `server.js`, `package.json`, `.env.example`
- **NÃO suba** o arquivo `.env` (contém segredos)

### 2. Criar conta no Render.com
- Acesse: https://render.com
- Crie conta gratuita

### 3. Criar novo Web Service
- Clique em **New > Web Service**
- Conecte seu repositório GitHub
- Configure:
  - **Name:** `memocash-wppconnect`
  - **Runtime:** `Node`
  - **Build Command:** `npm install`
  - **Start Command:** `npm start`
  - **Plan:** `Free`

### 4. Configurar variáveis de ambiente no Render
No painel do serviço, vá em **Environment** e adicione:

| Chave | Valor |
|-------|-------|
| `API_SECRET` | Um token secreto (ex: `mmc_abc123xyz`) |
| `SESSION_NAME` | `memocash-session` |

> O `PORT` é definido automaticamente pelo Render.com.

### 5. Fazer deploy
- Clique em **Deploy**
- Aguarde o build finalizar (~3 minutos)
- Sua URL será: `https://memocash-wppconnect.onrender.com`

### 6. Atualizar enviar.php
Edite a constante `NODE_URL` no arquivo `enviar.php`:
```php
define('NODE_URL', 'https://memocash-wppconnect.onrender.com');
define('API_SECRET', 'o_mesmo_token_do_render');
```

### 7. Escanear QR Code
Acesse via browser ou Postman:
```
GET https://memocash-wppconnect.onrender.com/qrcode?secret=SEU_TOKEN
```
- Retorna o QR Code em base64
- Escaneie pelo WhatsApp > Dispositivos Conectados

---

## Uso via PHP (Memocash Gestor)

### Verificar status
```php
$ch = curl_init('https://seusite.com/api/whatsapp/enviar.php?acao=status');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$data = json_decode(curl_exec($ch), true);
// $data['conectado'] => true/false
```

### Enviar cobrança em lote
```php
$payload = json_encode([
    'acao'     => 'enviar_lote',
    'clientes' => [
        ['id' => 1, 'nome' => 'João Silva',  'telefone' => '11999999999'],
        ['id' => 2, 'nome' => 'Maria Souza', 'telefone' => '11988888888']
    ],
    'mensagem' => 'Olá {nome}, sua fatura Memocash está disponível. Entre em contato!'
]);

$ch = curl_init('https://seusite.com/api/whatsapp/enviar.php');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = json_decode(curl_exec($ch), true);
curl_close($ch);
```

> Use `{nome}` na mensagem para personalizar com o nome do cliente.

---

## Observações importantes

- **Plano gratuito Render.com:** O serviço "dorme" após 15 minutos sem requisições. Na primeira chamada pode demorar ~30s para acordar.
- **Sessão persistente:** A sessão do WhatsApp é salva em arquivo, não precisa escanear QR toda vez.
- **Delay entre mensagens:** 2 segundos entre cada envio no lote para evitar bloqueio.
- **Reinício automático:** Se desconectar, o bot tenta reconectar automaticamente em 10 segundos.
