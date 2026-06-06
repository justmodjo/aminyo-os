#!/usr/bin/env node
/**
 * Formateur – Agent de formation client post-livraison
 *
 * Génère des guides personnalisés selon CMS et fonctionnalités du projet,
 * les envoie via le Facteur après livraison, répond aux questions techniques
 * basiques, réduit le temps de support après livraison.
 *
 * Cycle Hermès : chaque action est loggée et analysée pour amélioration continue.
 *
 * Usage :
 *   node formateur.js generate-guide <leadId>    → guide pour un client livré
 *   node formateur.js send-all-pending           → envoie les guides en attente
 *   node formateur.js faq <leadId> <question>    → répond à une question client
 *   node formateur.js check                      → vérifie si des guides sont à envoyer
 *   node formateur.js upgrade-guides             → améliore les guides avec Hermès
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const activityLogger = require('/data/.openclaw/lib/activity-logger.js');
const healthCheck = require('/data/.openclaw/lib/health-check.js');
const taskQueue = require('/data/.openclaw/lib/task-queue.js');

const TOOLS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const LOG_PATH = '/data/.openclaw/plugin-skills/formateur/formateur.log';
const DRAFTS_DIR = '/data/.openclaw/plugin-skills/formateur/brouillons';
const GUIDES_DIR = '/data/.openclaw/plugin-skills/formateur/guides';

const SUPABASE_URL = 'https://uurauxmdjhufidifldpv.supabase.co/rest/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1cmF1eG1kamh1ZmlkaWZsZHB2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzYzNjcxMCwiZXhwIjoyMDkzMjEyNzEwfQ.m9PdNZyp7NCFMYMiA1FJSNw4KkrtjOpwbc5ufD9cgo8';
const TELEGRAM_CHAT_ID = '6408961089';

// ── Helpers ──

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function loadTools() {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
}

function requete(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Catégories de guides ──

const GUIDES_TEMPLATES = {
  wordpress: {
    libre: 'WordPress (auto-hébergé)',
    nom: 'Guide WordPress',
    sections: [
      { id: 'connexion', titre: 'Connexion à votre administration', contenu: 'Votre site est livré sur WordPress. Voici comment vous connecter.' },
      { id: 'pages', titre: 'Modifier vos pages', contenu: 'Éditez vos pages existantes avec l\'éditeur Gutenberg.' },
      { id: 'articles', titre: 'Publier un article de blog', contenu: 'Créez et publiez des articles pour votre blog.' },
      { id: 'images', titre: 'Ajouter des images et médias', contenu: 'Comment optimiser vos images pour le web.' },
      { id: 'seo', titre: 'SEO de base', contenu: 'Les réglages SEO élémentaires avec le plugin installé.' },
      { id: 'maintenance', titre: 'Mise à jour et maintenance', contenu: 'Garder votre site à jour et sécurisé.' },
    ],
  },
  webflow: {
    libre: 'Webflow (hébergé)',
    nom: 'Guide Webflow',
    sections: [
      { id: 'connexion', titre: 'Connexion à votre site Webflow', contenu: 'Accédez à votre interface Webflow Designer.' },
      { id: 'contenu', titre: 'Modifier le contenu du CMS', contenu: 'Éditez vos collections CMS.' },
      { id: 'images', titre: 'Gérer vos images', contenu: 'Importez et optimisez vos images.' },
      { id: 'formulaires', titre: 'Configurer les formulaires', contenu: 'Gérez les soumissions de formulaire.' },
      { id: 'seo', titre: 'SEO Webflow', contenu: 'Les réglages SEO dans Webflow.' },
      { id: 'domaine', titre: 'Domaine et publication', contenu: 'Gérez votre nom de domaine et publiez les changements.' },
    ],
  },
  'next.js': {
    libre: 'Next.js + Supabase (sur-mesure)',
    nom: 'Guide Next.js',
    sections: [
      { id: 'connexion', titre: 'Accès à l\'interface d\'administration', contenu: 'Connectez-vous à votre dashboard personnalisé.' },
      { id: 'contenu', titre: 'Gérer vos contenus', contenu: 'Interface de gestion de contenu (CMS headless).' },
      { id: 'images', titre: 'Ajouter des médias', contenu: 'Upload et gestion des images via votre dashboard.' },
      { id: 'pages', titre: 'Pages et navigation', contenu: 'Structure de navigation et création de pages.' },
      { id: 'seo', titre: 'SEO et performance', contenu: 'Votre site est optimisé, voici comment le maintenir.' },
      { id: 'hebergement', titre: 'Hébergement et déploiement', contenu: 'Comprendre où votre site est hébergé (Railway/Vercel).' },
    ],
  },
};

const FONCTIONNALITES_GUIDES = {
  blog: { titre: 'Votre blog', icone: '📝', sections: ['articles'] },
  seo: { titre: 'Référencement SEO', icone: '🔍', sections: ['seo'] },
  ecommerce: { titre: 'Boutique en ligne', icone: '🛒', sections: ['produits', 'paiement', 'livraison'] },
  formulaire: { titre: 'Formulaires de contact', icone: '📋', sections: ['formulaires'] },
  reservation: { titre: 'Prise de rendez-vous', icone: '📅', sections: ['reservations', 'calendrier'] },
  galerie: { titre: 'Galerie photos/portfolio', icone: '🖼️', sections: ['images', 'galerie'] },
  referencement: { titre: 'Référencement local', icone: '📍', sections: ['seo', 'google-my-business'] },
};

// ─── FAQ par type de site ──
const FAQ_TYPES = {
  vitrine: {
    nom: 'Site vitrine',
    detection: (f) => !f.some(fn => ['blog','ecommerce','reservation'].includes(fn)),
    categories: [
      { id: 'pages', label: 'Modifier les pages', questions: [
        'Comment modifier le texte de ma page d\'accueil ?',
        'Comment ajouter une nouvelle page ?',
        'Comment changer les photos ?',
      ]},
      { id: 'visibilite', label: 'Visibilite en ligne', questions: [
        'Mon site apparait-il sur Google ?',
        'Comment etre mieux reference ?',
        'Comment modifier mon adresse ?',
      ]},
    ],
  },
  blog: {
    nom: 'Blog / Site de contenu',
    detection: (f) => f.includes('blog') && !f.includes('ecommerce'),
    categories: [
      { id: 'articles', label: 'Publier un article', questions: [
        'Comment creer un nouvel article de blog ?',
        'Comment ajouter des images dans un article ?',
        'Comment ecrire un article qui se classe sur Google ?',
      ]},
      { id: 'categories', label: 'Categories et tags', questions: [
        'Comment organiser mes articles par theme ?',
        'Comment ajouter des mots-cles a mes articles ?',
      ]},
    ],
  },
  ecommerce: {
    nom: 'Boutique en ligne',
    detection: (f) => f.includes('ecommerce'),
    categories: [
      { id: 'produits', label: 'Gerer les produits', questions: [
        'Comment ajouter un nouveau produit ?',
        'Comment modifier le prix d\'un produit ?',
        'Comment ajouter une photo produit ?',
      ]},
      { id: 'commandes', label: 'Gerer les commandes', questions: [
        'Comment voir les commandes rec,ues ?',
        'Comment preparer une commande ?',
        'Un client n\'a pas rec,u son email de confirmation ?',
      ]},
      { id: 'paiement', label: 'Paiement et livraison', questions: [
        'Comment configurer les frais de port ?',
        'Quels moyens de paiement sont disponibles ?',
        'Comment gerer les retours ?',
      ]},
    ],
  },
  reservation: {
    nom: 'Site avec prise de rendez-vous',
    detection: (f) => f.includes('reservation'),
    categories: [
      { id: 'calendrier', label: 'Gerer les rendez-vous', questions: [
        'Comment voir mes rendez-vous ?',
        'Comment bloquer un creneau ?',
        'Comment modifier les horaires d\'ouverture ?',
      ]},
      { id: 'clients', label: 'Gerer les clients', questions: [
        'Comment contacter un client qui a pris rendez-vous ?',
        'Comment annuler un rendez-vous ?',
      ]},
    ],
  },
  surmesure: {
    nom: 'Site sur-mesure (Next.js)',
    detection: (f, cms) => cms === 'next.js',
    categories: [
      { id: 'admin', label: 'Interface d\'administration', questions: [
        'Comment acceder a l\'interface d\'administration ?',
        'Comment modifier le contenu du site ?',
        'Comment ajouter des images ?',
      ]},
      { id: 'deploiement', label: 'Deploiement et maintenance', questions: [
        'Comment fonctionne le deploiement ?',
        'Comment mettre le site a jour ?',
        'Comment verifier que le site est en ligne ?',
      ]},
    ],
  },
};

// ─── Niveaux techniques client ──
// Détecté depuis Supabase (metadonnees lead) + memory_episodic (historique des interactions)
const NIVEAUX_TECHNIQUES = {
  debutant: {
    nom: 'Debutant',
    description: "Peu ou pas d'experience technique. A besoin d'explications tres simples, pas a pas.",
    ton: "Patient, rassurant, pedagogique. On explique chaque terme. On evite tout jargon.",
    profondeur: {
      intro: 'Pas de panique ! On va voir ca ensemble, etape par etape.',
      explications: 'Hyper detaillees, phrase par phrase. Chaque clic est decrit.',
      captures: true,
      vocabulaire: 'Basique et imagé. On utilise des analogies du quotidien.',
      niveauDetails: 5, // echelle 1-5
    },
    emailAccompagnement: "Chaleureux et encourageant. Insister sur la simplicite.",
  },
  intermediaire: {
    nom: 'Intermediaire',
    description: "A deja utilise un CMS ou un site web. Comprend les bases du web.",
    ton: 'Concis mais complet. On peut utiliser des termes techniques courants sans les expliquer systematiquement.',
    profondeur: {
      intro: 'Voici comment prendre en main votre site.',
      explications: "Concises. On va a l'essentiel avec des raccourcis utiles.",
      captures: false,
      vocabulaire: 'Technique modere. CMS, SEO, editeur, back-office sont compris.',
      niveauDetails: 3,
    },
    emailAccompagnement: "Pratique et efficace. Mettre en avant les gains de temps.",
  },
  avance: {
    nom: 'Avance',
    description: "Developpeur, designer ou utilisateur technique. Connait deja les CMS.",
    ton: 'Technique, precis, direct. On parle le meme langage. Pas de temps perdu.',
    profondeur: {
      intro: 'Documentation technique de votre projet.',
      explications: 'Tres concises. On donne les raccourcis, les APIs, les hooks si pertinent.',
      captures: false,
      vocabulaire: 'Technique pousse. Termes developpement, hebergement, DNS, deploiement.',
      niveauDetails: 1,
    },
    emailAccompagnement: "Direct et professionnel. Aller droit au but.",
  },
};

// ─── Detection du niveau technique client ──
// Scanne Supabase (metadonnees lead) + memory_episodic (interactions passees)

async function detecterNiveauTechnique(nomClient, emailClient, leadId) {

  await healthCheck.run("formateur", supabase, { requiredTables: ['activity_logs'], requiredVars: ['SUPABASE_URL'] }).catch(function(e) { logError("HealthCheck echec: " + e.message); });  log(`Detection niveau technique: ${nomClient || emailClient || leadId}`);

  // Sources de donnees (ponderation)
  const scores = { debutant: 0, intermediaire: 0, avance: 0 };

  // 1. Chercher le lead dans Supabase
  if (leadId) {
    const lead = await chercherLeadSupabase(leadId);
    if (lead) {
      const niveauDeclare = (lead.niveauTechnique || lead.niveau_technique || '').toLowerCase();
      if (niveauDeclare === 'intermediaire') scores.intermediaire += 15;
      else if (niveauDeclare === 'avance') scores.avance += 15;
      else if (niveauDeclare === 'debutant') scores.debutant += 15;

      // Metier-based inference
      const metier = (lead.metier || lead.secteur || lead.activite || '').toLowerCase();
      if (/artisan|boulanger|coiffeur|plombier|electricien|menuisier|restaurateur|commerc,ant/i.test(metier)) {
        scores.debutant += 8;
      } else if (/medecin|avocat|notaire|expert-comptable|architecte|consultant|profession liberale/i.test(metier)) {
        scores.intermediaire += 8;
      } else if (/startup|dev|technique|sas|editeur|digital|informatique|freelance/i.test(metier)) {
        scores.avance += 8;
      }

      // Budget indication
      const budget = parseInt(lead.budget) || 0;
      if (budget > 5000) scores.avance += 5;
      else if (budget > 2000) scores.intermediaire += 5;
    }
  }

  // 2. Scanner memory_episodic pour les interactions passees avec ce client
  try {
    // Chercher par email ou nom
    const query = encodeURIComponent(nomClient ? nomClient.split(' ')[0] : emailClient || '');
    const result = await requete(`${SUPABASE_URL}/memory_episodic?select=contenu,metadata&agent_name=eq.formateur&order=timestamp.desc&limit=15`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (Array.isArray(result) && result.length > 0) {
      for (const row of result) {
        const contenu = row.contenu || '';
        const meta = row.metadata || {};
        const sujet = (contenu + ' ' + JSON.stringify(meta)).toLowerCase();

        // Chercher si ce client est concerne
        if (emailClient && !sujet.includes(emailClient.toLowerCase())) continue;
        if (nomClient && !sujet.includes(nomClient.toLowerCase().split(' ')[0])) continue;

        // Analyser les questions posees
        const mots = sujet.split(/\s+/).length;
        const contientTermesSimples = /login|mot de passe|ou trouver|comment faire|je ne comprends/i.test(sujet);
        const contientTermesTechniques = /API|hook|DNS|SSH|CI\/CD|deploy|branch|git|query|REST|GraphQL|token|webhook/i.test(sujet);
        const contientSupport = /aide|support|bug|aide moi|pas marche|probleme|erreur/i.test(sujet);

        if (contientTermesSimples) scores.debutant += 6;
        if (contientTermesTechniques) scores.avance += 10;
        if (contientSupport && mots < 10) scores.debutant += 4; // Question courte = peu technique
        if (contientSupport && mots > 20) scores.intermediaire += 3; // Question longue = reflechie

        // Actions passees
        const action = (meta.action || meta.type || '').toLowerCase();
        if (action.includes('faq') && meta.success) scores.intermediaire += 4;
        if (action.includes('guide-envoye') && meta.success) scores.intermediaire += 2;
      }
    }
  } catch (e) {
    log(`Erreur memory_episodic: ${e.message?.slice(0,60)}`);
  }

  // 3. Default : intermediaire si aucun signal
  const total = scores.debutant + scores.intermediaire + scores.avance;
  if (total === 0) {
    log(`Aucune donnee pour ${nomClient || emailClient || leadId}, defaut: intermediaire`);
    return { niveau: 'intermediaire', ...NIVEAUX_TECHNIQUES.intermediaire, score: 0, sources: [] };
  }

  // 4. Selectionner le niveau avec le meilleur score
  const niveaux = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const meilleurNiveau = niveaux[0][0];
  const meilleurScore = niveaux[0][1];
  const secondScore = niveaux[1][1];

  // Si les deux premiers sont proches (ecart < 3), on prend le plus bas
  const niveauFinal = (meilleurScore - secondScore < 3 && meilleurNiveau !== 'debutant')
    ? niveaux[1][0]
    : meilleurNiveau;

  log(`Niveau detecte: ${niveauFinal} (${meilleurNiveau}=${meilleurScore}, ${niveaux[1][0]}=${secondScore})`);

  return {
    niveau: niveauFinal,
    ...NIVEAUX_TECHNIQUES[niveauFinal],
    score: meilleurScore,
    sources: ['lead_supabase', 'memory_episodic'],
  };
}

// ─── Adaptation du guide selon le niveau technique ──

function adapterGuideAuNiveau(guide, sections, niveauClient, nomClient) {
  const cfg = NIVEAUX_TECHNIQUES[niveauClient.niveau] || NIVEAUX_TECHNIQUES.intermediaire;
  const niveau = cfg.profondeur;

  log("Adaptation guide pour niveau " + niveauClient.niveau + " (details=" + niveau.niveauDetails + "/5)");

  // Generer le contenu adapte par section selon le niveau
  const sectionsAdaptees = sections.map(sec => {
    let contenu = "";

    if (niveau.niveauDetails >= 4) {
      contenu = sec.titre + " : voici comment faire pas a pas.\n\n"
        + "1. Ouvrez votre navigateur internet (Chrome, Firefox ou Safari).\n"
        + "2. Rendez-vous sur l'adresse de votre administration (communiquee par email).\n"
        + "3. Saisissez votre identifiant et votre mot de passe.\n"
        + "4. Une fois connecte, vous arrivez sur votre tableau de bord.\n"
        + "5. Explorez tranquillement : chaque action est reversible.\n\n"
        + "> **Conseil :** Prenez le temps d'explorer. Vous ne pouvez rien casser.\n";
    } else if (niveau.niveauDetails <= 2) {
      contenu = "**" + sec.titre + "**\n\n"
        + "Acces direct via l'interface d'administration. Operations standard disponibles dans le panneau de controle. "
        + "Pour toute customisation avancee (API, hooks, deploiement), referer a la documentation technique.\n";
    } else {
      contenu = "**" + sec.titre + "**\n\n"
        + (sec.contenu || "Guide d'utilisation de cette section.") + "\n\n"
        + "Pour aller plus loin, explorez les options avancees dans les parametres.\n";
    }

    return { ...sec, contenu };
  });

  // Intro adaptee
  let introGuide;
  if (niveau.niveauDetails >= 4) {
    introGuide = "Bienvenue " + nomClient + " ! \n\n"
      + "Ce guide est fait pour vous, meme si vous n'avez jamais touche a un site web. On va y aller pas a pas, tranquillement.\n\n"
      + "**Votre site :** il est en ligne et fonctionne deja parfaitement.\n"
      + "**Ce guide :** il vous montre comment l'utiliser au quotidien.\n"
      + "**Pas de panique :** si un mot vous semble bizarre, on l'explique.\n\n"
      + "> Commenc,ons !\n";
  } else if (niveau.niveauDetails <= 2) {
    introGuide = "Documentation technique - " + nomClient + "\n\n"
      + "Projet livre par Aminyo. Ce guide couvre l'administration courante du site.\n\n"
      + "**Environnement :** production\n"
      + "**Derniere mise a jour :** " + new Date().toLocaleDateString('fr-FR') + "\n";
  } else {
    introGuide = "Bonjour " + nomClient + ",\n\n"
      + "Voici votre guide personnalise pour prendre en main votre site. "
      + "Il couvre les operations courantes. Pour les questions specifiques, notre equipe est la.\n";
  }

  // Injecter l'intro adaptee dans le guide
  let nouveauGuide = guide;
  const debutIdx = nouveauGuide.indexOf("Bienvenue !");
  const apresTitre = nouveauGuide.indexOf("---", nouveauGuide.indexOf("# Guide"));
  if (debutIdx !== -1 && apresTitre !== -1) {
    const avantIntro = nouveauGuide.slice(0, debutIdx);
    const apresIntro = nouveauGuide.slice(apresTitre);
    nouveauGuide = avantIntro + introGuide + "\n---\n\n" + apresIntro;
  }

  // Ajouter un badge de niveau
  const badge = "> Guide adapte au niveau **" + cfg.nom + "**\n\n";
  if (nouveauGuide.startsWith("# Guide")) {
    const finTitre = nouveauGuide.indexOf("\n\n", nouveauGuide.indexOf("\n"));
    if (finTitre !== -1) {
      nouveauGuide = nouveauGuide.slice(0, finTitre + 2) + badge + nouveauGuide.slice(finTitre + 2);
    }
  }

  log("Guide adapte: " + sectionsAdaptees.length + " sections, niveau " + cfg.nom);
  return nouveauGuide;
}

// ─── Récupérer les projets livrés dans Supabase ──

async function recupererProjetsLivres() {
  try {
    const result = await requete(`${SUPABASE_URL}/agent_memory?select=id,content,lesson_learned,created_at&event_type=eq.projet_livre&order=created_at.desc&limit=20`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!Array.isArray(result)) {
      log(`Projets: ${JSON.stringify(result).slice(0,80)}`);
      return [];
    }

    const projets = [];
    for (const row of result) {
      try {
        const meta = row.lesson_learned ? (() => { try { return JSON.parse(row.lesson_learned); } catch { return {}; } })() : {};
        const contenu = row.content ? (() => { try { return JSON.parse(row.content); } catch { return {}; } })() : {};
        projets.push({
          leadId: meta.leadId || contenu.leadId || '',
          nom: meta.nomClient || contenu.client || meta.client_nom || 'Client',
          email: contenu.email || meta.email || '',
          cms: contenu.cms || meta.cms || contenu.plateforme || 'wordpress',
          fonctionnalites: contenu.fonctionnalites || meta.fonctionnalites || [],
          urlSite: contenu.urlSite || meta.url || contenu.url || '',
          livreeLe: contenu.dateLivraison || meta.dateLivraison || meta.date || '',
          guideEnvoye: contenu.guideEnvoye || meta.guideEnvoye || false,
          guideLangue: contenu.langue || meta.langue || 'fr',
          statut: meta.statut || contenu.statut || 'livre',
        });
      } catch {}
    }

    log(`${projets.length} projets livrés récupérés (${projets.filter(p => !p.guideEnvoye).length} en attente de guide)`);
    return projets;
  } catch (e) {
    log(`Erreur projets: ${e.message?.slice(0,80)}`);
    return [];
  }
}

async function chercherLeadSupabase(leadId) {
  try {
    const result = await requete(`${SUPABASE_URL}/agent_memory?select=id,content,lesson_learned,created_at&event_type=eq.lead&id=eq.${encodeURIComponent(leadId)}&limit=1`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (Array.isArray(result) && result.length > 0) {
      const meta = result[0].lesson_learned ? (() => { try { return JSON.parse(result[0].lesson_learned); } catch { return {}; } })() : {};
      const contenu = result[0].content ? (() => { try { return JSON.parse(result[0].content); } catch { return {}; } })() : {};
      return { ...meta, ...contenu };
    }
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Règles générales du Formateur — voir REGLES-FORMATEUR.md
// ═══════════════════════════════════════════════════════════════

// Secteurs et tons associés (Règle 5)
const SECTEURS_TONS = {
  artisan: {
    motsCles: ['plombier','electricien','macon','menuisier','peintre','carreleur','couvreur','plaquiste','paysagiste','chauffagiste','serrurier','vitrier','ramoneur','antenniste','jardinier','boulanger','boucher','coiffeur'],
    detecteSi: (m) => /artisan|chantier|ouvrage|batiment|travaux|reparation|pose|installation/i.test(m),
    ton: { nom: 'artisan', adjectif: 'simple et concret', instruction: 'Phrases courtes. Vocabulaire du terrain (chantier, outil, client, travail). Pas de jargon digital.' },
    exempleAdaptation: "Montrez votre site a vos clients en fin de chantier."
  },
  coach: {
    motsCles: ['coach','therapeute','sophrologue','psy','psychologue','bien-etre','bien etre','yoga','pilates','meditation','sportif','personal trainer','nutritionniste','esthetique','esthetique','beauté','beaute','institut','massage','reflexologue'],
    detecteSi: (m) => /coach|consultant|bien-être|bien etre|accompagnement|transformation|developpement/i.test(m),
    ton: { nom: 'chaleureux et motivant', adjectif: 'inspirant', instruction: 'On parle de confiance, d\'image, de communaute. Ton qui eleve sans etre pompeux.' },
    exempleAdaptation: "Votre site, c'est votre plus belle carte de visite. Il inspire confiance avant meme le premier rendez-vous."
  },
  restaurant: {
    motsCles: ['restaurant','resto','traiteur','bar','café','cafe','brasserie','snack','food','pizzeria','creperie','boulangerie','patisserie','gastronomie','cuisine','chef'],
    detecteSi: (m) => /restaurant|cuisine|plat|menu|deguster|reservation|gourmand/i.test(m),
    ton: { nom: 'convivial et gourmand', adjectif: 'chaleureux et savoureux', instruction: 'On parle de donner envie, d\'ambiance, de decouverte. Vocabulaire sensoriel.' },
    exempleAdaptation: "Vos photos de plats donnent faim avant meme d'avoir reserve."
  },
  liberal: {
    motsCles: ['avocat','notaire','expert-comptable','expert comptable','architecte','geometre','diagnostiqueur','assureur','agent immobilier','notaire'],
    detecteSi: (m) => /cabinet|etude|profession liberal|conseil|juridique|comptable|expertise/i.test(m),
    ton: { nom: 'professionnel et sobre', adjectif: 'rassurant et credible', instruction: 'On parle de serieux, de confiance, de credibilite. Ton sobre mais pas froid.' },
    exempleAdaptation: "Un site clair et structure inspire confiance avant meme le premier rendez-vous."
  }
};

const SECTEUR_DEFAUT = {
  ton: { nom: 'standard chaleureux', adjectif: 'simple et professionnel', instruction: 'Ton chaleureux et professionnel. Phrases simples, pas de jargon technique.' },
  exempleAdaptation: "Votre site est en ligne, montrez-le a vos clients."
};

/**
 * Detecte le secteur du client a partir des metadonnees du lead
 * Règle 5 : Le ton s'adapte toujours au secteur
 */
