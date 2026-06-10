#!/usr/bin/env node
/**
 * veilleur.js — Agent Veilleur d'Aminyo OS
 *
 * Surveille la concurrence et les tendances à deux niveaux :
 * - Local : agences web Normandie, tarifs, opportunités
 * - National/International : tendances design, pratiques agences,
 *   technologies émergentes, évolutions marché
 *
 * Usage :
 *   node veilleur.js                → rapport complet (local + national)
 *   node veilleur.js local           → rapport local uniquement
 *   node veilleur.js national        → rapport national uniquement
 *   node veilleur.js analyse <texte> → analyse concurrentielle d'un site/agence
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOOLS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const LOG_PATH = '/data/.openclaw/plugin-skills/veilleur/veilleur.log';
const ETAT_PATH = '/data/.openclaw/plugin-skills/veilleur/etat.json';

const DIR = path.dirname(LOG_PATH);
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hvhhuxjsubmqozgsbvti.supabase.co';
const REST_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '') + '/rest/v1';

function log(msg) {
  const line = `[${new Date().toISOString()}] [VEILLEUR] ${msg}`;
  console.error(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function requete(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AminyoVeilleur/1.0)',
        'Accept': 'text/html,application/json,*/*',
        ...(opts.headers || {}),
      },
    };
    const req = mod.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data) return resolve('');
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', err => { log('Req err: ' + err.message); reject(err); });
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function getSupabaseHeaders() {
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
  const key = tools.supabase_service_key || tools.supabase_service_role_key;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function chargerEtat() {
  try { return JSON.parse(fs.readFileSync(ETAT_PATH, 'utf8')); }
  catch { return { rapports: 0, dernierRapport: null, tendancesVues: [] }; }
}

function sauverEtat(e) {
  try { fs.writeFileSync(ETAT_PATH, JSON.stringify(e, null, 2)); } catch {}
}

// ── SOURCES LOCAL ──────────────────────────────────────

const SOURCES_LOCALES = [
  // Moteurs de recherche pour agences web Normandie
  { nom: 'Google — Agences web Le Havre',         url: 'https://www.google.com/search?q=agence+web+Le+Havre&num=20&hl=fr' },
  { nom: 'Google — Agences web Rouen',            url: 'https://www.google.com/search?q=agence+web+Rouen&num=20&hl=fr' },
  { nom: 'Google — Agences web Caen',             url: 'https://www.google.com/search?q=agence+web+Caen&num=20&hl=fr' },
  { nom: 'Google — Création site internet Normandie', url: 'https://www.google.com/search?q=cr%C3%A9ation+site+internet+Normandie+artisan&num=20&hl=fr' },
  { nom: 'Google — Agence web Normandie prix',    url: 'https://www.google.com/search?q=agence+web+Normandie+prix+tarifs&num=20&hl=fr' },
  // PagesJaunes pour les agences web locales
  { nom: 'PagesJaunes — Agences web Le Havre',    url: 'https://www.pagesjaunes.fr/annuaire/le-havre-76600/agence-web' },
  // Google Maps pour les concurrents directs
  { nom: 'Google — Agence web Le Havre Google Maps', url: 'https://www.google.com/maps/search/agence+web+Le+Havre/' },
  // Annuaire des agences web
  { nom: 'Annuaire — Agences web Normandie',      url: 'https://www.federationdesagencesweb.com/annuaire/normandie' },
  // Google Alerts : alerte sur la concurrence Normandie
  { nom: 'Google Alerts — Concurrence Normandie', url: 'https://www.google.com/alerts?q=agence+web+Normandie+prix+tarifs+site+internet' },
];

// ── SOURCES NATIONAL & INTERNATIONAL ───────────────────

const SOURCES_NATIONALES = [
  // Tendances design web
  { nom: 'Awwwards — Trends',        url: 'https://www.awwwards.com/websites/' },
  { nom: 'CSS Design Awards',        url: 'https://www.cssdesignawards.com/' },
  { nom: 'SiteInspire',              url: 'https://www.siteinspire.com/' },
  // Pratiques d'agences
  { nom: 'Medium — Web design agencies', url: 'https://medium.com/tag/web-design-agency' },
  { nom: 'Smashing Magazine',        url: 'https://www.smashingmagazine.com/' },
  // Technologies émergentes
  { nom: 'Product Hunt — Web',       url: 'https://www.producthunt.com/topics/web-design' },
  { nom: 'Hacker News — Web',        url: 'https://hn.algolia.com/api/v1/search?query=web+design+agency&tags=story&hitsPerPage=20' },
  // Observatoire des prix
  { nom: 'Clutch — Web design agencies France', url: 'https://clutch.co/fr/web-designers/le-havre' },
  { nom: 'Sortlist — Agences web France',       url: 'https://www.sortlist.fr/agence/web' },
  // Nouvelles sources demandées par Amine
  { nom: 'Awwwards — Top sites récompensés',     url: 'https://www.awwwards.com/websites/' },
  { nom: 'Dribbble — Web design trending',       url: 'https://dribbble.com/search/web-design' },
  { nom: 'Behance — Web design projects',        url: 'https://www.behance.net/search/projects?search=web+design+agency' },
  { nom: 'Product Hunt — Nouveaux outils tech',    url: 'https://www.producthunt.com/search?q=web+design' },
  { nom: 'GitHub Trending — Languages',          url: 'https://github.com/trending' },
  { nom: 'Google Alerts — Agences web France',   url: 'https://www.google.com/alerts?q=agence+web+France+design+tendances' },
  { nom: 'Les Numériques — Actualités tech FR',  url: 'https://www.lesnumeriques.com/actualites/' },
  { nom: 'Siècle Digital — Actu agences & startups', url: 'https://www.siecledigital.fr/actualites/' },
  { nom: 'Twitter — Veille design web',          url: 'https://nitter.net/search?f=tweets&q=web+design+agency+trends&since=&until=&near=' },
  { nom: 'LinkedIn — Tendances agences web FR',  url: 'https://www.linkedin.com/search/results/content/?keywords=agence%20web%20tendances%20design' },
];

// ── ANALYSE HTML (scraping basique) ──────────────────

function extraireLiens(html, domaine) {
  const liens = [];
  const regex = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1].toLowerCase();
    if (domaine && !url.includes(domaine)) continue;
    liens.push({ url: match[1], texte: match[2].trim().slice(0, 80) });
  }
  return liens;
}

