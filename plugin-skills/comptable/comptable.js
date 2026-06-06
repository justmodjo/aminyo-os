#!/usr/bin/env node
/**
 * comptable.js — Agent de comptabilité AminyoOS v2
 *
 * Workflow :
 * 1. Récupère les paiements Stripe (30 derniers jours)
 * 2. Vérifie les acomptes en attente dans Supabase
 * 3. Si retard > 5 jours → signale pour relance
 * 4. Met à jour les statuts dans Supabase
 * 5. Génère un résumé financier
 */

// ─── Bus inter-agents — Lire l'inbox au démarrage ─────────────────
const busProcessor = require('/data/.openclaw/lib/bus-processor.js')
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');;
busProcessor.processInbox('Comptable').catch(e => console.error('[bus] Erreur processInbox:', e.message));

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const LOG_PATH = '/data/.openclaw/plugin-skills/comptable/comptable.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] [comptable] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function getCreds() {
  try {
    return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  } catch {
    log('⚠️ Impossible de lire tools.json');
    return {};
  }
}

// ─── HTTPS REQUEST HELPER ───────────────────────

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'https:' ? https : http;
    const req = mod.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(d ? JSON.parse(d) : null); } catch { resolve(d); }
        } else {
          reject(new Error(`${res.statusCode}: ${d.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── STRIPE ────────────────────────────────────

async function getStripePayments() {
  const creds = getCreds();
  const key = creds.stripe_secret_key || process.env.STRIPE_SECRET_KEY;
  if (!key) {
    log('⚠️ Aucune clé Stripe trouvée');
    return [];
  }

  try {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    const data = await request({
      protocol: 'https:',
      hostname: 'api.stripe.com',
      path: `/v1/charges?created[gte]=${thirtyDaysAgo}&limit=100`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    if (!data || !data.data) {
      log('⚠️ Aucune donnée Stripe reçue');
      return [];
    }

    const paiements = data.data.map(c => ({
      id: c.id,
      client_email: c.billing_details?.email || c.receipt_email || '',
      client_nom: (c.billing_details?.name || '').trim(),
      montant: (c.amount / 100).toFixed(2),
      devise: c.currency,
      statut: c.status === 'succeeded' ? 'paye' : c.status === 'pending' ? 'en_attente' : c.status,
      date_paiement: new Date(c.created * 1000).toISOString().split('T')[0],
      methode: c.payment_method_details?.type || 'carte',
      montant_centimes: c.amount
    }));

    log(`💳 Stripe: ${paiements.length} paiements récupérés`);
    return paiements;
  } catch (e) {
    log(`⚠️ Erreur Stripe: ${e.message.substring(0, 150)}`);
    return [];
  }
}

// ─── SUPABASE HELPER ────────────────────────────

async function supabaseQuery(method, path, bodyObj = null) {
  const creds = getCreds();
  const url = creds.supabase_url || process.env.SUPABASE_URL;
  const key = creds.supabase_service_role_key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    log('⚠️ Credentials Supabase manquants');
    return null;
  }

  const u = new URL(url);
  const fullPath = '/rest/v1/' + path;
  const body = bodyObj ? JSON.stringify(bodyObj) : '';

  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || 443,
    path: fullPath,
    method,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    },
    timeout: 15000
  };

  return request(options, body || null);
}

// ─── ÉTAPE 1 : VÉRIFIER LES PAIEMENTS SUPABASE ──

async function getPaymentsSupabase() {
  try {
    // Récupère tous les paiements avec leur statut
    const result = await supabaseQuery('GET',
      'payments?order=created_at.desc&limit=50'
    );
    if (!Array.isArray(result)) {
      log(`ℹ️ Table payments: ${result ? 'réponse non-array' : 'vide'}`);
      return [];
    }
    log(`📋 ${result.length} paiements dans Supabase`);
    // Log vague — remplacé par un log détaillé à la fin du cycle
    return result;
  } catch (e) {
    log(`⚠️ Erreur Supabase GET: ${e.message.substring(0, 150)}`);
    return [];
  }
}

// ─── ÉTAPE 2 : VÉRIFIER PROJETS AVEC ACOMPTES ──

async function getProjetsWithDeposit() {
  try {
    const result = await supabaseQuery('GET',
      'projects?select=id,title,client_id,budget_total,deposit_status,status&order=created_at.desc&limit=50'
    );
    if (!Array.isArray(result)) return [];
    const enAttente = result.filter(p =>
      p.deposit_status === 'en_attente' || p.deposit_status === 'non_paye'
    );
    log(`📋 ${enAttente.length} projets avec acompte en attente`);
    return enAttente;
  } catch (e) {
    log(`⚠️ Erreur Supabase projets: ${e.message.substring(0, 150)}`);
    return [];
  }
}

// ─── ÉTAPE 3 : SYNCHRONISER STRIPE → SUPABASE ──

async function syncStripeToSupabase(paiements) {
  let created = 0;
  let alreadyExisting = 0;

  for (const p of paiements) {
    if (p.statut !== 'paye') continue;

    try {
      // Vérifier si déjà présent (par l'id Stripe qu'on met dans payment_link)
      const existing = await supabaseQuery('GET',
        `payments?payment_link=eq.${encodeURIComponent('stripe:' + p.id)}&limit=1`
      );

      if (existing && existing.length > 0) {
        alreadyExisting++;
        continue;
      }

      // Créer l'entrée
      await supabaseQuery('POST', 'payments', {
        amount: parseFloat(p.montant),
        payment_type: p.methode,
        status: 'Payé',
        payment_link: 'stripe:' + p.id,
        created_at: new Date(p.date_paiement + 'T12:00:00Z').toISOString()
      });
      created++;
    } catch (e) {
      log(`⚠️ Erreur sync ${p.id}: ${e.message.substring(0, 100)}`);
    }
  }

  log(`📥 Sync Stripe → Supabase: ${created} créés, ${alreadyExisting} déjà existants`);
  return { created, alreadyExisting };
}

// ─── ÉTAPE 4 : RELANCES ─────────────────────────

async function checkDelays(payementsSupabase, projetsEnAttente) {
  const now = Date.now();
  const seuilJours = 5;
  const seuilMs = seuilJours * 86400 * 1000;
  const relances = [];

  // Vérifier les paiements en attente depuis plus de 5 jours
  for (const p of payementsSupabase) {
    if (p.status === 'Payé' || p.status === 'paye') continue;
    const created = new Date(p.created_at || now).getTime();
    const joursRetard = Math.floor((now - created) / 86400000);
    if (joursRetard > seuilJours) {
      relances.push({
        type: 'paiement',
        id: p.id,
        montant: p.amount,
        joursRetard,
        client_id: p.client_id,
        project_id: p.project_id
      });
    }
  }

  // Vérifier les projets avec acompte en attente > 5 jours
  for (const p of projetsEnAttente) {
    const created = new Date(p.created_at || now).getTime();
    const joursRetard = Math.floor((now - created) / 86400000);
    if (joursRetard > seuilJours) {
      relances.push({
        type: 'projet',
        id: p.id,
        projet: p.title,
        budget: p.budget_total,
        joursRetard,
        client_id: p.client_id
      });
    }
  }

  if (relances.length > 0) {
    log(`⏰ ${relances.length} relances potentielles détectées`);
    relances.forEach(r => {
      log(`   → ${r.type === 'paiement' ? `Paiement ${r.montant}€` : `Projet "${r.projet}" (${r.budget}€)`} — ${r.joursRetard}j retard`);
    });
  }

  return relances;
}

// ─── ÉTAPE 5 : RÉSUMÉ ───────────────────────────

function genererResume(paiementsStripe, payementsSupabase, projetsEnAttente, relances, syncResult) {
  const totalPayeStripe = paiementsStripe
    .filter(p => p.statut === 'paye')
    .reduce((s, p) => s + parseFloat(p.montant || 0), 0);

  const totalAttenteProjets = projetsEnAttente
    .reduce((s, p) => s + parseFloat(p.budget_total || 0), 0);

  const resume = [
    `📊 **Résumé financier — ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}**`,
    ``,
    `**💳 Stripe (30 jours)** :`,
    `  • ${paiementsStripe.length} transactions`,
    `  • ${totalPayeStripe.toFixed(2)}€ encaissés`,
    `  • ${syncResult.created} nouveaux sync dans Supabase`,
    ``,
    `**📋 Projets avec acompte en attente** :`,
    `  • ${projetsEnAttente.length} projets`,
    `  • ${totalAttenteProjets.toFixed(2)}€ à encaisser`,
    ``,
    `**⏰ Relances potentielles (J+${5})** :`,
    relances.length > 0
      ? relances.map(r =>
          `  • ${r.type === 'paiement' ? `Paiement ${r.montant}€` : `Projet "${r.projet}"`} — ${r.joursRetard}j`
        ).join('\n')
      : '  • Aucune',
    ``,
    `**💾 Supabase** :`,
    `  • ${payementsSupabase.length} entrées dans payments`,
    `  • ${syncResult.alreadyExisting} déjà synchronisées`,
  ].join('\n');

  return resume;
}

// ─── ENVOI RÉSUMÉ ────────────────────────────────

function saveResume(resume) {
  const briefeurDir = '/data/.openclaw/plugin-skills/briefeur';
  try {
    if (!fs.existsSync(briefeurDir)) fs.mkdirSync(briefeurDir, { recursive: true });
    fs.writeFileSync(
      path.join(briefeurDir, 'resume-financier.json'),
      JSON.stringify({
        date: new Date().toISOString(),
        source: 'comptable',
        resume: resume
      }, null, 2),
      'utf8'
    );
    log(`📝 Résumé sauvegardé pour le Briefeur`);
  } catch (e) {
    log(`⚠️ Échec écriture résumé: ${e.message.substring(0, 80)}`);
  }

  // Écrire le résumé dans un fichier lisible par moi-même
  try {
    fs.writeFileSync('/data/.openclaw/plugin-skills/comptable/dernier-resume.txt', resume, 'utf8');
  } catch {}
}

// ─── MAIN ───────────────────────────────────────

async function run() {
  log('🚀 Démarrage tour Comptable');
  const startMs = Date.now();

  try {
    // 1. Stripe
    log('📡 Étape 1/5: Récupération Stripe...');
    const paiementsStripe = await getStripePayments();

    // 2. Paiements Supabase
    log('📡 Étape 2/5: Vérification paiements Supabase...');
    const payementsSupabase = await getPaymentsSupabase();

    // 3. Projets avec acomptes
    log('📡 Étape 3/5: Vérification acomptes projets...');
    const projetsEnAttente = await getProjetsWithDeposit();

    // 4. Sync Stripe → Supabase
    log('📡 Étape 4/5: Sync Stripe → Supabase...');
    const syncResult = await syncStripeToSupabase(paiementsStripe);

    // 5. Détection retards
    const relances = await checkDelays(payementsSupabase, projetsEnAttente);

    // 6. Résumé
    log('📡 Étape 5/5: Génération résumé...');
    const resume = genererResume(paiementsStripe, payementsSupabase, projetsEnAttente, relances, syncResult);
    saveResume(resume);

    // Stats calculées
    var totalPayeStripe = paiementsStripe
      .filter(function(p) { return p.statut === 'paye'; })
      .reduce(function(s, p) { return s + parseFloat(p.montant || 0); }, 0);
    var totalAttenteProjets = projetsEnAttente
      .reduce(function(s, p) { return s + parseFloat(p.budget_total || 0); }, 0);

    log('✅ Tour Comptable terminé');

    // Log détaillé dans activity_logs
    try {
      await activityLogger.log('comptable', 'cycle_financier', {
        title: 'Cycle financier — ' + paiementsStripe.length + ' transactions Stripe',
        description: relances.length + ' relance(s) detectee(s), ' +
          syncResult.created + ' sync vers Supabase',
        status: 'success',
        duration_ms: Date.now() - startMs,
        details: {
          transactions_stripe: paiementsStripe.length,
          paiements_supabase: payementsSupabase.length,
          ca_stripe_30j_eur: totalPayeStripe.toFixed(2),
          sync_crees: syncResult.created,
          sync_deja_existantes: syncResult.alreadyExisting,
          projets_acompte_attente: projetsEnAttente.length,
          total_attente_eur: totalAttenteProjets.toFixed(2),
          relances_potentielles: relances.length,
          relances_detail: relances.map(function(r) {
            return (r.type === 'paiement'
              ? 'Paiement ' + r.montant + 'EUR - ' + r.joursRetard + 'j'
              : 'Projet "' + r.projet + '" - ' + r.joursRetard + 'j');
          }).join(' | ') || 'aucune',
        },
        result_count: paiementsStripe.length + payementsSupabase.length,
      });
    } catch (alE) { log('Erreur activity log: ' + alE.message); }

  await healthCheck.run("comptable", supabase, { requiredTables: ['payments','clients','activity_logs'], requiredVars: ['SUPABASE_URL'], requiredColumns: { payments: ['id','amount','status'] } }).catch(function(e) { logError("HealthCheck echec: " + e.message); });
    return { ok: true, resume };
  } catch (e) {
    log('❌ Erreur: ' + e.message.substring(0, 200));

    // Log l'erreur avec détails
    try {
      await activityLogger.log('comptable', 'cycle_financier', {
        title: '❌ Cycle financier echoue',
        description: e.message.substring(0, 300),
        status: 'error',
        duration_ms: Date.now() - startMs,
        details: {
          erreur: e.message.substring(0, 500),
          etape: 'inconnue',
          actions_recommandees: 'Verifier les logs comptable.log et Stripe dashboard',
        },
      });
    } catch (alE) { log('Erreur activity log: ' + alE.message); }

    return { ok: false, error: e.message, resume: '❌ Erreur lors du tour comptable' };
  }
}

module.exports = { run };

if (require.main === module) {
  run().then(r => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  }).catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
