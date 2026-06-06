#!/usr/bin/env node
/**
 * briefeur.js
 * Resume quotidien business pour Amine - 8h chaque jour
 * Interroge Supabase (leads, payments, tasks, projects, agent_memory)
 * et envoie un rapport structure sur Telegram (max 15 lignes, actionnable)
 *
 * Format :
 *   📅 Brief du [jour] [date]
 *
 *   💰 CA mois : [X]€ | En attente : [X]€
 *   👥 Leads : [X] nouveaux | [X] a relancer d urgence
 *   🚀 Projets actifs : [X] | Deadlines proches : [liste]
 *   ✅ Taches du jour : [liste]
 *   ⚠️ Alertes : [liste ou "RAS"]
 *
 * Usage : node /data/.openclaw/plugin-skills/briefeur/briefeur.js
 *         ou via cron : 0 8 * * * node ...briefeur.js
 */

// ─── Bus inter-agents — Lire l'inbox au démarrage ─────────────────
const busProcessor = require('/data/.openclaw/lib/bus-processor.js');
busProcessor.processInbox('Briefeur').catch(e => console.error('[bus] Erreur processInbox:', e.message));

const fs = require('fs');
const path = require('path');
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');
const taskQueue = require('/data/.openclaw/lib/task-queue.js');

const TOOLS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const LOG_PATH = '/data/.openclaw/plugin-skills/briefeur/briefeur.log';

function getCredentials() {
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf-8'));
  return {
    supabaseUrl: tools.supabase_url,
    supabaseKey: tools.supabase_service_key,
    telegramBotToken: tools.telegram_bot_token,
    telegramChatId: '6408961089'
  };
}

async function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  const creds = getCredentials();
  const supabase = createClient(creds.supabaseUrl, creds.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  await healthCheck.run('briefeur', supabase, { requiredTables: ['activity_logs'], requiredVars: [] }).catch(function(e) { writeLog('HealthCheck echec: ' + e.message); });
  return supabase;
}

function writeLog(msg) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_PATH, '[' + new Date().toISOString() + '] ' + msg + '\n');
}

/**
 * Tenter une requete sur une table avec fallback silencieux
 */
async function tryQuery(supabase, table, query, label) {
  try {
    var result = await query;
    return result;
  } catch (e) {
    writeLog(label + ' pour ' + table + ' impossible: ' + e.message);
    return { data: null, count: null, error: e };
  }
}

/**
 * Collecter toutes les donnees pour le brief
 */
