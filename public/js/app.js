'use strict';

const form = document.getElementById('sessionForm');
const phoneInput = document.getElementById('phoneInput');
const companyInput = document.getElementById('companyInput');
const feedbackAlert = document.getElementById('feedbackAlert');
const qrContainer = document.getElementById('qrContainer');
const statusPill = document.getElementById('statusPill');
const sessionLabel = document.getElementById('sessionLabel');
const updatedAtLabel = document.getElementById('updatedAtLabel');
const devicesList = document.getElementById('devicesList');
const submitButton = document.querySelector('#sessionForm button[type="submit"]');

submitButton.disabled = true;

let currentSessionId = null;
let pollingInterval = null;
let sessionsInterval = null;

phoneInput.addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 11);
  event.target.value = formatPhoneInput(digits);
  updateSubmitState();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.replace(/\D/g, '');
  const company = companyInput.value.trim();
  const formattedPhone = formatPhoneInput(phone);
  phoneInput.value = formattedPhone;

  if (phone.length !== 11) {
    showAlert('Informe o telefone completo (DDD + número).', 'warning');
    return;
  }

  toggleForm(false);
  showAlert('Gerando sessão e QR Code...', 'info');

  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, company }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Falha ao criar sessão.');
    }

    currentSessionId = data.session?.sessionId || null;
    renderSession(data.session);
    startPolling();
    showAlert('Sessão iniciada com sucesso. Aguarde a geração do QR Code.', 'success');
    phoneInput.value = '';
    updateSubmitState();
    await loadSessions();
  } catch (error) {
    console.error(error);
    showAlert(resolveErrorMessage(error, 'Erro inesperado ao criar sessão.'), 'danger');
  } finally {
    toggleForm(true);
    if (phoneInput.value === '') {
      updateSubmitState();
    } else {
      phoneInput.value = formattedPhone;
      updateSubmitState();
    }
  }
});

