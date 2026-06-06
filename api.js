const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Supabase ───────────────────────────────────────────────
let supabase = null;
try {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (url && key) {
    supabase = createClient(url, key);
    console.log('[supabase] Connected');
  } else {
    console.log('[supabase] SKIPPED — missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
} catch (e) {
  console.error('[supabase] Init error:', e.message);
}

// ── Helpers ────────────────────────────────────────────────
function requireSupabase(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  next();
}

async function safeQuery(table, options = {}) {
  try {
    let query = supabase.from(table).select(options.select || '*', options.count ? { count: 'exact' } : undefined);
    if (options.eq) for (const [k, v] of Object.entries(options.eq)) query = query.eq(k, v);
    if (options.gte) for (const [k, v] of Object.entries(options.gte)) query = query.gte(k, v);
    if (options.lte) for (const [k, v] of Object.entries(options.lte)) query = query.lte(k, v);
    if (options.order) query = query.order(options.order.field, { ascending: options.order.asc !== false });
    if (options.limit) query = query.limit(options.limit);
    if (options.range) query = query.range(options.range[0], options.range[1]);
    const { data, error, count } = await query;
    if (error) throw error;
    return { data: data || [], count };
  } catch (e) {
    console.error(`[db] Error querying ${table}:`, e.message);
    throw e;
  }
}

// ── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aminyo-os-api',
    version: '1.0.0',
    supabase: supabase ? 'connected' : 'no-config',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ── Dashboard Stats ────────────────────────────────────────
async function getDashboardStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  const [leadsNew, leadsChaud, clientsActifs, paymentsMonth, eventsToday] = await Promise.all([
    safeQuery('leads', { eq: { status: 'nouveau' }, count: true }).catch(() => ({ count: 0 })),
    safeQuery('leads', { gte: { created_at: weekAgo }, count: true }).catch(() => ({ count: 0 })),
    safeQuery('clients', { eq: { status: 'actif' }, count: true }).catch(() => ({ count: 0 })),
    safeQuery('payments', { gte: { date: monthAgo } }).catch(() => ({ data: [] })),
    safeQuery('activity_logs', { gte: { created_at: todayISO }, order: { field: 'created_at', asc: false }, limit: 50 }).catch(() => ({ data: [] })),
  ]);

  const caMois = paymentsMonth.data.reduce((s, p) => s + parseFloat(p.amount || p.montant || 0), 0);
  const alertsToday = eventsToday.data.filter(e => e.status === 'error');

  return {
    leads: { nouveaux: leadsNew.count || 0, recents_7j: leadsChaud.count || 0 },
    clients: { actifs: clientsActifs.count || 0 },
    ca_mois_eur: caMois.toFixed(2),
    alertes_aujourdhui: alertsToday.length,
    actions_aujourdhui: eventsToday.data.length,
    timestamp: new Date().toISOString()
  };
}

app.get('/api/stats', requireSupabase, async (req, res) => {
  try {
    const stats = await getDashboardStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leads ──────────────────────────────────────────────────
app.get('/api/leads', requireSupabase, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const opts = { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 };
    if (status) opts.eq = { status };
    const { data } = await safeQuery('leads', opts);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/leads/:id', requireSupabase, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('leads').update(req.body).eq('id', id).select();
    if (error) throw error;
    res.json(data?.[0] || { updated: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Clients ────────────────────────────────────────────────
app.get('/api/clients', requireSupabase, async (req, res) => {
  try {
    const { limit } = req.query;
    const { data } = await safeQuery('clients', { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payments ───────────────────────────────────────────────
app.get('/api/payments', requireSupabase, async (req, res) => {
  try {
    const { limit } = req.query;
    const { data } = await safeQuery('payments', { order: { field: 'date', asc: false }, limit: parseInt(limit) || 50 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Projects ───────────────────────────────────────────────
app.get('/api/projects', requireSupabase, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const opts = { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 };
    if (status) opts.eq = { status };
    const { data } = await safeQuery('projects', opts);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Activity Logs ──────────────────────────────────────────
app.get('/api/activity', requireSupabase, async (req, res) => {
  try {
    const { agent, status, limit } = req.query;
    const opts = { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 100 };
    if (agent) opts.eq = { agent_id: agent };
    if (status) opts.eq = { ...opts.eq, status };
    const { data } = await safeQuery('activity_logs', opts);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agent Memory ───────────────────────────────────────────
app.get('/api/memory', requireSupabase, async (req, res) => {
  try {
    const { agent, type, limit } = req.query;
    const opts = { order: { field: 'updated_at', asc: false }, limit: parseInt(limit) || 50 };
    if (agent) opts.eq = { agent_id: agent };
    if (type) opts.eq = { ...opts.eq, type };
    const { data } = await safeQuery('agent_memory', opts);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tasks ──────────────────────────────────────────────────
app.get('/api/tasks', requireSupabase, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const opts = { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 };
    if (status) opts.eq = { status };
    const { data } = await safeQuery('tasks', opts);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Prospects ──────────────────────────────────────────────
app.get('/api/prospects', requireSupabase, async (req, res) => {
  try {
    const { limit } = req.query;
    const { data } = await safeQuery('prospects', { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI Actions ─────────────────────────────────────────────
app.get('/api/ai-actions', requireSupabase, async (req, res) => {
  try {
    const { limit } = req.query;
    const { data } = await safeQuery('ai_actions', { order: { field: 'created_at', asc: false }, limit: parseInt(limit) || 50 });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Webhook ────────────────────────────────────────────────
app.post('/api/webhook/:agent', (req, res) => {
  const { agent } = req.params;
  console.log(`[webhook] ${agent}:`, JSON.stringify(req.body).substring(0, 300));
  res.json({ received: true, agent, timestamp: new Date().toISOString() });
});

// ── Static files ───────────────────────────────────────────
app.use(express.static('public'));

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Start ──────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aminyo OS API running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
});
server.on('error', (err) => {
  console.error('[FATAL] Server error:', err.message);
  process.exit(1);
});
