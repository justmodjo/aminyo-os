#!/usr/bin/env node
/**
 * journaliste.js — Agent de contenu SEO pour Aminyo
 *
 * Génère des articles SEO premium pour aminyo.fr :
 * 1. Recherche mots-clés pertinents (agence web Normandie)
 * 2. Rédaction via Claude Sonnet (qualité premium)
 * 3. Vérification : originalité, cohérence, représentation Aminyo
 * 4. Soumission Telegram pour validation Amine
 * 5. Push sur justmodjo/amodjo-v1 uniquement après approbation
 *
 * Cycle Hermès : Action → Logger → Learn → Crystallize
 *
 * Usage :
 *   node journaliste.js                   # Cycle complet
 *   node journaliste.js --generate        # Générer un article (sans push)
 *   node journaliste.js --approve <id>    # Valider et pusher
 *   node journaliste.js --test            # Test API Claude
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOG_PATH = '/data/.openclaw/plugin-skills/journaliste/journaliste.log';
const STATE_PATH = '/data/.openclaw/plugin-skills/journaliste/etat.json';
const DRAFTS_DIR = '/data/.openclaw/plugin-skills/journaliste/brouillons';
const CREDS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const TELEGRAM_CHAT_ID = '6408961089';
const REPO = 'justmodjo/amodjo-v1';
const BRANCH = 'main';

// ─── Utilitaires ──────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] [journaliste] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function chargeCreds() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

function requete(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(url, { ...options, timeout: 60000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data.slice(0, 500), status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function chargerEtat() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {}
  return {
    derniereGeneration: null, articlesGeneres: 0, articlesApprouves: 0,
    articlesPushes: 0, sujetsUtilises: [], prochaineSuggestion: null,
    compteurNiveau: { local: 0, national: 0 }, prochainNiveau: 'local',
  };
}

function sauverEtat(etat) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(etat, null, 2));
  } catch (e) { log(`Sauvegarde etat: ${e.message?.slice(0,60)}`); }
}

// ─── Bibliothèque de sujets SEO (deux niveaux) ─
// Priorité 1 : Local Normandie (villes : Le Havre, Rouen, Caen, Évreux, Cherbourg)
// Priorité 2 : National France (positionne Aminyo comme agence française accessible à distance)
// Alternance : 2 locaux pour 1 national

const BANQUE_LOCALE = [
  { theme: 'agence-web-havre', niveau: 'local', titre: 'Pourquoi choisir une agence web au Havre pour votre PME ?', motsCles: ['agence web Le Havre', 'création site internet Le Havre', 'agence web Normandie', 'site internet PME'] },
  { theme: 'agence-web-rouen', niveau: 'local', titre: 'Création site web à Rouen : les clés pour séduire vos clients locaux', motsCles: ['agence web Rouen', 'création site internet Rouen', 'site web Rouen', 'agence web Normandie'] },
  { theme: 'agence-web-caen', niveau: 'local', titre: 'Site professionnel à Caen : comment l\'agence web Aminyo accompagne les PME normandes', motsCles: ['agence web Caen', 'création site Caen', 'site web professionnel Caen', 'agence web Normandie'] },
  { theme: 'agence-web-evrec', niveau: 'local', titre: 'Développement web à Évreux : donnez une vitrine numérique à votre entreprise', motsCles: ['agence web Évreux', 'création site Évreux', 'site internet Évreux', 'développement web Normandie'] },
  { theme: 'agence-web-cherbourg', niveau: 'local', titre: 'Agence web à Cherbourg : des sites premium pour les entreprises de la Manche', motsCles: ['agence web Cherbourg', 'création site Cherbourg', 'site internet Manche', 'agence web Normandie'] },
  { theme: 'seo-local-normandie', niveau: 'local', titre: 'SEO local en Normandie : comment être visible sur Google dans votre ville', motsCles: ['SEO local Normandie', 'référencement local Normandie', 'Google My Business Le Havre', 'visibilité locale'] },
  { theme: 'google-my-business-normandie', niveau: 'local', titre: 'Google My Business : le guide complet pour les artisans normands', motsCles: ['Google My Business Normandie', 'fiche Google artisan Normandie', 'avis clients Le Havre'] },
  { theme: 'artisanat-numerique-normandie', niveau: 'local', titre: 'Artisan en Normandie : 3 raisons de passer au numérique dès maintenant', motsCles: ['artisan numérique Normandie', 'transformation digitale artisan Le Havre', 'site internet artisan'] },
  { theme: 'e-commerce-artisanat', niveau: 'local', titre: 'De l\'atelier au web : comment les artisans normands peuvent vendre en ligne', motsCles: ['vente en ligne artisan Normandie', 'e-commerce artisanat', 'boutique en ligne Normandie'] },
  { theme: 'temojganges-normands', niveau: 'local', titre: 'Témoignages : ces entreprises normandes qui ont doublé leur chiffre grâce à leur site', motsCles: ['témoignages artisans Normandie', 'succès site web Normandie', 'retour expérience numérique Normandie'] },
  { theme: 'agglomeration-havraise', niveau: 'local', titre: 'Comment dominer la recherche locale dans l\'agglomération havraise ?', motsCles: ['référencement Le Havre', 'SEO local agglomération', 'search local Le Havre', 'agence web Le Havre'] },
];

const BANQUE_NATIONALE = [
  { theme: 'site-vitrine-vs-ecommerce', niveau: 'national', titre: 'Site vitrine vs site e-commerce : que choisir pour votre activité ?', motsCles: ['site vitrine', 'site e-commerce', 'création site web', 'agence web France'] },
  { theme: 'erreurs-premier-site', niveau: 'national', titre: 'Les 5 erreurs à éviter quand on crée son premier site web en 2026', motsCles: ['création site web débutant', 'erreurs site internet', 'conseils site web', 'agence web conseils'] },
  { theme: 'cout-site-professionnel', niveau: 'national', titre: 'Combien coûte un site professionnel pour une PME en 2026 ?', motsCles: ['prix création site web', 'budget site professionnel', 'tarif agence web', 'combien coûte un site'] },
  { theme: 'design-web-premium', niveau: 'national', titre: 'Design web premium : ce qui fait la différence pour un site professionnel', motsCles: ['design web premium', 'UX design', 'site professionnel design', 'agence web design'] },
  { theme: 'mobile-first', niveau: 'national', titre: 'Mobile first : pourquoi votre site doit être pensé pour le smartphone en 2026', motsCles: ['site mobile first', 'responsive design', 'site adapté mobile', 'agence web mobile'] },
  { theme: 'accessibilite-web', niveau: 'national', titre: 'Accessibilité web : un atout SEO et une obligation légale pour votre site', motsCles: ['accessibilité web', 'RGAA', 'SEO technique', 'site accessible'] },
  { theme: 'freelance-vs-agence', niveau: 'national', titre: 'Freelance ou agence web : lequel choisir pour votre projet digital ?', motsCles: ['freelance vs agence web', 'choisir agence web', 'agence web France', 'prestation web'] },
  { theme: 'refonte-site', niveau: 'national', titre: 'Refonte de site web : quand et pourquoi faut-il moderniser sa présence en ligne ?', motsCles: ['refonte site web', 'moderniser site internet', 'nouveau site web', 'agence web refonte'] },
  { theme: 'ia-et-creation-web', niveau: 'national', titre: 'IA et création web en 2026 : ce qui change vraiment pour les PME', motsCles: ['IA création site web', 'intelligence artificielle web', 'site internet IA', 'agence web 2026'] },
  { theme: 'choisir-domaine-hebergement', niveau: 'national', titre: 'Nom de domaine et hébergement : le guide pour bien choisir en 2026', motsCles: ['nom de domaine', 'hébergement web', 'choisir hébergeur', 'création site pro'] },
  { theme: 'seo-technique', niveau: 'national', titre: 'SEO technique pour les nuls : les bases pour bien référencer votre site', motsCles: ['SEO technique', 'référencement naturel', 'optimisation SEO', 'agence SEO France'] },
  { theme: 'site-eco-responsable', niveau: 'national', titre: 'Site web éco-responsable : comment allier performance et écologie ?', motsCles: ['site éco-responsable', 'web écologique', 'site web vert', 'agence web durable'] },
];

function getSujetsPourNiveau(niveau, sujetsDejaFaits = []) {
  const banque = niveau === 'local' ? BANQUE_LOCALE : BANQUE_NATIONALE;
  const dispo = banque.filter(s => !sujetsDejaFaits.includes(s.theme) && !sujetsDejaFaits.includes(s.titre));
  if (dispo.length === 0) {
    // Cycle épuisé : on recommence pour ce niveau
    return banque[Math.floor(Math.random() * banque.length)];
  }
  return dispo[Math.floor(Math.random() * dispo.length)];
}

function determinerProchainNiveau(etat) {
  // Règle : 2 locaux pour 1 national
  // On suit compteurNiveau.local et compteurNiveau.national
  const localCount = etat.compteurNiveau?.local || 0;
  const nationalCount = etat.compteurNiveau?.national || 0;
  
  // Si on a fait 2 locaux de suite → national
  // Sinon → local
  // Sauf si c'est le tout premier article (local)
  if (localCount + nationalCount === 0) return 'local';
  
  // On regarde les 2 derniers niveaux dans sujetsUtilises
  const recents = (etat.sujetsUtilises || []).slice(-2).map(s => {
    const localTheme = BANQUE_LOCALE.find(b => b.theme === s || b.titre === s);
    return localTheme ? 'local' : 'national';
  });
  
  const derniersLocaux = recents.filter(n => n === 'local').length;
  if (derniersLocaux >= 2) return 'national';
  return 'local';
}

// ─── Recherche de mots-clés (via Google Trends-like ou fallback structuré) ──
async function rechercherMotsCles(theme) {
  const creds = chargeCreds();
  
  // Fallback : on enrichit les mots-clés de base avec des variantes
  const motsClesBase = theme.motsCles || [theme.theme];
  const enrichis = [];
  
  for (const mc of motsClesBase) {
    enrichis.push(mc);
    enrichis.push(mc + ' 2026');
    enrichis.push(mc + ' prix');
    enrichis.push(mc + ' avis');
    enrichis.push(mc.replace('Le Havre', 'Normandie'));
    enrichis.push(mc.replace('Normandie', 'Le Havre'));
  }
  
  // Déduplication
  const uniques = [...new Set(enrichis)];
  log(`${uniques.length} mots-clés générés pour "${theme.theme}"`);
  return uniques;
}

// ─── Rédaction via Claude Sonnet ────────────────
async function redigerArticle(sujet, motsCles) {
  const creds = chargeCreds();
  const apiKey = creds.anthropic_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === '__process_env_ANTHROPIC_API_KEY__') {
    log('Clé Anthropic manquante');
    return null;
  }

  const niveau = sujet.niveau || 'local';

  let cibleGeo, consigneGeo;
  if (niveau === 'local') {
    cibleGeo = "artisans et PME en Normandie (Le Havre, Rouen, Caen, Evreux, Cherbourg)";
    consigneGeo = "- Cible : " + cibleGeo + "\n- Localisation : mentionne la Normandie et la/les ville(s) concernee(s) naturellement\n- Marque : Aminyo \u2014 agence web premium au Havre (contact@aminyo.fr)\n- Ancrage local fort : montre qu'on connait le territoire normand";
  } else {
    cibleGeo = "artisans et PME partout en France (accessible a distance)";
    consigneGeo = "- Cible : " + cibleGeo + "\n- Localisation : NE mentionne AUCUNE ville specifique. Parle de la France en general.\n- Marque : Aminyo \u2014 agence web francaise premium, disponible a distance (contact@aminyo.fr)\n- Positionnement : agence web francaise de qualite, pas de barriere geographique";
  }

  const prompt = `Tu es un redacteur SEO premium pour ${sujet.titre}.

Genere un article de blog complet et professionnel en francais.

**Sujet :** ${sujet.titre}
**Niveau :** ${niveau}
**Mots-cles a integrer naturellement :** ${motsCles.join(', ')}

**Consignes :**
- Ton : professionnel, humain, direct
- Longueur : 800-1200 mots
- Structure : H1 (titre), H2, H3, paragraphes fluides, liste a puces si pertinent
${consigneGeo}
- SEO : mots-cles integres naturellement, pas de bourrage
- Originalite : contenu 100% unique, pas de plagiat
- Appel a l'action : inviter a contacter Aminyo pour un devis

**Format de sortie :**
\`\`\`
TITRE: [titre SEO avec mot-cle principal]
META: [meta-description 150-160 caracteres]
SLUG: [slug-url]
CONTENU:
[article complet en markdown]
\`\`\``;

  try {
    const result = await requete('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = result?.content?.[0]?.text;
    if (!content) {
      log("Claude n'a pas retourné de contenu");
      return null;
    }
    
    log(`Article rédigé : ${content.split('\n')[0]?.replace('TITRE:','')?.trim() || sujet.titre}`);
    return content;
  } catch (e) {
    log(`Erreur Claude: ${e.message?.slice(0,100)}`);
    return null;
  }
}

// ─── Vérification qualité (adaptée au niveau) ──
function verifierQualite(article, sujet) {
  const checks = [];
  const niveau = sujet.niveau || 'local';
  
  // 1. Cohérence : titre présent
  const aTitre = article.includes('TITRE:');
  checks.push({ nom: 'titre', ok: aTitre });
  
  // 2. Meta description
  const aMeta = article.includes('META:');
  checks.push({ nom: 'meta', ok: aMeta });
  
  // 3. Contenu minimum (800 mots)
  const mots = article.replace(/```/g, '').split(/\s+/).length;
  checks.push({ nom: 'longueur', ok: mots >= 800, detail: `${mots} mots` });
  
  // 4. Présence d'Aminyo
  const aAminyo = article.toLowerCase().includes('aminyo');
  checks.push({ nom: 'marque', ok: aAminyo });
  
  // 5. Présence de contact
  const aContact = article.includes('contact@aminyo.fr');
  checks.push({ nom: 'contact', ok: aContact });
  
  // 6. Localisation (adaptée au niveau)
  let aLocalisation = false;
  if (niveau === 'local') {
    aLocalisation = article.toLowerCase().includes('normandie') ||
      article.toLowerCase().includes('le havre') ||
      article.toLowerCase().includes('rouen') ||
      article.toLowerCase().includes('caen') ||
      article.toLowerCase().includes('évreux') ||
      article.toLowerCase().includes('cherbourg');
  } else {
    // National : ne doit PAS mentionner de ville spécifique
    // mais doit mentionner la France
    aLocalisation = article.toLowerCase().includes('france') ||
      article.toLowerCase().includes('français');
  }
  checks.push({ nom: 'localisation', ok: aLocalisation });
  
  // 7. Mots-clés intégrés
  const motsClesTrouves = (sujet.motsCles || []).filter(mc =>
    article.toLowerCase().includes(mc.toLowerCase())
  ).length;
  const ratioMC = (sujet.motsCles?.length || 1) > 0 ? motsClesTrouves / sujet.motsCles.length : 0;
  checks.push({ nom: 'mots-cles', ok: ratioMC >= 0.5, detail: `${motsClesTrouves}/${sujet.motsCles.length}` });
  
  // Synthèse
  const okCount = checks.filter(c => c.ok).length;
  const ok = okCount >= 5; // Au moins 5/7 checks
  const erreurs = checks.filter(c => !c.ok).map(c => `${c.nom}${c.detail ? ' ('+c.detail+')' : ''}`);
  
  log(`Qualité : ${okCount}/7 checks OK [${niveau}]`);
  if (!ok) log(`Problèmes : ${erreurs.join(', ')}`);
  
  return { ok, checks, okCount, erreurs, mots };
}

// ─── Génération ID d'article ──────────────────
function genererId(sujet) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = (sujet.titre || 'article')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `ART-${date}-${slug}`;
}

// ─── Sauvegarde brouillon ──────────────────────
function sauverBrouillon(articleId, article, sujet, motsCles, qualite) {
  try {
    if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    
    const draft = {
      id: articleId,
      date: new Date().toISOString(),
      sujet: { theme: sujet.theme, niveau: sujet.niveau, titre: sujet.titre, motsCles: sujet.motsCles },
      motsClesUtilises: motsCles,
      qualite: { ok: qualite.ok, checks: qualite.checks, mots: qualite.mots },
      article,
      statut: 'en_attente_validation',
    };
    
    fs.writeFileSync(path.join(DRAFTS_DIR, `${articleId}.json`), JSON.stringify(draft, null, 2));
    log(`Brouillon sauvegardé : ${articleId}`);
    return true;
  } catch (e) {
    log(`Erreur sauvegarde brouillon: ${e.message?.slice(0,60)}`);
    return false;
  }
}

// ─── Envoi sur Telegram pour validation ────────
async function soumettreValidation(articleId, article, sujet, qualite) {
  const creds = chargeCreds();
  const bot = creds.telegram_bot_token;
  if (!bot) { log('Telegram token manquant'); return false; }

  // Extraire les infos
  const titreMatch = article.match(/TITRE:\s*(.+)/);
  const metaMatch = article.match(/META:\s*(.+)/);
  const slugMatch = article.match(/SLUG:\s*(.+)/);
  const titre = titreMatch?.[1]?.trim() || sujet.titre;
  const meta = metaMatch?.[1]?.trim() || '';
  const slug = slugMatch?.[1]?.trim() || '';
  
  // Extraire le contenu (après CONTENU:)
  const contenuMatch = article.match(/CONTENU:\s*([\s\S]+)/);
  const contenu = contenuMatch?.[1]?.trim()?.slice(0, 2000) || '';

  const niveau = sujet.niveau || 'local';
  const niveauBadge = niveau === 'local' ? '📍 LOCAL Normandie' : '🌍 NATIONAL France';

  let msg = `📝 <b>Nouvel article généré</b>\n<b>${niveauBadge}</b>\n\n`;
  msg += `<b>ID :</b> ${articleId}\n`;
  msg += `<b>Titre :</b> ${titre}\n`;
  msg += `<b>Slug :</b> ${slug}\n`;
  msg += `<b>Meta :</b> ${meta?.slice(0, 160)}\n\n`;
  
  msg += `<b>Qualité :</b> ${qualite.okCount}/7 ✅\n`;
  msg += `<b>Mots :</b> ${qualite.mots}\n`;
  if (qualite.erreurs.length > 0) {
    msg += `<b>⚠️ Points faibles :</b> ${qualite.erreurs.join(', ')}\n`;
  }
  msg += `<b>Mots-clés :</b> ${(sujet.motsCles||[]).join(', ')}\n\n`;
  msg += `<b>Aperçu :</b>\n${contenu?.slice(0, 1500)}...\n\n`;
  msg += `<i>Réponds avec "✅" pour approuver et pusher sur ${REPO}</i>`;

  try {
    await requete(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true });
    log(`Article ${articleId} soumis pour validation Telegram`);
    return true;
  } catch (e) {
    log(`Telegram: ${e.message?.slice(0,60)}`);
    return false;
  }
}

// ─── Push sur justmodjo/amodjo-v1 ─────────────
async function pusherArticle(articleId) {
  const creds = chargeCreds();
  const token = creds.mino_github_token;
  if (!token) { log('GitHub token manquant'); return false; }

  const draftPath = path.join(DRAFTS_DIR, `${articleId}.json`);
  if (!fs.existsSync(draftPath)) { log(`Brouillon ${articleId} introuvable`); return false; }
  
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const article = draft.article;
  
  // Extraire slug et contenu
  const slugMatch = article.match(/SLUG:\s*(.+)/);
  const titreMatch = article.match(/TITRE:\s*(.+)/);
  const contenuMatch = article.match(/CONTENU:\s*([\s\S]+)/);
  
  const slug = slugMatch?.[1]?.trim() || `article-${articleId.toLowerCase()}`;
  const titre = titreMatch?.[1]?.trim() || 'Article Aminyo';
  const contenu = contenuMatch?.[1]?.trim() || article;
  
  // Chemin dans le repo : content/blog/YYYY/MM/slug.md
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const filePath = `content/blog/${year}/${month}/${slug}.md`;
  
  // Contenu au format Markdown
  const meta = article.match(/META:\s*(.+)/);
  const markdown = `---
title: "${titre}"
date: "${now.toISOString().split('T')[0]}"
description: "${meta?.[1]?.trim() || ''}"
slug: "${slug}"
tags:
${(draft.sujet.motsCles||[]).slice(0,5).map(mc => `  - "${mc}"`).join('\n')}
draft: false
---

${contenu}
`;
  
  // Encoder en base64
  const buffer = Buffer.from(markdown, 'utf-8');
  const contentEncoded = buffer.toString('base64');
  
  // Vérifier si le fichier existe déjà (pour obtenir le sha)
  let sha = null;
  try {
    const check = await requete(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Aminyo-Journaliste',
      },
    });
    if (check.sha) sha = check.sha;
  } catch {} // Nouveau fichier → pas de sha
  
  // Push via GitHub Contents API
  const pushPayload = {
    message: `📝 Article: ${titre} (via Journaliste Aminyo)`,
    content: contentEncoded,
    branch: BRANCH,
  };
  if (sha) pushPayload.sha = sha;
  
  try {
    const result = await requete(`https://api.github.com/repos/${REPO}/contents/${filePath}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Aminyo-Journaliste',
        'Content-Type': 'application/json',
      },
    }, pushPayload);
    
    if (result.content?.sha || result.commit?.sha) {
      log(`Article pusher : ${REPO}/${filePath}`);
      draft.statut = 'push';
      draft.pushDate = new Date().toISOString();
      draft.pushUrl = `https://github.com/${REPO}/blob/${BRANCH}/${filePath}`;
      fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
      return true;
    }
    
    log(`Push GitHub: réponse inattendue`);
    return false;
  } catch (e) {
    log(`Erreur push GitHub: ${e.message?.slice(0,100)}`);
    return false;
  }
}

// ─── Notifier approbation sur Telegram ────────
async function notifierApprobation(articleId) {
  const creds = chargeCreds();
  const bot = creds.telegram_bot_token;
  if (!bot) return false;
  
  try {
    await requete(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, {
      chat_id: TELEGRAM_CHAT_ID,
      text: `✅ Article ${articleId} pusher sur ${REPO}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch { return false; }
}

// ─── Bus inter-agents ──────────────────────────
function chargerBus() {
  try { const p = '/data/.openclaw/lib/message-bus.js'; if (fs.existsSync(p)) return require(p); } catch {}
  return null;
}
function chargerLogger() {
  try { const p = '/data/.openclaw/lib/memory-logger.js'; if (fs.existsSync(p)) return require(p); } catch {}
  return null;
}
function chargerLearn() {
  try { const p = '/data/.openclaw/lib/learning-orchestrator.js'; if (fs.existsSync(p)) return require(p); } catch {}
  return null;
}
function chargerCrystal() {
  try { const p = '/data/.openclaw/lib/crystallizer.js'; if (fs.existsSync(p)) return require(p); } catch {}
  return null;
}

// ─── Cycle Hermès ──────────────────────────────
async function cycleHermes(action, details, success) {
  try {
    const logger = chargerLogger();
    const learn = chargerLearn();
    const crystal = chargerCrystal();
    const d = { resultat: details, success };
    if (logger) await logger.action('Journaliste', d);
    if (learn) await learn.run('Journaliste', d);
    if (crystal && (action === 'article-publie' || action === 'erreur-generation')) {
      const lecons = await crystal.collect('Journaliste');
      if (lecons && lecons.length > 0) log(`${lecons.length} leçons cristallisées`);
    }
    log(`Hermès: ${action} ${success ? 'OK' : 'FAIL'}`);
  } catch (e) { log(`Hermès: ${e.message?.slice(0,60)}`); }
}

// ─── Génération complète (avec alternance 2 local / 1 national) ─
async function genererArticle(etat) {
  // 1. Déterminer le niveau (local ou national)
  const niveau = determinerProchainNiveau(etat);
  log(`Niveau déterminé : ${niveau}`);
  
  // 2. Choisir un sujet dans la bonne banque
  const sujet = getSujetsPourNiveau(niveau, etat.sujetsUtilises || []);
  sujet.niveau = niveau;
  log(`Sujet choisi : ${sujet.titre} [${niveau}]`);
  
  // 3. Rechercher les mots-clés
  const motsCles = await rechercherMotsCles(sujet);
  
  // 4. Rédiger via Claude Sonnet
  log('Rédaction via Claude Sonnet...');
  const article = await redigerArticle(sujet, motsCles);
  if (!article) {
    await cycleHermes('erreur-generation', `Échec rédaction niveau ${niveau}: ${sujet.titre}`, false);
    return null;
  }
  
  // 5. Vérifier la qualité
  const qualite = verifierQualite(article, sujet);
  
  // 6. Sauvegarder le brouillon
  const articleId = genererId(sujet);
  sauverBrouillon(articleId, article, sujet, motsCles, qualite);
  
  // 7. Soumettre pour validation Telegram
  await soumettreValidation(articleId, article, sujet, qualite);
  
  // 8. Mettre à jour l'état + compteur niveau
  etat.derniereGeneration = new Date().toISOString();
  etat.articlesGeneres = (etat.articlesGeneres || 0) + 1;
  etat.sujetsUtilises = [...new Set([...(etat.sujetsUtilises||[]), sujet.theme])];
  etat.prochaineSuggestion = null;
  if (!etat.compteurNiveau) etat.compteurNiveau = { local: 0, national: 0 };
  etat.compteurNiveau[niveau] = (etat.compteurNiveau[niveau] || 0) + 1;
  sauverEtat(etat);
  
  await cycleHermes('article-genere', `${articleId} [${niveau}]: ${sujet.titre} (${qualite.mots} mots)`, qualite.ok);
  
  return { id: articleId, article, sujet, qualite };
}

// ─── Approbation et push ───────────────────────
async function approuverEtPusher(articleId) {
  log(`Approbation de l'article ${articleId}...`);
  
  const draftPath = path.join(DRAFTS_DIR, `${articleId}.json`);
  if (!fs.existsSync(draftPath)) {
    log(`Aucun brouillon trouvé pour ${articleId}`);
    return false;
  }
  
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  if (draft.statut === 'push') {
    log(`Article ${articleId} déjà pusher`);
    return true;
  }
  
  // Push sur justmodjo/amodjo-v1
  const pushOK = await pusherArticle(articleId);
  if (!pushOK) {
    await cycleHermes('erreur-push', `Échec push ${articleId}`, false);
    return false;
  }
  
  // Mettre à jour l'état
  const etat = chargerEtat();
  etat.articlesApprouves = (etat.articlesApprouves || 0) + 1;
  etat.articlesPushes = (etat.articlesPushes || 0) + 1;
  sauverEtat(etat);
  
  // Notification
  await notifierApprobation(articleId);
  
  await cycleHermes('article-publie', `${articleId} pusher sur ${REPO}`, true);
  
  return true;
}

// ─── Test API Claude ───────────────────────────
async function testClaude() {
  const creds = chargeCreds();
  const apiKey = creds.anthropic_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === '__process_env_ANTHROPIC_API_KEY__') {
    log('Clé Anthropic manquante');
    return false;
  }
  
  try {
    const result = await requete('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Dis "Claude Sonnet OK" si tu me reçois.' }],
    });
    
    const ok = result?.content?.[0]?.text?.includes('OK') || false;
    log(`Test Claude Sonnet: ${ok ? 'OK' : 'Réponse inattendue'}`);
    return ok;
  } catch (e) {
    log(`Test Claude Sonnet: ${e.message?.slice(0,100)}`);
    return false;
  }
}

// ─── Main ──────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--approve') && args[args.indexOf('--approve') + 1] ? 'approve'
    : args.includes('--test') ? 'test'
    : args.includes('--generate') ? 'generate'
    : 'full';
  
  log(`Démarrage Journaliste (mode: ${mode})`);
  const etat = chargerEtat();
  
  if (mode === 'test') {
    const ok = await testClaude();
    console.log(JSON.stringify({ ok, mode: 'test' }));
    return;
  }
  
  if (mode === 'approve') {
    const articleId = args[args.indexOf('--approve') + 1];
    const ok = await approuverEtPusher(articleId);
    console.log(JSON.stringify({ ok, mode: 'approve', articleId }));
    return;
  }
  
  // generate ou full
  const result = await genererArticle(etat);
  if (!result) {
    console.log(JSON.stringify({ ok: false, mode }));
    process.exit(1);
  }
  
  log('Journaliste terminé');
  console.log(JSON.stringify({
    ok: true,
    mode,
    id: result.id,
    titre: result.sujet.titre,
    mots: result.qualite.mots,
    qualite: `${result.qualite.okCount}/7`,
  }));
}

if (require.main === module) {
  main().catch(e => {
    log(`Erreur fatale: ${e.message}`);
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { main, genererArticle, approuverEtPusher, cycleHermes, testClaude, getSujetsPourNiveau, determinerProchainNiveau, verifierQualite };
