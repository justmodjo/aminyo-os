/**
 * activity-logger.js – Logging centralisé des actions agents dans Supabase activity_logs
 *
 * Schéma activity_logs :
 *   id, created_at, type, title, description,
 *   related_lead_id, related_client_id, related_project_id,
 *   agent_name, status, details, duration_ms, result_count
 *
 * Usage : const logger = require('/data/.openclaw/lib/activity-logger.js');
 *         await logger.log('facteur', 'brouillon_cree', { title: 'Réponse à X', description: '...', lead_id: 42 });
 */

const https = require('https');
const fs = require('fs');

function getTools() {
  return JSON.parse(fs.readFileSync('/data/.openclaw/plugin-skills/gardien/tools.json', 'utf8'));
}

function logError(msg) {
  try {
    fs.appendFileSync('/data/.openclaw/lib/activity-logger.log', `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Enregistre une action dans activity_logs (table Supabase)
 *
 * @param {string} agent   - Nom de l'agent (loggé dans agent_name + description)
 * @param {string} type    - Type d'action (email_envoye, brouillon_cree, veille, etc.)
 * @param {object} opts    - Options
 * @param {string} opts.title       - Titre court
 * @param {string} opts.description - Description détaillée
 * @param {*}      opts.lead_id     - ID du lead lié
 * @param {*}      opts.client_id   - ID du client lié
 * @param {*}      opts.project_id  - ID du projet lié
 * @param {string} opts.status      - success/error/warning/pending (colonne status)
 * @param {object} opts.details     - JSONB avec détails structurés de l'action
 * @param {number} opts.duration_ms - Temps d'exécution en ms
 * @param {number} opts.result_count- Nombre de résultats traités
 */
async function log(agent, type, opts) {
  var tools = getTools();
  // Utiliser service_role_key (plus fiable) ou fallback service_key
  var key = tools.supabase_service_role_key || tools.supabase_service_key || process.env.SUPABASE_SERVICE_KEY;
  var baseUrl = (tools.supabase_url || process.env.SUPABASE_URL || 'https://uurauxmdjhufidifldpv.supabase.co').replace(/\/+$/, '');
  
  if (!key) { logError('activity-logger: clé Supabase manquante'); return false; }

  opts = opts || {};
  var now = new Date().toISOString();

  // Préfixer la description avec le nom de l'agent
  var descParts = [];
  if (agent) descParts.push('[' + agent + ']');
  if (opts.status && opts.status !== 'success') descParts.push('(' + opts.status + ')');
  if (opts.description) descParts.push(opts.description);
  var description = descParts.join(' ');

  var record = {
    agent_name: agent || null,
    type: type,
    title: opts.title || type,
    description: description || null,
    status: opts.status || null,
    details: opts.details || null,
    duration_ms: opts.duration_ms || null,
    result_count: opts.result_count || null,
    related_lead_id: opts.lead_id || null,
    related_client_id: opts.client_id || null,
    related_project_id: opts.project_id || null,
    created_at: now,
  };

  var hostname = baseUrl.replace('https://', '').replace('http://', '');
  var body = JSON.stringify(record);

  return new Promise(function(resolve) {
    var req = https.request({
      hostname: hostname,
      path: '/rest/v1/activity_logs',
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          logError('HTTP ' + res.statusCode + ': ' + d.substring(0, 300));
          resolve(false);
        }
      });
    });
    req.on('error', function(e) {
      logError('Erreur requête: ' + e.message);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

module.exports = { log };
