#!/usr/bin/env node
/**
 * prospecteur.js — Agent de prospection AminyoOS
 *
 * Recherche des prospects ciblés pour Aminyo :
 * TPE/PME Normandie sans site web ou site obsolète,
 * artisans, commerces, professions libérales.
 *
 * Workflow :
 * 1. SCAN sources (Apify Google Maps, web, Mémoire)
 * 2. FILTRE + qualification (géolocalisation, score IA)
 * 3. ENRICHIT Supabase (table leads)
 * 4. PRÉPARE approche → bus Porte-Parole
 * 5. CONTACT → bus Facteur
 * 6. CRISTALLISE → cycle Hermès
 *
 * Fréquence : mardi et jeudi 7h00
 * Paramètres :
 *   - MAX_SCRAPE = 24 entreprises par session Apify (8 recherches × 3 cibles)
 *   - SCORE_MIN_CONTACT = 60/100 (score minimum pour contact)
 *   - MAX_CONTACTS = 15 (maximum de prospects contactés par session)
 */

const https = require('https')
const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');;
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CREDS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const LOG_PATH = '/data/.openclaw/plugin-skills/prospecteur/prospecteur.log';

// ─── Paramètres de production ─────────────────
const MAX_SCRAPE = 24;                 // Total cibles sur Google Maps (8 recherches × ~3 cibles)
const SCORE_MIN_CONTACT = 60;           // Score minimum pour être contacté
const MAX_CONTACTS = 15;                // Maximum de prospects contactés par session
const CIBLES_PAR_RECHERCHE = 3;          // 3 entreprises par recherche Apify (optimisation coût ~$3-4/cycle)
const STATE_PATH = '/data/.openclaw/plugin-skills/prospecteur/etat-prospection.json';
// Make désactivé — remplacé par Apify Maps Scraper
const MEMOIRE_REQUESTS = '/data/.openclaw/plugin-skills/memoire/memoire-requests.json';

// ─── Cycle Hermès ──────────────────────────────
const learn = require('/data/.openclaw/lib/learning-orchestrator.js');
const logger = require('/data/.openclaw/lib/memory-logger.js');
const analyzer = require('/data/.openclaw/lib/failure-analyzer.js');
const crystal = require('/data/.openclaw/lib/crystallizer.js');
const bus = require('/data/.openclaw/lib/message-bus.js');
const reuser = require('/data/.openclaw/lib/reuser.js');

// Make désactivé — remplacé par Apify Maps Scraper
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ─── Logging ───────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] [prospecteur] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function chargeCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { return {}; }
}

