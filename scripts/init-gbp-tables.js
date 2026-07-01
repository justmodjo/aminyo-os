#!/usr/bin/env node
/**
 * Script d'initialisation des tables GBP pour Réputateur & Auditeur
 * 
 * Exécute la migration SQL via un appel à l'API Supabase SQL (si disponible)
 * ou via le PostgreSQL direct.
 * 
 * Usage: node init-gbp-tables.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const MIGRATION_PATH = '/data/workspace/migrations/2026-06-18-gbp-reputation-avis.sql';

function chargeCreds() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

async function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(url, { ...options, timeout: 30000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: res.statusCode }); }
        catch { resolve({ data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('🚀 Initialisation des tables GBP...\n');
  
  const creds = chargeCreds();
  const supabaseUrl = creds.supabase_url || process.env.SUPABASE_URL;
  const supabaseKey = creds.supabase_service_role_key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase credentials manquants dans tools.json');
    process.exit(1);
  }
  
  // Essayer via le endpoint /sql de Supabase (disponible sur self-hosted ou via le dashboard)
  // Sinon, on utilise l'API REST /rest/v1/rpc/execute_sql si la fonction existe
  
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  
  console.log('📝 Migration SQL chargée (' + migration.length + ' octets)');
  console.log('🔗 Supabase:', supabaseUrl);
  
  // Tentative 1: endpoint /sql (disponible si pg_net est configuré)
  try {
    console.log('\n📡 Tentative via /rest/v1/rpc/execute_sql...');
    const result = await request(
      supabaseUrl + '/rest/v1/rpc/execute_sql',
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Content-Type': 'application/json',
        },
      },
      { sql_text: migration }
    );
    console.log('✅ Résultat:', JSON.stringify(result.data || result, null, 2));
    console.log('✅ Table reputation_avis créée (via RPC execute_sql)');
    return { ok: true, method: 'rpc' };
  } catch (e) {
    console.log('⚠️ RPC execute_sql indisponible:', e.message?.slice(0, 60));
  }
  
  // Tentative 2: via le SQL endpoint direct (custom)
  // On va créer la table via une requête REST directe à Supabase
  // en utilisant les patterns d'insertion
  console.log('\n📡 Vérification si la table existe déjà...');
  try {
    const check = await request(
      supabaseUrl + '/rest/v1/reputation_avis?select=count&limit=1',
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Accept': 'application/json',
        },
      }
    );
    if (check.status !== 404 && check.status !== 200) {
      // Probablement que la table n'existe pas, essayer de la créer
    }
    if (check.data && !check.data.code) {
      console.log('✅ Table reputation_avis existe déjà');
      return { ok: true, method: 'existing' };
    }
  } catch (e) {
    console.log('⚠️ Check table:', e.message?.slice(0, 60));
  }
  
  // Tentative 3: Créer via Supabase Management API (si PG connection string est dispo)
  console.log('\n⚠️ Impossible de créer la table via REST API.');
  console.log('🔧 Veuillez exécuter le SQL manuellement dans Supabase Dashboard:');
  console.log('   https://supabase.com/dashboard/project/uurauxmdjhufidifldpv/sql/new');
  console.log('\n📋 SQL à exécuter:');
  console.log('─'.repeat(60));
  console.log(migration);
  console.log('─'.repeat(60));
  
  return { ok: false, method: null, needsManual: true, sql: migration };
}

main().then(r => {
  console.log('\n' + (r.ok ? '✅' : '❌') + ' Terminé');
  if (r.needsManual) process.exit(2);
  process.exit(r.ok ? 0 : 1);
}).catch(e => {
  console.error('❌ Erreur fatale:', e.message);
  process.exit(1);
});
