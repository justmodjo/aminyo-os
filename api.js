const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Supabase
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aminyo-os-api',
    supabase: supabase ? 'connected' : 'no-config',
    timestamp: new Date().toISOString()
  });
});

// Dashboard endpoint for agents
app.get('/api/status', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data: alerts, error: alertsErr } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('status', 'error')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .limit(10);
    
    const { data: recentActions, error: actionsErr } = await supabase
      .from('activity_logs')
      .select('*')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      status: 'ok',
      alerts: alerts || [],
      recentActions: recentActions || [],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook endpoint for inter-agent messages
app.post('/api/webhook/:agent', async (req, res) => {
  const agent = req.params.agent;
  const payload = req.body;
  
  // Log the webhook
  console.log(`[webhook] ${agent}:`, JSON.stringify(payload).substring(0, 200));
  
  res.json({ received: true, agent, timestamp: new Date().toISOString() });
});

// Static files
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`Aminyo OS API running on port ${PORT}`);
});