function detecterSecteurClient(projet) {
  const metier = ((projet.secteur || projet.metier || projet.activite || projet.categoryName || '') + ' ' +
                  (projet.nom || '') + ' ' +
                  JSON.stringify(projet.fonctionnalites || [])).toLowerCase();

  for (const [secteur, cfg] of Object.entries(SECTEURS_TONS)) {
    // Check motsCles
    for (const mot of cfg.motsCles) {
      if (metier.includes(mot)) {
        log(`Secteur detecte: ${secteur} (mot-cle: ${mot})`);
        return { secteur, ...cfg.ton };
      }
    }
    // Check detecteSi regex
    if (cfg.detecteSi && cfg.detecteSi(metier)) {
      log(`Secteur detecte: ${secteur} (regex)`);
      return { secteur, ...cfg.ton };
    }
  }

  log('Secteur non detecte, defaut: standard');
  return { secteur: 'standard', ...SECTEUR_DEFAUT };
}

/**
 * Genere le template complet des 3 emails post-livraison
 * Règles 1-5 appliquees systematiquement
 */
function genererEmailsFormateur(projet) {
  const secteur = detecterSecteurClient(projet);
  const ton = secteur.ton || SECTEUR_DEFAUT.ton;
  const ex = secteur.exempleAdaptation || SECTEUR_DEFAUT.exempleAdaptation;
  const aPour = projet.nom ? projet.nom.split(' ')[0] : 'vous';
  const siteUrl = projet.urlSite || 'votre site';

  // ─── EMAIL #1 — J+1 : Prise en main (Règle 3) ──
  const emailJ1 = `Bonjour ${aPour},

Felicitations, votre site est en ligne !
👉 ${siteUrl}

Il est deja accessible sur Google, sur mobile, et vos nouveaux clients peuvent vous trouver facilement.

${ex}

**Vous n'avez rien a faire pour l'instant.** Le site est livre, tout fonctionne. Pas de mot de passe a retenir, rien a installer.

**Mais si un jour vous voulez changer quelque chose :**
Vous m'envoyez un message avec ce que vous voulez modifier et je m'en occupe. C'est aussi simple que ca.

**Petite astuce :** Montrez votre site a votre entourage, a vos clients. C'est votre vitrine numerique, elle travaille pour vous 24h/24.

Si vous souhaitez que je continue a veiller sur votre site chaque mois (mises a jour, securite, petites modifications), j'ai une offre a partir de 49€/mois. Dites-moi si ca vous interesse.

Vous avez une question ? Repondez simplement a cet email.

Amine
Aminyo — contact@aminyo.fr`;

  // ─── EMAIL #2 — J+7 : 3 actions concretes (Règle 1 → pas de "forfait") ──
  const emailJ7 = `Bonjour ${aPour},

Ca fait une semaine que votre site est en ligne. 3 choses tres simples pour en profiter :

**1. Ajoutez le lien dans votre signature email**
Chaque email que vous envoyez est une pub gratuite. Ajoutez ${siteUrl} a la fin de vos emails.
→ Si vous ne savez pas faire, envoyez-moi "Aide signature" et je vous explique.

**2. Montrez-le a vos clients**
${ex} Ça inspire confiance.

**3. Envoyez-moi des photos**
Les prochaines fois que vous faites un beau travail, prenez une photo et envoyez-la moi. Je l'ajoute a votre galerie. C'est ce qui fait la difference avec ceux qui n'ont pas de site.

Si vous voulez que je fasse l'une de ces actions pour vous, dites-le moi.

Bonne semaine !

Amine
Aminyo`;

  // ─── EMAIL #3 — J+30 : Bilan concis + offre (Règle 4) ──
  const emailJ30 = `Bonjour ${aPour},

Ca fait deja un mois que votre site est en ligne.

J'espere qu'il vous apporte satisfaction. Si vous avez des photos de chantier a ajouter ou des modifications a faire, envoyez-les moi.

**Je continue de veiller sur votre site chaque mois pour 49€ :** mises a jour securite, petites modifications, suivi. Ca vous interesse ? Dites-moi oui par retour de mail et on commence quand vous voulez.

A bientot,

Amine
Aminyo — contact@aminyo.fr
"Le site vitrine, c'est la poignee de main digitale."`;

  const meta = {
    client: projet.nom,
    email: projet.email,
    secteur: secteur.secteur,
    ton: ton.nom,
    url: projet.urlSite,
    dateCreation: new Date().toISOString(),
    version: '2.0.0'
  };

  // Noter les emails generes (sans stats inventees — Règle 2)
  log(`Emails generes pour ${projet.nom} (${secteur.secteur}, ton ${ton.nom})`);

  return {
    j1: { sujet: `${aPour}, votre site est en ligne !`, corps: emailJ1 },
    j7: { sujet: `${aPour}, 3 astuces pour votre site`, corps: emailJ7 },
    j30: { sujet: `Bilan 1 mois — ${aPour}`, corps: emailJ30 },
    meta
  };
}