function extraireTextesGoogle(html) {
  // Extrait les titres de résultats Google
  const resultats = [];
  const regex = /<h3[^>]*>(.*?)<\/h3>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const texte = match[1].replace(/<[^>]+>/g, '').trim();
    if (texte && texte.length > 5 && !texte.includes('Annonce') && !texte.includes('Publicité')) {
      resultats.push(texte);
    }
  }
  return resultats;
}

function extraireNomsAgences(html) {
  // Extraction basique de noms d'agences web
  const noms = [];
  const patterns = [
    /([A-Z][a-zéèêëàâîïôûùç]+(?:\s[A-Z][a-zéèêëàâîïôûùç]*)*\s(?:agence|agency|digital|studio|web|design|creation))/gi,
    /(?:agence|agency|studio|digital)\s([A-Z][a-zéèêëàâîïôûùç]+(?:\s[A-Z][a-zéèêëàâîïôûùç]*)*)/gi,
    /([A-Z][a-zéèêëàâîïôûùç]{2,}\s?[A-Z]?[a-zéèêëàâîïôûùç]*\.[a-z]{2,})/g,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(html)) !== null) {
      const nom = m[0] || m[1];
      if (nom && nom.length > 3 && nom.length < 80) noms.push(nom.trim());
    }
  }
  return [...new Set(noms)].slice(0, 20);
}

// ── SCRAPING ──────────────────────────────────────────

async function scraperSource(source) {
  try {
    const html = await requete(source.url, { method: 'GET' });
    if (typeof html !== 'string' || html.length < 100) {
      return { source, resultats: [], erreur: 'Réponse trop courte ou non-html' };
    }

    let elements = [];
    if (source.url.includes('google.com/search')) {
      elements = extraireTextesGoogle(html);
    } else {
      elements = extraireNomsAgences(html);
    }

    return { source, resultats: elements.slice(0, 15), erreur: null };
  } catch (e) {
    log(`  ⚠️ ${source.nom}: ${e.message.slice(0, 80)}`);
    return { source, resultats: [], erreur: e.message };
  }
}

