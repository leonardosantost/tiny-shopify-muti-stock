import { env } from '../lib/env.js';
import { getConfigValue, getSkuCache, saveSkuCache } from '../lib/db.js';

function getShopifyStore() {
  return getConfigValue('shopify_store', env.shopify.store);
}

function getShopifyToken() {
  return getConfigValue('shopify_access_token', env.shopify.accessToken);
}

function getShopifyApiVersion() {
  return getConfigValue('shopify_api_version', env.shopify.apiVersion);
}

function assertShopifyConfigured() {
  if (!getShopifyStore() || !getShopifyToken()) {
    throw new Error('SHOPIFY_STORE/SHOPIFY_ACCESS_TOKEN não configurado');
  }
}

function toLocationGid(locationId) {
  return String(locationId).startsWith('gid://')
    ? String(locationId)
    : `gid://shopify/Location/${locationId}`;
}

function toInventoryItemGid(inventoryItemId) {
  return String(inventoryItemId).startsWith('gid://')
    ? String(inventoryItemId)
    : `gid://shopify/InventoryItem/${inventoryItemId}`;
}

async function shopifyGraphql(query, variables = {}) {
  assertShopifyConfigured();

  const url = `https://${getShopifyStore()}/admin/api/${getShopifyApiVersion()}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': getShopifyToken()
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(`Shopify GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`);
  }

  return payload.data;
}

export async function listShopifyLocations() {
  const query = `
    query Locations($first: Int!) {
      locations(first: $first) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(query, { first: 100 });
  return data.locations.edges
    .map((edge) => ({
      id: edge.node.id,
      numericId: edge.node.id.split('/').pop(),
      name: edge.node.name,
      isActive: edge.node.isActive
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function findInventoryItemBySku(sku) {
  if (!sku) return null;

  const cached = getSkuCache(sku);
  if (cached) {
    return {
      inventoryItemId: toInventoryItemGid(cached.shopify_inventory_item_id),
      variantId: cached.shopify_variant_id || null,
      title: cached.product_title || null,
      source: 'cache'
    };
  }

  const query = `
    query FindVariantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            title
            product {
              title
            }
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphql(query, { query: `sku:${sku}` });
  const edge = data.productVariants.edges[0];
  if (!edge) return null;

  const node = edge.node;
  const result = {
    inventoryItemId: node.inventoryItem.id,
    variantId: node.id,
    title: `${node.product.title} - ${node.title}`,
    source: 'api'
  };

  saveSkuCache({
    sku,
    shopify_inventory_item_id: result.inventoryItemId,
    shopify_variant_id: result.variantId,
    product_title: result.title
  });

  return result;
}

export async function setInventoryQuantity({ inventoryItemId, locationId, quantity, reason = 'correction' }) {
  const mutation = `
    mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors {
          field
          message
        }
        inventoryAdjustmentGroup {
          reason
          referenceDocumentUri
          changes {
            name
            delta
          }
        }
      }
    }
  `;

  const variables = {
    input: {
      name: 'available',
      reason,
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId: toInventoryItemGid(inventoryItemId),
          locationId: toLocationGid(locationId),
          quantity: Number(quantity)
        }
      ]
    }
  };

  const data = await shopifyGraphql(mutation, variables);
  const result = data.inventorySetQuantities;

  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }

  return result;
}