// ─── Génération du guide personnalisé ──

async function genererGuideProjet(projet, niveauForce) {
    const cms = (projet.cms || 'wordpress').toLowerCase().replace(/[^a-z]/g, '');
  const template = GUIDES_TEMPLATES[cms] || GUIDES_TEMPLATES.wordpress;
  const fonctionnalites = projet.fonctionnalites || [];

  // Détection du niveau technique du client
  let niveauClient;
  if (niveauForce) {
    niveauClient = { niveau: niveauForce, ...NIVEAUX_TECHNIQUES[niveauForce] };
    log(`Niveau forcé: ${niveauForce}`);
  } else {
    niveauClient = await detecterNiveauTechnique(projet.nom, projet.email, projet.leadId);
  }

  log(`Génération guide pour ${projet.nom} (${template.libres}) — niveau ${niveauClient.nom}`);

  // Sections de base du CMS + sections additionnelles selon fonctionnalités
  const sections = [...template.sections];

  // Ajouter des sections spécifiques selon les fonctionnalités
  for (const f of fonctionnalites) {
    const fNorm = f.toLowerCase().replace(/[^a-z]/g, '');
    for (const [key, guideF] of Object.entries(FONCTIONNALITES_GUIDES)) {
      if (fNorm.includes(key) || key.includes(fNorm)) {
        for (const secId of guideF.sections) {
          if (!sections.find(s => s.id === secId)) {
            sections.push({ id: secId, titre: `Fonctionnalité : ${guideF.titre}`, contenu: `Guide pour utiliser la fonctionnalité ${guideF.titre} ${guideF.icone} sur votre site.` });
          }
        }
      }
    }
  }

  // Construire le guide de base
  let guide = `# Guide d'utilisation — ${projet.nom}

`;
  guide += `Bienvenue ! Ce guide personnalisé vous aide à prendre en main votre site ${template.libres} livré par Aminyo.

`;
  guide += `---

`;

  for (const sec of sections) {
    guide += `## ${sec.titre}

`;
    guide += `${sec.contenu}

`;
    guide += `---

`;
  }

  // Section support
  guide += `## Besoin d'aide ?

`;
  guide += `Si vous avez des questions :
`;
  guide += `- Répondez à cet email ou contactez-nous sur **contact@aminyo.fr**
`;
  guide += `- Consultez notre FAQ : https://aminyo.fr/faq
`;
  guide += `- Temps de réponse moyen : < 24h

`;
  guide += `---

`;
  guide += `*Généré par Aminyo • ${new Date().toLocaleDateString('fr-FR')}*`;

  // Adapter le guide au niveau technique du client
  guide = adapterGuideAuNiveau(guide, sections, niveauClient, projet.nom);

  const meta = {
    client: projet.nom,
    email: projet.email,
    cms,
    niveauTechnique: niveauClient.niveau,
    niveauDetails: niveauClient.profondeur.niveauDetails,
    fonctionnalites: fonctionnalites.join(', '),
    url: projet.urlSite,
    dateLivraison: projet.livreeLe,
    sections: sections.map(s => s.id),
    versionGuide: '1.0.0',
  };

  return { guide, meta };
}

