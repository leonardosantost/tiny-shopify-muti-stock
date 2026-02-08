import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from './lib/env.js';
import {
  addLog,
  deleteMapping,
  getConfigObject,
  getConfigValue,
  listLogs,
  listMappings,
  setConfigValue,
  upsertMapping
} from './lib/db.js';
import { getSchedulerStatus, restartScheduler, startScheduler } from './services/scheduler.js';
import {
  loadIntegrationReferences,
  runFullSync,
  syncFromSalesWebhook,
  syncFromStockWebhook
} from './services/sync.js';

const app = express();
const oauthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SHOPIFY_SCOPES = 'read_products,read_locations,read_inventory,write_inventory';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('src/public'));

function parseWebhookPayload(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return { raw: body };
    }
  }

  if (typeof body.payload === 'string') {
    try {
      return JSON.parse(body.payload);
    } catch {
      return body;
    }
  }

  if (typeof body.json === 'string') {
    try {
      return JSON.parse(body.json);
    } catch {
      return body;
    }
  }

  return body;
}

function normalizeText(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function normalizeShopDomain(rawShop) {
  const trimmed = normalizeText(rawShop)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/g, '')
    .toLowerCase();

  if (!trimmed) return '';
  return trimmed.endsWith('.myshopify.com') ? trimmed : `${trimmed}.myshopify.com`;
}

function getOauthConfig() {
  const clientId = getConfigValue('shopify_client_id', env.shopify.clientId);
  const clientSecret = getConfigValue('shopify_client_secret', env.shopify.clientSecret);
  const scopes = getConfigValue('shopify_scopes', env.shopify.scopes || DEFAULT_SHOPIFY_SCOPES);
  const redirectUri = getConfigValue(
    'shopify_redirect_uri',
    env.shopify.redirectUri || `${env.baseUrl}/auth/shopify/callback`
  );

  return { clientId, clientSecret, scopes, redirectUri };
}

function putOauthState(state, store) {
  oauthStates.set(state, {
    store,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS
  });
}

function consumeOauthState(state) {
  const item = oauthStates.get(state);
  oauthStates.delete(state);
  if (!item) return null;
  if (item.expiresAt < Date.now()) return null;
  return item;
}

function validateShopifyHmac(query, clientSecret) {
  const incomingHmac = normalizeText(query.hmac);
  if (!incomingHmac || !clientSecret) return false;

  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${normalizeText(query[key])}`)
    .join('&');

  const digest = createHmac('sha256', clientSecret).update(message).digest('hex');
  const left = Buffer.from(digest, 'utf8');
  const right = Buffer.from(incomingHmac, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function buildAuthorizeUrl(store) {
  const { clientId, clientSecret, scopes, redirectUri } = getOauthConfig();
  if (!store) {
    throw new Error('shopify_store obrigatório para OAuth');
  }
  if (!clientId) {
    throw new Error('shopify_client_id não configurado');
  }
  if (!clientSecret) {
    throw new Error('shopify_client_secret não configurado');
  }

  const state = randomBytes(24).toString('hex');
  putOauthState(state, store);

  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes || DEFAULT_SHOPIFY_SCOPES,
    redirect_uri: redirectUri,
    state
  });

  return `https://${store}/admin/oauth/authorize?${params.toString()}`;
}