async function scraperTendancesNationales(source) {
  try {
    const html = await requete(source.url, { method: 'GET' });
    if (typeof html !== 'string' || html.length < 100) return { source, resultats: [], erreur: 'Réponse vide' };

    let elements = [];
    // Product Hunt, HN Algolia → JSON
    if (source.url.includes('algolia')) {
      if (typeof html === 'object' && html.hits) {
        elements = html.hits.slice(0, 10).map(h => h.title || h.url || '');
      }
    } else if (source.url.includes('producthunt')) {
      // Product Hunt → extrait des noms de produits
      const titreMatch = html.match(/<h2[^>]*class="[^"]*styles_title__[^"]*"[^>]*>([^<]+)/gi);
      if (titreMatch) elements = titreMatch.slice(0, 10).map(t => t.replace(/<[^>]+>/g, ''));
    } else if (source.url.includes('medium')) {
      elements = extraireTextesGoogle(html).slice(0, 10);
    } else if (source.url.includes('smashing') || source.url.includes('awwwards') || source.url.includes('cssdesign')) {
      elements = extraireTextesGoogle(html).slice(0, 15);
    } else {
      elements = extraireNomsAgences(html);
    }

    return { source, resultats: elements.slice(0, 15), erreur: null };
  } catch (e) {
    log(`  ⚠️ ${source.nom}: ${e.message.slice(0, 80)}`);
    return { source, resultats: [], erreur: e.message };
  }
}

// ── ANALYSE VIA DEEPSEEK ──────────────────────────────

function analyserAvecDeepSeek(mode, donnees) {
  return new Promise((resolve) => {
    const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
    const key = tools.deepseek_key;
    if (!key) { log('Clé DeepSeek manquante, fallback texte brut'); resolve({ analyse: 'Analyse non disponible', opportunites: [], tendances: [] }); return; }

    let prompt;
    if (mode === 'local') {
      prompt = `Tu es le Veilleur d'Aminyo, agence web premium au Havre (76600). Analyse les données de veille locale ci-dessous et extrais :

1. **Concurrents identifiés** : liste les agences web concurrentes en Normandie (Le Havre, Rouen, Caen)
2. **Positionnement** : que proposent-elles ? Sont-elles premium ou low-cost ?
3. **Tarifs** : fourchette de prix observée
4. **Opportunités** : ce que les concurrents ne font PAS, que Aminyo pourrait exploiter
5. **Menaces** : ce qu'il faut surveiller
6. **Recommandation** : une action concrète pour la semaine à venir

Données collectées :
${JSON.stringify(donnees, null, 2).slice(0, 4000)}

Format : réponse structurée en français, max 300 mots.`;
    } else {
      prompt = `Tu es le Veilleur d'Aminyo, agence web premium au Havre (76600). Analyse les tendances nationales et internationales ci-dessous et extrais :

1. **Tendances design** : couleurs, layouts, typographie, UX qui émergent
2. **Pratiques agences** : ce que les meilleures agences françaises/mondiales adoptent
3. **Technologies** : frameworks, CMS, outils qui gagnent du terrain
4. **Tarifs** : évolution du marché français
5. **À adopter** : ce qu'Aminyo peut implémenter rapidement pour prendre un avantage local
6. **À surveiller** : tendances à long terme

Données collectées :
${JSON.stringify(donnees, null, 2).slice(0, 4000)}

Format : réponse structurée en français, max 300 mots.`;
    }

    const postData = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
    };

    const u = new URL('https://api.deepseek.com/chat/completions');
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = json.choices?.[0]?.message?.content || 'Analyse non disponible';
          resolve({ analyse: text, opportunites: [], tendances: [] });
        } catch { resolve({ analyse: data.slice(0, 1500), opportunites: [], tendances: [] }); }
      });
    });
    req.on('error', () => resolve({ analyse: 'Erreur analyse', opportunites: [], tendances: [] }));
    req.write(JSON.stringify(postData));
    req.end();
  });
}

// ── RAPPORT ───────────────────────────────────────────

