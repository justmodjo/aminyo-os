#!/usr/bin/env node
/**
 * Rapport Sentinelle quotidien
 * S'exécute à 8h chaque matin via cron OpenClaw
 * Envoie un rapport complet Telegram
 */

const { execSync } = require('child_process');
const fs = require('fs');

const SENTINELLE_DIR = '/data/.openclaw/plugin-skills/sentinelle';
const TOOLS_PATH = '/data/.openclaw/plugin-skills/gardien/tools.json';
const STATE_FILE = '/data/workspace/memory/sentinelle-state.json';
const TELEGRAM_ID = '6408961089';

function loadTools() {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
}

function sendTelegram(text) {
  const tools = loadTools();
  const botToken = tools["telegram_bot_token"];
  
  try {
    execSync(`curl -s -X POST "https://api.telegram.org/bot${botToken}/sendMessage" \
      -d "chat_id=${TELEGRAM_ID}" \
      -d "text=${encodeURIComponent(text)}" \
      -d "parse_mode=HTML" > /dev/null 2>&1`, { timeout: 15000 });
    console.log('✅ Rapport envoyé par Telegram');
  } catch (err) {
    console.error('❌ Erreur envoi Telegram:', err.message);
  }
}

function runAllChecks() {
  const results = [];
  const checks = [
    { name: 'Supabase GRANTs', script: 'check-supabase-policy.js', emoji: '🗄️' },
    { name: 'Railway', script: 'check-railway-policy.js', emoji: '🚆' },
    { name: 'API Express Railway', script: 'check-aminyo-api.js', emoji: '🚆' },
    { name: 'Providers IA', script: 'check-providers-policy.js', emoji: '🔌' }
  ];

  for (const check of checks) {
    const scriptPath = `${SENTINELLE_DIR}/${check.script}`;
    try {
      execSync(`node ${scriptPath}`, { timeout: 30000, stdio: 'pipe' });
      results.push({ ...check, status: 'OK' });
    } catch (err) {
      results.push({ ...check, status: 'FAIL' });
    }
  }

  return results;
}

function main() {
  console.log('📊 Rapport Sentinelle Quotidien');
  console.log(new Date().toLocaleString('fr-FR'));
  console.log('');

  const results = runAllChecks();
  const criticals = results.filter(r => r.status === 'FAIL' && r.emoji !== '⚙️' && r.emoji !== '🔌');
  const warnings = results.filter(r => r.status === 'FAIL');

  // Construire le message Telegram
  let msg = `🛡️ <b>Rapport Sentinelle</b>\n📅 ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;

  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : '❌';
    msg += `${icon} ${r.emoji} ${r.name}\n`;
  }

  msg += '\n';

  if (criticals.length > 0) {
    msg += `🚨 <b>PROBLÈMES CRITIQUES</b>\n`;
    for (const c of criticals) {
      msg += `❌ ${c.emoji} ${c.name}\n`;
    }
    // Ajouter la procédure de récupération
    msg += `\n<code>node /data/.openclaw/plugin-skills/sentinelle/sentinelle.js</code>`;
  } else if (warnings.length > 0) {
    msg += `⚠️ Avertissements non critiques\n`;
    msg += `\n<code>node /data/.openclaw/plugin-skills/sentinelle/sentinelle.js</code>`;
  } else {
    msg += `✅ <b>Tout est opérationnel</b>\n`;
    msg += `\nAucune anomalie détectée.`;
  }

  // Ajouter les infos de deadline et prochain check
  const daysLeft = Math.ceil((new Date('2026-05-30') - new Date()) / 86400000);
  msg += `\n\n⏰ <b>Prochain check :</b> Demain 8h00`;
  if (daysLeft >= 0) {
    msg += `\n📋 <b>Deadline GRANTs :</b> J-${daysLeft}`;
  }

  // Sauvegarder l'état
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastReport: new Date().toISOString(),
    lastStatus: criticals.length > 0 ? 'CRITICAL' : warnings.length > 0 ? 'WARNING' : 'OK',
    results: results.map(r => ({ name: r.name, status: r.status })),
    deadline: '2026-05-30'
  }, null, 2));

  sendTelegram(msg);
  console.log('📊 Rapport finalisé');
}

main();