function startPolling() {
  stopPolling();
  if (!currentSessionId) return;

  pollingInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/session/${currentSessionId}`);
      if (!response.ok) {
        throw new Error('Sessão não encontrada ou expirada.');
      }

      const data = await response.json();
      if (data.success) {
        renderSession(data.session);
      }
    } catch (error) {
      console.error(error);
      showAlert(resolveErrorMessage(error, 'Perdemos a conexão com a sessão. Tente gerar novamente.'), 'danger');
      stopPolling();
    }
  }, 4000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function renderSession(session = null) {
  if (!session) {
    statusPill.className = 'status-pill status-error';
    statusPill.textContent = 'Sessão não encontrada';
    sessionLabel.textContent = '—';
    updatedAtLabel.textContent = '—';
    renderQr(null);
    renderDevices([]);
    return;
  }

  sessionLabel.textContent = session.sessionId;
  updatedAtLabel.textContent = session.updatedAt ? new Date(session.updatedAt).toLocaleString('pt-BR') : '—';

  switch ((session.status || '').toUpperCase()) {
    case 'CONECTADO':
      statusPill.className = 'status-pill status-connected';
      statusPill.textContent = 'Conectado';
      break;
    case 'AGUARDANDO_LEITURA':
    case 'AGUARDANDO_QR':
      statusPill.className = 'status-pill status-waiting';
      statusPill.textContent = 'Aguardando leitura';
      break;
    case 'ERRO':
      statusPill.className = 'status-pill status-error';
      statusPill.textContent = 'Erro na sessão';
      break;
    default:
      statusPill.className = 'status-pill status-waiting';
      statusPill.textContent = session.status || 'Atualizando';
  }

  renderQr(session.qrCode, session.qrCodeAscii, session.status);
}

function renderQr(qrBase64, qrAscii, status) {
  const normalizedStatus = (status || '').toUpperCase();
  const isWaiting = ['AGUARDANDO_QR', 'AGUARDANDO_LEITURA'].includes(normalizedStatus);

  if (normalizedStatus === 'CONECTADO') {
    qrContainer.innerHTML = `
      <div>
        <p class="mb-1 fw-semibold">Dispositivo conectado 👍</p>
        <p class="mb-0 text-light-emphasis small">Você já pode usar o WhatsApp integrado.</p>
      </div>`;
    return;
  }

  if (!qrBase64 && !qrAscii) {
    if (isWaiting) {
      qrContainer.innerHTML = `
        <div class="qr-loading">
          <div class="spinner-border text-light" role="status" aria-hidden="true"></div>
          <p class="mb-0 mt-3">Gerando QR Code...</p>
        </div>`;
    } else {
      qrContainer.innerHTML = `
        <div>
          <p class="mb-1 fw-semibold">QR Code indisponível</p>
          <p class="mb-0 text-light-emphasis small">Aguarde a geração ou reconecte a sessão.</p>
        </div>`;
    }
    return;
  }

  if (qrBase64) {
    qrContainer.innerHTML = `<img src="${qrBase64}" alt="QR Code para conectar" draggable="false" />`;
    return;
  }

  qrContainer.innerHTML = `
    <pre class="qr-ascii">${qrAscii}</pre>
    <p class="small text-light-emphasis mt-3">Escaneie usando um leitor compatível ou gere novamente.</p>
  `;
}

async function loadSessions(showLoading = false) {
  if (showLoading) {
    devicesList.className = 'list-empty';
    devicesList.innerHTML = 'Carregando sessões...';
  }

  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) {
      throw new Error('Falha ao carregar sessões.');
    }

    const data = await response.json();
    renderSessionsList(data.sessions || []);
  } catch (error) {
    console.error('Erro ao carregar sessões:', error);
    devicesList.className = 'list-empty';
    devicesList.textContent = 'Não foi possível listar as sessões. Tente novamente.';
  }
}

function renderSessionsList(sessions) {
  if (!sessions.length) {
    devicesList.className = 'list-empty';
    devicesList.textContent = 'Nenhum aparelho conectado no momento.';
    return;
  }

  devicesList.className = 'd-flex flex-column gap-3';
  devicesList.innerHTML = sessions
    .map((session) => {
      const devices = session.devices && session.devices.length > 0 ? session.devices : null;
      const statusLabel = formatSessionStatus(session.status);
      const canDelete = session.status !== 'AGUARDANDO_QR';
      const sessionName = session.company?.trim() || session.phone || session.phoneIntl || session.sessionId;
      return `
        <article class="device-card">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <p class="mb-1 fw-semibold">${sessionName}</p>
              <p class="mb-0 text-light-emphasis small">Status: ${statusLabel}</p>
            </div>
            <div class="d-flex align-items-center gap-2 session-actions">
              <span class="badge text-bg-primary badge-counter">${devices ? devices.length : 0} aparelho(s)</span>
              <button class="btn btn-sm btn-outline-danger btn-delete-session" data-session-id="${session.sessionId}" ${canDelete ? '' : 'disabled'}>
                Excluir
              </button>
            </div>
          </div>
          <div class="mt-3">
            ${devices ? devices.map(renderDeviceRow).join('') : '<p class="mb-0 text-light-emphasis small">Nenhum aparelho conectado.</p>'}
          </div>
        </article>`;
    })
    .join('');

  attachDeleteHandlers();
}

function renderDeviceRow(device) {
  const battery = device.battery ? `<span class="badge text-bg-dark ms-2">${device.battery}</span>` : '';
  const plugged = device.plugged != null ? (device.plugged ? 'Carregando' : 'Desconectado') : '—';
  return `
    <div class="d-flex justify-content-between align-items-center py-2 border-bottom border-secondary-subtle">
      <div>
        <p class="mb-0 fw-semibold">${device.pushName || 'Sem nome'} ${battery}</p>
        <p class="mb-0 text-light-emphasis small">ID: ${device.id || '—'}</p>
      </div>
      <div class="text-end text-light-emphasis small">
        <p class="mb-0">${plugged}</p>
      </div>
    </div>`;
}

function formatSessionStatus(status) {
  if (!status) return 'Desconhecido';
  switch (status.toUpperCase()) {
    case 'CONECTADO':
      return 'Conectado';
    case 'AGUARDANDO_QR':
    case 'AGUARDANDO_LEITURA':
      return 'Aguardando leitura';
    case 'ERRO':
      return 'Erro';
    default:
      return status;
  }
}

function toggleForm(enable) {
  phoneInput.disabled = !enable;
  const digitsLength = phoneInput.value.replace(/\D/g, '').length;
  submitButton.disabled = !enable || digitsLength !== 11;
}

function showAlert(message, type = 'info') {
  feedbackAlert.className = `alert alert-${type}`;
  feedbackAlert.textContent = message;
  feedbackAlert.classList.remove('d-none');
  setTimeout(() => feedbackAlert.classList.add('d-none'), 5000);
}

window.addEventListener('beforeunload', () => {
  stopPolling();
  stopSessionsWatcher();
});

function updateSubmitState() {
  if (phoneInput.disabled) {
    return;
  }

  const digitsLength = phoneInput.value.replace(/\D/g, '').length;
  submitButton.disabled = digitsLength !== 11;
}

function resolveErrorMessage(error, fallback) {
  const message = (error && error.message) || '';
  if (message.toLowerCase().includes('failed to fetch')) {
    return 'Servidor Node desligado';
  }
  return message || fallback;
}

function startSessionsWatcher() {
  loadSessions(true);
  sessionsInterval = setInterval(loadSessions, 10000);
}

function stopSessionsWatcher() {
  if (sessionsInterval) {
    clearInterval(sessionsInterval);
    sessionsInterval = null;
  }
}

function formatPhoneInput(digits) {
  if (!digits) {
    return '';
  }

  if (digits.length <= 2) {
    return `(${digits}`;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  }

  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7, 11)}`;
}

function attachDeleteHandlers() {
  const buttons = devicesList.querySelectorAll('button[data-session-id]');
  buttons.forEach((button) => {
    button.addEventListener('click', async () => {
      const sessionId = button.getAttribute('data-session-id');
      if (!sessionId) return;

      button.disabled = true;
      button.textContent = 'Excluindo...';

      try {
        const response = await fetch(`/api/session/${sessionId}`, { method: 'DELETE' });
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json') ? await response.json() : await response.text();

        if (!response.ok || (payload && payload.success === false)) {
          const message = typeof payload === 'string' ? payload : payload?.message;
          throw new Error(message || 'Falha ao excluir sessão.');
        }

        await loadSessions();
      } catch (error) {
        console.error('Erro ao excluir sessão:', error);
        showAlert(error.message || 'Erro ao excluir sessão.', 'danger');
      }
    });
  });
}

startSessionsWatcher();
