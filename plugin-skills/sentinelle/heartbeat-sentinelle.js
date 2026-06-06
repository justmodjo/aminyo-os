#!/usr/bin/env node
/**
 * Heartbeat Sentinelle - Checks rapides entre les rapports quotidiens
 * S'exécute via le heartbeat OpenClaw (toutes les 30 min)
 * Alerte immédiatement en cas de problème critique
 */

const { execSync } = require('child_process');
const path = require('path')
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');;
const fs = require('fs');

const SENTINELLE_DIR = '/data/.openclaw/plugin-skills/sentinelle';
const STATE_FILE = '/data/workspace/memory/sentinelle-state.json';
const LOG_FILE = '/data/.openclaw/plugin-skills/sentinelle/sentinelle.log';
const TELEGRAM_ID = '6408961089';

// Seuils critiques
const CRITICAL_CHECKS = ['supabase', 'railway', 'watchdog'];
const WARNING_CHECKS = ['make', 'providers'];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastReport: null,
      lastStatus: 'OK',
      consecutiveFailures: {},
      lastAlertSent: null
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendTelegram(msg) {
  try {
    const tools = JSON.parse(fs.readFileSync('/data/.openclaw/plugin-skills/gardien/tools.json', 'utf8'));
    const key = tools["telegram_bot_token"];
    execSync(`curl -s -X POST "https://api.telegram.org/bot${key}/sendMessage" \
      -d "chat_id=${TELEGRAM_ID}" \
      -d "text=${encodeURIComponent(msg)}" \
      -d "parse_mode=HTML" > /dev/null 2>&1`, { timeout: 10000 });
  } catch (e) {
    log('❌ Erreur envoi Telegram: ' + e.message);
  }
}

function runCheck(scriptName) {
  const scriptPath = path.join(SENTINELLE_DIR, scriptName);
  try {
    execSync(`node ${scriptPath}`, { timeout: 30000, stdio: 'pipe' });
    return { status: 'OK' };
  } catch (err) {
    return { status: 'FAIL', error: err.stderr ? err.stderr.toString().substring(0, 200) : err.message };
  }
}