async function collectData() {
  const supabase = await getSupabase();
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // === LEADS ===
  var { count: leadsNew } = await tryQuery(supabase, 'leads',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'Nouveau'));
  leadsNew = leadsNew || 0;

  var { count: leadsProspection } = await tryQuery(supabase, 'leads',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('pipeline_stage', 'Prospection'));
  leadsProspection = leadsProspection || 0;

  var { count: leadsHaute } = await tryQuery(supabase, 'leads',
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('priority', 'Haute'));
  leadsHaute = leadsHaute || 0;

  // Relances urgentes : leads > 3 jours, status=Nouveau
  var { data: oldLeads } = await tryQuery(supabase, 'leads',
    supabase.from('leads')
      .select('first_name, last_name, email, company, created_at')
      .lt('created_at', threeDaysAgo)
      .eq('status', 'Nouveau')
      .order('created_at', { ascending: true })
      .limit(5));
  var urgentsCount = (oldLeads && oldLeads.length > 0) ? oldLeads.filter(function(l) { return l.first_name || l.last_name; }).length : 0;
  // Compter total des urgents > 3 jours
  var { count: urgentsTotal } = await tryQuery(supabase, 'leads',
    supabase.from('leads').select('*', { count: 'exact', head: true }).lt('created_at', threeDaysAgo).eq('status', 'Nouveau'));
  urgentsTotal = (urgentsTotal !== null && urgentsTotal !== undefined) ? urgentsTotal : urgentsCount;

  // Dernier lead avec infos
  var { data: recentLeads } = await tryQuery(supabase, 'leads',
    supabase.from('leads')
      .select('first_name, last_name, company, project_type, budget_range, created_at')
      .not('first_name', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3));

  // Deadlines proches
  var { data: deadlines } = await tryQuery(supabase, 'leads',
    supabase.from('leads')
      .select('first_name, last_name, deadline, pipeline_stage, priority')
      .not('deadline', 'is', null)
      .not('deadline', 'eq', '')
      .limit(10));

  // === PAYMENTS ===
  var caMois = null;
  var caAttente = null;
  var caError = null;
  try {
    var { data: payments } = await supabase.from('payments').select('amount, status, created_at').limit(100);
    if (payments && payments.length > 0) {
      var monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0,0,0,0);
      var monthStr = monthStart.toISOString();
      var monthPayments = payments.filter(function(p) { return p.created_at >= monthStr; });
      caMois = monthPayments.reduce(function(sum, p) { return sum + (parseFloat(p.amount) || 0); }, 0);
      var pendingPayments = payments.filter(function(p) { return p.status === 'pending' || p.status === 'en_attente' || p.status === 'sent'; });
      caAttente = pendingPayments.reduce(function(sum, p) { return sum + (parseFloat(p.amount) || 0); }, 0);
    }
  } catch (e) {
    caError = e.message;
    writeLog('payments inaccessible: ' + e.message);
  }

  // === TASKS ===
  var todayTasks = [];
  var tasksError = null;
  try {
    var { data: tasks } = await supabase.from('tasks')
      .select('title, deadline, status, priority')
      .limit(50);
    if (tasks && tasks.length > 0) {
      var todayDate = new Date().toISOString().split('T')[0];
      todayTasks = tasks.filter(function(t) {
        return t.deadline && t.deadline.split('T')[0] === todayDate;
      });
    }
  } catch (e) {
    tasksError = e.message;
    writeLog('tasks inaccessible: ' + e.message);
  }

  // === PROJECTS ===
  var projetsActifs = 0;
  var projsError = null;
  var projsList = [];
  try {
    var { data: projects } = await supabase.from('projects')
      .select('name, status, deadline, client_name')
      .limit(50);
    if (projects && projects.length > 0) {
      var activeStatuses = ['active', 'en_cours', 'in_progress', 'en_attente'];
      // Detection auto des statuts actifs
      var uniqueStatuses = [...new Set(projects.map(function(p) { return p.status; }))];
      activeStatuses = uniqueStatuses.filter(function(s) {
        return s && !['done', 'complete', 'termine', 'cancelled', 'annule', 'archive'].includes(s.toLowerCase());
      });
      var actifs = projects.filter(function(p) { return activeStatuses.includes(p.status) && p.status; });
      projetsActifs = actifs.length;
      projsList = actifs.slice(0, 3);
    }
  } catch (e) {
    projsError = e.message;
    writeLog('projects inaccessible: ' + e.message);
  }

  // === ALERTES SENTINELLE / GARDIEN du jour ===
  var { data: todayAlerts } = await supabase
    .from('agent_memory')
    .select('event_type, content, created_at')
    .gte('created_at', today)
    .order('created_at', { ascending: false })
    .limit(20);

  // === MEMOIRE EPISODIQUE (stats du jour) ===
  var { count: todayActions } = await supabase
    .from('memory_episodic')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today);

  var { count: todayFailures } = await supabase
    .from('memory_episodic')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today)
    .eq('success', false);

  return {
    // Leads
    leadsNew: leadsNew || 0,
    leadsProspection: leadsProspection || 0,
    leadsHaute: leadsHaute || 0,
    urgentsTotal: urgentsTotal || 0,
    recentLeads: recentLeads || [],
    deadlines: deadlines || [],

    // Payments
    caMois: caMois,
    caAttente: caAttente,
    caError: caError,

    // Tasks
    todayTasks: todayTasks || [],

    // Projects
    projetsActifs: projetsActifs,
    projsList: projsList,

    // Alertes systeme
    todayAlerts: todayAlerts || [],
    todayActions: todayActions || 0,
    todayFailures: todayFailures || 0,

    // Erreurs
    errors: {
      payments: caError,
      tasks: tasksError,
      projects: projsError
    }
  };
}

/**
 * Construit le message Telegram au format demande
 */