// ─── Envoi via le Facteur (guide + sequence 3 emails) ──

async function envoyerGuideFacteur(projet, guide, meta) {
  const tools = loadTools();
  const anthropicKey = tools.anthropic_key;
  if (!anthropicKey) { log('Clé Anthropic manquante'); return false; }

  // Generer les 3 emails avec les nouvelles regles (1-5)
  const sequence = genererEmailsFormateur(projet);

  // Email J+1 = email d'accompagnement du guide
  const emailBody = sequence.j1.corps + `\n\n---\nVotre guide personnalisé ci-dessous :\n\n${guide}`;
  const sujet = sequence.j1.sujet;
  let envoiOk = false;
  try {
    execSync(`node /data/.openclaw/plugin-skills/facteur/agent.js send --to "${projet.email}" --subject "${sujet.replace(/"/g, '\\"')}" --body "${(emailBody + '\n\n' + guide).replace(/"/g, '\\"').slice(0, 50000)}"`, {
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`Guide envoyé à ${projet.email}`);
    envoiOk = true;
  } catch (e) {
    log(`Erreur envoi Facteur: ${e.message?.slice(0,100)}`);
    envoiOk = false;
  }

  // Archiver chez l'Archiviste (même si l'envoi a échoué, on garde le document)
  try {
    const archiviste = require('/data/.openclaw/plugin-skills/archiviste/archiviste.js');
    const contenuArchive = `# Guide formation — ${projet.nom}\n\nCMS : ${meta.cms}\nFonctionnalités : ${meta.fonctionnalites}\nNiveau : ${meta.niveauTechnique || 'intermediaire'}\nEnvoyé le : ${new Date().toISOString()}\nStatut envoi : ${envoiOk ? 'OK' : 'ECHEC'}\n\n---\n\n${guide}\n\n---\n\n${emailBody}`;
    await archiviste.stockerDocument(
      (meta.leadId || projet.nom || 'inconnu').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase(),
      'formation',
      contenuArchive,
      (meta.url || projet.email || 'guide').replace(/[^a-zA-Z0-9-_]/g, '_'),
      { cms: meta.cms, niveau: meta.niveauTechnique, email: projet.email, envoiOk }
    );
    log(`Guide archivé dans Supabase pour ${projet.nom}`);
  } catch (e) {
    log(`Erreur archivage guide: ${e.message?.slice(0,100)}`);
    // Non bloquant — l'essentiel est que le guide ait été envoyé
  }

  return envoiOk;
}

// ─── FAQ client : répondre aux questions techniques ──

async function repondreQuestionClient(question, projet) {
  const tools = loadTools();
  const anthropicKey = tools.anthropic_key;
  if (!anthropicKey) {
    return 'Désolé, le service de réponse n\'est pas disponible pour le moment. Contactez contact@aminyo.fr';
  }

  const prompt = `Tu es le support technique d'Aminyo, agence web premium au Havre.

Client : ${projet.nom || 'Client'}
Projet : ${projet.cms || 'WordPress'} — ${(projet.fonctionnalites || []).join(', ')}

Question du client : "${question}"

Réponds de manière simple, claire et actionnable :
1. Réponds directement à la question (pas de bla-bla)
2. Si besoin, donne les étapes une par une
3. Si la question est trop complexe pour une réponse simple, dis-le honnêtement et propose de prendre rendez-vous
4. Reste chaleureux et patient — le client n'est pas technique
5. Si la solution est dans le guide, référence la section correspondante

Format : paragraphes courts, max 200 mots. En français.`;

  try {
    const response = await requete('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: 'Tu es le support technique d\'Aminyo. Réponses simples, courtes, actionnables. Ton chaleureux et patient.',
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.content && response.content[0]?.text) {
      return response.content[0].text;
    }
  } catch (e) {
    log(`Erreur FAQ: ${e.message?.slice(0,80)}`);
  }

  return `Merci pour votre question. La réponse nécessite un peu plus de contexte — je vous invite à nous écrire sur contact@aminyo.fr et nous vous répondrons sous 24h.`;
}

// ─── Sauvegarde guide (brouillon) ──

function sauvegarderGuide(projet, guide, meta) {
  if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const filename = `guide-${projet.leadId || Date.now()}.json`;
  const data = JSON.stringify({ projet, guide, meta, date: new Date().toISOString(), statut: 'pret' }, null, 2);
  fs.writeFileSync(path.join(DRAFTS_DIR, filename), data, 'utf8');
  return filename;
}

function chargerGuidesPret() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const guides = [];
  for (const f of fs.readdirSync(DRAFTS_DIR)) {
    if (f.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        if (data.statut === 'pret') guides.push(data);
      } catch {}
    }
  }
  return guides;
}

