#!/usr/bin/env node
/**
 * enrichisseur.js — Enrichit les prospects Apify avec email + réseaux sociaux
 *
 * Étape 2.5 du pipeline Prospecteur :
 * - Scrape le site web du prospect pour l'email
 * - Cherche Instagram/Facebook via recherche DuckDuckGo
 * - Met à jour le score enrichi
 * - Stocke dans Supabase (colonnes instagram_url, facebook_url, score_enrichi)
 *
 * Usage :
 *   node enrichisseur.js <lead_id|all>       (enrichit un lead ou tous les non-enrichis)
 *   node enrichisseur.js --batch <fichier>    (fichier JSON avec tableau de prospects bruts)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const LOG_PATH = '/data/.openclaw/plugin-skills/prospecteur/enrichisseur.log';
const CREDS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';

// ─── Logger ─────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] [enrichisseur] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
}

// ─── HTTPS helpers ───────────────────────────
function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AminyoOS/1.0; +https://aminyo.fr)' },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', d => data += d.toString('utf8'));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── 1. Email depuis site web ─────────────────
async function findEmailFromWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const cleanUrl = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
    const home = await fetchUrl(cleanUrl, 15000);
    if (!home || !home.data) return null;
    const html = home.data;

    // Chercher mailto: dans les liens
    const mailtoMatch = html.match(/href="mailto:([^"]+)"/i);
    if (mailtoMatch && !mailtoMatch[1].includes('noreply') && !mailtoMatch[1].includes('no-reply')) {
      return mailtoMatch[1].trim();
    }

    // Chercher email en texte dans la page
    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatch) {
      const valid = emailMatch.find(e =>
        !e.includes('noreply') && !e.includes('no-reply') &&
        !e.includes('example.com') && !e.includes('domain.com') &&
        !e.includes('@sentry') && e.split('@')[1] && !e.split('@')[1].includes('dev')
      );
      if (valid) return valid.trim();
    }

    return null;
  } catch { return null; }
}

// ─── 2. Trouver le site web depuis le nom de l'entreprise ──
async function findWebsite(companyName) {
  if (!companyName || !companyName.trim()) return null;
  const slug = companyName.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const variants = [
    `https://www.${slug}.fr`,
    `https://${slug}.fr`,
    `https://www.${slug}.com`,
    `https://${slug}.com`,
  ];
  for (const url of variants) {
    const res = await fetchUrl(url, 3000);
    if (res && res.status && res.status >= 200 && res.status < 400) return url;
  }
  return null;
}

// ─── 3. Réseaux sociaux — recherche directe ─────
async function findSocialMedia(companyName, opts = {}) {
  const result = { instagram: null, facebook: null };
  if (!companyName || !companyName.trim()) return result;
  
  const name = companyName.trim();
  
  // Nettoyer le nom pour en faire un slug de compte social
  const searchName = name.toLowerCase()
    .replace(/^(le|la|l'|les|the) /i, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
    .slice(0, 30);
  
  if (searchName.length >= 3) {
    // Essayer nom direct sur Instagram
    const instaUrl = `https://www.instagram.com/${searchName}/`;
    const instaRes = await fetchUrl(instaUrl, 5000);
    if (instaRes && instaRes.status === 200 && !instaRes.data.includes('Page Not Found') && !instaRes.data.includes('login')) {
      result.instagram = instaUrl;
    }
    
    // Essayer nom direct sur Facebook
    const fbUrl = `https://www.facebook.com/${searchName}`;
    const fbRes = await fetchUrl(fbUrl, 5000);
    if (fbRes && fbRes.status && fbRes.status >= 200 && fbRes.status < 400) {
      result.facebook = fbUrl;
    }
  }

  // Fallback Apify Instagram Scraper si Instagram pas trouvé et que le lead a un bon score
  if (!result.instagram && opts.useApify && opts.apifyToken && opts.aiScore >= 70) {
    log(`  🚀 Apify Instagram fallback pour « ${name} » (score ≥70)`);
    try {
      const apifyResult = await findInstagramViaApify(name, opts.apifyToken);
      if (apifyResult) {
        result.instagram = apifyResult;
        log(`  📸 Instagram trouvé via Apify: ${apifyResult}`);
      } else {
        log(`  📸 Apify Instagram: pas trouvé pour « ${name} »`);
      }
    } catch (e) {
      log(`  ⚠️ Erreur Apify Instagram: ${e.message}`);
    }
  }

  return result;
}

// ─── 3b. Apify Instagram Profile Scraper (fallback payant ~$0.001/recherche) ────
async function findInstagramViaApify(companyName, apifyToken) {
  // Apify API: lancer l'acteur Instagram Profile Scraper
  // Documentation: https://apify.com/apify/instagram-profile-scraper
  const body = JSON.stringify({
    usernames: [
      companyName.toLowerCase()
        .replace(/^(le |la |l'|les |the )/i, '')
        .replace(/[^a-z0-9]/g, '')
        .trim()
        .slice(0, 30)
    ],
    resultsLimit: 1,
    proxyConfig: { useApifyProxy: true }
  });

  // Lancer l'acteur
  const run = await apifyPost(apifyToken, 'https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs', body);
  if (!run || !run.data || !run.data.id) return null;

  // Attendre la fin (timeout 15s)
  const runId = run.data.id;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await apifyGet(apifyToken, `https://api.apify.com/v2/actor-runs/${runId}`);
    if (!statusRes || !statusRes.data) continue;
    if (statusRes.data.status === 'SUCCEEDED') {
      // Récupérer les résultats
      const datasetRes = await apifyGet(apifyToken, `https://api.apify.com/v2/actor-runs/${runId}/dataset/items`);
      // dataset/items retourne un ARRAY directement (pas un objet avec .data)
      const items = Array.isArray(datasetRes) ? datasetRes : (datasetRes && datasetRes.data);
      if (items && items.length > 0) {
        const username = items[0].username || items[0].fullName || null;
        if (username) {
          return `https://www.instagram.com/${username}/`;
        }
      }
      return null;
    } else if (statusRes.data.status === 'FAILED') {
      log(`  ⚠️ Apify Instagram run failed: ${(statusRes.data.errorMessage || '').slice(0, 100)}`);
      return null;
    }
  }
  
  // Timeout — annuler le run pour éviter des coûts inutiles
  await apifyPost(apifyToken, `https://api.apify.com/v2/actor-runs/${runId}/abort`, '');
  return null;
}

function apifyPost(token, url, body) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function apifyGet(token, url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── (DuckDuckGo supprimé — non fiable, remplacé par détection directe de nom de compte ci-dessus)

// ─── 3. Score enrichi ──────────────────────────
function calculerScoreEnrichi(email, instagram, facebook) {
  let score = 0;
  if (email) score += 10;
  if (instagram) score += 5;
  if (facebook) score += 5;
  return score;
}

// ─── 4. Enrichir un lead existant ──────────────
async function enrichirLead(supabase, lead, dryRun = false) {
  const { id, company, website: websiteInput, email: emailExistant } = lead;
  let logMsg = `📋 Enrichissement: ${company || id || '?'}`;
  
  // Trouver le site web si pas fourni (via nom entreprise)
  let website = websiteInput;
  if (!website && company) {
    website = await findWebsite(company);
    if (website) logMsg += ` 🌐 site: ${website}`;
  }
  
  // Email depuis site web
  let email = emailExistant;
  if (!email && website) {
    email = await findEmailFromWebsite(website);
    logMsg += email ? ` 📧 trouvé: ${email}` : ' 📧 non trouvé';
  } else if (!email && !website) {
    logMsg += ' 📧 pas de site web';
  } else if (email) {
    logMsg += ` 📧 déjà présent: ${email}`;
  }

  // Récupérer le token Apify depuis les credentials
  let apifyToken = null;
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    apifyToken = creds.apify_api_token || creds.APIFY_TOKEN || null;
  } catch {}

  // Instagram/Facebook (avec fallback Apify pour les gros scores)
  const social = await findSocialMedia(company, {
    useApify: true,
    apifyToken,
    aiScore: lead.ai_score || 0
  });
  logMsg += social.instagram ? ' 📸 insta' : ' 📸 non trouvé';
  logMsg += social.facebook ? ' 👍 fb' : ' 👍 non trouvé';

  // Score enrichi
  const scoreEnrichi = calculerScoreEnrichi(email, social.instagram, social.facebook);

  log(logMsg);

  if (!dryRun && supabase) {
    const update = { score_enrichi: scoreEnrichi };
    if (email && !emailExistant) update.email = email;
    if (website && !websiteInput) update.website_url = website;
    if (social.instagram) update.instagram_url = social.instagram;
    if (social.facebook) update.facebook_url = social.facebook;

    const { error } = await supabase
      .from('leads')
      .update(update)
      .eq('id', id);

    if (error) log(`❌ Erreur MAJ lead ${id}: ${error.message}`);
    else log(`✅ Lead ${id} enrichi (score: ${scoreEnrichi})`);
  }

  return { email, instagram: social.instagram, facebook: social.facebook, score: scoreEnrichi };
}

// ─── 5. Enrichir depuis un batch Apify brut ────
async function enrichirBatch(supabase, prospectsBruts, dryRun = false) {
  let apifyToken = null;
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    apifyToken = creds.apify_api_token || creds.APIFY_TOKEN || null;
  } catch {}

  const enrichis = [];
  for (const p of prospectsBruts) {
    const website = p.website || p.website_url || '';
    const email = p.email || await findEmailFromWebsite(website);
    const social = await findSocialMedia(p.company || p.name, {
      useApify: true,
      apifyToken,
      aiScore: p.ai_score || 0
    });
    const scoreEnrichi = calculerScoreEnrichi(email, social.instagram, social.facebook);

    enrichis.push({
      ...p,
      email: email || null,
      instagram_url: social.instagram,
      facebook_url: social.facebook,
      score_enrichi: scoreEnrichi
    });

    const company = p.company || p.name || '?';
    log(`📋 ${company}: 📧 ${email || '❌'} 📸 ${social.instagram || '❌'} 👍 ${social.facebook || '❌'} score:${scoreEnrichi}`);
  }
  return enrichis;
}

// ─── CLI ────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run') || args.includes('dry-run');
    
    if (!fs.existsSync(CREDS_PATH)) {
      log('❌ tools.json introuvable');
      process.exit(1);
    }
    const tools = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    const supabase = createClient(tools.supabase_url, tools.supabase_service_role_key);

    // Mode batch depuis fichier JSON
    const batchIdx = args.indexOf('--batch');
    if (batchIdx !== -1 && args[batchIdx + 1]) {
      const filePath = args[batchIdx + 1];
      if (!fs.existsSync(filePath)) { log(`❌ Fichier introuvable: ${filePath}`); process.exit(1); }
      const prospects = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const results = await enrichirBatch(supabase, Array.isArray(prospects) ? prospects : prospects.bruts || [], dryRun);
      console.log(JSON.stringify(results, null, 2));
      process.exit(0);
    }

    // Mode all : enrichir tous les leads sans score_enrichi
    if (args[0] === 'all' || args[0] === '--all') {
      log('🔍 Enrichissement de tous les leads non enrichis...');
      const { data: leads, error } = await supabase
        .from('leads')
        .select('id, company, website, email, instagram_url, facebook_url, score_enrichi')
        .or('score_enrichi.is.null,score_enrichi.eq.0')
        .limit(50);

      if (error) { log(`❌ Erreur Supabase: ${error.message}`); process.exit(1); }
      if (!leads || leads.length === 0) { log('✅ Aucun lead à enrichir'); process.exit(0); }

      log(`📊 ${leads.length} leads à enrichir`);
      for (const lead of leads) {
        await enrichirLead(supabase, lead, dryRun);
        // Pause 1s entre chaque pour éviter les rate limits
        await new Promise(r => setTimeout(r, 1000));
      }
      log('✅ Enrichissement terminé');
      process.exit(0);
    }

    // Mode single : enrichir un lead spécifique par email ou id
    if (args[0]) {
      const identifiant = args[0];
      const { data: leads, error } = await supabase
        .from('leads')
        .select('id, company, website, email, instagram_url, facebook_url, score_enrichi')
        .or(`id.eq.${identifiant},email.eq.${identifiant}`)
        .limit(1);

      if (error) { log(`❌ Erreur: ${error.message}`); process.exit(1); }
      if (!leads || leads.length === 0) { log(`❌ Lead non trouvé: ${identifiant}`); process.exit(0); }

      await enrichirLead(supabase, leads[0], dryRun);
      process.exit(0);
    }

    // Mode help
    console.log(`
Usage:
  node enrichisseur.js all                Enrichir tous les leads non enrichis
  node enrichisseur.js <id|email>         Enrichir un lead spécifique
  node enrichisseur.js --batch <fichier>  Enrichir un batch depuis JSON
  node enrichisseur.js all --dry-run      Simuler sans écrire
    `);
  })();
}

module.exports = { enrichirLead, enrichirBatch, findEmailFromWebsite, findWebsite, findSocialMedia, findInstagramViaApify, calculerScoreEnrichi };