function renderOauthResultPage({ ok, message, store = '', scope = '' }) {
  const safeMessage = String(message || '').replace(/</g, '&lt;');
  const status = ok ? 'ok' : 'error';
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Shopify OAuth</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #22313f; }
      .ok { color: #0f766e; }
      .error { color: #b91c1c; }
    </style>
  </head>
  <body>
    <h2 class="${status}">${ok ? 'Conexão concluída' : 'Falha na conexão'}</h2>
    <p>${safeMessage}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(
          {
            type: 'shopify_oauth',
            ok: ${ok ? 'true' : 'false'},
            store: ${JSON.stringify(store)},
            scope: ${JSON.stringify(scope)},
            message: ${JSON.stringify(message || '')}
          },
          window.location.origin
        );
      }
      setTimeout(() => window.close(), 300);
    </script>
  </body>
</html>`;
}

function isWebhookAuthorized(req) {
  const configuredSecret = getConfigValue('tiny_webhook_secret', env.tiny.webhookSecret);
  if (!configuredSecret) return true;

  const incoming =
    req.headers['x-webhook-secret'] ||
    req.headers['x-tiny-webhook-secret'] ||
    req.query.secret ||
    req.body?.secret;

  return String(incoming || '') === String(configuredSecret);
}

function initDefaults() {
  if (!getConfigValue('sync_interval_minutes')) {
    setConfigValue('sync_interval_minutes', String(env.syncIntervalMinutes));
  }

  if (env.tiny.token && !getConfigValue('tiny_api_token')) {
    setConfigValue('tiny_api_token', env.tiny.token);
  }

  if (env.tiny.format && !getConfigValue('tiny_api_format')) {
    setConfigValue('tiny_api_format', env.tiny.format);
  }

  if (env.tiny.webhookSecret && !getConfigValue('tiny_webhook_secret')) {
    setConfigValue('tiny_webhook_secret', env.tiny.webhookSecret);
  }

  if (env.shopify.store && !getConfigValue('shopify_store')) {
    setConfigValue('shopify_store', env.shopify.store);
  }

  if (env.shopify.accessToken && !getConfigValue('shopify_access_token')) {
    setConfigValue('shopify_access_token', env.shopify.accessToken);
  }

  if (env.shopify.clientId && !getConfigValue('shopify_client_id')) {
    setConfigValue('shopify_client_id', env.shopify.clientId);
  }

  if (env.shopify.clientSecret && !getConfigValue('shopify_client_secret')) {
    setConfigValue('shopify_client_secret', env.shopify.clientSecret);
  }

  if (env.shopify.scopes && !getConfigValue('shopify_scopes')) {
    setConfigValue('shopify_scopes', env.shopify.scopes);
  }

  if (env.shopify.redirectUri && !getConfigValue('shopify_redirect_uri')) {
    setConfigValue('shopify_redirect_uri', env.shopify.redirectUri);
  }

  const savedShopifyApiVersion = getConfigValue('shopify_api_version');
  if (!savedShopifyApiVersion) {
    setConfigValue('shopify_api_version', env.shopify.apiVersion);
  } else if (/^2025-/.test(savedShopifyApiVersion)) {
    setConfigValue('shopify_api_version', '2026-01');
  }
}

app.get('/api/config', (req, res) => {
  const cfg = getConfigObject();
  res.json({
    ...cfg,
    tiny_api_token: cfg.tiny_api_token || '',
    shopify_access_token: cfg.shopify_access_token || ''
  });
});

app.post('/api/config', (req, res) => {
  const allowedKeys = [
    'tiny_api_token',
    'tiny_api_format',
    'tiny_webhook_secret',
    'shopify_store',
    'shopify_access_token',
    'shopify_api_version',
    'shopify_client_id',
    'shopify_client_secret',
    'shopify_scopes',
    'shopify_redirect_uri',
    'sync_interval_minutes'
  ];

  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      setConfigValue(key, req.body[key]);
    }
  }

  restartScheduler();
  addLog({
    type: 'config',
    status: 'ok',
    message: 'Configuração atualizada',
    context: { keys: Object.keys(req.body || {}) }
  });

  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ scheduler: getSchedulerStatus() });
});

app.get('/api/shopify/oauth/status', (req, res) => {
  const cfg = getConfigObject();
  const token = cfg.shopify_access_token || '';
  const store = normalizeShopDomain(cfg.shopify_store || env.shopify.store);
  const scopes = cfg.shopify_installed_scopes || cfg.shopify_scopes || env.shopify.scopes;

  res.json({
    connected: Boolean(token && store),
    store,
    scopes: scopes || DEFAULT_SHOPIFY_SCOPES,
    hasClientId: Boolean(cfg.shopify_client_id || env.shopify.clientId),
    hasClientSecret: Boolean(cfg.shopify_client_secret || env.shopify.clientSecret)
  });
});

app.get('/api/shopify/oauth/start', (req, res) => {
  try {
    const requested = normalizeShopDomain(req.query.store || getConfigValue('shopify_store', env.shopify.store));
    const url = buildAuthorizeUrl(requested);
    res.json({ ok: true, url });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get('/auth/shopify/start', (req, res) => {
  try {
    const requested = normalizeShopDomain(req.query.store || getConfigValue('shopify_store', env.shopify.store));
    const url = buildAuthorizeUrl(requested);
    res.redirect(url);
  } catch (error) {
    res.status(400).send(renderOauthResultPage({ ok: false, message: error.message }));
  }
});

app.get('/auth/shopify/callback', async (req, res) => {
  const { clientId, clientSecret } = getOauthConfig();
  const code = normalizeText(req.query.code);
  const shop = normalizeShopDomain(req.query.shop);
  const state = normalizeText(req.query.state);

  if (!code || !shop || !state) {
    return res.status(400).send(renderOauthResultPage({ ok: false, message: 'Callback OAuth incompleto' }));
  }

  const savedState = consumeOauthState(state);
  if (!savedState || savedState.store !== shop) {
    return res.status(400).send(renderOauthResultPage({ ok: false, message: 'State inválido ou expirado' }));
  }

  if (!validateShopifyHmac(req.query, clientSecret)) {
    return res.status(401).send(renderOauthResultPage({ ok: false, message: 'Assinatura HMAC inválida' }));
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code
      })
    });

    if (!tokenRes.ok) {
      throw new Error(`Falha ao trocar code por token (HTTP ${tokenRes.status})`);
    }

    const tokenPayload = await tokenRes.json();
    if (!tokenPayload.access_token) {
      throw new Error('Resposta OAuth sem access_token');
    }

    setConfigValue('shopify_store', shop);
    setConfigValue('shopify_access_token', tokenPayload.access_token);
    if (tokenPayload.scope) {
      setConfigValue('shopify_installed_scopes', tokenPayload.scope);
    }

    addLog({
      type: 'shopify_oauth',
      status: 'ok',
      message: 'Token Shopify gerado via OAuth',
      context: { store: shop, scope: tokenPayload.scope || '' }
    });

    return res.send(
      renderOauthResultPage({
        ok: true,
        message: `Token salvo para ${shop}`,
        store: shop,
        scope: tokenPayload.scope || ''
      })
    );
  } catch (error) {
    addLog({
      type: 'shopify_oauth',
      status: 'error',
      message: error.message,
      context: { store: shop }
    });
    return res
      .status(500)
      .send(renderOauthResultPage({ ok: false, message: error.message, store: shop }));
  }
});

app.get('/api/references', async (req, res) => {
  try {
    const data = await loadIntegrationReferences();
    res.json(data);
  } catch (error) {
    addLog({
      type: 'references',
      status: 'error',
      message: error.message,
      context: null
    });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/mappings', (req, res) => {
  res.json({ mappings: listMappings() });
});

app.post('/api/mappings', (req, res) => {
  const mapping = req.body || {};
  if (!mapping.tiny_deposito_id || !mapping.shopify_location_id) {
    return res.status(400).json({ ok: false, error: 'tiny_deposito_id e shopify_location_id são obrigatórios' });
  }

  upsertMapping(mapping);
  addLog({
    type: 'mapping',
    status: 'ok',
    message: 'Mapeamento salvo',
    context: mapping
  });

  return res.json({ ok: true });
});

app.delete('/api/mappings/:tinyDepositoId', (req, res) => {
  deleteMapping(req.params.tinyDepositoId);
  addLog({
    type: 'mapping',
    status: 'ok',
    message: 'Mapeamento removido',
    context: { tinyDepositoId: req.params.tinyDepositoId }
  });
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const limit = Number(req.query.limit || 200);
  res.json({ logs: listLogs(limit) });
});

app.post('/api/sync/full', async (req, res) => {
  const result = await runFullSync({ trigger: 'manual' });
  res.json(result);
});

app.post('/webhooks/tiny/stock', async (req, res) => {
  if (!isWebhookAuthorized(req)) {
    addLog({
      type: 'webhook_stock',
      status: 'unauthorized',
      message: 'Webhook não autorizado',
      context: { ip: req.ip }
    });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const payload = parseWebhookPayload(req.body);
    const result = await syncFromStockWebhook(payload);
    return res.json(result);
  } catch (error) {
    addLog({
      type: 'webhook_stock',
      status: 'error',
      message: error.message,
      context: { body: req.body }
    });
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/webhooks/tiny/sales', async (req, res) => {
  if (!isWebhookAuthorized(req)) {
    addLog({
      type: 'webhook_sales',
      status: 'unauthorized',
      message: 'Webhook não autorizado',
      context: { ip: req.ip }
    });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const payload = parseWebhookPayload(req.body);
    const result = await syncFromSalesWebhook(payload);
    return res.json(result);
  } catch (error) {
    addLog({
      type: 'webhook_sales',
      status: 'error',
      message: error.message,
      context: { body: req.body }
    });
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/test/webhook-stock', async (req, res) => {
  const payload = {
    dados: {
      idProduto: req.body.idProduto || '',
      sku: req.body.sku || '',
      saldo: req.body.saldo ?? 0,
      idDeposito: req.body.idDeposito || ''
    }
  };

  const result = await syncFromStockWebhook(payload);
  res.json(result);
});

initDefaults();
startScheduler();

app.listen(env.port, () => {
  const webhookStock = `${env.baseUrl}/webhooks/tiny/stock`;
  const webhookSales = `${env.baseUrl}/webhooks/tiny/sales`;
  console.log(`Servidor em http://localhost:${env.port}`);
  console.log(`Webhook Tiny estoque: ${webhookStock}`);
  console.log(`Webhook Tiny vendas: ${webhookSales}`);
});