function marquerGuideEnvoye(filename) {
  const p = path.join(DRAFTS_DIR, filename);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    data.statut = 'envoye';
    data.envoyeLe = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

// ─── FAQ personnalisee par type de site ──

function detecterTypeSite(fonctionnalites, cms) {
  if (!fonctionnalites || fonctionnalites.length === 0) return 'vitrine';
  for (const [type, cfg] of Object.entries(FAQ_TYPES)) {
    try {
      if (cfg.detection(fonctionnalites, cms)) return type;
    } catch {}
  }
  return 'vitrine';
}

async function genererFAQPersonnalisee(projet) {
  const typeSite = detecterTypeSite(projet.fonctionnalites, projet.cms);
  const cfg = FAQ_TYPES[typeSite];
  log(`Generation FAQ personnalisee pour ${projet.nom} (${cfg.nom})`);

  // Charger les questions Hermès enregistrées pour ce type de site
  let questionsHermes = [];
  try {
    const result = await requete(SUPABASE_URL + '/memory_semantic?select=contenu,metadata&categorie=eq.lecon_formateur&order=created_at.desc&limit=50', {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': '***' + SUPABASE_ANON_KEY,
      },
    });
    if (Array.isArray(result)) {
      for (const r of result) {
        try {
          const lecon = JSON.parse(r.contenu || '{}');
          if (lecon.lecon && lecon.lecon.includes('faq-repondu-') && lecon.meta?.typeSite === typeSite) {
            questionsHermes.push({
              question: lecon.lecon.replace(/^faq-repondu-/i, '').trim(),
              reponse: lecon.meta?.reponse || 'Contactez contact@aminyo.fr',
              compteur: lecon.meta?.compteur || 1,
            });
          }
        } catch {}
      }
    }
  } catch (e) {
    log('Erreur chargement FAQ Hermes: ' + (e.message || '').slice(0,60));
  }

  // Fusionner questions de base + questions Hermès (triees par compteur desc)
  let toutesQuestions = [];
  for (const cat of cfg.categories) {
    for (const q of cat.questions) {
      toutesQuestions.push({ question: q, reponse: null, compteur: 0, categorie: cat.label });
    }
  }
  for (const qh of questionsHermes) {
    const existante = toutesQuestions.find(tq => tq.question.toLowerCase() === qh.question.toLowerCase());
    if (existante) {
      existante.compteur = qh.compteur;
    } else {
      toutesQuestions.push({ question: qh.question, reponse: qh.reponse, compteur: qh.compteur, categorie: 'Questions frequentes' });
    }
  }

  toutesQuestions.sort((a, b) => b.compteur - a.compteur);

  // Construire la FAQ
  const niveau = await detecterNiveauTechnique(projet.nom, projet.email, projet.leadId);
  const intro = niveau.niveau === 'debutant'
    ? 'Voici les reponses aux questions les plus courantes. Si vous avez un doute, n\'hesitez pas a nous ecrire !'
    : 'Questions frequentes et reponses rapides.';

  let faq = '# FAQ — ' + cfg.nom + '\n\n' + intro + '\n\n';
  for (const q of toutesQuestions.slice(0, 15)) {
    faq += '## ' + q.question + '\n\n';
    if (q.reponse) {
      faq += q.reponse + '\n\n';
    } else {
      faq += 'Consultez votre guide d\'utilisation ou contactez contact@aminyo.fr pour une reponse personnalisee.\n\n';
    }
    faq += '---\n\n';
  }
  faq += '*FAQ generee par Aminyo • ' + new Date().toLocaleDateString('fr-FR') + '\n';

  // Sauvegarder
  if (!fs.existsSync(GUIDES_DIR)) fs.mkdirSync(GUIDES_DIR, { recursive: true });
  const filename = 'faq-' + (projet.leadId || Date.now()) + '.md';
  fs.writeFileSync(path.join(GUIDES_DIR, filename), faq, 'utf8');
  log('FAQ sauvegardee: ' + filename + ' (' + toutesQuestions.length + ' questions)');

  return { faq, filename, typeSite, nbQuestions: toutesQuestions.length };
}

// ─── Cycle Hermès ──

