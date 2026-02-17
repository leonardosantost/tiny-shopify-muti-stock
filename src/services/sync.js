import {
  addLog,
  getConfigValue,
  getMappingByDeposito,
  getMappingByDepositoNome,
  listActiveMappings,
  setConfigValue
} from '../lib/db.js';
import {
  findTinyProductBySku,
  getTinyProductStock,
  listTinyStockUpdates,
  listTinyProducts
} from './tiny.js';
import {
  findInventoryItemBySku,
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

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseTinyDateToMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const native = Date.parse(raw);
  if (!Number.isNaN(native)) return native;

  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!br) return 0;

  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = br;
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
}

function findMatchingDeposit(mapping, deposits = []) {
  const mappedName = normalizeKey(mapping.tiny_deposito_nome);
  const mappedId = normalizeKey(mapping.tiny_deposito_id);

  // Primary match: depósito name (Tiny v2 usually provides only name).
  if (mappedName) {
    const byName = deposits.find((d) => normalizeKey(d.depositoNome) === mappedName);
    if (byName) return byName;
  }

  // Fallback by id if available.
  if (mappedId) {
    const byId = deposits.find((d) => normalizeKey(d.depositoId) === mappedId);
    if (byId) return byId;
  }

  return null;
}

function findMappingForStockUpdate(update, mappings) {
  const byName = mappings.find(
    (mapping) =>
      normalizeKey(mapping.tiny_deposito_nome) &&
      normalizeKey(mapping.tiny_deposito_nome) === normalizeKey(update.depositoNome)
  );
  if (byName) return byName;

  const byId = mappings.find(
    (mapping) =>
      normalizeKey(mapping.tiny_deposito_id) &&
      normalizeKey(mapping.tiny_deposito_id) === normalizeKey(update.depositoId)
  );
  return byId || null;
}