async function genererRapport(mode = 'full') {
  const etat = chargerEtat();
  etat.rapports = (etat.rapports || 0) + 1;
  etat.dernierRapport = new Date().toISOString();

  let sourcesLocal = [];
  let sourcesNational = [];

  // PHASE 1 : Collecte locale
  if (mode === 'full' || mode === 'local') {
    log('📡 Collecte données locales Normandie...');
    for (const s of SOURCES_LOCALES) {
      const result = await scraperSource(s);
      sourcesLocal.push(result);
      log(`  ${s.nom}: ${result.resultats.length} éléments` + (result.erreur ? ' ⚠️' : ''));
      await pause(500);
    }
  }

  // PHASE 2 : Collecte nationale/internationale
  if (mode === 'full' || mode === 'national') {
    log('📡 Collecte tendances nationales/internationales...');
    for (const s of SOURCES_NATIONALES) {
      const result = await scraperTendancesNationales(s);
      sourcesNational.push(result);
      log(`  ${s.nom}: ${result.resultats.length} éléments` + (result.erreur ? ' ⚠️' : ''));
      await pause(500);
    }
  }

  // PHASE 3 : Analyse DeepSeek
  log('🧠 Analyse des données...');
  const analyseLocal = mode !== 'national' ? await analyserAvecDeepSeek('local', sourcesLocal.filter(s => s.resultats.length > 0)) : null;
  const analyseNational = mode !== 'local' ? await analyserAvecDeepSeek('national', sourcesNational.filter(s => s.resultats.length > 0)) : null;

  sauverEtat(etat);

  // PHASE 4 : Stockage dans memory_semantic
  try {
    const contenuAnalyse = {
      date: new Date().toISOString(),
      mode,
      local: analyseLocal?.analyse?.slice(0, 2000) || 'Non analysé',
      national: analyseNational?.analyse?.slice(0, 2000) || 'Non analysé',
      nbSourcesLocales: sourcesLocal.filter(s => s.resultats.length > 0).length,
      nbSourcesNationales: sourcesNational.filter(s => s.resultats.length > 0).length,
      nbElementsLocaux: sourcesLocal.reduce((a, s) => a + s.resultats.length, 0),
      nbElementsNationaux: sourcesNational.reduce((a, s) => a + s.resultats.length, 0),
    };
    await requete(REST_URL + '/memory_semantic', {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        agent_id: 'veilleur',
        categorie: 'rapport_veille',
        contenu: JSON.stringify(contenuAnalyse),
        metadata: { action: 'rapport-' + mode, date: new Date().toISOString() },
      }),
    });
    log('Rapport stocké dans memory_semantic');
  } catch (e) { log('Erreur stockage rapport: ' + e.message); }

  // PHASE 5 : Génération du message Telegram
  let message = '🔭 *Rapport Veilleur — ' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) + '*\n\n';

  if (analyseLocal) {
    message += '*🗺️ Veille locale — Normandie*\n';
    message += analyseLocal.analyse.slice(0, 1500) + '\n\n';
  }

  if (analyseNational) {
    message += '*🌍 Veille nationale & internationale*\n';
    message += analyseNational.analyse.slice(0, 1500) + '\n\n';
  }

  if (!analyseLocal && !analyseNational) {
    message += 'Aucune donnée collectée cette semaine.\n';
    message += 'Les sources n\'ont pas répondu — réessaye plus tard.\n\n';
  }

  message += '───\n';
  message += '📬 *Collaborations agents*\n';
  message += '→ Éclaireur : tendances tech GitHub\n';
  message += '→ Journaliste : sujets d\'articles SEO\n';
  message += '→ Stratège : recommandations business\n';
  message += '→ Comptable : indicateurs à surveiller\n\n';

  // Extraire les URLs des concurrents pour le Journaliste
  const concurrentsTrouves = [];
  for (const s of sourcesLocal) {
    for (const r of s.resultats) {
      if (typeof r === 'string' && r.length > 2) concurrentsTrouves.push(r);
    }
  }
  if (concurrentsTrouves.length > 0) {
    message += '*🎯 Concurrents locaux détectés :*\n';
    const uniques = [...new Set(concurrentsTrouves)].slice(0, 10);
    for (const c of uniques) message += '• ' + c.slice(0, 60) + '\n';
  }

  message += '\n*Prochaine veille : vendredi prochain 16h.*';

  await notifierTelegram(message);
  log('Rapport ' + mode + ' envoyé sur Telegram');
  return { message, analyseLocal, analyseNational, sourcesLocal, sourcesNational };
}

// ── ANALYSE D'UN CONCURRENT DIRECT ──────────────────