async function cycleHermes(action, details, success = true) {
  try {
    const cristal = require('/data/.openclaw/lib/learning-orchestrator.js');
    await cristal.learn.run('formateur-' + action, { details, success });
    // Stocker aussi dans Supabase pour mémoire durable
    await requete(`${SUPABASE_URL}/memory_semantic`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
    }, {
      contenu: JSON.stringify({ lecon: details, resultat: success ? 'succes' : 'echec', timestamp: new Date().toISOString() }),
      metadata: {
        action: 'formateur-' + action,
        agent: 'formateur',
        success,
        date: new Date().toISOString(),
      },
      source: 'formateur',
      categorie: 'lecon_formateur',
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    log(`cycleHermes error: ${e.message?.slice(0,50)}`);
  }
}

async function notifierTelegram(message) {
  const tools = loadTools();
  const botToken = tools.telegram_bot_token;
  if (!botToken) { log('Token Telegram manquant'); return; }
  try {
    await requete(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
  } catch (e) {
    log(`Erreur Telegram: ${e.message?.slice(0,60)}`);
  }
}

// ─── Apprentissage Hermès pour le Formateur ──

async function hermesAnalyserEtAjuster() {
  log('Hermès Formateur: analyse des performances...');
  try {
    const result = await requete(`${SUPABASE_URL}/memory_semantic?select=contenu,metadata&categorie=eq.lecon_formateur&order=created_at.desc&limit=30`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!Array.isArray(result) || result.length === 0) {
      log('Hermès: aucune leçon disponible');
      return;
    }

    const lecons = result.map(r => ({ lecon: (JSON.parse(r.contenu || '{}')?.lecon || ''), meta: r.metadata || {} }));
    const total = lecons.length;
    const succes = lecons.filter(l => l.meta.success !== false).length;
    const taux = Math.round(succes / total * 100);
    const envoisReussis = lecons.filter(l => l.lecon.includes('guide-envoye') && l.meta.success).length;
    const faqsRepondues = lecons.filter(l => l.lecon.includes('faq-repondu') && l.meta.success).length;

    log(`Hermès: ${taux}% succès (${envoisReussis} envois, ${faqsRepondues} FAQs)`);

    // Ajustements automatiques
    const ajustements = [];
    if (taux < 60) ajustements.push('Vérifier les tokens et permissions');
    if (envoisReussis === 0 && total > 5) ajustements.push('Vérifier le Facteur (peut-être bloqué)');

    await cycleHermes('analyse-performance', `${taux}% succes | ${envoisReussis} envois | ${faqsRepondues} FAQs | ${ajustements.length} ajustements`, taux >= 60);

    // Stocker analyse dans Supabase
    await requete(`${SUPABASE_URL}/agent_memory`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
    }, {
      event_type: 'analyse_performance_formateur',
      content: JSON.stringify({ taux, envoisReussis, faqsRepondues, total, ajustements, date: new Date().toISOString() }),
      lesson_learned: JSON.stringify({ type: 'analyse_performance', tauxSucces: taux, leconsCount: total }),
      agent_name: 'formateur',
      created_at: new Date().toISOString(),
    });

    return { taux, envoisReussis, faqsRepondues, ajustements };
  } catch (e) {
    log(`Erreur analyse Hermès: ${e.message?.slice(0,60)}`);
  }
}

// ─── Upgrade des guides avec leçons Hermès ──

async function upgradeGuides() {
  log('Upgrade des guides avec leçons Hermès...');
  try {
    const result = await requete(`${SUPABASE_URL}/memory_semantic?select=contenu,metadata&categorie=eq.lecon_formateur&order=created_at.desc&limit=20`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!Array.isArray(result) || result.length < 5) {
      log('Pas assez de données pour upgrade (besoin de 5+ leçons)');
      return false;
    }

    const lecons = result.map(r => {
      try { return JSON.parse(r.contenu || '{}'); }
      catch { return {}; }
    });

    // Extraire les FAQs fréquentes
    const questionsFAQ = lecons
      .filter(l => l.lecon?.includes('faq'))
      .map(l => ({ question: l.lecon?.replace(/^faq[-:]/i, '').trim(), success: l.resultat === 'succes' }))
      .filter(q => q.question && q.question.length > 10)
      .slice(0, 10);

    if (questionsFAQ.length >= 3) {
      // Mettre à jour les guides avec une section FAQ enrichie
      if (!fs.existsSync(GUIDES_DIR)) fs.mkdirSync(GUIDES_DIR, { recursive: true });

      const faqContent = questionsFAQ.map((q, i) =>
        `${i+1}. **${q.question}**\n   → Consultez votre guide ou contactez contact@aminyo.fr`
      ).join('\n\n');

      fs.writeFileSync(path.join(GUIDES_DIR, 'faq-communes.md'),
        `# FAQ Aminyo — Questions fréquentes\n\n_Généré le ${new Date().toLocaleDateString('fr-FR')}_\n\n${faqContent}\n\n---\n*Mise à jour automatique via Hermès*`,
        'utf8');

      log(`FAQ enrichie avec ${questionsFAQ.length} questions fréquentes`);
      await cycleHermes('guide-upgrade', `FAQ enrichie: ${questionsFAQ.length} questions ajoutées`, true);
      return true;
    }

    log('Pas assez de questions FAQ pour upgrade significatif');
    return false;
  } catch (e) {
    log(`Erreur upgrade: ${e.message?.slice(0,80)}`);
    return false;
  }
}

// ─── Actions principales ──

async function genererGuide(leadId) {
  log(`Génération guide pour lead ${leadId}`);

  // Chercher le projet dans Supabase
  let projet = null;

  // 1. Essayer les projets livrés
  const projets = await recupererProjetsLivres();
  projet = projets.find(p => p.leadId === leadId);

  // 2. Fallback : chercher le lead directement
  if (!projet) {
    const lead = await chercherLeadSupabase(leadId);
    if (lead) {
      projet = {
        leadId,
        nom: lead.nomClient || lead.nom || 'Client',
        email: lead.email || '',
        cms: lead.cms || lead.plateforme || 'wordpress',
        fonctionnalites: lead.fonctionnalites || lead.fonctionnalites_projet || [],
        urlSite: lead.url || lead.urlSite || '',
        livreeLe: lead.dateLivraison || '',
        guideEnvoye: false,
      };
    }
  }

  if (!projet || !projet.email) {
    log(`Impossible de trouver le projet ${leadId}`);
    await cycleHermes('erreur-generation', `Lead ${leadId} introuvable ou email manquant`, false);
    return null;
  }

  // Générer le guide
  const { guide, meta } = genererGuideProjet(projet);

  // Sauvegarder localement
  const filename = sauvegarderGuide(projet, guide, meta);

  await cycleHermes('guide-genere', `${projet.nom} (${meta.cms}) : ${meta.sections.length} sections`, true);

  return { filename, projet, meta, guide };
}

async function envoyerGuidesEnAttente() {
  const guides = chargerGuidesPret();
  if (guides.length === 0) {
    log('Aucun guide en attente');
    return 0;
  }

  let envoyes = 0;
  for (const g of guides) {
    const ok = await envoyerGuideFacteur(g.projet, g.guide, g.meta);
    if (ok) {
      marquerGuideEnvoye(`guide-${g.projet.leadId || Date.now()}.json`);
      await notifierTelegram(`📘 Guide envoyé à <b>${g.projet.nom}</b>\nCMS: ${g.meta.cms} | ${g.meta.sections.length} sections`);
      await cycleHermes('guide-envoye', `${g.projet.nom} <${g.projet.email}>: ${g.meta.cms}`, true);
      envoyes++;
    } else {
      await cycleHermes('erreur-envoi', `${g.projet.nom}: échec envoi Facteur`, false);
    }
  }

  return envoyes;
}

async function checkProjetsSansGuide() {
  const projets = await recupererProjetsLivres();
  const sansGuide = projets.filter(p => !p.guideEnvoye);

  if (sansGuide.length === 0) {
    log('Tous les projets livrés ont leur guide');
    return [];
  }

  log(`${sansGuide.length} projets sans guide`);

  for (const p of sansGuide) {
    log(`  - ${p.nom} (${p.email}) [${p.cms}]`);
    const result = await genererGuide(p.leadId);
    if (result) {
      await notifierTelegram(
        `📘 <b>Nouveau guide prêt</b>\nClient : ${p.nom}\nCMS : ${p.cms}\nEmail : ${p.email}\n\n<i>En attente d'envoi...</i>`
      );
    }
  }

  return sansGuide;
}

// ─── Relance proactive : site livré sans activité ──

async function checkSiteInactivity() {
  const projets = await recupererProjetsLivres();
  const maintenant = Date.now();
  const SEUIL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

  const bloques = [];

  for (const p of projets) {
    // Chercher une trace d'activité dans memory_episodic
    try {
      const query = encodeURIComponent(p.nom ? p.nom.split(' ')[0] : p.email || '');
      const resultat = await requete(`${SUPABASE_URL}/memory_episodic?select=timestamp,contenu&agent_name=eq.formateur&metadata->>action=eq.activite_site&order=timestamp.desc&limit=3`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      // Verifier si le client a une activite detectee recente
      let aActivite = false;
      if (Array.isArray(resultat)) {
        for (const row of resultat) {
          const contenu = (row.contenu || '').toLowerCase();
          const email = p.email ? p.email.toLowerCase() : '';
          if (contenu.includes(email) || contenu.includes((p.nom || '').toLowerCase().split(' ')[0])) {
            const ts = new Date(row.timestamp).getTime();
            if (maintenant - ts < SEUIL_MS) {
              aActivite = true;
              break;
            }
          }
        }
      }

      if (!aActivite && p.guideEnvoye) {
        bloques.push(p);
      }
    } catch {}
  }

  // Filtrer les clients deja relances recemment (eviter spam)
  const aRelancer = [];
  for (const p of bloques) {
    try {
      const resultat = await requete(`${SUPABASE_URL}/memory_episodic?select=id&agent_name=eq.formateur&metadata->>action=eq.relance_proactive&order=timestamp.desc&limit=1`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      let dejaRelance = false;
      if (Array.isArray(resultat)) {
        for (const row of resultat) {
          const contenu = (row.contenu || '').toLowerCase();
          if (contenu.includes((p.nom || '').toLowerCase().split(' ')[0]) || contenu.includes((p.email || '').toLowerCase())) {
            dejaRelance = true;
            break;
          }
        }
      }

      if (!dejaRelance) {
        aRelancer.push(p);
      }
    } catch {
      aRelancer.push(p); // si erreur, on relance (mieux vaut trop que pas assez)
    }
  }

  log(`${aRelancer.length} clients sans activite depuis 7+ jours (${bloques.length} detectes, ${bloques.length - aRelancer.length} deja relances)`);

  for (const p of aRelancer) {
    await envoyerRelanceProactive(p);
  }

  return aRelancer;
}

async function envoyerRelanceProactive(projet) {
  log(`Relance proactive : ${projet.nom} (${projet.email})`);

  const niveau = await detecterNiveauTechnique(projet.nom, projet.email, projet.leadId);
  let ton;
  if (niveau.niveau === 'debutant') {
    ton = 'Ton tres chaleureux et rassurant. Le client est peut-etre un peu perdu. Propose une aide pas a pas.';
  } else if (niveau.niveau === 'avance') {
    ton = 'Ton direct et professionnel. Propose une assistance technique si besoin.';
  } else {
    ton = 'Ton amical et professionnel. Propose simplement de l\'aide si necessaire.';
  }

  const prompt = `Tu rediges un email de relance pour un client d'Aminyo (agence web premium).

Client : ${projet.nom}
Email : ${projet.email}
CMS : ${projet.cms || 'non precise'}
Fonctionnalites : ${(projet.fonctionnalites || []).join(', ') || 'non precise'}
URL du site : ${projet.urlSite || 'non communiquee'}

Objectif : prendre des nouvelles, proposer de l'aide si le client a des questions sur son site, sans etre insistant.

Ton : ${ton}

Contraintes :
- Pas d'excuses ("desole", "pardonnez") - le client n'a rien a se reprocher
- Pas de sentiment d'abandon - le site est livre et fonctionne
- Proposer un coup de pouce, une demo rapide ou un rendez-vous telephonique
- Garder un ton positif et constructif
- Signature : Amine - Aminyo

Format : simple texte, pas d'HTML.`;

  // Envoyer l'email via le Facteur
  let emailBody = '';
  try {
    const response = await requete('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response && response.content) {
      emailBody = response.content.map(c => c.text).filter(Boolean).join('\n');
    }
  } catch (e) {
    log(`Erreur HTTP Facteur: ${e.message?.slice(0,80)}`);
    return null;
  }

  if (!emailBody) {
    log('Relance Facteur : aucune reponse');
    return null;
  }

  emailBody += '\n\n---\nCe message a ete envoye via le systeme Aminyo.';

  // Poster le brouillon sur Telegram pour validation
  const truncEmail = emailBody.length > 800 ? emailBody.slice(0, 800) + '...' : emailBody;
  const msgValidation =
    '✋ <b>Relance proactive</b> — <i>validation requise</i>\n\n' +
    'Client : <b>' + projet.nom + '</b>\n' +
    'Email : ' + projet.email + '\n' +
    'Site : ' + (projet.urlSite || 'N/C') + '\n' +
    'Niveau detecte : ' + niveau.niveau + '\n' +
    'Inactivite : 7+ jours\n\n' +
    '<b>Projet d\'email :</b>\n' +
    'Sujet : Des questions sur votre site, ' + projet.nom + ' ?\n' +
    '---\n' +
    truncEmail + '\n' +
    '---\n\n' +
    'Reponds avec <b>OUI</b> pour envoyer, <b>NON</b> pour annuler.';

  await notifierTelegram(msgValidation);

  // Logger en attente de validation
  try {
    await requete(SUPABASE_URL + '/memory_episodic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        agent_name: 'formateur',
        contenu: JSON.stringify({
          action: 'relance_proactive',
          client: projet.nom,
          email: projet.email,
          leadId: projet.leadId,
          cms: projet.cms,
          statut: 'en_attente_validation',
          sujet: 'Des questions sur votre site, ' + projet.nom + ' ?',
          corps: emailBody.slice(0, 2000),
        }),
        metadata: {
          action: 'relance_proactive',
          success: false,
          statut: 'en_attente_validation',
          leadId: projet.leadId,
        },
        timestamp: new Date().toISOString(),
      }),
    });
    log('Relance loggee en attente de validation dans memory_episodic');
  } catch (e) {
    log('Erreur log memory_episodic: ' + (e.message || '').slice(0,80));
  }

  return { envoye: false, statut: 'en_attente_validation', client: projet.nom, email: projet.email };
}

