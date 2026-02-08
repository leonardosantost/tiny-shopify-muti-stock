const configForm = document.getElementById('config-form');
const mappingForm = document.getElementById('mapping-form');
const tinySelect = document.getElementById('tiny-deposito');
const shopifySelect = document.getElementById('shopify-location');
const mappingsBody = document.getElementById('mappings-body');
const logsPre = document.getElementById('logs');
const oauthStatus = document.getElementById('oauth-status');
const oauthButton = document.getElementById('connect-shopify-oauth');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Erro HTTP ${response.status}`);
  }

  return response.json();
}

function setFormValue(name, value) {
  const input = configForm.elements.namedItem(name);
  if (input) input.value = value || '';
}

async function loadConfig() {
  const cfg = await api('/api/config');
  setFormValue('tiny_api_token', cfg.tiny_api_token);
  setFormValue('tiny_api_format', cfg.tiny_api_format || 'json');
  setFormValue('tiny_webhook_secret', cfg.tiny_webhook_secret);
  setFormValue('shopify_store', cfg.shopify_store);
  setFormValue('shopify_access_token', cfg.shopify_access_token);
  setFormValue('shopify_client_id', cfg.shopify_client_id);
  setFormValue('shopify_client_secret', cfg.shopify_client_secret);
  setFormValue(
    'shopify_scopes',
    cfg.shopify_scopes || 'read_products,read_locations,read_inventory,write_inventory'
  );
  setFormValue('shopify_redirect_uri', cfg.shopify_redirect_uri);
  setFormValue('shopify_api_version', cfg.shopify_api_version || '2026-01');
  setFormValue('sync_interval_minutes', cfg.sync_interval_minutes || 180);
}

async function loadOauthStatus() {
  const status = await api('/api/shopify/oauth/status');
  if (status.connected) {
    oauthStatus.textContent = `Conectado: ${status.store}`;
  } else {
    oauthStatus.textContent = 'Não conectado';
  }

  if (!status.hasClientId || !status.hasClientSecret) {
    oauthStatus.textContent += ' (faltam client_id/client_secret)';
  }
}

function renderSelect(select, items, placeholder, valueKey = 'id', labelKey = 'nome') {
  select.innerHTML = '';

  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);

  for (const item of items) {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = item[labelKey] || item.name || item.id;
    option.dataset.name = item[labelKey] || item.name || '';
    select.appendChild(option);
  }
}

async function loadReferences() {
  const data = await api('/api/references');
  renderSelect(tinySelect, data.deposits, 'Selecione depósito Tiny', 'id', 'nome');
  renderSelect(shopifySelect, data.locations, 'Selecione location Shopify', 'id', 'name');
}

function mappingRow(mapping) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${mapping.tiny_deposito_nome || mapping.tiny_deposito_id}</td>
    <td>${mapping.shopify_location_name || mapping.shopify_location_id}</td>
    <td>${mapping.active ? 'Ativo' : 'Inativo'}</td>
    <td><button class="delete" data-id="${mapping.tiny_deposito_id}">Remover</button></td>
  `;

  const btn = tr.querySelector('button');
  btn.addEventListener('click', async () => {
    if (!confirm('Remover mapeamento?')) return;
    await api(`/api/mappings/${mapping.tiny_deposito_id}`, { method: 'DELETE' });
    await loadMappings();
    await loadLogs();
  });

  return tr;
}

async function loadMappings() {
  const data = await api('/api/mappings');
  mappingsBody.innerHTML = '';
  for (const mapping of data.mappings) {
    mappingsBody.appendChild(mappingRow(mapping));
  }
}

async function loadLogs() {
  const data = await api('/api/logs?limit=150');
  const lines = data.logs
    .map((log) => {
      const context = log.context ? ` ${JSON.stringify(log.context)}` : '';
      return `${log.created_at} [${log.type}] [${log.status}] ${log.message || ''}${context}`;
    })
    .join('\n');

  logsPre.textContent = lines || 'Sem logs ainda.';
}

configForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(configForm).entries());
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  await loadOauthStatus();
  await loadLogs();
  alert('Configuração salva.');
});

document.getElementById('load-references').addEventListener('click', async () => {
  await loadReferences();
});

document.getElementById('run-full-sync').addEventListener('click', async () => {
  const result = await api('/api/sync/full', { method: 'POST', body: '{}' });
  await loadLogs();
  alert(`Sync finalizado. Atualizados: ${result.updated || 0}`);
});

mappingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const tinyOption = tinySelect.selectedOptions[0];
  const shopifyOption = shopifySelect.selectedOptions[0];

  if (!tinyOption?.value || !shopifyOption?.value) {
    alert('Selecione depósito e location.');
    return;
  }

  await api('/api/mappings', {
    method: 'POST',
    body: JSON.stringify({
      tiny_deposito_id: tinyOption.value,
      tiny_deposito_nome: tinyOption.dataset.name,
      shopify_location_id: shopifyOption.value,
      shopify_location_name: shopifyOption.dataset.name,
      active: true
    })
  });

  await loadMappings();
  await loadLogs();
  alert('Mapeamento salvo.');
});

document.getElementById('refresh-logs').addEventListener('click', loadLogs);

oauthButton.addEventListener('click', async () => {
  const shop = String(configForm.elements.namedItem('shopify_store')?.value || '').trim();
  if (!shop) {
    alert('Preencha o Shopify store antes de conectar.');
    return;
  }

  const data = await api(`/api/shopify/oauth/start?store=${encodeURIComponent(shop)}`);
  const popup = window.open(data.url, 'shopifyOAuth', 'width=680,height=760');

  if (!popup) {
    window.location.href = data.url;
    return;
  }
});

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== 'shopify_oauth') return;

  await loadConfig();
  await loadOauthStatus();
  await loadLogs();

  if (event.data.ok) {
    alert(`Shopify conectado com sucesso (${event.data.store}).`);
  } else {
    alert(`Falha no OAuth Shopify: ${event.data.message || 'erro desconhecido'}`);
  }
});

document.getElementById('test-webhook-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());
  await api('/api/test/webhook-stock', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  await loadLogs();
  alert('Webhook de teste processado.');
});

async function boot() {
  await loadConfig();
  await loadOauthStatus();
  await loadMappings();
  await loadLogs();
}

boot().catch((error) => {
  logsPre.textContent = `Erro ao carregar UI: ${error.message}`;
});

setInterval(loadLogs, 10000);
