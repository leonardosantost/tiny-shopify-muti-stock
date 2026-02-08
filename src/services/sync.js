import {
  addLog,
  getConfigValue,
  getMappingByDeposito,
  listActiveMappings
} from '../lib/db.js';
import {
  discoverTinyDeposits,
  findTinyProductBySku,
  getTinyProductStock,
  listTinyProducts
} from './tiny.js';
import {
  findInventoryItemBySku,
  listShopifyLocations,
  setInventoryQuantity
} from './shopify.js';

let fullSyncInProgress = false;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function logAndStore({ type, status, message, context }) {
  addLog({ type, status, message, context });
  const prefix = `[${new Date().toISOString()}] [${type}] [${status}]`;
  console.log(prefix, message || '', context || '');
}

async function updateSkuOnMapping({ sku, quantity, mapping, reason, source }) {
  if (!sku) {
    return { status: 'skipped', reason: 'sku_missing' };
  }

  const inventory = await findInventoryItemBySku(sku);
  if (!inventory) {
    return { status: 'not_found', reason: 'sku_not_found_on_shopify' };
  }

  await setInventoryQuantity({
    inventoryItemId: inventory.inventoryItemId,
    locationId: mapping.shopify_location_id,
    quantity,
    reason
  });

  return {
    status: 'updated',
    sku,
    quantity,
    inventoryItemId: inventory.inventoryItemId,
    locationId: mapping.shopify_location_id,
    source,
    mapping
  };
}

async function syncSingleProductForMapping(product, mapping, options = {}) {
  const tinyStock = await getTinyProductStock(product.id);
  const deposit = tinyStock.deposits.find((d) => String(d.depositoId) === String(mapping.tiny_deposito_id));
  if (!deposit) {
    return { status: 'skipped', reason: 'deposit_not_present' };
  }

  const quantity = safeNumber(deposit.saldo);
  const sku = tinyStock.sku || product.sku;

  return updateSkuOnMapping({
    sku,
    quantity,
    mapping,
    reason: options.reason || 'correction',
    source: options.source || 'full_sync'
  });
}

export async function runFullSync({ trigger = 'manual' } = {}) {
  if (fullSyncInProgress) {
    const msg = 'Full sync já em execução';
    logAndStore({ type: 'full_sync', status: 'skipped', message: msg, context: { trigger } });
    return { ok: false, message: msg };
  }

  fullSyncInProgress = true;
  const startedAt = Date.now();

  try {
    const mappings = listActiveMappings();
    if (!mappings.length) {
      const msg = 'Nenhum mapeamento ativo para sincronizar';
      logAndStore({ type: 'full_sync', status: 'skipped', message: msg, context: { trigger } });
      return { ok: true, message: msg, updated: 0 };
    }

    let currentPage = 1;
    let updated = 0;
    let notFound = 0;
    let skipped = 0;

    while (true) {
      const { products, totalPages } = await listTinyProducts(currentPage);
      if (!products.length) break;

      for (const product of products) {
        for (const mapping of mappings) {
          try {
            const result = await syncSingleProductForMapping(product, mapping, {
              reason: 'correction',
              source: 'full_sync'
            });
            if (result.status === 'updated') updated += 1;
            if (result.status === 'not_found') notFound += 1;
            if (result.status === 'skipped') skipped += 1;
          } catch (error) {
            skipped += 1;
            logAndStore({
              type: 'full_sync_item',
              status: 'error',
              message: error.message,
              context: {
                productId: product.id,
                sku: product.sku,
                mapping: {
                  tinyDepositoId: mapping.tiny_deposito_id,
                  shopifyLocationId: mapping.shopify_location_id
                }
              }
            });
          }
        }
      }

      if (currentPage >= totalPages) break;
      currentPage += 1;
    }

    const durationMs = Date.now() - startedAt;
    const summary = { trigger, updated, notFound, skipped, durationMs };
    logAndStore({
      type: 'full_sync',
      status: 'ok',
      message: `Full sync finalizado em ${durationMs}ms`,
      context: summary
    });

    return { ok: true, ...summary };
  } catch (error) {
    logAndStore({
      type: 'full_sync',
      status: 'error',
      message: error.message,
      context: { trigger }
    });

    return { ok: false, error: error.message };
  } finally {
    fullSyncInProgress = false;
  }
}