function buildBrief(data) {
  var lines = [];
  var date = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Europe/Paris'
  });

  // Header
  lines.push('\uD83D\uDCC5 Brief du ' + date);
  lines.push('');

  // --- CA ---
  var caMois = data.caMois !== null ? data.caMois.toFixed(0) : 'N/A';
  var caAttente = data.caAttente !== null ? data.caAttente.toFixed(0) : 'N/A';
  lines.push('\uD83D\uDCB0 CA mois : ' + caMois + '\u20AC | En attente : ' + caAttente + '\u20AC');

  // --- LEADS ---
  var leadsLine = '\uD83D\uDC65 Leads : ' + data.leadsNew + ' nouveaux | ' + data.leadsProspection + ' en prospection';
  if (data.urgentsTotal > 0) {
    leadsLine += ' | \u26A0\uFE0F ' + data.urgentsTotal + ' a relancer d urgence';
  }
  lines.push(leadsLine);

  // Dernier lead
  if (data.recentLeads.length > 0) {
    var dernier = data.recentLeads[0];
    var nom = [dernier.first_name || '', dernier.last_name || ''].filter(Boolean).join(' ') || 'anonyme';
    lines.push('    Dernier : ' + nom + ' (' + (dernier.project_type || '?') + ')');
  }

  // --- PROJETS ---
  var projLine = '\uD83D\uDE80 Projets actifs : ' + data.projetsActifs;
  if (data.deadlines.length > 0) {
    projLine += ' | Deadlines proches : ';
    projLine += data.deadlines.slice(0, 3).map(function(d) {
      var dn = [d.first_name || '', d.last_name || ''].filter(Boolean).join(' ') || 'lead';
      return dn + ' (' + (d.deadline || '?').substring(0, 15) + ')';
    }).join(', ');
  }
  lines.push(projLine);

  // --- TACHES DU JOUR ---
  if (data.todayTasks.length > 0) {
    lines.push('\u2705 Taches du jour : ' + data.todayTasks.map(function(t) {
      return t.title || t.name || '?';
    }).slice(0, 4).join(', '));
  } else {
    lines.push('\u2705 Taches du jour : aucune pour aujourd hui');
  }

  // --- ALERTES ---
  var systemAlerts = data.todayAlerts.filter(function(a) {
    return a && a.event_type && a.event_type !== 'skill_shared' && a.event_type !== 'test' && a.event_type !== 'skill_cristallise';
  });

  // Ajouter les statuts des tables inaccessibles en warning
  var warnings = [];
  if (data.errors.payments) warnings.push('payments non accessible');
  if (data.errors.tasks) warnings.push('tasks non accessible');
  if (data.errors.projects) warnings.push('projects non accessible');
  if (data.todayFailures > 0) warnings.push(data.todayFailures + ' echec(s) aujourd hui');

  var allAlerts = [];
  if (systemAlerts.length > 0) {
    allAlerts = systemAlerts.slice(0, 3).map(function(a) {
      var c = a.content || '';
      try { var parsed = typeof c === 'string' ? JSON.parse(c) : c; c = parsed.skill_name || parsed.lesson_learned || c; } catch(e) {}
      return (a.event_type || '').replace(/_/g, ' ') + ': ' + (typeof c === 'string' ? c.substring(0, 50) : '');
    });
  }
  if (warnings.length > 0) {
    allAlerts = allAlerts.concat(warnings);
  }

  if (allAlerts.length > 0) {
    lines.push('\u26A0\uFE0F Alertes : ' + allAlerts.join(' | '));
  } else {
    lines.push('\u26A0\uFE0F Alertes : RAS');
  }

  // Stats activite
  lines.push('\uD83D\uDCCA Activite : ' + data.todayActions + ' actions effectuees');

  return lines.join('\n');
}

/**
 * Envoie sur Telegram
 */
async function sendTelegram(message) {
  const creds = getCredentials();
  if (!creds.telegramBotToken || creds.telegramBotToken === '' || creds.telegramBotToken === 'telegram_bot_token_ici') {
    return { sent: false, reason: 'no_telegram_token' };
  }

  const https = require('https');
  const url = 'https://api.telegram.org/bot' + creds.telegramBotToken + '/sendMessage';

  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      chat_id: creds.telegramChatId,
      text: message,
      parse_mode: 'Markdown'
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          resolve(parsed.ok ? { sent: true } : { sent: false, error: parsed.description });
        } catch(e) {
          resolve({ sent: false, error: 'parse error' });
        }
      });
    });
    req.on('error', function(e) { resolve({ sent: false, error: e.message }); });
    req.write(body);
    req.end();
  });
}

