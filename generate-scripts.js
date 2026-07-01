const { createClient } = require('@supabase/supabase-js');
const tools = JSON.parse(require('fs').readFileSync('/data/.openclaw/plugin-skills/gardien/tools.json', 'utf8'));
const sb = createClient(tools.supabase_url, tools.supabase_service_role_key);

sb.from('leads')
  .select('*')
  .is('email', null)
  .not('phone', 'is', null)
  .neq('phone', '')
  .order('created_at', { ascending: false })
  .then(({ data, error }) => {
    if (error) { console.log('Erreur:', error.message); return; }
    
    const seen = new Map();
    data.forEach(d => {
      const nom = (d.company || d.first_name || '').trim();
      if (!nom || seen.has(nom)) return;
      seen.set(nom, d);
    });

    const prospects = [...seen.values()];
    
    const prioOrder = { 'Haute': 0, 'Moyenne': 1, 'Basse': 2 };
    prospects.sort((a, b) => {
      const pa = prioOrder[a.priority] ?? 1;
      const pb = prioOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return (b.ai_score || 0) - (a.ai_score || 0);
    });

    const lines = [];
    let count = 0;

    // Grouper par catégorie
    const groupes = {};
    prospects.forEach(d => {
      const cat = (d.notes || '').replace('Artisan Normandie — ', '') || d.pipeline_stage || 'Autre';
      if (!groupes[cat]) groupes[cat] = [];
      groupes[cat].push(d);
    });

    for (const [categorie, items] of Object.entries(groupes)) {
      lines.push('');
      lines.push('═══════════════════════════════════════════════════');
      lines.push('  CATÉGORIE : ' + categorie.toUpperCase());
      lines.push('  ' + items.length + ' prospect(s)');
      lines.push('═══════════════════════════════════════════════════');
      
      items.forEach(d => {
        count++;
        const nom = (d.company || d.first_name || '').trim();
        const accroche = categorie.includes('coiffeur') 
          ? "Je suis passé devant votre salon et je me suis dit qu'un site web vous amènerait encore plus de clients."
          : categorie.includes('restaurant')
            ? "Je suis tombé sur votre établissement — vous avez une belle réputation. Mais sans site web, les touristes passent à côté."
            : categorie.includes('électricien')
              ? "Je cherche un électricien au Havre et je suis tombé sur votre fiche. Vous êtes bien noté — dommage que vous n'ayez pas de site."
              : categorie.includes('plombier')
                ? "Je cherchais un plombier au Havre et je suis tombé sur votre fiche Google Maps. Vous avez de bons avis."
                : categorie.includes('menuisier')
                  ? "Je suis tombé sur votre entreprise — vous faites du bon travail. Mais sans site, les gens passent à côté."
                  : categorie.includes('coach')
                    ? "Je suis tombé sur votre profil. Vous avez de bons retours — mais sans site web, les clients potentiels vous cherchent ailleurs."
                    : "Je suis tombé sur votre entreprise sur Google Maps.";

        lines.push('');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push('SCRIPT #' + count + '  —  ' + nom);
        lines.push('Numéro  : ' + (d.phone || '?'));
        lines.push('Priorité: ' + d.priority + ' | Score: ' + d.ai_score);
        lines.push('');
        lines.push('--- ACCROCHE ---');
        lines.push(accroche);
        lines.push('');
        lines.push('--- CONSTANT ---');
        lines.push("Vous n'avez pas de site internet. Résultat : des clients vous cherchent sur Google et ne vous trouvent pas.");
        lines.push('');
        lines.push('--- VALEUR ---');
        lines.push("Je crée des sites pour les artisans au Havre. Un site simple, clair, qui donne envie d'appeler. Je ne vous vends rien aujourd'hui, je vous montre.");
        lines.push('');
        lines.push('--- CTA ---');
        lines.push("Si vous avez 5 minutes, je vous montre ce que je fais. Vous déciderez après. Ça ne vous engage à rien.");
        lines.push('');
        lines.push('--- ANTI-OBJECTION ---');
        lines.push('→ "Pas le temps"  →  Je comprends. 5 minutes suffisent, je vous montre un exemple similaire.');
        lines.push('→ "Pas intéressé"  →  Pas de souci. Si un jour vous en avez besoin, vous savez où me trouver.');
        lines.push('→ "J\'ai déjà quelqu\'un"  →  Tant mieux. Si ça ne marche pas avec lui, je suis disponible.');
        lines.push('');
        lines.push('--- RELANCE ---');
        lines.push('J+3 : Rappel si pas de réponse');
        lines.push('J+7 : SMS si pas de nouveau contact');
        lines.push('');
      });
    }

    lines.push('═══════════════════════════════════════════════════');
    lines.push('  TOTAL : ' + count + ' scripts d\'appel');
    lines.push('  Généré le : ' + new Date().toISOString());
    lines.push('═══════════════════════════════════════════════════');

    require('fs').writeFileSync('/data/workspace/scripts-appels-prospects.txt', lines.join('\n'), 'utf8');
    console.log('✅ ' + count + ' scripts téléphoniques générés dans scripts-appels-prospects.txt');
  });
