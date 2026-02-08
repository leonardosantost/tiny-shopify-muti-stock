# Tiny ↔ Shopify Stock Sync

Sincroniza estoque da Tiny por depósito para locations do Shopify, com:
- sincronização periódica (default: 3h);
- sincronização pontual por webhook de estoque da Tiny;
- gatilho de reconciliação por webhook de vendas;
- frontend simples para configurar credenciais, mapeamentos e ver logs.

## Requisitos

- Node.js 20+
- Credenciais Tiny API v2
- Credenciais Shopify Admin API (`write_inventory`, `read_locations`, `read_products`)

## Instalação

```bash
cp .env.example .env
npm install
npm run dev
```

Servidor: `http://localhost:3000`

## Deploy (importante)

- Use Node `22` (arquivo `.nvmrc` incluído).
- Em CI/container, prefira `npm ci` (install limpo).
- Se for obrigatoriamente Node 24+, o `better-sqlite3` pode compilar do source, então o container precisa de toolchain:
  - Debian/Ubuntu: `apt-get update && apt-get install -y python3 make g++`

## Webhooks

Configure na Tiny os endpoints:

- Estoque: `http://SEU_HOST:3000/webhooks/tiny/stock`
- Vendas: `http://SEU_HOST:3000/webhooks/tiny/sales`

Se usar segredo, defina `tiny_webhook_secret` (na tela ou `.env`) e envie no header:
- `x-webhook-secret: <secret>`

## Fluxo de sincronização

1. Full sync manual ou scheduler:
- `produtos.pesquisa.php` (lista produtos)
- `produto.obter.estoque.php` (saldo por depósito)
- atualiza `available` no Shopify via `inventorySetQuantities` na location mapeada.

2. Webhook de estoque Tiny:
- atualiza SKU imediatamente quando recebe `idProduto/sku/saldo/idDeposito`.

3. Webhook de vendas:
- extrai SKUs do payload;
- busca saldo atual na Tiny;
- reconcilia no Shopify.

## Frontend

A tela principal (`/`) permite:
- salvar credenciais Tiny/Shopify e intervalo (min);
- gerar `SHOPIFY_ACCESS_TOKEN` por OAuth (com `client_id` + `client_secret`);
- carregar depósitos Tiny e locations Shopify;
- criar/remover mapeamento depósito→location;
- executar full sync manual;
- testar webhook de estoque;
- acompanhar logs.

## Shopify OAuth (simples)

Se você só tem `client_id` e `client_secret`:

1. Preencha no frontend:
- `Shopify store`
- `Shopify client id`
- `Shopify client secret`
- (opcional) `Shopify OAuth scopes` e `Shopify redirect URI`

2. Clique em `Salvar configuração`.
3. Clique em `Conectar Shopify (OAuth)`.
4. Autorize no admin da loja.
5. O callback salva automaticamente:
- `shopify_access_token`
- `shopify_store`
- `shopify_installed_scopes`

Redirect padrão usado pelo backend (se não configurar um custom):
- `${BASE_URL}/auth/shopify/callback`

## Endpoints úteis

- `GET /api/config`
- `POST /api/config`
- `GET /api/shopify/oauth/status`
- `GET /api/shopify/oauth/start`
- `GET /auth/shopify/start`
- `GET /auth/shopify/callback`
- `GET /api/references`
- `GET /api/mappings`
- `POST /api/mappings`
- `DELETE /api/mappings/:tinyDepositoId`
- `GET /api/logs`
- `POST /api/sync/full`
- `POST /webhooks/tiny/stock`
- `POST /webhooks/tiny/sales`

## Observações

- O projeto usa SQLite local (`sync.db`).
- A identificação de produto no Shopify é por SKU.
- Se o SKU não existir no Shopify, o evento é logado como `not_found/skipped`.
