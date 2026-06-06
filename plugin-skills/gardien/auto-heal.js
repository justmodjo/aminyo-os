#!/usr/bin/env node
/**
 * 🛡️ Gardien Auto-Heal - Détection et réparation automatique des sessions bloquées
 * 
 * Détecte les sessions bloquées (heartbeat-recovered, sessions anciennes)
 * et tente de les réparer automatiquement.
 * 
 * Intégré dans le système Heartbeat pour surveillance continue.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const LOG_FILE = path.join(__dirname, 'gardien.log');
const STATE_FILE = '/data/workspace/memory/heartbeat-state.json';
const TELEGRAM_CHAT_ID = '6408961089';
const CONFIG_FILE = path.join(__dirname, 'tools.json');
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');

// Seuils de détection
const THRESHOLDS = {
  HEARTBEAT_MAX_AGE_MS: 10 * 60 * 1000, // 10 minutes max pour une session heartbeat
  STALE_SESSION_AGE_MS: 30 * 60 * 1000, // 30 minutes = session probablement morte
  MAX_RECOVERED_SESSIONS: 3, // Plus de 3 sessions "recovered" = problème
};

// Logging
function log(message, emoji = '🛡️') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${emoji} ${message}`;
  console.log(logLine);
  try {
    fs.appendFileSync(LOG_FILE, logLine + '\n');
  } catch (err) {
    console.error('❌ Erreur log:', err.message);
  }
}

// Envoyer une alerte Telegram — avec log structuré
function sendTelegramAlert(message, priority = 'normal') {
  // Construire les détails structurés depuis le message
  var alertDetails = {
    priorite: priority,
    declencheur: 'inconnu',
    service_concerne: 'gardien',
    action_recommandee: 'Diagnostic requis',
    date: new Date().toISOString(),
    message_original: message.substring(0, 300),
  };

  // Extraire le déclencheur du message
  if (message.includes('recovered')) alertDetails.declencheur = 'trop_de_sessions_recovered';
  else if (message.includes('heartbeat') || message.includes('bloqué')) alertDetails.declencheur = 'sessions_heartbeat_bloquees';
  else if (message.includes('aucune session') || message.includes('session trouvée')) alertDetails.declencheur = 'aucune_session_detectee';
  else if (message.includes('Redémarrage')) alertDetails.declencheur = 'redemarrage_force';
  else if (message.includes('cleanup') || message.includes('nettoyage')) alertDetails.declencheur = 'cleanup_sessions';

  // Extraire les chiffres du message (ex: '3 sessions recovered')
  var countMatch = message.match(/(\d+) sessions/);
  if (countMatch) alertDetails.quantite_sessions = parseInt(countMatch[1]);

  // Action recommandée
  if (priority === 'critical') {
    if (message.includes('Railway')) alertDetails.action_recommandee = 'Redémarrer le service Railway depuis le dashboard';
    else if (message.includes('gateway')) alertDetails.action_recommandee = 'Redémarrer OpenClaw gateway: openclaw gateway restart';
    else alertDetails.action_recommandee = 'Intervention manuelle requise - consulter les logs';
  } else {
    if (message.includes('cleanup')) alertDetails.action_recommandee = 'Aucune action requise - auto-heal en cours';
    else alertDetails.action_recommandee = 'Surveiller la situation - auto-heal actif';
  }

  activityLogger.log('gardien', 'alerte', {
    title: (priority === 'critical' ? '🚨 Alerte Gardien' : '⚠️ Alerte Gardien') + ' — ' + alertDetails.declencheur.replace(/_/g, ' '),
    description: message.substring(0, 200),
    status: priority === 'critical' ? 'error' : 'warning',
    details: alertDetails,
  }).catch(function(e) {
    require('fs').appendFileSync('/data/.openclaw/plugin-skills/gardien/gardien.log', '[activity_log_err] ' + e.message + '\n');
  });

  const emoji = priority === 'critical' ? '🚨' : '⚠️';
  const finalMessage = `${emoji} **Auto-Heal Gardien**\n\n${message}`;
  
  try {
    // Utiliser l'API interne OpenClaw pour envoyer via Telegram
    const alertCmd = `curl -s "http://127.0.0.1:18789/api/send" -H "Content-Type: application/json" -d '{"channel": "telegram", "chatId": "${TELEGRAM_CHAT_ID}", "text": ${JSON.stringify(finalMessage)}}'`;
    execSync(alertCmd, { timeout: 5000 });
    log(`📤 Alerte Telegram envoyée (${priority})`, '📤');
  } catch (err) {
    log(`❌ Impossible d'envoyer l'alerte Telegram: ${err.message}`, '❌');
  }
}

// Récupérer les sessions OpenClaw
function getSessions() {
  try {
    const output = execSync('openclaw sessions list --json --limit all', {
      encoding: 'utf8',
      timeout: 10000,
    });
    const data = JSON.parse(output);
    return data.sessions || [];
  } catch (err) {
    log(`❌ Impossible de récupérer les sessions: ${err.message}`, '❌');
    return [];
  }
}

// Analyser les sessions pour détecter les problèmes
function analyzeSessions(sessions) {
  const now = Date.now();
  const issues = {
    staleHeartbeats: [],
    recoveredSessions: [],
    staleSessions: [],
    totalSessions: sessions.length,
  };

  sessions.forEach((session) => {
    const ageMs = session.ageMs || 0;
    const key = session.key || '';

    // Sessions heartbeat trop anciennes
    if (key.includes('heartbeat') && ageMs > THRESHOLDS.HEARTBEAT_MAX_AGE_MS) {
      issues.staleHeartbeats.push({ key, ageMs });
    }

    // Sessions "recovered" (signe de problèmes passés)
    if (key.includes('recovered')) {
      issues.recoveredSessions.push({ key, ageMs });
    }

    // Sessions très anciennes (> 30 min)
    if (ageMs > THRESHOLDS.STALE_SESSION_AGE_MS) {
      issues.staleSessions.push({ key, ageMs });
    }
  });

  return issues;
}

// Nettoyer les sessions problématiques
function cleanupStaleSessions() {
  try {
    log('🧹 Nettoyage direct des sessions obsolètes...', '🧹');
    
    const sessionsFile = '/data/.openclaw/agents/main/sessions/sessions.json';
    
    // Lire le fichier sessions.json
    if (!fs.existsSync(sessionsFile)) {
      log('⚠️ Fichier sessions.json introuvable', '⚠️');
      return false;
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const beforeCount = sessionsData.sessions ? sessionsData.sessions.length : 0;
    
    // Filtrer les sessions recovered et done
    if (sessionsData.sessions) {
      sessionsData.sessions = sessionsData.sessions.filter(session => {
        const key = session.key || '';
        return !key.includes('recovered') && !key.includes('done');
      });
    }
    
    const afterCount = sessionsData.sessions ? sessionsData.sessions.length : 0;
    const removed = beforeCount - afterCount;
    
    // Réécrire le fichier
    fs.writeFileSync(sessionsFile, JSON.stringify(sessionsData, null, 2));
    
    log(`✅ Cleanup terminé : ${removed} sessions supprimées`, '✅');
    return true;
  } catch (err) {
    log(`❌ Échec du cleanup : ${err.message}`, '❌');
    return false;
  }
}

// Redémarrer le gateway OpenClaw (dernière solution)
function restartGateway() {
  try {
    log('🔄 Redémarrage du gateway OpenClaw...', '🔄');
  execSync('openclaw gateway restart', {
      encoding: 'utf8',
      timeout: 30000,
    });
    
    log('✅ Gateway redémarré avec succès', '✅');
    return true;
  } catch (err) {
    log(`❌ Échec du redémarrage : ${err.message}`, '❌');
    return false;
  }
}

// Redémarrer le service via Railway API
function restartRailwayService() {
  try {
    log('🚀 Redémarrage du service via Railway API...', '🚀');
    
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const { railway_token, railway_service_id, railway_environment_id = 'dc14ae48-ea7a-43d7-8100-28a73ca078d8' } = config;
    
    if (!railway_token || !railway_service_id) {
      log('❌ Credentials Railway manquants dans tools.json', '❌');
      return false;
    }
    
    const mutation = `mutation { serviceInstanceRedeploy(environmentId: "${railway_environment_id}", serviceId: "${railway_service_id}") }`;
    
    const curlCmd = `curl -s -X POST "https://backboard.railway.app/graphql/v2" \
      -H "Authorization: Bearer ${railway_token}" \
      -H "Content-Type: application/json" \
      -d '{"query":${JSON.stringify(mutation)}}'`;
    
    const result = JSON.parse(execSync(curlCmd, { encoding: 'utf8', timeout: 15000 }));
    
    if (result.errors) {
      log(`❌ Erreur Railway API : ${JSON.stringify(result.errors)}`, '❌');
      return false;
    }
    
    log('✅ Service Railway redémarré avec succès', '✅');
    return true;
  } catch (err) {
    log(`❌ Échec du redémarrage Railway : ${err.message}`, '❌');
    return false;
  }
}

// Sauvegarder l'état de la vérification
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const existingState = fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      : {};
    
    const newState = {
      ...existingState,
      lastAutoHealCheck: Date.now(),
      lastAutoHealIssues: state,
    };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
  } catch (err) {
    log(`⚠️ Impossible de sauvegarder l'état : ${err.message}`, '⚠️');
  }
}

// Récupérer le compteur d'échecs
function getFailureCount() {
  try {
    if (!fs.existsSync(STATE_FILE)) return 0;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state.cleanupFailureCount || 0;
  } catch (err) {
    return 0;
  }
}

// Incrémenter le compteur d'échecs
function incrementFailureCount() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const existingState = fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      : {};
    
    const count = (existingState.cleanupFailureCount || 0) + 1;
    existingState.cleanupFailureCount = count;
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(existingState, null, 2));
    return count;
  } catch (err) {
    log(`⚠️ Impossible d'incrémenter le compteur : ${err.message}`, '⚠️');
    return 0;
  }
}

// Réinitialiser le compteur d'échecs
function resetFailureCount() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.cleanupFailureCount = 0;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`⚠️ Impossible de réinitialiser le compteur : ${err.message}`, '⚠️');
  }
}

// Auto-Heal principal
async function autoHeal() {
  log('🛡️ Démarrage Auto-Heal', '🛡️');
  
  // 1. Récupérer les sessions
  const sessions = getSessions();
  if (sessions.length === 0) {
    log('⚠️ Aucune session trouvée (problème API ou gateway ?)', '⚠️');
    sendTelegramAlert(
      '⚠️ Aucune session détectée.\n\n' +
      '**Action requise :**\n' +
      '1. Vérifier le gateway : `openclaw status`\n' +
      '2. Si down : `openclaw gateway restart`',
      'critical'
    );
    return;
  }

  log(`📊 ${sessions.length} sessions actives`, '📊');

  // 2. Analyser les sessions
  const issues = analyzeSessions(sessions);
  
  // 3. Décider de l'action
  let actionTaken = false;
  let needsRestart = false;

  // Cas 1 : Trop de sessions "recovered"
  if (issues.recoveredSessions.length > THRESHOLDS.MAX_RECOVERED_SESSIONS) {
    log(`⚠️ ${issues.recoveredSessions.length} sessions recovered détectées (seuil : ${THRESHOLDS.MAX_RECOVERED_SESSIONS})`, '⚠️');
    actionTaken = cleanupStaleSessions();
    if (!actionTaken) {
      const failCount = incrementFailureCount();
      log(`❌ Échec cleanup (${failCount}/2)`, '❌');
      
      if (failCount >= 2) {
        log('🚨 2 échecs consécutifs → Redémarrage Railway...', '🚨');
        const railwayRestart = restartRailwayService();
        if (railwayRestart) {
          resetFailureCount();
          sendTelegramAlert(
            '✅ **Auto-Heal : Service Railway redémarré**\n\n' +
            `Cleanup JSON a échoué 2 fois de suite.\n` +
            `Le service a été redémarré via Railway API.`,
            'normal'
          );
        } else {
          sendTelegramAlert(
            '🚨 **CRITIQUE : Redémarrage Railway échoué**\n\n' +
            `Cleanup JSON échoue, redémarrage Railway impossible.\n\n` +
            `**Action immédiate requise :**\n` +
            `1. Vérifier Railway manuellement\n` +
            `2. Redémarrer via dashboard Railway`,
            'critical'
          );
        }
      } else {
        needsRestart = true;
      }
    } else {
      resetFailureCount();
    }
  }

  // Cas 2 : Sessions heartbeat bloquées
  if (issues.staleHeartbeats.length > 0) {
    log(`⚠️ ${issues.staleHeartbeats.length} sessions heartbeat bloquées`, '⚠️');
    issues.staleHeartbeats.forEach((s) => {
      const ageMin = Math.floor(s.ageMs / 60000);
      log(`  - ${s.key} (âge : ${ageMin} min)`, '  ');
    });
    
    actionTaken = cleanupStaleSessions();
    if (!actionTaken) {
      const failCount = incrementFailureCount();
      log(`❌ Échec cleanup (${failCount}/2)`, '❌');
      
      if (failCount >= 2) {
        log('🚨 2 échecs consécutifs → Redémarrage Railway...', '🚨');
        const railwayRestart = restartRailwayService();
        if (railwayRestart) {
          resetFailureCount();
          sendTelegramAlert(
            '✅ **Auto-Heal : Service Railway redémarré**\n\n' +
            `Cleanup JSON a échoué 2 fois de suite.\n` +
            `Le service a été redémarré via Railway API.`,
            'normal'
          );
        } else {
          sendTelegramAlert(
            '🚨 **CRITIQUE : Redémarrage Railway échoué**\n\n' +
            `Cleanup JSON échoue, redémarrage Railway impossible.\n\n` +
            `**Action immédiate requise :**\n` +
            `1. Vérifier Railway manuellement\n` +
            `2. Redémarrer via dashboard Railway`,
            'critical'
          );
        }
      } else {
        needsRestart = true;
      }
    } else {
      resetFailureCount();
    }
  }

  // Cas 3 : Sessions très anciennes
  if (issues.staleSessions.length > 5) {
    log(`ℹ️ ${issues.staleSessions.length} sessions anciennes (> 30 min)`, 'ℹ️');
    actionTaken = cleanupStaleSessions();
    if (actionTaken) {
      resetFailureCount();
    }
  }

  // 4. Redémarrage si nécessaire
  if (needsRestart) {
    log('🚨 Problème critique détecté, redémarrage du gateway...', '🚨');
    
    const restartSuccess = restartGateway();
    
    if (restartSuccess) {
      sendTelegramAlert(
        '✅ **Auto-Heal : Gateway redémarré**\n\n' +
        `Problèmes détectés :\n` +
        `- ${issues.staleHeartbeats.length} heartbeats bloqués\n` +
        `- ${issues.recoveredSessions.length} sessions recovered\n\n` +
        `Le gateway a été redémarré automatiquement.`,
        'normal'
      );
    } else {
      sendTelegramAlert(
        '🚨 **CRITIQUE : Redémarrage échoué**\n\n' +
        `Impossible de redémarrer le gateway automatiquement.\n\n` +
        `**Action immédiate requise :**\n` +
        `1. SSH sur le serveur\n` +
        `2. Lancer : \`openclaw gateway restart\``,
        'critical'
      );
    }
  } else if (actionTaken) {
    log('✅ Auto-Heal : Cleanup effectué avec succès', '✅');
  } else {
    log('✅ Auto-Heal : Aucun problème détecté', '✅');
  }

  // 5. Log final structuré dans activity_logs
  try {
    var statutCheck = actionTaken ? 'warning' : (needsRestart ? 'error' : 'success');
    await activityLogger.log('gardien', 'auto_heal', {
      title: (actionTaken ? '🧹 Nettoyage effectue' : needsRestart ? '🔄 Redemarrage requis' : '✅ Auto-Heal OK') + ' — ' +
        issues.totalSessions + ' sessions',
      description: [
        issues.staleHeartbeats.length + ' heartbeat(s) bloque(s)',
        issues.recoveredSessions.length + ' recovered',
        issues.staleSessions.length + ' stale(s)',
        actionTaken ? 'action: cleanup' : needsRestart ? 'action: restart' : 'action: none',
      ].join(', '),
      status: statutCheck,
      details: {
        sessions_actives: issues.totalSessions,
        sessions_heartbeat_bloquees: issues.staleHeartbeats.length,
        sessions_heartbeat_detail: issues.staleHeartbeats.map(function(s) {
          return s.key + ' (' + Math.floor(s.ageMs / 60000) + 'min)';
        }).join(', ') || 'aucune',
        sessions_recovered: issues.recoveredSessions.length,
        sessions_recovered_detail: issues.recoveredSessions.map(function(s) {
          return s.key;
        }).join(', ') || 'aucune',
        sessions_obsoletes: issues.staleSessions.length,
        action_entreprise: actionTaken ? 'cleanup' : (needsRestart ? 'restart_gateway' : 'aucune'),
        restart_necessaire: needsRestart,
      },
      result_count: issues.staleHeartbeats.length + issues.recoveredSessions.length,
    });
  } catch (alE) {
    log('Erreur activity log final: ' + alE.message);
  }

  // 5. Sauvegarder l'état
  saveState(issues);
  
  log('🛡️ Auto-Heal terminé', '🛡️');
}

// Point d'entrée
if (require.main === module) {
  autoHeal().catch((err) => {
    log(`❌ Erreur fatale Auto-Heal : ${err.message}`, '❌');
    console.error(err);
    process.exit(1);
  });
}

module.exports = { autoHeal };
