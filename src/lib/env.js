import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  tiny: {
    token: process.env.TINY_API_TOKEN || '',
    format: process.env.TINY_API_FORMAT || 'json',
    webhookSecret: process.env.TINY_WEBHOOK_SECRET || ''
  },
  shopify: {
    store: process.env.SHOPIFY_STORE || '',
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-01',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    scopes:
      process.env.SHOPIFY_SCOPES ||
      'read_products,read_locations,read_inventory,write_inventory',
    redirectUri: process.env.SHOPIFY_REDIRECT_URI || ''
  },
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || 180)
};
