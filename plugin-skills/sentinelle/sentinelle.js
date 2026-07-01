#!/usr/bin/env node
/**
 * Sentinelle - Orchestrateur de vérifications
 * Lance tous les checks et résume les résultats avec logs précis
 * Usage : node sentinelle.js
 * Options : --supabase, --railway, --make, --providers (check spécifique)
 *           --all (défaut, lance tout)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');

const SCRIPTS_DIR = __dirname;
const LOG_FILE = '/data/.openclaw/plugin-skills/sentinelle/sentinelle.log';
const STATE_FILE = '/data/workspace/memory/sentinelle-state.json';

const CHECK_SCRIPTS = {
  supabase: {
    label: 'Supabase GRANTs',
    file: 'check-supabase-policy.js',
    emoji: '🗄️',
    niveau: 'critique',
    tables_concernees: ['activity_logs', 'ai_actions', 'agent_memory', 'leads', 'clients', 'payments', 'tasks', 'projects']
  },
  railway: {
    label: 'Railway',
    file: 'check-railway-policy.js',
    emoji: '🚆',
    niveau: 'critique',
    tables_concernees: null
  },
  aminpy_api: {
    label: 'API Express Aminyo',
    file: 'check-aminyo-api.js',
    emoji: '🚆',
    niveau: 'critique',
    tables_concernees: null
  },
  providers: {
    label: 'Providers IA',
    file: 'check-providers-policy.js',
    emoji: '🔌',
    niveau: 'warning',
    tables_concernees: null
  }
};

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(msg);
}

function runCheck(key) {
  const script = CHECK_SCRIPTS[key];
  const scriptPath = path.join(SCRIPTS_DIR, script.file);
  
  console.log('\n' + '='.repeat(50));
  console.log(script.emoji + ' ' + script.label);
  console.log('='.repeat(50) + '\n');
  
  try {
    // Capturer stdout pour extraire les erreurs détaillées
    var output = execSync('node ' + scriptPath, {
      cwd: SCRIPTS_DIR,
      timeout: 60000,
      stdio: 'pipe'
    }).toString();
    
    // Extraire les lignes d'erreur du script
    var errorLines = output.split('\n').filter(function(l) {
      return l.includes('❌') || l.includes('⚠️') || l.includes('ERREUR') || l.includes('err');
    });
    
    return { status: 'OK', output: output, errors: errorLines };
  } catch (err) {
    var stderr = (err.stderr || '').toString();
    var stdout = (err.stdout || '').toString();
    var errorLines = stderr.split('\n').filter(Boolean);
    var outputLines = stdout.split('\n').filter(Boolean);
    
    return {
      status: 'FAIL',
      error: stderr.substring(0, 300) || err.message,
      errorLines: errorLines.slice(0, 5),
      output: outputLines.slice(0, 10)
    };
  }
}

function saveState(results, allOk, criticalFound, warningFound) {
  try {
    var state = {
      lastCheck: new Date().toISOString(),
      status: criticalFound ? 'CRITICAL' : warningFound ? 'WARNING' : 'OK',
      checks: {},
    };
    Object.keys(results).forEach(function(key) {
      state.checks[key] = { status: results[key].status };
      if (results[key].status === 'FAIL') {
        state.checks[key].error = (results[key].error || '').substring(0, 200);
        state.checks[key].errorLines = results[key].errorLines || [];
      }
    });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    log('Erreur sauvegarde état: ' + e.message);
  }
}

function main() {
  const args = process.argv.slice(2);
  let checksToRun;
  
  if (args.length === 0 || args.includes('--all')) {
    checksToRun = Object.keys(CHECK_SCRIPTS);
  } else {
    checksToRun = args.filter(a => !a.startsWith('--')).map(a => a.toLowerCase());
    checksToRun = checksToRun.filter(k => CHECK_SCRIPTS[k]);
    if (checksToRun.length === 0) checksToRun = Object.keys(CHECK_SCRIPTS);
  }

  console.log('🛡️  Sentinelle - Rapport complet');
  console.log('📅 ' + new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }));
  
  const results = {};
  
  for (const key of checksToRun) {
    results[key] = runCheck(key);
    log('  ' + CHECK_SCRIPTS[key].emoji + ' ' + CHECK_SCRIPTS[key].label + ' : ' + results[key].status);
    if (results[key].status === 'FAIL') {
      log('    → ' + (results[key].error || '').substring(0, 150));
      (results[key].errorLines || []).forEach(function(ln) { log('    → ' + ln.substring(0, 200)); });
    }
  }
  
  // Résumé final
  console.log('\n' + '='.repeat(50));
  console.log('📊 RÉSUMÉ SENTINELLE');
  console.log('='.repeat(50) + '\n');
  
  var allOk = true;
  var anyCritical = false;
  var anyWarning = false;
  
  for (const [key, result] of Object.entries(results)) {
    var script = CHECK_SCRIPTS[key];
    var isOk = result.status === 'OK';
    console.log('  ' + script.emoji + ' ' + script.label + ' : ' + (isOk ? '✅ OK' : '❌ PROBLÈME'));
    if (!isOk) {
      allOk = false;
      if (script.niveau === 'critique') anyCritical = true;
      else anyWarning = true;
    }
  }
  
  console.log('\n' + (allOk ? '✅ Tout est opérationnel' : anyCritical ? '❌ Problèmes critiques détectés' : '⚠️ Problèmes non-critiques détectés'));
  
  // Log dans activity_logs avec détails précis
  try {
    var failedEntries = Object.entries(results).filter(function(e) { return e[1].status === 'FAIL'; });
    var detailsParCheck = {};
    Object.keys(results).forEach(function(key) {
      var r = results[key];
      detailsParCheck[key] = {
        statut: r.status,
        niveau: CHECK_SCRIPTS[key].niveau,
        service: CHECK_SCRIPTS[key].label,
        erreur: r.status === 'FAIL' ? (r.error || 'inconnue').substring(0, 200) : null,
        tables_concernees: CHECK_SCRIPTS[key].tables_concernees
      };
    });

    activityLogger.log('sentinelle', 'verification', {
      title: (allOk ? '✅' : '❌') + ' Vérification Sentinelle',
      description: (checksToRun.length === Object.keys(CHECK_SCRIPTS).length ? 'Vérification complète' : 'Vérification partielle: ' + checksToRun.join(', ')),
      status: allOk ? 'success' : (anyCritical ? 'error' : 'warning'),
      details: {
        services_verifies: checksToRun,
        services_en_echec: failedEntries.map(function(e) { return e[0]; }),
        niveau_plus_grave: anyCritical ? 'critique' : (anyWarning ? 'warning' : 'success'),
        detail_par_service: detailsParCheck,
        actions_recommandees: failedEntries.map(function(e) {
          var k = e[0];
          if (k === 'supabase') return 'Vérifier les tables Supabase et les permissions GRANT';
          if (k === 'railway') return 'Redémarrer le service Railway';
          if (k === 'aminpy_api') return 'Vérifier le déploiement Railway de aminyo-os-api';
          if (k === 'providers') return 'Vérifier clés API (OpenAI, DeepSeek, Anthropic)';
          if (k === 'providers') return 'Vérifier clés API (OpenAI, DeepSeek, Anthropic)';
          return 'Diagnostic requis';
        }).join(' | '),
        date_verification: new Date().toISOString()
      },
      result_count: failedEntries.length,
    });
  } catch(alE) {
    log('Erreur activity log: ' + alE.message);
  }

  saveState(results, allOk, anyCritical, anyWarning);
  
  process.exit(allOk ? 0 : 1);
}

main();