async function syncSkuAcrossMappings(
  sku,
  mappings,
  { reason = 'correction', source = 'sku_sync', productId = null } = {}
) {
  if (!sku) {
    return { ok: true, updated: 0, skipped: mappings.length, notFound: 0, reason: 'sku_missing' };
  }

  let tinyProduct = null;
  if (productId) {
    tinyProduct = { id: String(productId), sku };
  } else {
    tinyProduct = await findTinyProductBySku(sku);
  }

  if (!tinyProduct?.id) {
    return { ok: true, updated: 0, skipped: mappings.length, notFound: 0, reason: 'tiny_sku_not_found' };
  }

  const stock = await getTinyProductStock(tinyProduct.id);
  const effectiveSku = stock.sku || sku;

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const mapping of mappings) {
    try {
      const deposit = findMatchingDeposit(mapping, stock.deposits);
      if (!deposit) {
        skipped += 1;
        continue;
      }

      const result = await updateSkuOnMapping({
        sku: effectiveSku,
        quantity: safeNumber(deposit.saldo),
        mapping,
        reason,
        source
      });

      if (result.status === 'updated') updated += 1;
      if (result.status === 'not_found') notFound += 1;
      if (result.status === 'skipped') skipped += 1;
    } catch (error) {
      skipped += 1;
      logAndStore({
        type: 'sku_sync_item',
        status: 'error',
        message: error.message,
        context: { sku: effectiveSku, tinyDepositoNome: mapping.tiny_deposito_nome }
      });
    }
  }

  return { ok: true, updated, skipped, notFound, sku: effectiveSku, productId: tinyProduct.id };
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
  const tinyStock = options.stock ?? await getTinyProductStock(product.id);
  const deposit = findMatchingDeposit(mapping, tinyStock.deposits);
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
        let stock = null;
        try {
          stock = await getTinyProductStock(product.id);
        } catch (error) {
          skipped += mappings.length;
          logAndStore({
            type: 'full_sync_item',
            status: 'error',
            message: error.message,
            context: {
              productId: product.id,
              sku: product.sku
            }
          });
          continue;
        }

        for (const mapping of mappings) {
          try {
            const result = await syncSingleProductForMapping(product, mapping, {
              reason: 'correction',
              source: 'full_sync',
              stock
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
  const depositoNome = String(data.nomeDeposito || data.deposito || data.depositoNome || '');
  const sku = String(data.sku || '').trim();
  const idProduto = String(data.idProduto || data.idproduto || '');
  const hasSaldo = data.saldo !== undefined && data.saldo !== null && data.saldo !== '';

  let quantity = hasSaldo ? safeNumber(data.saldo) : null;
  let mapping = depositoId ? getMappingByDeposito(depositoId) : null;
  if (!mapping && depositoNome) {
    mapping = getMappingByDepositoNome(depositoNome);
  }

  if (!mapping && (depositoId || depositoNome)) {
    logAndStore({
      type: 'webhook_stock',
      status: 'skipped',
      message: 'Depósito sem mapeamento',
      context: { depositoId, depositoNome, sku, idProduto }
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
    const deposit = findMatchingDeposit(mapping, stock.deposits);
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
  let skipped = 0;
  let notFound = 0;
  for (const sku of skus) {
    const result = await syncSkuAcrossMappings(sku, mappings, {
      reason: 'sale',
      source: 'webhook_sales'
    });
    updated += result.updated || 0;
    skipped += result.skipped || 0;
    notFound += result.notFound || 0;
  }

  logAndStore({
    type: 'webhook_sales',
    status: 'ok',
    message: `Webhook venda processado (${updated} atualizações)`,
    context: { skus, skipped, notFound }
  });

  return { ok: true, updated };
}

export async function runSkuSync({ sku, trigger = 'manual_test' } = {}) {
  const normalizedSku = String(sku || '').trim();
  if (!normalizedSku) {
    return { ok: false, error: 'sku é obrigatório' };
  }

  const mappings = listActiveMappings();
  if (!mappings.length) {
    return { ok: false, error: 'Nenhum mapeamento ativo configurado' };
  }

  try {
    const result = await syncSkuAcrossMappings(normalizedSku, mappings, {
      reason: 'correction',
      source: 'manual_sku_test'
    });

    logAndStore({
      type: 'sku_test',
      status: 'ok',
      message: `Teste SKU concluído (${result.updated} atualizações)`,
      context: { sku: normalizedSku, trigger, skipped: result.skipped, notFound: result.notFound }
    });

    return { ok: true, ...result };
  } catch (error) {
    logAndStore({
      type: 'sku_test',
      status: 'error',
      message: error.message,
      context: { sku: normalizedSku, trigger }
    });

    return { ok: false, error: error.message };
  }
}

export async function runIncrementalSync({ trigger = 'scheduler' } = {}) {
  const mappings = listActiveMappings();
  if (!mappings.length) {
    logAndStore({
      type: 'incremental_sync',
      status: 'skipped',
      message: 'Nenhum mapeamento ativo para incremental sync',
      context: { trigger }
    });
    return { ok: true, updated: 0, skipped: 0, notFound: 0 };
  }

  const lastProcessedMs = Number(getConfigValue('tiny_stock_updates_last_ms', '0')) || 0;
  let page = 1;
  let maxSeenMs = lastProcessedMs;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let processed = 0;

  try {
    while (true) {
      const { updates, totalPages } = await listTinyStockUpdates(page);
      if (!updates.length) break;

      for (const update of updates) {
        const updateMs = parseTinyDateToMs(update.dataAtualizacao);
        if (updateMs) {
          maxSeenMs = Math.max(maxSeenMs, updateMs);
          if (lastProcessedMs && updateMs <= lastProcessedMs) {
            continue;
          }
        }

        const mapping = findMappingForStockUpdate(update, mappings);
        if (!mapping) {
          skipped += 1;
          continue;
        }

        let sku = String(update.sku || '').trim();
        let quantity =
          update.saldo === undefined || update.saldo === null || Number.isNaN(Number(update.saldo))
            ? null
            : Number(update.saldo);

        if ((!sku || quantity === null) && update.idProduto) {
          const stock = await getTinyProductStock(update.idProduto);
          const deposit = findMatchingDeposit(mapping, stock.deposits);
          sku = sku || stock.sku || '';
          quantity = deposit ? safeNumber(deposit.saldo) : 0;
        }

        const result = await updateSkuOnMapping({
          sku,
          quantity: quantity ?? 0,
          mapping,
          reason: 'correction',
          source: 'incremental_sync'
        });

        if (result.status === 'updated') updated += 1;
        if (result.status === 'not_found') notFound += 1;
        if (result.status === 'skipped') skipped += 1;
        processed += 1;
      }

      if (page >= totalPages) break;
      page += 1;
    }

    if (maxSeenMs > lastProcessedMs) {
      setConfigValue('tiny_stock_updates_last_ms', String(maxSeenMs));
    }

    logAndStore({
      type: 'incremental_sync',
      status: 'ok',
      message: `Incremental sync concluído (${updated} atualizações)`,
      context: { trigger, processed, updated, skipped, notFound, lastProcessedMs, maxSeenMs }
    });

    return { ok: true, processed, updated, skipped, notFound, lastProcessedMs, maxSeenMs };
  } catch (error) {
    logAndStore({
      type: 'incremental_sync',
      status: 'error',
      message: error.message,
      context: { trigger, page }
    });
    return { ok: false, error: error.message };
  }
}
