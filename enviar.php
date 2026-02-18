<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET');
header('Access-Control-Allow-Headers: Content-Type');

define('API_SECRET', 'Svfa123');
define('NODE_URL', 'https://SEU-NOME-AQUI.onrender.com'); // URL do Render.com

$input = json_decode(file_get_contents('php://input'), true);
$acao = $input['acao'] ?? $_GET['acao'] ?? '';

switch ($acao) {
    case 'status':
        echo json_encode(verificarStatus());
        break;
    case 'qrcode':
        echo json_encode(obterQrCode());
        break;
    case 'enviar':
        $telefone = $input['telefone'] ?? '';
        $mensagem = $input['mensagem'] ?? '';
        echo json_encode(enviarMensagem($telefone, $mensagem));
        break;
    case 'enviar_lote':
        $clientes = $input['clientes'] ?? [];
        $mensagem = $input['mensagem'] ?? '';
        echo json_encode(enviarLote($clientes, $mensagem));
        break;
    case 'desconectar':
        echo json_encode(desconectar());
        break;
    default:
        echo json_encode(['success' => false, 'message' => 'Ação inválida.']);
}

function chamarNode(string $endpoint, string $metodo = 'GET', array $dados = []): array {
    $url = NODE_URL . '/' . ltrim($endpoint, '/');
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'x-api-secret: ' . API_SECRET
    ]);

    if ($metodo === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($dados));
    }

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $erro = curl_error($ch);
    curl_close($ch);

    if ($erro || $response === false) {
        return ['success' => false, 'message' => 'Servidor WhatsApp indisponível. Verifique se o Render.com está ativo.'];
    }

    $data = json_decode($response, true);
    return $data ?? ['success' => false, 'message' => 'Resposta inválida do servidor.'];
}

function verificarStatus(): array {
    return chamarNode('status');
}

function obterQrCode(): array {
    return chamarNode('qrcode');
}

function enviarMensagem(string $telefone, string $mensagem): array {
    if (empty($telefone) || empty($mensagem)) {
        return ['success' => false, 'message' => 'Telefone e mensagem são obrigatórios.'];
    }
    return chamarNode('enviar', 'POST', ['telefone' => $telefone, 'mensagem' => $mensagem]);
}

function enviarLote(array $clientes, string $mensagem): array {
    if (empty($clientes) || empty($mensagem)) {
        return ['success' => false, 'message' => 'Clientes e mensagem são obrigatórios.'];
    }
    return chamarNode('enviar-lote', 'POST', ['clientes' => $clientes, 'mensagem' => $mensagem]);
}

function desconectar(): array {
    return chamarNode('desconectar', 'POST');
}
?>
