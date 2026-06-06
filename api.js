const express = require('express');
const cors = require('cors');

// Crash-proof: capturer toutes les erreurs
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Supabase optionnel — pas de crash si absent
let supabase = null;
try {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (supabaseUrl && supabaseKey) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, supabaseKey);
  }
} catch (e) {
  console.error('[config] Supabase not available:', e.message);
}

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aminyo-os-api',
    supabase: supabase ? 'connected' : 'no-config',
    timestamp: new Date().toISOString()
  });
});

// Dashboard status
app.get('/api/status', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const [alertsRes, actionsRes] = await Promise.all([
      supabase.from('activity_logs').select('*').eq('status', 'error').gte('created_at', yesterday).limit(10),
      supabase.from('activity_logs').select('*').gte('created_at', yesterday).order('created_at', { ascending: false }).limit(20)
    ]);
    res.json({
      status: 'ok',
      alerts: alertsRes.data || [],
      recentActions: actionsRes.data || [],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook endpoint
app.post('/api/webhook/:agent', (req, res) => {
  const { agent } = req.params;
  console.log(`[webhook] ${agent}:`, JSON.stringify(req.body).substring(0, 300));
  res.json({ received: true, agent, timestamp: new Date().toISOString() });
});

// Static files
app.use(express.static('public'));

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

// Start
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aminyo OS API running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('[FATAL] Server error:', err.message);
  process.exit(1);
});