// ─── Satisfaction 30 jours ─────────────────────────────────────────────────

async function checkSatisfaction30j() {
  const projets = await recupererProjetsLivres();
  const maintenant = Date.now();
  const SEUIL_MS = 30 * 24 * 60 * 60 * 1000;
  const outils = loadTools();
  const anthropicKey = outils.anthropic_key;
  if (!anthropicKey) { log('Clé Anthropic manquante pour satisfaction'); return []; }

  const eligibles = [];

  for (const p of projets) {
    // Verifier que le projet est livre depuis 30+ jours
    let dateLivraison = null;
    if (p.livreeLe) {
      dateLivraison = new Date(p.livreeLe).getTime();
    }
    if (!dateLivraison || isNaN(dateLivraison)) continue;
    const age = maintenant - dateLivraison;
    if (age < SEUIL_MS) continue; // pas encore 30 jours

    // Verifier si satisfaction deja envoyee
    try {
      const resultat = await requete(`${SUPABASE_URL}/memory_episodic?select=id&agent_name=eq.formateur&metadata->>action=eq.satisfaction_30j&order=timestamp.desc&limit=5`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      let dejaEnvoye = false;
      if (Array.isArray(resultat)) {
        for (const row of resultat) {
          const contenu = (row.contenu || '').toLowerCase();
          if (contenu.includes((p.nom || '').slice(0, 10).toLowerCase()) || contenu.includes((p.email || '').toLowerCase())) {
            dejaEnvoye = true;
            break;
          }
        }
      }

      if (!dejaEnvoye) {
        eligibles.push(p);
      }
    } catch {}
  }

  log(`${eligibles.length} clients eligibles pour satisfaction 30 jours`);

  for (const p of eligibles) {
    await envoyerSatisfaction(p);
  }

  return eligibles;
}

async function envoyerSatisfaction(projet) {
  log(`Satisfaction 30j : ${projet.nom} (${projet.email})`);

  const outils = loadTools();
  const anthropicKey = outils.anthropic_key;

  const prompt = `Tu rediges un email court de satisfaction pour un client d'Aminyo (agence web premium, Le Havre).

Client : ${projet.nom}
Email : ${projet.email}
CMS : ${projet.cms || 'non precise'}
URL du site : ${projet.urlSite || 'non communiquee'}

Objectif : prendre des nouvelles 30 jours apres la livraison de son site. Le ton est chaleureux et humain.

Contenu :
1. Petit rappel du contexte (le site a ete livre il y a un mois)
2. Question ouverte : "Comment se passe la gestion de votre site ?"
3. Deux options implicites : si tout va bien -> encourager a laisser un avis ; si probleme -> proposer de l'aide et contacter l'equipe
4. Signature : Amine — Aminyo

Format : simple texte, pas d'HTML, max 150 mots.`;

  let emailBody = '';
  try {
    const response = await requete('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: 'Tu es Amine, fondateur d\'Aminyo, agence web premium au Havre. Ton ton est chaleureux, professionnel et humain.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response && response.content) {
      emailBody = response.content.map(c => c.text).filter(Boolean).join('\n');
    }
  } catch (e) {
    log(`Erreur Claude satisfaction: ${e.message?.slice(0,80)}`);
    return null;
  }

  if (!emailBody) {
    log('Satisfaction : aucune reponse Claude');
    return null;
  }

  emailBody += '\n\n---\nMessage automatique Aminyo - votre avis nous aide a progresser.';

  // Poste sur Telegram pour validation
  const truncEmail = emailBody.length > 800 ? emailBody.slice(0, 800) + '...' : emailBody;
  const msgValidation =
    '📬 <b>Satisfaction 30 jours</b> — <i>validation requise</i>\n\n' +
    'Client : <b>' + escapeHtml(projet.nom) + '</b>\n' +
    'Email : ' + escapeHtml(projet.email) + '\n' +
    'Site : ' + escapeHtml(projet.urlSite || '(non communiqué)') + '\n' +
    'CMS : ' + escapeHtml(projet.cms || '?') + '\n\n' +
    '<b>Brouillon :</b>\n' + escapeHtml(truncEmail) + '\n\n' +
    'Réponds avec <b>OUI</b> pour envoyer, <b>NON</b> pour annuler.\n' +
    '<i>Si réponse positive du client → pense à lui demander un avis Google (via le Réputateur).</i>\n' +
    '<i>Si problème signalé → alerte immédiate ici.</i>';

  await notifierTelegram(msgValidation);
  log('Satisfaction soumise a validation Telegram pour ' + projet.nom);

  // Logger dans memory_episodic
  try {
    const memoryModule = require('/data/.openclaw/lib/supabase-memory.js');
    await requete(`${SUPABASE_URL}/memory_episodic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        agent_name: 'formateur',
        action: 'satisfaction_30j',
        contenu: JSON.stringify({
          nom: projet.nom,
          email: projet.email,
          cms: projet.cms,
          url: projet.urlSite,
          statut: 'en_attente_validation',
          corps: emailBody.slice(0, 2000),
        }),
        metadata: {
          action: 'satisfaction_30j',
          success: false,
          statut: 'en_attente_validation',
          leadId: projet.leadId,
        },
        timestamp: new Date().toISOString(),
      }),
    });
    log('Satisfaction loggee en attente de validation dans memory_episodic');
  } catch (e) {
    log('Erreur log memory_episodic: ' + (e.message || '').slice(0,80));
  }

  return { envoye: false, statut: 'en_attente_validation', client: projet.nom, email: projet.email };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'check';

  // Systeme embarque (pas de Facteur distant)
  const systemPrompt = 'Tu es Amine, fondateur d\'Aminyo, agence web premium au Havre. Ton ton est direct, professionnel, humain. Tu t\'adresses a tes clients comme des partenaires.';

  // Charger les outils
  const tools = loadTools();
  const anthropicKey = tools.anthropic_key || tools.ANTHROPIC_API_KEY || '';

  // Charger l'etat de l'agent
  const etatPath = path.join(DRAFTS_DIR, '..', 'etat.json');
  let etat = { derniereAnalyse: null, guidesEnvoyes: 0, faqsRepondues: 0 };
  try { etat = JSON.parse(fs.readFileSync(etatPath, 'utf8')); } catch {}

  log('Formateur mode: ' + mode);
  let result = null;

  switch (mode) {
    case 'generate-guide': {
      const leadId = args[1];
      if (!leadId) { console.log('Usage: node formateur.js generate-guide <leadId>'); process.exit(1); }
      result = await genererGuide(leadId);
      await activityLogger.log('formateur', 'generer_guide', {
        title: 'Guide generé pour lead ' + leadId,
        description: 'Guide de formation cree pour le client',
        status: result ? 'success' : 'warning',
        lead_id: leadId,
        details: {
          lead_id: leadId,
          guide_cree: !!result,
        },
      }).catch(function() {});
      break;
    }

    case 'send-all-pending':
      result = await envoyerGuidesEnAttente();
      await activityLogger.log('formateur', 'envoi_guides_en_attente', {
        title: (result || 0) + ' guide(s) en attente envoyes',
        description: 'Envoi automatique des guides en attente',
        status: result > 0 ? 'success' : 'info',
        details: {
          guides_envoyes: result || 0,
        },
        result_count: result || 0,
      }).catch(function() {});
      break;

    case 'faq': {
      const leadId = args[1];
      const question = args.slice(2).join(' ');
      if (!leadId || !question) { console.log('Usage: node formateur.js faq <leadId> <question>'); process.exit(1); }
      result = await repondreQuestionClient(question, leadId);
      break;
    }

    case 'check':
      result = await checkProjetsSansGuide();
      break;

    case 'upgrade-guides':
      result = await upgradeGuides();
      break;

    case 'learn':
      result = await hermesAnalyserEtAjuster();
      break;

    case 'relance':
      result = await checkSiteInactivity();
      break;

    case 'satisfaction':
      result = await checkSatisfaction30j();
      break;

    case 'generate-faq': {
      const leadId = args[1];
      if (!leadId) { console.log('Usage: node formateur.js generate-faq <leadId>'); process.exit(1); }
      const projets = await recupererProjetsLivres();
      const projet = projets.find(p => p.leadId === leadId);
      if (!projet) { console.log('Projet non trouve: ' + leadId); process.exit(1); }
      result = await genererFAQPersonnalisee(projet);
      break;
    }

    case 'recuperer-guide':
    case 'get-guide': {
      const leadId = args[1];
      let type = args[2] || 'formation';
      if (!leadId) { console.log('Usage: node formateur.js recuperer-guide <leadId> [type]'); process.exit(1); }
      try {
        const archiviste = require('/data/.openclaw/plugin-skills/archiviste/archiviste.js');
        const docs = await archiviste.getDocumentsClient(leadId, type);
        if (docs.length === 0) {
          console.log(JSON.stringify({ success: false, message: 'Aucun document trouve pour ' + leadId + ' (type: ' + type + ')' }));
        } else {
          result = { success: true, documents: docs };
        }
      } catch (e) {
        console.log(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
      }
      break;
    }

    case 'sequence': {
      // Generer les 3 emails post-livraison pour un projet (Règles 1-5)
      const leadId = args[1];
      if (!leadId) { console.log('Usage: node formateur.js sequence <leadId>'); process.exit(1); }
      const projets = await recupererProjetsLivres();
      const projetSeq = projets.find(p => p.leadId === leadId);
      if (!projetSeq) { console.log('Projet non trouve: ' + leadId); process.exit(1); }
      const emails = genererEmailsFormateur(projetSeq);
      console.log(JSON.stringify({ success: true, emails, meta: emails.meta }, null, 2));
      result = { success: true, client: projetSeq.nom, emailsGeneres: 3 };
      break;
    }

    case 'test-emails': {
      // Mode debug : genere les 3 emails pour un projet fictif (test direct)
      const nomTest = args[1] || 'Client test';
      const secteurTest = args[2] || 'artisan';
      const projetTest = {
        nom: nomTest,
        email: args[3] || 'client@test.fr',
        urlSite: args[4] || 'https://client-test.fr',
        secteur: secteurTest,
        fonctionnalites: []
      };
      const testEmails = genererEmailsFormateur(projetTest);
      console.log(JSON.stringify({ success: true, emails: testEmails, meta: testEmails.meta }, null, 2));
      result = { success: true, test: true };
      break;
    }

    case 'full': {
      // Cycle complet : check + generate + send + learn
      const projetsSansGuide = await checkProjetsSansGuide();
      const envoyes = await envoyerGuidesEnAttente();
      const upgrade = await upgradeGuides();
      const analyse = await hermesAnalyserEtAjuster();

      result = { projetsSansGuide: projetsSansGuide.length, envoyes, upgrade, analyse };
      await activityLogger.log('formateur', 'cycle_complet', {
        title: 'Cycle Formateur — ' + projetsSansGuide.length + ' projet(s) sans guide',
        description: envoyes + ' guide(s) envoyes, ' +
          (upgrade || 0) + ' upgrade(s), ' +
          (analyse ? analyse.length + ' analyses' : '0 analyse'),
        status: result ? 'success' : 'warning',
        details: {
          projets_sans_guide: projetsSansGuide.length,
          guides_envoyes: envoyes,
          upgrades_effectues: upgrade || 0,
          analyses_effectuees: analyse ? analyse.length : 0,
          leads_recents: analyse ? analyse.slice(0, 3).join(', ') : 'aucun',
          resultat: JSON.stringify(result).substring(0, 300),
        },
        result_count: projetsSansGuide.length + (envoyes || 0),
      });
      break;
    }

    default:
      console.log('Usage: node formateur.js <mode>');
      console.log('Modes : generate-guide, send-all-pending, faq, check, upgrade-guides, learn, full, relance, generate-faq, recuperer-guide <leadId> [type], satisfaction, sequence <leadId>, test-emails [nom] [secteur] [email] [url]');
      process.exit(1);
  }

  // Sauvegarder etat
  etat.derniereAction = new Date().toISOString();
  etat.dernierMode = mode;
  fs.writeFileSync(etatPath, JSON.stringify(etat, null, 2), 'utf8');

  // Output JSON
  if (mode !== 'faq') {
    console.log(JSON.stringify({ ok: true, mode, result }));
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = {
  main,
  genererGuide,
  envoyerGuidesEnAttente,
  checkProjetsSansGuide,
  repondreQuestionClient,
  upgradeGuides,
  hermesAnalyserEtAjuster,
  genererGuideProjet,
  GUIDES_TEMPLATES,
  FONCTIONNALITES_GUIDES,
  NIVEAUX_TECHNIQUES,
  detecterNiveauTechnique,
  adapterGuideAuNiveau,
  checkSiteInactivity,
  envoyerRelanceProactive,
  FAQ_TYPES,
  detecterTypeSite,
  genererFAQPersonnalisee,
  checkSatisfaction30j,
  envoyerSatisfaction,
  detecterSecteurClient,
  SECTEURS_TONS,
  genererEmailsFormateur,
};
