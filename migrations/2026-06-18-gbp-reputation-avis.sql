-- Migration: Table reputation_avis pour Google Business Profile
-- Date: 2026-06-18
-- Action: Créer la table qui stocke les avis Google récupérés via GBP API

CREATE TABLE IF NOT EXISTS public.reputation_avis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    avis_id TEXT UNIQUE NOT NULL,          -- Google reviewId
    auteur TEXT NOT NULL,
    note NUMERIC(2,1) NOT NULL CHECK (note >= 1 AND note <= 5),
    contenu TEXT,
    date_avis TIMESTAMPTZ,
    date_recuperation TIMESTAMPTZ DEFAULT now(),
    repondu BOOLEAN DEFAULT false,
    reponse TEXT,
    location_name TEXT,                    -- Nom de l'établissement GBP
    source TEXT DEFAULT 'google_my_business',
    synced_at TIMESTAMPTZ DEFAULT now()
);

-- Index pour recherche rapide
CREATE INDEX IF NOT EXISTS idx_reputation_avis_date ON public.reputation_avis (date_avis DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_avis_note ON public.reputation_avis (note);
CREATE INDEX IF NOT EXISTS idx_reputation_avis_source ON public.reputation_avis (source);
CREATE INDEX IF NOT EXISTS idx_reputation_avis_repondu ON public.reputation_avis (repondu);

-- Enable RLS
ALTER TABLE public.reputation_avis ENABLE ROW LEVEL SECURITY;

-- RLS: service_role bypass (utilisé par l'agent), public read-only
CREATE POLICY "Service role full access" ON public.reputation_avis
    FOR ALL USING (true) WITH CHECK (true);

-- Trigger auto update synced_at
CREATE OR REPLACE FUNCTION update_synced_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.synced_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_reputation_avis_synced_at ON public.reputation_avis;
CREATE TRIGGER update_reputation_avis_synced_at
    BEFORE UPDATE ON public.reputation_avis
    FOR EACH ROW EXECUTE FUNCTION update_synced_at_column();

-- Permission
GRANT ALL ON public.reputation_avis TO service_role;
GRANT SELECT ON public.reputation_avis TO anon, authenticated;
