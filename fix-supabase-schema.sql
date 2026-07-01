📝 SQL à exécuter dans Supabase SQL Editor :
-- Exécuter dans Supabase Dashboard → SQL Editor

ALTER TABLE leads ADD COLUMN IF NOT EXISTS relance_stage text DEFAULT 'inactive';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS relances_planifiees integer DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signal_achat boolean DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signal_achat_score integer DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signal_achat_le timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS signal_achat_reponse text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS froid_le timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS passage_froid_le timestamptz;