// ─── Transport HTTPS générique ─────────────────
function requete(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Supabase ──────────────────────────────────
function sbQuery(method, table, params, body) {
  return new Promise((resolve, reject) => {
    const creds = chargeCreds();
    const url = SUPABASE_URL || creds.supabase_url;
    const key = SUPABASE_SERVICE_KEY || creds.supabase_service_role_key;
    if (!url || !key) return reject(new Error('Supabase creds manquants'));

    const u = new URL(url);
    const fullPath = '/rest/v1/' + table + (params ? '?' + new URLSearchParams(params) : '');
    const bodyStr = body ? JSON.stringify(body) : '';
    const mod = u.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: u.hostname, port: u.port || 443,
      path: fullPath, method,
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
        ...(method === 'PATCH' || method === 'POST' ? { 'Prefer': 'return=representation' } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data || '[]')); }
        catch { resolve([]); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sbGet(table, select, filters) {
  const params = { select: select || '*', ...(filters || {}) };
  return sbQuery('GET', table, params, null);
}

function sbInsert(table, rows) {
  return sbQuery('POST', table, {}, Array.isArray(rows) ? rows : [rows]);
}

function sbUpdate(table, idColumn, idValue, updates) {
  return sbQuery('PATCH', table, { [idColumn]: `eq.${idValue}` }, updates);
}

// ═══════════════════════════════════════════════
// OBSERVE — Sources de prospection
// ═══════════════════════════════════════════════

/**
 * Make désactivé — remplacé par Apify Maps Scraper
 * Le cycle Apify est géré via cycleApify() dans la méthode run().
 */
function collecterMake() {
  return [];
}

/**
 * 2. Lire le cache Mémoire pour réactiver des leads dormants
 */
function collecterMemoire() {
  try {
    const idxPath = '/data/.openclaw/plugin-skills/memoire/memoire-index.json';
    if (fs.existsSync(idxPath)) {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (idx && Array.isArray(idx.patternsDetectes)) {
        const disparus = idx.patternsDetectes.filter(p => p.id === 'disparait_apres_devis');
        if (disparus.length > 0) {
          log(`📡 Mémoire: ${disparus.length} pattern(s) disparition trouvé(s)`);
          return disparus.flatMap(p => p.clients || []).filter(Boolean);
        }
      }
    }
  } catch(e) { log(`⚠️ Mémoire: ${e.message?.substring(0, 60)}`); }
  return [];
}

/**
 * 3. Lire les prospects déjà en Supabase pour éviter les doublons
 */
async function collecterExistants(c) {
  try {
    const data = await sbGet('leads', 'id,email,company,first_name,last_name');
    const existants = (Array.isArray(data) ? data : []).map(l => ({
      email: (l.email || '').toLowerCase(),
      company: (l.company || '').toLowerCase(),
      nom: ((l.first_name || '') + ' ' + (l.last_name || '')).toLowerCase().trim(),
    }));
    log(`📡 Supabase: ${existants.length} leads existants`);
    return existants;
  } catch(e) {
    log(`⚠️ Supabase: ${e.message?.substring(0, 60)}`);
    return [];
  }
}

/**
 * 4. Sources web : recherches ciblées pour la Normandie
 *    Utilise wttr.in comme proxy public.
 */
async function collecterWeb(c) {
  const recherches = [
    { query: 'artisan Le Havre site internet', ville: 'Le Havre' },
    { query: 'restaurant Le Havre site web', ville: 'Le Havre' },
    { query: 'artisan Rouen site internet', ville: 'Rouen' },
    { query: 'coiffeur Le Havre sans site', ville: 'Le Havre' },
    { query: 'boulangerie site web Normandie', ville: 'Normandie' },
  ];
  // Note: les recherches web réelles nécessitent une API de recherche.
  // Pour l'instant, placeholder — enrichi via Make ou scrap manuel.
  log('📡 Web: recherches ciblées Normandie configurées');
  return [];
}

// ═══════════════════════════════════════════════
// RÉFLÉCHIS — Qualification et filtrage
// ═══════════════════════════════════════════════

const VILLES_NORMANDIE = [
  'le havre', 'rouen', 'caen', 'cherbourg', 'dieppe', 'fecamp',
  'honfleur', 'deauville', 'trouville', 'etretat', 'yvetot',
  'bolbec', 'lillebonne', 'montivilliers', 'octeville', 'saint-romain',
  'gournay', 'forges', 'neufchâtel', 'eu', 'le treport',
  'pont-audemer', 'bernay', 'verneuil', 'gisors', 'les andelys',
  'vernon', 'evreux', 'louvier', 'pont-de-l-arche', 'elbeuf',
  'barentin', 'duclair', 'canteleu', 'maromme', 'bois-guillaume',
  'sotteville', 'grand-couronne', 'petit-couronne', 'ouville',
  'cany', 'saint-valery', 'valmont', 'goderville', 'criquetot',
];

function estNormandie(company, notes) {
  const txt = ((company || '') + ' ' + (notes || '')).toLowerCase();
  return VILLES_NORMANDIE.some(v => txt.includes(v));
}

// Mapping sectoriel : catégorie → { budget, priorité }
const SECTEURS_BUDGET = {
  // ── Budget élevé — priorité haute ──
  'restaurant':      { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'restaurant ':     { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'restauration':    { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'hôtel':           { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'hotel':           { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'hôtel restaurant':{ budget: 'élevé',  priorite: 'haute', boost: 20 },
  'camping':         { budget: 'élevé',  priorite: 'haute', boost: 18 },
  'hôtellerie':      { budget: 'élevé',  priorite: 'haute', boost: 18 },
  'brasserie':       { budget: 'élevé',  priorite: 'haute', boost: 18 },
  'gastronomique':   { budget: 'élevé',  priorite: 'haute', boost: 20 },
  'bar':             { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'pub':             { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'chambre d\'hôte': { budget: 'élevé',  priorite: 'haute', boost: 18 },

  // ── Budget moyen — priorité haute ──
  'médecin':         { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'medecin':         { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'dentiste':        { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'chirurgien':      { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'kiné':            { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'kinésithérapeute':{ budget: 'moyen',  priorite: 'haute', boost: 14 },
  'avocat':          { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'notaire':         { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'expert-comptable':{ budget: 'moyen',  priorite: 'haute', boost: 15 },
  'architecte':      { budget: 'moyen',  priorite: 'haute', boost: 15 },
  'géomètre':        { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'géometre':        { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'cabinet':         { budget: 'moyen',  priorite: 'haute', boost: 13 },
  'conseil':         { budget: 'moyen',  priorite: 'haute', boost: 12 },
  'coach':           { budget: 'moyen',  priorite: 'haute', boost: 12 },
  'psychologue':     { budget: 'moyen',  priorite: 'haute', boost: 13 },
  'ostéopathe':      { budget: 'moyen',  priorite: 'haute', boost: 13 },
  'osteopathe':      { budget: 'moyen',  priorite: 'haute', boost: 13 },
  'vétérinaire':     { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'veterinaire':     { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'pharmacie':       { budget: 'moyen',  priorite: 'haute', boost: 14 },
  'orthophoniste':   { budget: 'moyen',  priorite: 'haute', boost: 12 },
  'sophrologue':     { budget: 'moyen',  priorite: 'haute', boost: 12 },

  // ── Budget moyen — priorité normale ──
  'maçon':           { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'maçon':           { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'plombier':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'électricien':     { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'electricien':     { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'menuisier':       { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'couvreur':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'charpentier':     { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'peintre':         { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'plaquiste':       { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'carreleur':       { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'chauffagiste':    { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'serrurier':       { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'jardinier':       { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'paysagiste':      { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'élagueur':        { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'elagueur':        { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'pisciniste':      { budget: 'moyen',  priorite: 'normale', boost: 10 },
  'toiture':         { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'isolation':       { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'ravale':          { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'terrassement':    { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'garage':          { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'garagiste':       { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'concession':      { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'coiffeur':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'coiffure':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'barbier':         { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'esthétique':      { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'esthetique':      { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'onglerie':        { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'tatoueur':        { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'boulanger':       { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'boulangerie':     { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'boucher':         { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'primeur':         { budget: 'moyen',  priorite: 'normale', boost: 4 },
  'épicerie':        { budget: 'moyen',  priorite: 'normale', boost: 4 },
  'epicerie':        { budget: 'moyen',  priorite: 'normale', boost: 4 },
  'fleuriste':       { budget: 'moyen',  priorite: 'normale', boost: 6 },
  'traiteur':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'pharmacien':      { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'opticien':        { budget: 'moyen',  priorite: 'normale', boost: 8 },
  'agent immobilier':{ budget: 'élevé',  priorite: 'haute', boost: 18 },
  'immobilier':      { budget: 'élevé',  priorite: 'haute', boost: 18 },
  'agence immob':    { budget: 'élevé',  priorite: 'haute', boost: 18 },

  // ── Budget faible — priorité basse ──
  'association':     { budget: 'faible',  priorite: 'basse', boost: 2 },
  'associatif':      { budget: 'faible',  priorite: 'basse', boost: 2 },
  'club':            { budget: 'faible',  priorite: 'basse', boost: 3 },
  'sportif':         { budget: 'faible',  priorite: 'basse', boost: 3 },
  'culturel':        { budget: 'faible',  priorite: 'basse', boost: 2 },
  'musée':           { budget: 'faible',  priorite: 'basse', boost: 2 },
  'musee':           { budget: 'faible',  priorite: 'basse', boost: 2 },
  'comité':          { budget: 'faible',  priorite: 'basse', boost: 2 },
  'amical':          { budget: 'faible',  priorite: 'basse', boost: 2 },
};

/**
 * Détecte le secteur du prospect à partir de son nom, catégorie, notes
 * Retourne { secteur, budget, priorite, boost }
 */
function detecterSecteur(prospect) {
  const sources = [
    prospect.categories || prospect.catégorie || '',
    prospect.company || prospect.first_name || '',
    prospect.notes || '',
    prospect.project_description || '',
  ];
  const texteComplet = sources.filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Chercher la correspondance la plus longue d'abord
  const entrees = Object.entries(SECTEURS_BUDGET)
    .filter(([mot]) => texteComplet.includes(mot))
    .sort(([a], [b]) => b.length - a.length);

  if (entrees.length > 0) {
    const [mot, meta] = entrees[0];
    return { secteur: mot, ...meta };
  }

  return { secteur: 'non détecté', budget: 'non défini', priorite: 'normale', boost: 5 };
}

function calculerScore(prospect) {
  let score = 0;
  const txt = ((prospect.notes || '') + ' ' + (prospect.project_description || '')).toLowerCase();

  // ─── Critères de base (contact) ───
  if (!prospect.email && !prospect.phone) score -= 10;
  if (prospect.email) score += 20;
  if (prospect.phone) score += 10;
  if (prospect.company) score += 10;

  // ─── Indices de besoin (notes/project_description) ───
  if (txt.includes('pas de site') || txt.includes('sans site')) score += 25;
  if (txt.includes('site obsolète') || txt.includes('refonte')) score += 20;
  if (txt.includes('vitrine') || txt.includes('site internet')) score += 15;
  if (txt.includes('urgent') || txt.includes('besoin')) score += 10;

  // Budget explicite
  if (prospect.budget_range) score += 10;

  // ─── Données enrichies Apify ───
  // Site web
  const site = (prospect.website || '').toLowerCase();
  const pasDeSite = !prospect.website || prospect.website === 'non renseigné' || site === '';
  if (pasDeSite) {
    score += 25;  // Pas de site web du tout
  }

  // Avis Google
  const nbAvis = parseInt(prospect.nbAvis || prospect.ratingCount || prospect.avis || 0);
  const note = parseFloat(prospect.note || prospect.rating || 0);
  if (!nbAvis || nbAvis < 5) {
    score += 10;  // Moins de 5 avis Google = peu de visibilité
  }
  if (!note || note === 0) {
    score += 10;  // Pas de Google My Business ou pas noté
  }

  // Analyse site (remplie par analyseur-site.js)
  const analyse = prospect.siteAnalyse || {};
  if (analyse.responsive && !analyse.responsive.responsive) {
    score += 20;  // Site non responsive/mobile
  }
  if (analyse.performance && analyse.performance.tempsChargementMs > 2000) {
    score += 15;  // PageSpeed score < 50 (lent)
  }
  if (analyse.modele && analyse.modele.modele) {
    const modele = (analyse.modele.modele || '').toLowerCase();
    if (modele.includes('wix') || modele.includes('jimdo')) {
      score += 5;  // Site sur Wix/Jimdo gratuit
    }
  }

  // Vétusté estimée via scoreVetuste
  const sv = parseFloat(prospect.scoreVetuste || 0);
  if (sv >= 7) {
    score += 15;  // Design daté de plus de 5 ans
  }

  // ─── Malus ───
  // Site moderne et récent
  if (sv !== undefined && sv <= 2 && site && !pasDeSite) {
    score -= 50;  // Site moderne et récent
  }
  // Franchise / chaîne nationale
  const franchiseMots = ['franchise', 'chaîne', 'chaine', 'groupe', 'national', 'enseigne', 'siège', 'siege'];
  if (franchiseMots.some(m => txt.includes(m) || ((prospect.categories || '') + ' ' + (prospect.company || '')).toLowerCase().includes(m))) {
    score -= 30;  // Franchise ou chaîne nationale
  }
  // Grosse entreprise
  const grosMots = ['groupe', 'sas', 'sa ', 'multinational', 'siège social', 'siege social'];
  // Si plus de 100 employés ou mots-clés
  const employes = parseInt(prospect.employes || prospect.employees || 0);
  if (employes > 50 || grosMots.some(m => txt.includes(m))) {
    score -= 20;  // Grosse entreprise avec équipe digitale
  }

  // Boost sectoriel (selon budget potentiel)
  const secteur = detecterSecteur(prospect);
  score += secteur.boost;

  // Normalisation 0-100
  return Math.min(Math.max(score, 0), 100);
}

function qualifierProspects(bruts, existants) {
  const qualifies = [];
  const dejaConnus = new Set(existants.map(e => e.company || e.nom || e.email));

  for (const p of bruts) {
    const key = (p.company || p.first_name || '').toLowerCase().trim();
    const emailKey = (p.email || '').toLowerCase().trim();

    // Dédoublonnage
    if (dejaConnus.has(key) || dejaConnus.has(emailKey)) {
      log(`🔁 Doublon ignoré: ${key || emailKey}`);
      continue;
    }

    // Filtre géographique si notes fournies
    if (p.notes || p.company) {
      if (!estNormandie(p.company, p.notes) && !p.project_description?.includes('Normandie')) {
        continue; // hors zone
      }
    }

    const score = calculerScore(p);
    if (score < 10) {
      log(`⏭️ Score trop faible (${score}) pour ${key}`);
      continue;
    }

    // Détection du secteur et du budget potentiel
    const secteur = detecterSecteur(p);

    // Priorité finale: combine score IA + secteur budget
    const prioriteFinale = score >= 70 || secteur.budget === 'élevé'
      ? 'Haute'
      : score >= 50 || secteur.budget === 'moyen'
        ? 'Moyenne'
        : 'Basse';

    qualifies.push({
      ...p,
      ai_score: score,
      secteur: secteur.secteur,
      budgetPotentiel: secteur.budget,
      prioriteBudget: secteur.priorite,
      status: score >= 50 && secteur.budget !== 'faible' ? 'qualifié' : 'à_qualifier',
      pipeline_stage: score >= 50 && secteur.budget !== 'faible' ? 'Lead qualifié' : 'Nouveau lead',
      priority: prioriteFinale,
      next_action: score >= 50 && secteur.budget !== 'faible'
        ? 'Préparer approche personnalisée'
        : secteur.budget === 'faible'
          ? 'Mettre en liste de réserve — budget insuffisant'
          : 'Collecter plus d\'informations',
      source: p.source || 'Prospecteur',
      created_at: new Date().toISOString(),
    });
  }

  // Stats par secteur pour le log
  const statsSecteurs = {};
  qualifies.forEach(p => {
    const s = p.budgetPotentiel || 'non défini';
    statsSecteurs[s] = (statsSecteurs[s] || 0) + 1;
  });
  const lignesStats = Object.entries(statsSecteurs)
    .sort(([a], [b]) => ['élevé','moyen','faible','non défini'].indexOf(a) - ['élevé','moyen','faible','non défini'].indexOf(b))
    .map(([k, v]) => `${k} : ${v}`).join(', ');

  log(`🎯 ${qualifies.length} qualifiés (budget: ${lignesStats})`);
  return qualifies;
}

// ═══════════════════════════════════════════════
// CRISTALLISE — Stockage et actions
// ═══════════════════════════════════════════════

async function insererProspects(c, qualifies) {
  if (qualifies.length === 0) return [];
  const inseres = [];
  for (const p of qualifies) {
    try {
      const result = await sbInsert('leads', {
        first_name: p.first_name || p.company || null,
        last_name: p.last_name || null,
        email: p.email || null,
        phone: p.phone || null,
        company: p.company || null,
        project_type: p.project_type || '',
        budget_range: p.budget_range || '',
        deadline: p.deadline || '',
        project_description: p.project_description || '',
        notes: p.notes || '',
        source: p.source || 'Prospecteur',
        status: p.status || 'Nouveau',
        pipeline_stage: p.pipeline_stage || 'Nouveau lead',
        ai_score: p.ai_score || 0,
        priority: p.priority || 'Moyenne',
        next_action: p.next_action || '',
      });
      inseres.push(p);
      log(`➕ ${p.company || p.first_name || '?'} (score ${p.ai_score})`);
    } catch(e) {
      log(`⚠️ Insert ${p.company || '?'}: ${e.message?.substring(0, 80)}`);
    }
  }
  return inseres;
}

/**
 * Appelle Mémoire pour contextualiser un prospect (existait-il avant ? déjà contacté ?)
 * Écrit un fichier de requête dans le dossier Mémoire.
 */
async function contextualiserProspect(prospect) {
  const nom = prospect.company || prospect.first_name || 'inconnu';
  const email = prospect.email || '';

  try {
    const req = {
      type: 'prospecteur.contextualisation',
      source: 'Prospecteur',
      prospect: { nom, email, ville: prospect.city || prospect.ville || '', telephone: prospect.phone || '' },
      demandes: [
        'Ce prospect a-t-il déjà été contacté par Aminyo ?',
        'Existe-t-il un historique de devis ou d\'échange ?',
        'Y a-t-il des informations sectorielles pertinentes ?',
      ],
      createdAt: new Date().toISOString(),
    };

    const reqPath = '/data/.openclaw/plugin-skills/memoire/requests/memoire-requests.json';
    const dir = path.dirname(reqPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let existant = [];
    try { existant = JSON.parse(fs.readFileSync(reqPath, 'utf8')); } catch {}
    if (!Array.isArray(existant)) existant = [];
    existant.push(req);
    fs.writeFileSync(reqPath, JSON.stringify(existant, null, 2));

    log(`📡 Mémoire contextualisée: ${nom}`);
    return true;
  } catch(e) {
    log(`⚠️ Mémoire context: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

/**
 * Appelle Porte-Parole pour préparer l'approche personnalisée.
 * Écrit un fichier briefing dans son dossier.
 */
async function preparerApproche(prospects) {
  if (!prospects || prospects.length === 0) return;

  log(`📝 Préparation approche pour ${prospects.length} prospect(s)`);
  try {
    const briefing = {
      type: 'prospecteur.approche',
      source: 'Prospecteur',
      targets: ['Porte-Parole'],
      prospects: prospects.map(p => ({
        nom: p.company || p.first_name || '',
        email: p.email || '',
        telephone: p.phone || '',
        site_web: p.website || '',
        ville: p.city || p.ville || '',
        categorie: p.category || p.categorie || '',
        score: p.ai_score || 0,
        notes: p.notes || '',
        priorite: p.ai_score >= 70 ? 'Haute' : 'Moyenne',
        type_approche: !p.website ? 'proposition_site' : 'refonte',
      })),
      contexte: 'Campagne hebdomadaire Apify Maps Scraper — Normandie',
      date: new Date().toISOString(),
    };

    try {
      await bus.publish({
        type: 'prospecteur.nouveaux-prospects',
        source: 'Prospecteur',
        targets: ['Porte-Parole', 'Facteur', 'Briefeur'],
        payload: briefing,
      });
    } catch(e) {
      log(`⚠️ Bus inter-agents momentanément indisponible: ${e.message?.slice(0, 80)}`);
      // Fallback : écriture directe dans les inbox
      const busDir = '/data/.openclaw/bus/messages'; const now = Date.now();
      ['porte-parole', 'facteur', 'briefeur'].forEach(agent => {
        const d = '/data/.openclaw/plugin-skills/' + agent + '/inbox';
        try {
          if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(d + '/prospecteur-' + now + '.json', JSON.stringify(briefing, null, 2));
        } catch {}
      });
    }

    // Backup fichier
    const ppPath = '/data/.openclaw/plugin-skills/porte-parole/briefings/briefing-' + new Date().toISOString().split('T')[0] + '.json';
    const ppDir = path.dirname(ppPath);
    if (!fs.existsSync(ppDir)) fs.mkdirSync(ppDir, { recursive: true });
    fs.writeFileSync(ppPath, JSON.stringify(briefing, null, 2));

    log(`📡 Bus: Porte-Parole notifié (${prospects.length} approches préparées)`);
  } catch(e) {
    log(`⚠️ Porte-Parole: ${e.message?.slice(0, 80)}`);
  }
}

/**
 * Appelle Facteur pour générer les brouillons de premier contact.
 * Écrit les ébauches dans son dossier.
 */
async function genererBrouillons(prospects) {
  if (!prospects || prospects.length === 0) return;

  log(`✉️ Génération brouillons pour ${prospects.length} prospect(s)`);
  try {
    const brouillons = prospects.map(p => {
      // Construire un accroche personnalisée basée sur les données réelles
      const details = [];

      // Avis Google
      const nbAvis = p.nbAvis || p.ratingCount || p.avis || 0;
      const note = p.note || p.rating || 0;
      if (nbAvis >= 20 && note >= 4.5) {
        details.push(`Vous avez ${nbAvis} excellents avis Google (${note}/5) mais votre site ne reflète pas cette qualité —
vos clients méritent une vitrine aussi belle que votre réputation`);
      } else if (nbAvis >= 10 && note >= 4) {
        details.push(`Avec ${nbAvis} avis positifs sur Google, votre réputation est solide —
il est temps que votre site web soit à la hauteur de vos services`);
      } else if (nbAvis >= 5) {
        details.push(`Vos ${nbAvis} premiers avis Google montrent que vos clients vous apprécient —
un site web professionnel transformerait cette reconnaissance en business`);
      } else if (nbAvis > 0) {
        details.push(`Vous avez commencé à recevoir des avis Google —
un site web donnerait à vos nouveaux clients une vitrine pour vous découvrir`);
      } else {
        details.push(`Votre visibilité en ligne mérite d'être construite —
un site web vous aiderait à développer votre clientèle locale`);
      }

      // Site web — vétusté
      const sv = p.scoreVetuste;
      if (sv !== undefined && sv >= 7) {
        details.push(`J'ai consulté votre site qui a besoin d'une refonte complète :
chargement lent, design daté, pas adapté aux mobiles —
vos visiteurs partent avant même de vous connaître`);
      } else if (sv !== undefined && sv >= 4) {
        details.push(`Votre site actuel pourrait être optimisé :
quelques améliorations techniques et de design augmenteraient
significativement votre taux de conversion`);
      } else if (sv !== undefined && sv > 0 && p.website) {
        details.push(`Votre site tient la route mais gagnerait à être modernisé
pour suivre les standards actuels du web`);
      }

      // Pas de site du tout — priorité absolue
      if (!p.website || p.website === 'non renseigné') {
        details.push(`Vous n'avez pas encore de site web — aujourd'hui,
un professionnel sans site web perd des clients chaque jour
qui ne le trouvent pas sur Google`);
      }

      // Détail Google Maps observé
      if (p.categories || p.catégorie) {
        const cat = p.categories || p.catégorie;
        details.push(`J'ai remarqué que vous êtes ${cat} en ${p.city || p.ville || 'Normandie'} —
un site dédié à votre activité vous démarquerait de vos concurrents locaux`);
      }

      // SSL manquant
      const analyse = p.siteAnalyse;
      if (analyse && analyse.ssl && !analyse.ssl.sslPresent) {
        details.push(`Votre site n'est pas sécurisé (pas de HTTPS) —
Google pénalise les sites sans SSL et vos visiteurs voient un avertissement de sécurité`);
      }

      // Non responsive
      if (analyse && analyse.responsive && !analyse.responsive.responsive) {
        details.push(`Votre site n'est pas adapté aux mobiles —
plus de 70% des recherches locales se font sur téléphone, chaque clic perdu est un client potentiel`);
      }

      return {
        type: 'prospecteur.contact',
        source: 'Prospecteur',
        destinataire: {
          nom: p.company || p.first_name || '',
          email: p.email || '',
          telephone: p.phone || '',
          ville: p.city || p.ville || '',
          codePostal: p.postCode || p.code_postal || '',
        },
        canal: p.email ? 'email' : 'téléphone',
        angle: !p.website
          ? 'Création site web (priorité haute — pas de présence en ligne)'
          : sv >= 7
            ? 'Refonte urgente site web (vétusté criticité élevée)'
            : 'Modernisation / optimisation site web',
        accrochePersonnalisee: details.length > 0
          ? details[0] // La meilleure accroche
          : null,
        detailsProspect: details.slice(1), // Accroches secondaires pour enrichir
        metriques: {
          noteGoogle: note || 'N/A',
          avisGoogle: nbAvis || 0,
          scoreVetuste: sv ?? 'N/A',
          sslPresent: analyse?.ssl?.sslPresent ?? '?',
          responsive: analyse?.responsive?.responsive ?? '?',
          tempsChargementMs: analyse?.performance?.tempsChargementMs || '?',
          modeleSite: analyse?.modele?.modele || '?',
        },
        date: new Date().toISOString(),
      };
    });

    try {
      await bus.publish({
        type: 'prospecteur.brouillons-contact',
        source: 'Prospecteur',
        targets: ['Facteur'],
        payload: {
          brouillons,
          total: brouillons.length,
          campagne: 'Apify Hebdo ' + new Date().toISOString().split('T')[0],
        },
      });
    } catch(e) {
      log(`⚠️ Bus Facteur indisponible: ${e.message?.slice(0, 80)}`);
      const d = '/data/.openclaw/plugin-skills/facteur/inbox';
      try {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(d + '/brouillons-' + Date.now() + '.json', JSON.stringify({ brouillons, total: brouillons.length }, null, 2));
      } catch {}
    }

    log(`📡 Bus: Facteur notifié (${prospects.length} brouillons)`);
    return brouillons;
  } catch(e) {
    log(`⚠️ Facteur: ${e.message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * Envoie un rapport Telegram structuré après chaque session de prospection.
 * Format : 🔍 Prospection → 📊 Scrapés → ✅ Qualifiés → 📧 Emails → ⭐Top → 🗑️ Écartés
 */
async function notifierTelegramAvecBoutons(prospects, stats) {
  const creds = chargeCreds();
  const bot = creds.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = '6408961089';
  if (!bot) { log('⚠️ Telegram: token manquant'); return; }

  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  const top = prospects.slice(0, 5);
  const qualifiesCount = stats.qualifies || 0;
  const ecartes = (stats.resultatsBruts || 0) - qualifiesCount;

  let msg = `<b>🔍 Prospection du ${date}</b>\n\n`;

  // ─── Ligne 1 : Scrapés ───
  msg += `<b>📊 Scrapés :</b> ${stats.resultatsBruts || 0} entreprises\n`;

  // ─── Ligne 2 : Qualifiés ───
  msg += `<b>✅ Qualifiés (score ≥${stats.scoreMinContact || 60}) :</b> ${qualifiesCount}\n`;

  // ─── Ligne 3 : Emails ───
  msg += `<b>📧 Emails préparés :</b> ${stats.hautsScores || 0}\n`;

  // ─── Ligne 4 : Top prospect ───
  if (top.length > 0) {
    const p = top[0];
    const secteur = p.secteur || '?';
    msg += `<b>⭐ Top prospect :</b> ${p.company || p.first_name || '?'} · ${secteur} · score ${p.ai_score || p.score || '?'}\n`;
  }

  // ─── Ligne 5 : Écartés ───
  if (ecartes > 0) {
    // Raisons principales estimées depuis les scores
    const raisons = [];
    if (stats.scoreMoyen && stats.scoreMoyen < 60) raisons.push('score insuffisant <60');
    if (stats.tresVetuste !== undefined) {
      const modernes = qualifiesCount - (stats.tresVetuste || 0);
      if (modernes > 0) raisons.push('site moderne / récent');
    }
    if (raisons.length === 0) raisons.push('hors zone Normandie ou données incomplètes');
    msg += `<b>🗑️ Écartés :</b> ${ecartes} (${raisons.join(', ')})\n`;
  }

  // ─── Boutons ───
  try {
    const url = `https://api.telegram.org/bot${bot}/sendMessage`;
    await requete(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Envoyer les approches', callback_data: 'prospecteur:envoyer' },
          { text: '✏️ Modifier les cibles', callback_data: 'prospecteur:modifier' },
          { text: '📊 Voir le détail', callback_data: 'prospecteur:detail' },
        ]],
      },
    });
    log('📨 Rapport Telegram envoyé (Prospection ' + date + ')');
  } catch(e) {
    log(`⚠️ Telegram: ${e.message?.slice(0, 80)}`);
  }
}

/**
 * Notification Telegram enrichie : résumé par recherche + par secteur + top entreprises contactées.
 */
async function notifierTelegramMultiRecherche(prospects, stats) {
  const creds = chargeCreds();
  const bot = creds.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = '6408961089';
  if (!bot) { log('⚠️ Telegram: token manquant'); return; }

  const date = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris'
  });

  let msg = `<b>🔍 Prospection du ${date}</b>\n\n`;

  // ─── Résultats par recherche ───
  const resultats = stats.resultatsParRecherche || [];
  const rechercheSecteur = new Map(RECHERCHES_PROSPECTION.map(r => [r.search, r.secteur]));
  const resultatsAvecSecteur = resultats.map(r => ({
    ...r,
    secteur: r.secteur || rechercheSecteur.get(r.search) || 'autres',
  }));
  const artisans = resultatsAvecSecteur.filter(r => r.secteur === 'artisans');
  const sport = resultatsAvecSecteur.filter(r => r.secteur === 'sport-bienetre');

  msg += `<b>📊 Résultats par recherche :</b>\n`;
  msg += `┌─ <b>Artisans</b>\n`;
  for (const r of artisans) {
    const icone = r.error ? '❌' : (r.count > 0 ? '✅' : '⚠️');
    msg += `│ ${icone} ${r.search} : ${r.count}\n`;
  }
  msg += `└─ Total : ${artisans.reduce((s, r) => s + r.count, 0)}\n\n`;

  msg += `┌─ <b>Sport & Bien-être</b>\n`;
  for (const r of sport) {
    const icone = r.error ? '❌' : (r.count > 0 ? '✅' : '⚠️');
    msg += `│ ${icone} ${r.search} : ${r.count}\n`;
  }
  msg += `└─ Total : ${sport.reduce((s, r) => s + r.count, 0)}\n\n`;

  // ─── Synthèse ───
  const totalBruts = stats.resultatsBruts.length || 0;
  msg += `<b>Synthèse :</b>\n`;
  msg += `📦 ${totalBruts} résultats uniques (${resultats.length} recherches)\n`;
  msg += `✅ ${stats.qualifies} qualifiés (score ≥${stats.scoreMinContact})\n`;
  msg += `📧 ${stats.hautsScores} préparés pour contact (max ${MAX_CONTACTS}/cycle)\n`;

  // ─── Top entreprises contactées (avec enrichissement) ───
  if (prospects.length > 0) {
    msg += `\n<b>🏆 Top ${Math.min(prospects.length, MAX_CONTACTS)} contactés :</b>\n`;
    prospects.slice(0, MAX_CONTACTS).forEach((p, i) => {
      const nom = p.company || p.first_name || '?';
      const secteur = p.secteur || '?';
      const ville = p.city || '?';
      const s = p.ai_score || p.score || '?';
      const phone = p.phone || p.telephone || '';
      const email = p.email || (p._enrichi?.email) || '';
      const insta = p.instagram_url || (p._enrichi?.instagram) || '';
      const fb = p.facebook_url || (p._enrichi?.facebook) || '';
      const scoreEnrichi = p.score_enrichi || 0;
      
      msg += `${i+1}. <b>${nom}</b> (${secteur}, ${ville})\n`;
      msg += `   Score IA: ${s} | Enrichi: +${scoreEnrichi}\n`;
      msg += `   📧 ${email || '❌ non trouvé'}\n`;
      if (phone) msg += `   📱 ${phone}\n`;
      msg += `   📸 ${insta || '❌'}\n`;
      msg += `   👍 ${fb || '❌'}\n\n`;
    });
  } else {
    msg += `\n⚠️ Aucun prospect qualifié ce cycle\n`;
  }

  // ─── Boutons ───
  try {
    const url = `https://api.telegram.org/bot${bot}/sendMessage`;
    await requete(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Envoyer les approches', callback_data: 'prospecteur:envoyer' },
          { text: '✏️ Modifier les cibles', callback_data: 'prospecteur:modifier' },
          { text: '📊 Voir le détail', callback_data: 'prospecteur:detail' },
        ]],
      },
    });
    log('📨 Rapport Telegram envoyé (Prospection ' + date + ')');
  } catch(e) {
    log(`⚠️ Telegram: ${e.message?.slice(0, 80)}`);
  }
}

async function envoyerRapportTelegram(c, stats) {
  const creds = chargeCreds();
  const bot = creds.telegram_bot_token || c.telegram_bot_token;
  const chatId = '6408961089';

  if (!bot || !chatId) { log('⚠️ Telegram: token manquant'); return; }

  let msg = `<b>🔍 Prospecteur — ${new Date().toISOString().split('T')[0]}</b>\n\n`;
  msg += `<b>Sources consultées :</b>\n`;
  msg += `• Apify Maps Scraper : ${stats.resultatsBruts || 0} prospect(s) brut(s)\n`;
  msg += `• Mémoire : ${stats.memoire} pattern(s) disparition\n`;
  msg += `• Supabase : ${stats.existants} existant(s)\n\n`;

  if (stats.inseres > 0) {
    msg += `<b>✅ Nouveaux prospects :</b> ${stats.inseres}\n`;
    msg += `<b>Score moyen :</b> ${stats.scoreMoyen}/100\n`;
    if (stats.hautsScores > 0) msg += `<b>🔝 Qualifiés (≥50) :</b> ${stats.hautsScores} → transmis à Porte-Parole\n`;
    msg += '\n';
  } else {
    msg += `Aucun nouveau prospect aujourd'hui\n\n`;
  }

  msg += `📡 Collaborations : Porte-Parole (approche) · Facteur (contact) · Briefeur (indicateurs)`;

  try {
    const url = `https://api.telegram.org/bot${bot}/sendMessage`;
    await requete(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      chat_id: chatId, text: msg, parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    log('📨 Rapport Telegram envoyé');
  } catch(e) {
    log(`⚠️ Telegram: ${e.message?.substring(0, 80)}`);
  }
}

function sauvegarderEtat(stats) {
  const etat = {
    dernierScan: new Date().toISOString(),
    ...stats,
  };
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(etat, null, 2), 'utf8');
  } catch(e) { log(`⚠️ État: ${e.message?.substring(0, 60)}`); }
}

// ═══════════════════════════════════════════════
// APIFY — Scraping Google Maps (multi-recherches)
// ═══════════════════════════════════════════════

/**
 * Recherches ciblées pour chaque cycle de prospection.
 * 8 recherches réparties en 2 secteurs, 24 cibles total (~3 par recherche).
 */
const RECHERCHES_PROSPECTION = [
  // ── Artisans BTP Normandie (3) ──
  { search: 'plombier Le Havre France',     secteur: 'artisans' },
  { search: 'électricien Le Havre France',  secteur: 'artisans' },
  { search: 'menuisier Rouen',              secteur: 'artisans' },
  // ── Artisans BTP IDF (3 nouvelles) ──
  { search: 'plombier Hauts-de-Seine 92',    secteur: 'artisans' },
  { search: 'électricien Val-de-Marne 94',   secteur: 'artisans' },
  { search: 'artisan Seine-et-Marne 77',     secteur: 'artisans' },
  // ── Sport & Bien-être (2 Normandie + 1 IDF) ──
  { search: 'coach sportif Le Havre',        secteur: 'sport-bienetre' },
  { search: 'salle de sport Le Havre',       secteur: 'sport-bienetre' },
  { search: 'coach sportif Val-d\'Oise 95',  secteur: 'sport-bienetre' },
  // ── Beauté (1) ──
  { search: 'salon coiffure Le Havre',       secteur: 'beaute' },
  // ── Restauration (1) ──
  { search: 'restaurant Le Havre France',    secteur: 'restauration' },
  // ── Libre (1) ──
  { search: 'artisan Normandie',             secteur: 'artisans' },
];

/**
 * Cycle Apify multi-recherches : exécute les 8 recherches en rafale,
 * déduplique, qualifie, insère et journalise.
 */
async function cycleApify(dryRun = false) {
  if (dryRun) {
    log('🔄 Mode DRY-RUN — données simulées pour test inter-agents');
    const bruts = GENERATEUR_MOCK();
    log(`✅ ${bruts.length} entreprises mock générées`);
    return { ok: true, bruts };
  }

  const apifyPath = path.join(__dirname, 'apify-maps-scraper.js');
  if (!fs.existsSync(apifyPath)) {
    log('⚠️ apify-maps-scraper.js introuvable');
    return { ok: false, error: 'fichier manquant' };
  }

  // Charge le module Apify
  const apify = require(apifyPath);

  log(`🤖 Apify — lancement ${RECHERCHES_PROSPECTION.length} recherches (${CIBLES_PAR_RECHERCHE} cibles/recherche)`);

  /**
   * Journalise une activité dans la table activity_logs Supabase.
   */
  async function logActivity(type, title, description, extra = {}) {
    try {
      await sbInsert('activity_logs', {
        agent_name: 'prospecteur',
        type: type,
        title: title,
        description: description,
        status: extra.status || null,
        duration_ms: extra.duration_ms || null,
        result_count: extra.result_count || null,
        details: extra.details || null,
        created_at: new Date().toISOString(),
      });
    } catch(e) {
      log(`⚠️ activity_logs: ${e.message?.slice(0, 80)}`);
    }
  }

  // Vue d'ensemble des résultats par recherche (pour Telegram)
  const resultatsParRecherche = [];
  // Déduplication : clé normalisée (company en minuscules)
  const tousBruts = [];
  const dejaVus = new Set();

  // Phase 1 : lancer TOUS les runs Apify en rafale (fire & forget), récupérer les runIds
  log(`🚀 Phase 1 — Lancement de ${RECHERCHES_PROSPECTION.length} recherches en rafale...`);
  const runsEnCours = [];
  for (let i = 0; i < RECHERCHES_PROSPECTION.length; i++) {
    const { search, secteur } = RECHERCHES_PROSPECTION[i];
    try {
      // Lancement via le module apify (sans attendre la fin)
      const run = await apify.scrape(search, CIBLES_PAR_RECHERCHE, {});
      runsEnCours.push({ search, secteur, runId: run.id, run });
      log(`  🔍 [${i+1}/${RECHERCHES_PROSPECTION.length}] "${search}" → run ${run.id}`);
    } catch (e) {
      const errorMsg = `Lancement "${search}" échoué: ${e.message?.slice(0, 80)}`;
      log(`  ❌ ${errorMsg}`);
      resultatsParRecherche.push({ search, secteur, count: 0, error: errorMsg });
    }
    // Petite pause entre les lancements pour éviter rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  log(`⏳ Phase 2 — Attente des ${runsEnCours.length} runs (max 5 min)...`);
  // Phase 2 : attendre TOUS les runs en parallèle avec un timeout global de 4 min
  const POLL_INTERVAL = 5000;
  const MAX_WAIT = 360000; // 6 min max pour tous (runs Apify ~3-4 min à démarrer + exécution)
  const attendreRuns = async () => {
    const debut = Date.now();
    while (Date.now() - debut < MAX_WAIT) {
      const statuts = await Promise.all(
        runsEnCours.map(async r => {
          try {
            const result = await apify.apiFetch('/actor-runs/' + r.runId);
            return { search: r.search, runId: r.runId, data: result.data, status: result.data?.status };
          } catch {
            return { search: r.search, runId: r.runId, status: 'UNKNOWN' };
          }
        })
      );

      const succeeded = statuts.filter(s => s.status === 'SUCCEEDED').length;
      const failed = statuts.filter(s => s.status === 'FAILED' || s.status === 'ABORTED' || s.status === 'TIMED-OUT').length;
      const pending = runsEnCours.length - succeeded - failed;
      log(`  ⏳ ${succeeded} terminés, ${pending} en cours, ${failed} échoués`);

      if (pending === 0) return statuts;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    log(`  ⏰ Timeout global atteint (${MAX_WAIT/1000}s)`);
    // Récupérer les statuts finaux (même incomplets)
    return await Promise.all(
      runsEnCours.map(async r => {
        try {
          const result = await apify.apiFetch('/actor-runs/' + r.runId);
          return { search: r.search, runId: r.runId, data: result.data, status: result.data?.status };
        } catch {
          return { search: r.search, runId: r.runId, status: 'TIMEOUT' };
        }
      })
    );
  };

  const statutsFinaux = await attendreRuns();

  // Phase 3 : récupérer les résultats des runs réussis
  log('📥 Phase 3 — Récupération des résultats...');
  for (const statut of statutsFinaux) {
    const { search, secteur, runId, status } = statut;
    if (status !== 'SUCCEEDED') {
      log(`  ⏭️ "${search}" ignoré (${status})`);
      continue;
    }

    try {
      const results = await apify.getResults(runId);
      const count = results.length;
      log(`  ✅ "${search}" → ${count} résultats`);

      await logActivity(
        'prospection_recherche',
        `Recherche Apify: ${search}`,
        `${count} résultats bruts pour "${search}"`
      );

      resultatsParRecherche.push({ search, secteur, count });

      for (const item of results) {
        const nom = (item.title || item.name || item.company || '').toLowerCase().trim();
        const email = (item.email || '').toLowerCase().trim();
        const key = nom || email;
        if (!key || dejaVus.has(key)) continue;
        dejaVus.add(key);

        tousBruts.push({
          company: item.title || item.name || item.company || '',
          address: item.address || '',
          phone: item.phone || item.phoneNumber || '',
          email: item.email || '',
          website: item.website || '',
          rating: item.averageRating || item.rating || 0,
          reviews: item.totalReviews || item.reviewsCount || 0,
          category: item.category || item.type || item.categories || '',
          city: item.city || '',
          postCode: item.postalCode || '',
          latitude: item.latitude || item.lat || null,
          longitude: item.longitude || item.lng || null,
          note: item.averageRating || item.rating || 0,
          nbAvis: item.totalReviews || item.reviewsCount || 0,
          searchQuery: search,
          secteurRecherche: secteur,
          source: 'Apify Maps Scraper',
          notes: secteur === 'sport-bienetre'
            ? `Secteur sport/bien-être — recherche "${search}"`
            : `Artisan Normandie — recherche "${search}"`,
          categories: item.category || item.type || '',
        });
      }
    } catch (e) {
      log(`  ❌ "${search}": ${e.message?.slice(0, 80)}`);
    }
  }

  log(`📊 Multi-recherche terminée: ${tousBruts.length} bruts uniques (${RECHERCHES_PROSPECTION.length} recherches)`);

  // Journalise le total
  await logActivity(
    'prospection_terminee',
    `Prospection multi-termes terminée`,
    `${tousBruts.length} résultats uniques après ${RECHERCHES_PROSPECTION.length} recherches (dédupliqués)`
  );

  return {
    ok: true,
    bruts: tousBruts,
    resultatsParRecherche,
    qualifies: 0,
    inseres: 0,
  };
}

/**
 * Génère 5 entreprises mock pour tester le pipeline complet
 */
function GENERATEUR_MOCK() {
  return [
    { company: 'Menuiserie Leblanc (Le Havre)', notes: 'Artisan menuisier au Havre — site vitrine existant mais obsolète', address: '15 Rue de Paris, 76600 Le Havre', phone: '+33235123456', email: 'contact@menuserie-leblanc.fr', website: 'https://menuserie-leblanc.fr', rating: 4.5, reviews: 23, category: 'Menuisier', placeId: 'mock01', search: 'artisan Normandie' },
    { company: 'Électricité Normande (Rouen)', notes: 'Électricien général à Rouen — pas de site web, contacté via devis', address: '8 Avenue Foch, 76000 Rouen', phone: '+33235123457', email: null, website: 'https://electricite-normande.fr', rating: 4.2, reviews: 15, category: 'Électricien', placeId: 'mock02', search: 'artisan Normandie' },
    { company: 'Plomberie Lecapitaine (Caen)', notes: 'Plombier à Caen — site orange.fr obsolète, besoin refonte complète, pas de site responsive, urgent', address: '3 Rue Carnot, 14000 Caen', phone: '+33231123456', email: 'contact@plomberie-lecapitaine.fr', website: 'http://plomberie-lecapitaine.pagesperso-orange.fr', rating: 3.8, reviews: 8, category: 'Plombier', placeId: 'mock03', search: 'artisan Normandie' },
    { company: 'Maçonnerie Hamelin (Étretat)', notes: 'Maçon à Étretat — pas de site web du tout, urgent, besoin d\'une vitrine rapidement', address: '12 Route d\'Étretat, 76790 Étretat', phone: '+33235234567', email: null, website: null, rating: 4.7, reviews: 31, category: 'Maçon', placeId: 'mock04', search: 'artisan Normandie' },
    { company: 'Paysagiste Cotentin (Granville)', notes: 'Paysagiste à Granville — site vitrine basique, demande devis', address: '5 Rue de la Mer, 50400 Granville', phone: '+33233456789', email: 'bonjour@paysagiste-cotentin.com', website: 'https://paysagiste-cotentin.com', rating: 4.0, reviews: 12, category: 'Paysagiste', placeId: 'mock05', search: 'artisan Normandie' },
  ];
}

// ═══════════════════════════════════════════════
// RUN — Pipeline complet inter-agents
// ═══════════════════════════════════════════════

/**
 * Cycle hebdomadaire complet :
 *   1. Lancement Apify → 161 scrapes Google Maps Normandie
 *   2. Qualification + score
 *   3. Contextualisation Mémoire (historique, devis, infos sectorielles)
 *   4. Insertion Supabase
 *   5. Préparation approche Porte-Parole (briefing personnalisé)
 *   6. Génération brouillons Facteur
 *   7. Notification Telegram interactive (boutons Envoyer/Modifier/Détail)
 *   8. Alimentation Briefeur (indicateurs)
 *   9. Log Hermès (apprentissage, cristallisation)
 *
 * Aucun agent ne travaille en silo.
 */
async function run() {
  const start = Date.now();
  const dryRun = process.argv[2] === 'dry-run' || process.argv.includes('--dry-run');
  if (dryRun) log('🔍 Prospecteur — DRY-RUN (données simulées, aucune action réelle)');
  else log('🔍 Prospecteur — CYCLE COMPLET (Apify + inter-agents)');
  const c = chargeCreds();

  // ─── Hermès : préparation ───
  try { await reuser.prepareContext('Prospecteur'); } catch(e) {}

  // ════════════════════════════════════════
  // ÉTAPE 1 : Scrape Apify Google Maps (8 recherches en rafale)
  // ════════════════════════════════════════
  log(`🤖 ÉTAPE 1/8 — Lancement scrape Apify (${RECHERCHES_PROSPECTION.length} recherches × ${CIBLES_PAR_RECHERCHE} cibles = ${MAX_SCRAPE} max)`);
  const apifyResult = await cycleApify(dryRun);
  const apifyOk = apifyResult && apifyResult.ok !== false;

  // Apify a retourné des bruts dédupliqués
  const brutsApify = apifyResult?.bruts || [];
  const resultatsParRecherche = apifyResult?.resultatsParRecherche || [];

  log(`📊 Apify: ${brutsApify.length} bruts uniques (${RECHERCHES_PROSPECTION.length} recherches)`);

  // ════════════════════════════════════════
  // ÉTAPE 2 : Collecter les autres sources
  // ════════════════════════════════════════
  // Make désactivé — remplacé par Apify
  // Seules Mémoire (réactivation) + web restent en complément
  log('📡 ÉTAPE 2/8 — Collecte sources complémentaires (Mémoire, Supabase)');
  const memoireDisparus = collecterMemoire();
  const existants = await collecterExistants(c);
  const webBruts = await collecterWeb(c);

  const memoireProspects = memoireDisparus.map(nom => ({
    first_name: nom,
    company: nom,
    phone: '',
    source: 'Mémoire (réactivation)',
    notes: 'Lead disparu après devis — tentative réactivation',
  }));

  const tousBruts = [...brutsApify, ...memoireProspects, ...webBruts];

  // ════════════════════════════════════════
  // ÉTAPE 3 : Qualification complète
  // ════════════════════════════════════════
  log('🎯 ÉTAPE 3/8 — Qualification et scoring');
  const qualifies = qualifierProspects(tousBruts, existants);
  const hautScore = qualifies.filter(p => p.ai_score >= SCORE_MIN_CONTACT).slice(0, MAX_CONTACTS);
  const moyenScore = qualifies.filter(p => p.ai_score >= 30 && p.ai_score < SCORE_MIN_CONTACT);

  log(`🎯 Qualifiés: ${qualifies.length} (${hautScore.length} hauts scores ≥${SCORE_MIN_CONTACT}, ${moyenScore.length} moyens ≥30)`);
  log(`📊 Contact max: ${MAX_CONTACTS} prospects par session — retenus: ${hautScore.length}`);

  // ════════════════════════════════════════
  // ÉTAPE 4 : Contextualisation Mémoire
  // ════════════════════════════════════════
  if (hautScore.length > 0) {
    log('📚 ÉTAPE 4/8 — Contextualisation Mémoire');
    for (const p of hautScore) {
      await contextualiserProspect(p);
    }
  }

  // ════════════════════════════════════════
  // ÉTAPE 5 : Analyse des sites web (vétusté, SSL, responsive)
  // ════════════════════════════════════════
  const analyseurPath = path.join(__dirname, 'analyseur-site.js');
  let analyses = [];
  if (fs.existsSync(analyseurPath) && hautScore.length > 0) {
    log('🔍 ÉTAPE 5/10 — Analyse des sites web des prospects');
    const { analyserBatch } = require(analyseurPath);
    analyses = await analyserBatch(hautScore);
    // Fusionner les scores de vétusté dans les prospects
    for (const a of analyses) {
      const match = hautScore.find(p =>
        (p.company && a.company && p.company === a.company) ||
        (p.website && a.site_web && p.website === a.site_web) ||
        (p.email && a.email && p.email === a.email)
      );
      if (match) {
        match.scoreVetuste = a.scoreVetuste || 0;
        match.analyseSite = a.siteAnalyse || null;
        match.priorite = a.priorite || match.ai_score || 0;
      }
    }
    // Logger le résumé
    const scores = analyses.filter(a => a.siteAnalyse).map(a => a.scoreVetuste);
    if (scores.length > 0) {
      const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      const worst = Math.max(...scores);
      const noSite = analyses.filter(a => !a.site_web && !a.website).length;
      log(`📊 Vétusté: moyenne ${avg}/10, pire ${worst}/10, ${noSite} sans site`);
    }
  }

  // ════════════════════════════════════════
  // ÉTAPE 6 : Insertion Supabase
  // ════════════════════════════════════════
  log('💾 ÉTAPE 6/9 — Insertion Supabase');
  // Note : les prospects Apify sont déjà insérés par apify-maps-scraper.js
  // On insère seulement les sources secondaires ici (Mémoire, web)
  const inseres = await insererProspects(c, qualifies);

  // ════════════════════════════════════════
  // ÉTAPE 6.5 : Enrichissement (email + réseaux sociaux)
  // ════════════════════════════════════════
  const enrichisseurPath = path.join(__dirname, 'enrichisseur.js');
  let enrichisCount = 0;
  if (fs.existsSync(enrichisseurPath) && hautScore.length > 0) {
    log('🌐 ÉTAPE 6.5/9 — Enrichissement des hauts scores (email + réseaux)');
    const { enrichirBatch } = require(enrichisseurPath);
    const supabase = createClient(
      (c || {}).supabase_url || process.env.SUPABASE_URL,
      (c || {}).supabase_service_role_key || process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    // Enrichir les hauts scores depuis les données brutes
    const batch = hautScore.map(p => ({
      company: p.company || p.name,
      website: p.website || '',
      email: p.email || '',
      phone: p.phone || '',
      city: p.city || ''
    }));
    const enrichis = await enrichirBatch(null, batch, false);
    enrichisCount = enrichis.filter(e => e.email || e.instagram_url || e.facebook_url).length;
    
    // Rattacher les infos enrichies aux prospects pour la notification
    for (const p of hautScore) {
      const match = enrichis.find(e => e.company === (p.company || p.name));
      if (match) {
        p._enrichi = match;
        if (match.email && !p.email) p.email = match.email;
        if (match.instagram_url) p.instagram_url = match.instagram_url;
        if (match.facebook_url) p.facebook_url = match.facebook_url;
        p.score_enrichi = match.score_enrichi || 0;
      }
    }
    log(`📊 Enrichis: ${enrichisCount}/${hautScore.length} avec données trouvées`);
  }

  // ════════════════════════════════════════
  // ÉTAPE 7 : Briefing Porte-Parole + Brouillons Facteur
  // ════════════════════════════════════════
  if (hautScore.length > 0) {
    log('📝 ÉTAPE 7/9 — Briefing Porte-Parole + Facteur');
    await preparerApproche(hautScore);
    await genererBrouillons(hautScore);
  }

  // ════════════════════════════════════════
  // ÉTAPE 8 : Statistiques + Telegram + Briefeur + Hermès
  // ════════════════════════════════════════
  const dureeSec = ((Date.now() - start) / 1000).toFixed(0);

  const scoresVetuste = hautScore.filter(p => p.scoreVetuste !== undefined).map(p => p.scoreVetuste);
  const vetusteMoyenne = scoresVetuste.length > 0
    ? (scoresVetuste.reduce((a, b) => a + b, 0) / scoresVetuste.length).toFixed(1)
    : 'N/A';
  const tresVetuste = hautScore.filter(p => (p.scoreVetuste || 0) >= 7).length;

  const stats = {
    apify: apifyOk,
    resultatsBruts: brutsApify,
    resultatsParRecherche,
    qualifies: qualifies.length,
    inseres: inseres.length,
    hautsScores: hautScore.length,
    scoreMoyen: qualifies.length > 0
      ? Math.round(qualifies.reduce((s, p) => s + p.ai_score, 0) / qualifies.length)
      : 0,
    scoreMinContact: SCORE_MIN_CONTACT,
    vetusteMoyenne,
    tresVetuste,
    sitesAnalyses: analyses.length,
    budgetRepartition: { haut: 0, moyen: 0, faible: 0 },
    sourcePrincipale: 'Apify Maps Scraper',
    memoire: memoireDisparus.length,
    web: webBruts.length,
    existants: existants.length,
    dureeSec: parseInt(dureeSec),
    date: new Date().toISOString(),
  };

  // Log final complet dans activity_logs (pour le dashboard)
  try {
    await sbInsert('activity_logs', {
      agent_name: 'prospecteur',
      type: 'cycle_complet',
      title: '[Prospecteur] Cycle complet de prospection',
      description: `${qualifies.length} qualifiés, ${inseres.length} insérés, ${hautScore.length} hauts scores, ${brutsApify.length} bruts Apify, ${dureeSec}s`,
      status: qualifies.length > 0 ? 'success' : 'empty',
      duration_ms: parseInt(dureeSec) * 1000,
      result_count: qualifies.length,
      details: JSON.stringify(stats).substring(0, 1000),
      created_at: new Date().toISOString(),
    });
  } catch(e) { log(`⚠️ activity_logs (final): ${e.message?.slice(0, 60)}`); }

  // Notification Telegram complète avec résumé par recherche
  log('📨 ÉTAPE 8/8 — Notification Telegram + Briefeur + Hermès');
  await notifierTelegramMultiRecherche(hautScore, stats);
  sauvegarderEtat(stats);

  // Briefeur
  try {
    await bus.publish({
      type: 'prospecteur.rapport-hebdomadaire',
      source: 'Prospecteur',
      targets: ['Briefeur', 'Sentinelle', 'Synthésiseur'],
      payload: {
        ...stats,
        cibles_configurees: MAX_SCRAPE,
        sources: 'Apify Maps Scraper + Mémoire + Web',
        agents_sollicites: ['AnalyseurSite', 'Mémoire', 'Porte-Parole', 'Facteur', 'Briefeur', 'Sentinelle', 'Synthésiseur'],
      },
    });
    log('📡 Bus: Briefeur + Sentinelle + Synthésiseur notifiés');
  } catch(e) { log(`⚠️ Bus Briefeur: ${e.message?.slice(0, 60)}`); }

  // Feedback Loop : patterns, apprentissage, ajustement des poids
  try {
    const feedbackPath = path.join(__dirname, 'feedback-loop.js');
    if (fs.existsSync(feedbackPath)) {
      log('🧠 Feedback Loop — apprentissage actif (sans notification)');
      const feedback = require(feedbackPath);
      feedback.main().catch(() => {});
    }
  } catch(fe) { log(`⚠️ FeedbackLoop: ${fe.message?.slice(0, 60)}`); }

  // Hermès
  try {
    const resume = `${stats.inseres} insérés, ${stats.hautsScores} prioritaires, ` +
      `vétusté moy. ${vetusteMoyenne}/10, ` +
      `sources: Apify(${stats.resultatsBruts}) Mémoire(${stats.memoire}), ` +
      `${stats.dureeSec}s`;
    await logger.action('Prospecteur', { resultat: resume, success: true });
    await learn.run('Prospecteur', {
      details: resume,
      success: true,
      agents_impliques: ['AnalyseurSite', 'Mémoire', 'Porte-Parole', 'Facteur', 'Briefeur', 'FeedbackLoop'],
    });
  } catch(he) { log(`⚠️ Hermès: ${he.message?.slice(0, 60)}`); }

  // Cristallisation
  try {
    const lecons = await crystal.collect('Prospecteur');
    if (lecons && lecons.length > 0) log(`📚 ${lecons.length} leçons cristallisées`);
  } catch(e) {}

  // Rapport hebdo (généré silencieusement en fin de cycle)
  try {
    const rapportPath = path.join(__dirname, 'rapport-hebdo.js');
    if (fs.existsSync(rapportPath)) {
      const { main: rapportMain } = require(rapportPath);
      rapportMain().catch(() => {});
    }
  } catch(reporte) {}

  log(`✅ Cycle complet terminé en ${dureeSec}s`);
  return { ok: true, ...stats };
}

// ─── CLI ───────────────────────────────────────
if (require.main === module) {
  run().then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