async function main() {

  log('🛡️ Heartbeat Sentinelle');
  
  const state = loadState();
  const results = {};
  let criticalFound = false;
  let warningFound = false;
  
  // Vérifier les tâches interrompues (reprise automatique)
  log('  Tâches interrompues...');
  try {
    var resumer = require('/data/.openclaw/plugin-skills/taches/resumer-taches.js');
    var reprise = await resumer.reprendreTachesInterrompues();
    if (reprise.relancees > 0) {
      log('  🔄 ' + reprise.relancees + ' tâche(s) relancée(s)');
    }
    if (reprise.echecs > 0) {
      log('  ⚠️ ' + reprise.echecs + ' échec(s) de reprise');
    }
  } catch(tqErr) {
    log('  ⚠️ Reprise tâches non disponible: ' + tqErr.message);
  }

  // Checks critiques
  log('  Supabase...');
  results.supabase = runCheck('check-supabase-policy.js');
  if (results.supabase.status === 'FAIL') {
    criticalFound = true;
    log('  ❌ Supabase CRITIQUE');
  } else log('  ✅ Supabase OK');
  
  log('  Railway...');
  results.railway = runCheck('check-railway-policy.js');
  if (results.railway.status === 'FAIL') {
    criticalFound = true;
    log('  ❌ Railway CRITIQUE');
  } else log('  ✅ Railway OK');
  
  log('  Watchdog...');
  results.watchdog = runCheck('check-watchdog.js');
  if (results.watchdog.status === 'FAIL') {
    criticalFound = true;
    log('  ❌ Watchdog CRITIQUE');
  } else log('  ✅ Watchdog OK');
  
  // Checks warning
  log('  Make.com...');
  results.make = runCheck('check-make-policy.js');
  if (results.make.status === 'FAIL') {
    warningFound = true;
    log('  ⚠️ Make WARNING');
  } else log('  ✅ Make OK');
  
  log('  Providers IA...');
  results.providers = runCheck('check-providers-policy.js');
  if (results.providers.status === 'FAIL') {
    warningFound = true;
    log('  ⚠️ Providers WARNING');
  } else log('  ✅ Providers OK');
  
  // Mise à jour de l'état
  const newStatus = criticalFound ? 'CRITICAL' : warningFound ? 'WARNING' : 'OK';
  state.lastStatus = newStatus;
  state.lastCheck = new Date().toISOString();
  
  // Alerte immédiate si critique — avec détails précis
  if (criticalFound || warningFound) {
    const now = Date.now();
    const lastAlert = state.lastAlertSent ? new Date(state.lastAlertSent).getTime() : 0;
    
    // Ne pas alerter plus d'une fois par heure sauf si nouveau problème
    if (now - lastAlert > 3600000) {
      var failedEntries = Object.entries(results).filter(([_, r]) => r.status === 'FAIL');

      var detailsAlerte = {};
      var alertLines = [];
      var actionRecommandee = 'Aucune action manuelle requise';

      failedEntries.forEach(function([key, res]) {
        var errorDetail = res.error || 'Indisponible';
        detailsAlerte[key] = {
          statut: 'FAIL',
          niveau: CRITICAL_CHECKS.includes(key) ? 'critique' : 'warning',
          erreur: errorDetail
        };

        if (key === 'supabase') {
          alertLines.push('❌ Supabase — table(s) inaccessible(s) ou GRANT manquant');
          actionRecommandee = 'Vérifier la table concernée dans check-supabase-policy.js et les permissions GRANT';
        } else if (key === 'railway') {
          alertLines.push('❌ Railway — service OpenClaw injoignable ou API hors ligne');
          actionRecommandee = 'Redémarrer le service Railway depuis le dashboard ou attendre le redémarrage automatique (Gardien)';
        } else if (key === 'watchdog') {
          alertLines.push('❌ Watchdog Mino — l agent ne répond pas');
          actionRecommandee = 'Vérifier que le service est démarré et joignable sur son endpoint';
        } else if (key === 'make') {
          alertLines.push('⚠️ Make.com — API inaccessible ou scénarios en erreur');
          actionRecommandee = 'Vérifier le dashboard Make.com pour les scénarios en échec';
        } else if (key === 'providers') {
          alertLines.push('⚠️ Providers IA — modèle(s) injoignable(s)');
          actionRecommandee = 'Vérifier les clés API (OpenAI, DeepSeek, Anthropic) et les quotas';
        }
      });

      var msg = (criticalFound ? '🚨 ALERTE CRITIQUE' : '⚠️ ALERTE WARNING') + ' - Sentinelle\n\n' +
        alertLines.join('\n') + '\n\n' +
        '🔧 Action recommandée : ' + actionRecommandee;

      var msgTelegram = encodeURI(msg);
      sendTelegram(msgTelegram);

      // Log détaillé dans activity_logs
      activityLogger.log('sentinelle', criticalFound ? 'alerte_critique' : 'alerte_warning', {
        title: (criticalFound ? '🚨' : '⚠️') + ' Alerte Sentinelle — ' + failedEntries.map(function(e) { return e[0]; }).join(', '),
        description: alertLines.join('. '),
        status: criticalFound ? 'error' : 'warning',
        details: {
          declencheur: failedEntries.map(function(e) { return e[0]; }),
          niveau: criticalFound ? 'critique' : 'warning',
          services_concretes: failedEntries.map(function(e) { return e[0]; }),
          tables_supabase_concernees: results.supabase?.error || null,
          erreurs_par_service: detailsAlerte,
          action_recommandee: actionRecommandee,
          statut_resume: failedEntries.map(function(e) { return e[0] + ': ' + (e[1].error || 'indisponible').substring(0, 80); }).join(' | '),
        },
      }).catch(function(e) { log('Erreur activity log: ' + e.message); });

      state.lastAlertSent = new Date().toISOString();
      log('🚨 Alerte Telegram envoyée');
    } else {
      log('  ⏭️ Alerte déjà envoyée récemment, skip');
    }
  }
  
  saveState(state);
  log(`📊 Statut: ${newStatus}`);
}

main().catch(err => log('❌ Erreur heartbeat: ' + err.message));