async function analyserConcurrent(nomOuUrl) {
  log('Analyse concurrent : ' + nomOuUrl);

  // Scraper le site si c'est une URL
  let contenu = '';
  if (nomOuUrl.startsWith('http')) {
    try {
      const html = await requete(nomOuUrl, { method: 'GET' });
      if (typeof html === 'string') contenu = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
    } catch {}
  }

  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
  const prompt = `Tu es le Veilleur d'Aminyo (agence web premium au Havre). Analyse ce concurrent web :

Nom/URL : ${nomOuUrl}
${contenu ? 'Contenu extrait du site : ' + contenu.slice(0, 2000) : '(pas de contenu récupéré)'}

Extrais :
1. **Type d'agence** (taille, positionnement, cible)
2. **Offre** (prestations, CMS, services)
3. **Forces** (ce qu'ils font bien)
4. **Faiblesses** (ce qu'ils ne font pas, ce qui cloche)
5. **Prix** (si visible — fourchette estimée)
6. **Ce qu'Aminyo peut faire mieux**

Format : structuré en français, 200 mots max.`;

  try {
    const response = await requete('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tools.deepseek_key}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.3,
      }),
    });
    return response?.choices?.[0]?.message?.content || 'Analyse non disponible';
  } catch (e) {
    return 'Erreur analyse : ' + e.message;
  }
}

// ── CYCLE HERMÈS ──────────────────────────────────────

async function cycleHermes(action, details, success = true) {
  try {
    const memoryModule = require('/data/.openclaw/lib/supabase-memory.js');
    await memoryModule.addEpisode({
      agent_id: 'veilleur',
      session_id: null,
      action,
      details: typeof details === 'string' ? details : JSON.stringify(details).slice(0, 500),
      result: success ? 'succès' : 'échec',
      success,
      timestamp: new Date().toISOString(),
    });
  } catch {}
}

async function hermesAnalyserEtAjuster() {
  try {
    const memoryModule = require('/data/.openclaw/lib/supabase-memory.js');
    const episodes = await memoryModule.getEpisodes('veilleur', 30);
    const rapports = episodes.filter(e => e.action === 'veille-complete' || e.action === 'veille-local' || e.action === 'veille-national');
    const succes = rapports.filter(e => e.success !== false).length;
    const taux = rapports.length > 0 ? (succes / rapports.length * 100).toFixed(0) : 'N/A';
    log(`Hermès Veilleur : ${rapports.length} rapports, ${taux}% succès`);
    await cycleHermes('analyse-performance', `Taux succès: ${taux}% sur ${rapports.length} rapports`, true);
  } catch {}
}

// ── NOTIFICATIONS ──────────────────────────────────────

async function notifierTelegram(message) {
  try {
    const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
    const token = tools.telegram_bot_token;
    if (!token) { log('Token Telegram manquant'); return false; }
    const body = {
      chat_id: '6408961089',
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    };
    await requete(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, body);
    return true;
  } catch (e) { log('Erreur Telegram: ' + e.message); return false; }
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── MAIN ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'full';

  log('Démarrage Veilleur — mode: ' + mode);

  if (mode === 'analyse' && args[1]) {
    const resultat = await analyserConcurrent(args.slice(1).join(' '));
    console.log(resultat);
    return { analyse: resultat };
  }

  const result = await genererRapport(mode);

  // Stocker dans l'état et logger Hermès
  await cycleHermes(
    mode === 'full' ? 'veille-complete' : mode === 'local' ? 'veille-local' : 'veille-national',
    `Rapport généré: ${result.sourcesLocal?.length || 0} sources locales, ${result.sourcesNational?.length || 0} sources nationales`,
    true
  );

  console.log(JSON.stringify({
    success: true,
    mode,
    sourcesLocales: result.sourcesLocal?.filter(s => s.resultats.length > 0).length || 0,
    sourcesNationales: result.sourcesNational?.filter(s => s.resultats.length > 0).length || 0,
    analyseLocale: result.analyseLocal?.analyse?.slice(0, 100) || null,
    analyseNationale: result.analyseNational?.analyse?.slice(0, 100) || null,
  }));

  return result;
}

if (require.main === module) {
  main().catch(e => {
    log('Fatal: ' + e.message);
    console.error(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = {
  main,
  genererRapport,
  analyserConcurrent,
  hermesAnalyserEtAjuster,
  SOURCES_LOCALES,
  SOURCES_NATIONALES,
};
