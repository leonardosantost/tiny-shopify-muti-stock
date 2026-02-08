import { env } from '../lib/env.js';
import { getConfigValue } from '../lib/db.js';

const TINY_API_BASE = 'https://api.tiny.com.br/api2';

function assertTinyConfigured() {
  if (!getTinyToken()) {
    throw new Error('TINY_API_TOKEN não configurado');
  }
}

function getTinyToken() {
  return getConfigValue('tiny_api_token', env.tiny.token);
}

function getTinyFormat() {
  return getConfigValue('tiny_api_format', env.tiny.format);
}

function normalizeTinyResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resposta inválida da Tiny');
  }

  const root = payload.retorno || payload;
  const errors = root.erros || root.error;
  if (errors) {
    const errText = Array.isArray(errors)
      ? errors.map((item) => item.erro || item.msg || JSON.stringify(item)).join('; ')
      : JSON.stringify(errors);
    throw new Error(`Erro Tiny: ${errText}`);
  }

  return root;
}

export async function callTiny(endpoint, data = {}) {
  assertTinyConfigured();

  const params = new URLSearchParams();
  params.set('token', getTinyToken());
  params.set('formato', getTinyFormat());

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const response = await fetch(`${TINY_API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Tiny HTTP ${response.status}`);
  }

  const payload = await response.json();
  return normalizeTinyResponse(payload);
}

function parseTinyProductRow(row) {
  const product = row.produto || row;
  return {
    id: String(product.id ?? product.idProduto ?? ''),
    sku: product.sku ? String(product.sku).trim() : '',
    nome: product.nome || ''
  };
}

export async function listTinyProducts(page = 1) {
  const root = await callTiny('produtos.pesquisa.php', { pagina: page });
  const products = Array.isArray(root.produtos) ? root.produtos.map(parseTinyProductRow) : [];
  return {
    page,
    totalPages: Number(root.numero_paginas || root.numeroPaginas || 1),
    products
  };
}

function normalizeDeposit(raw) {
  return {
    depositoId: String(raw.idDeposito ?? raw.iddeposito ?? raw.id ?? raw.codigo ?? ''),
    depositoNome: raw.nome || raw.nomeDeposito || raw.deposito || '',
    saldo: Number(raw.saldo ?? raw.saldoFisico ?? raw.quantidade ?? raw.estoque ?? 0)
  };
}

export async function getTinyProductStock(productId) {
  const root = await callTiny('produto.obter.estoque.php', { id: productId });
  const product = root.produto || {};

  const rawDepositos =
    product.depositos ||
    product.deposito ||
    root.depositos ||
    root.deposito ||
    [];

  const deposits = (Array.isArray(rawDepositos) ? rawDepositos : [rawDepositos])
    .filter(Boolean)
    .map((entry) => normalizeDeposit(entry.deposito || entry));

  return {
    productId: String(product.id ?? productId),
    sku: String(product.sku || '').trim(),
    nome: product.nome || '',
    deposits
  };
}

export async function listTinyStockUpdates(page = 1) {
  const root = await callTiny('lista.atualizacoes.estoque', { pagina: page });
  const updates = Array.isArray(root.atualizacoes)
    ? root.atualizacoes.map((entry) => {
        const item = entry.atualizacao || entry;
        return {
          idProduto: String(item.idProduto || item.idproduto || ''),
          sku: String(item.sku || '').trim(),
          saldo: Number(item.saldo || 0),
          depositoId: String(item.idDeposito || item.iddeposito || ''),
          depositoNome: item.nomeDeposito || item.deposito || '',
          dataAtualizacao: item.dataAtualizacao || item.data || ''
        };
      })
    : [];

  return {
    page,
    totalPages: Number(root.numero_paginas || root.numeroPaginas || 1),
    updates
  };
}

export async function discoverTinyDeposits(sampleProducts = 150) {
  const found = new Map();
  let page = 1;
  let seenProducts = 0;

  while (true) {
    const { products, totalPages } = await listTinyProducts(page);
    if (!products.length) break;

    for (const product of products) {
      if (!product.id) continue;
      const stock = await getTinyProductStock(product.id);
      for (const deposit of stock.deposits) {
        if (!deposit.depositoId) continue;
        if (!found.has(deposit.depositoId)) {
          found.set(deposit.depositoId, {
            id: deposit.depositoId,
            nome: deposit.depositoNome || `Depósito ${deposit.depositoId}`
          });
        }
      }

      seenProducts += 1;
      if (seenProducts >= sampleProducts) {
        return Array.from(found.values()).sort((a, b) => a.nome.localeCompare(b.nome));
      }
    }

    if (page >= totalPages) break;
    page += 1;
  }

  return Array.from(found.values()).sort((a, b) => a.nome.localeCompare(b.nome));
}

export async function findTinyProductBySku(sku) {
  if (!sku) return null;

  let page = 1;
  while (true) {
    const { products, totalPages } = await listTinyProducts(page);
    const matched = products.find((product) => product.sku === sku);
    if (matched) return matched;

    if (page >= totalPages) break;
    page += 1;
  }

  return null;
}