export async function syncFromStockWebhook(payload) {
  const data = payload?.dados || payload || {};
  const depositoId = String(data.idDeposito || data.iddeposito || data.depositoId || '');
  const sku = String(data.sku || '').trim();
  const idProduto = String(data.idProduto || data.idproduto || '');
  const hasSaldo = data.saldo !== undefined && data.saldo !== null && data.saldo !== '';

  let quantity = hasSaldo ? safeNumber(data.saldo) : null;
  let mapping = depositoId ? getMappingByDeposito(depositoId) : null;

  if (!mapping && depositoId) {
    logAndStore({
      type: 'webhook_stock',
      status: 'skipped',
      message: 'Depósito sem mapeamento',
      context: { depositoId, sku, idProduto }
    });
    return { ok: true, skipped: true, reason: 'mapping_not_found' };
  }

  if (!mapping && !depositoId) {
    const mappings = listActiveMappings();
    if (mappings.length === 1) {
      mapping = mappings[0];
    }
  }

  if (!mapping) {
    logAndStore({
      type: 'webhook_stock',
      status: 'skipped',
      message: 'Não foi possível determinar mapeamento',
      context: { sku, idProduto }
    });
    return { ok: true, skipped: true, reason: 'mapping_undetermined' };
  }

  let effectiveSku = sku;
  if (quantity === null && idProduto) {
    const stock = await getTinyProductStock(idProduto);
    const deposit = stock.deposits.find((d) => String(d.depositoId) === String(mapping.tiny_deposito_id));
    quantity = deposit ? safeNumber(deposit.saldo) : 0;
    effectiveSku = effectiveSku || stock.sku;
  }

  if (quantity === null) {
    quantity = 0;
  }

  const result = await updateSkuOnMapping({
    sku: effectiveSku,
    quantity,
    mapping,
    reason: 'correction',
    source: 'tiny_webhook_stock'
  });

  logAndStore({
    type: 'webhook_stock',
    status: result.status === 'updated' ? 'ok' : 'skipped',
    message: `Webhook estoque processado: ${result.status}`,
    context: { sku: effectiveSku, quantity, mapping: mapping.tiny_deposito_id }
  });

  return { ok: true, result };
}

function flattenSkusFromSalesPayload(payload) {
  const candidates = [];

  const items =
    payload?.dados?.itens ||
    payload?.dados?.pedido?.itens ||
    payload?.pedido?.itens ||
    payload?.itens ||
    [];

  for (const rawItem of items) {
    const item = rawItem.item || rawItem;
    const sku = String(item.sku || item.codigo || '').trim();
    if (sku) candidates.push(sku);
  }

  return [...new Set(candidates)];
}

export async function syncFromSalesWebhook(payload) {
  const skus = flattenSkusFromSalesPayload(payload);
  const mappings = listActiveMappings();

  if (!mappings.length) {
    logAndStore({
      type: 'webhook_sales',
      status: 'skipped',
      message: 'Sem mapeamentos para webhook de venda',
      context: null
    });
    return { ok: true, skipped: true, reason: 'no_mappings' };
  }

  if (!skus.length) {
    logAndStore({
      type: 'webhook_sales',
      status: 'skipped',
      message: 'Webhook venda sem SKU identificável',
      context: { keys: Object.keys(payload || {}) }
    });
    return { ok: true, skipped: true, reason: 'no_sku' };
  }

  let updated = 0;
  for (const sku of skus) {
    for (const mapping of mappings) {
      try {
        const inventory = await findInventoryItemBySku(sku);
        if (!inventory) continue;

        const matched = await findTinyProductBySku(sku);
        if (!matched) continue;

        const stock = await getTinyProductStock(matched.id);
        const deposit = stock.deposits.find((d) => String(d.depositoId) === String(mapping.tiny_deposito_id));
        if (!deposit) continue;

        await setInventoryQuantity({
          inventoryItemId: inventory.inventoryItemId,
          locationId: mapping.shopify_location_id,
          quantity: safeNumber(deposit.saldo),
          reason: 'sale'
        });
        updated += 1;
      } catch (error) {
        logAndStore({
          type: 'webhook_sales_item',
          status: 'error',
          message: error.message,
          context: { sku, tinyDepositoId: mapping.tiny_deposito_id }
        });
      }
    }
  }

  logAndStore({
    type: 'webhook_sales',
    status: 'ok',
    message: `Webhook venda processado (${updated} atualizações)`,
    context: { skus }
  });

  return { ok: true, updated };
}

export async function loadIntegrationReferences() {
  const [deposits, locations] = await Promise.all([
    discoverTinyDeposits(),
    listShopifyLocations()
  ]);

  return { deposits, locations };
}

export function getRuntimeConfig() {
  return {
    sync_interval_minutes: Number(getConfigValue('sync_interval_minutes', '180'))
  };
}