async function main() {
  writeLog('Execution du briefeur');

  var tqId = await taskQueue.start('briefeur', 'rapport-quotidien', {});

  const data = await collectData();
  const message = buildBrief(data);
  const result = await sendTelegram(message);

  if (result.sent && tqId) await taskQueue.complete(tqId);

  writeLog('Envoi Telegram: ' + (result.sent ? 'OK' : 'ECHEC ' + (result.error || result.reason || '')));

  console.log(message);
  console.log('');
  console.log('Envoye:', result.sent);

  // Log dans activity_logs — précis et actionnable
  try {
    var erreursTables = [];
    if (data.errors.payments) erreursTables.push('payments: ' + data.errors.payments);
    if (data.errors.tasks) erreursTables.push('tasks: ' + data.errors.tasks);
    if (data.errors.projects) erreursTables.push('projects: ' + data.errors.projects);

    var alertes_detail = [];
    if (data.todayFailures > 0) alertes_detail.push(data.todayFailures + ' echec(s)');
    if (data.urgentsTotal > 0) alertes_detail.push(data.urgentsTotal + ' lead(s) urgent(s)');
    if (erreursTables.length > 0) alertes_detail.push('tables inaccessibles: ' + erreursTables.join(', '));

    var agentsActifs = [];
    var seenAgents = {};
    (data.todayAlerts || []).forEach(function(a) {
      var agt = a.agent_name || '';
      if (agt && !seenAgents[agt] && agt !== 'mino') {
        seenAgents[agt] = true;
        agentsActifs.push(agt);
      }
    });

    let threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    let recents = (data.recentLeads || []).slice(0, 3).map(function(l) {
      return (l.first_name || '') + ' ' + (l.last_name || '') + ' (' + (l.project_type || '?') + ')';
    });

    await activityLogger.log('briefeur', 'rapport_quotidien', {
      title: 'Brief quotidien du ' + new Date().toLocaleDateString('fr-FR'),
      description: (result.sent ? 'Envoyé' : 'Échec envoi') + ' — ' +
        data.leadsNew + ' nouveaux leads, ' +
        data.projetsActifs + ' projets actifs, ' +
        (data.caMois !== null ? data.caMois.toFixed(0) + 'EUR CA mois' : 'CA N/A'),
      status: result.sent ? 'success' : 'error',
      details: {
        leads_nouveaux: data.leadsNew,
        leads_prospection: data.leadsProspection,
        leads_haute_priorite: data.leadsHaute,
        leads_urgents_relance: data.urgentsTotal,
        leads_recents: recents.join(' | '),
        ca_mois_eur: data.caMois !== null ? data.caMois.toFixed(2) : null,
        ca_attente_eur: data.caAttente !== null ? data.caAttente.toFixed(2) : null,
        projets_actifs: data.projetsActifs,
        taches_aujourdhui: (data.todayTasks || []).length,
        agents_ayant_tourne: agentsActifs.join(', ') || 'aucun',
        actions_effectuees: data.todayActions,
        echecs_jour: data.todayFailures,
        alertes_resume: alertes_detail.join(' | ') || 'RAS',
        envoyee_sur_telegram: result.sent,
      },
      result_count: data.leadsNew + data.projetsActifs + (data.todayTasks || []).length,
    });
  } catch(alE) { writeLog('Activity log error: ' + alE.message); }

  // Ecrire dans l orchestrateur
  try {
    const learn = require('/data/.openclaw/lib/learning-orchestrator.js');
    await learn.runSuccess('Briefeur quotidien', message, { reutilisabilite: 9, complexite: 3, valeur: 9 });
  } catch(e) {
    writeLog('Erreur orchestrateur: ' + e.message);
  }

  return { sent: result.sent, message: message };
}

if (require.main === module) {
  main().catch(function(e) {
    console.error('ERREUR FATALE:', e.message);
    writeLog('ERREUR FATALE: ' + e.message);
    process.exit(1);
  }).then(function() {
    process.exit(0);
  });
} else {
  module.exports = { collectData, buildBrief, main };
}
