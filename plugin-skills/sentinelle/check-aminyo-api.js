#!/usr/bin/env node
/**
 * check-aminyo-api.js — Vérifie que l'API Express Railway répond
 * Retour avec code 0 si OK, code 1 si FAIL
 */
const https = require('https');

https.get('https://aminyo-os-api-production.up.railway.app/health', { timeout: 10000 }, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      process.exit(0); // OK
    } else {
      console.error(`Status: ${res.statusCode}`);
      process.exit(1); // FAIL
    }
  });
}).on('error', (e) => {
  console.error(e.message);
  process.exit(1); // FAIL
}).on('timeout', function() { this.destroy(); process.exit(1); });
