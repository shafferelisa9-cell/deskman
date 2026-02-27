-- DeskMan: Desktop Management System
-- Supabase Database Schema
-- Run this in your Supabase SQL Editor to set up the backend

-- ============================================================
-- TABLES
-- ============================================================

-- Registered endpoint agents
CREATE TABLE agents (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT UNIQUE NOT NULL,
    hostname TEXT NOT NULL,
    username TEXT,
    ip_address TEXT,
    os_info TEXT,
    status TEXT DEFAULT 'online' CHECK (status IN ('online', 'offline', 'sleeping')),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    system_info JSONB DEFAULT '{}'
);

-- Commands queued for agents
CREATE TABLE commands (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Results returned from executed commands
CREATE TABLE command_results (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    command_id UUID NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    output TEXT,
    exit_code INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cached file system listings from agents
CREATE TABLE file_listings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    entries JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, path)
);

-- Screenshot metadata (images stored in Supabase Storage)
CREATE TABLE screenshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    captured_at TIMESTAMPTZ DEFAULT NOW()
);

-- System event logs
CREATE TABLE event_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT,
    log_type TEXT DEFAULT 'info' CHECK (log_type IN ('info', 'success', 'warning', 'error')),
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active listeners configuration
CREATE TABLE listeners (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    port INTEGER NOT NULL UNIQUE,
    protocol TEXT DEFAULT 'tcp',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_last_seen ON agents(last_seen);
CREATE INDEX idx_commands_agent_id ON commands(agent_id);
CREATE INDEX idx_commands_status ON commands(status);
CREATE INDEX idx_command_results_command_id ON command_results(command_id);
CREATE INDEX idx_file_listings_agent_path ON file_listings(agent_id, path);
CREATE INDEX idx_screenshots_agent_id ON screenshots(agent_id);
CREATE INDEX idx_event_logs_created ON event_logs(created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE listeners ENABLE ROW LEVEL SECURITY;

-- Allow authenticated dashboard users full access
CREATE POLICY "Authenticated users can manage agents"
    ON agents FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can manage commands"
    ON commands FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read command results"
    ON command_results FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can manage file listings"
    ON file_listings FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can manage screenshots"
    ON screenshots FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can manage event logs"
    ON event_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can manage listeners"
    ON listeners FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Allow the agent (using service_role key) full access via anon role as well
-- The agent uses the service_role key which bypasses RLS entirely.
-- For the dashboard to also work with the anon key during development:
CREATE POLICY "Anon read agents" ON agents FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read commands" ON commands FOR SELECT TO anon USING (true);
CREATE POLICY "Anon insert commands" ON commands FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon update commands" ON commands FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon read command results" ON command_results FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read file listings" ON file_listings FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read screenshots" ON screenshots FOR SELECT TO anon USING (true);
CREATE POLICY "Anon manage event logs" ON event_logs FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Anon manage listeners" ON listeners FOR ALL TO anon USING (true) WITH CHECK (true);

-- ============================================================
-- STORAGE BUCKET
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('screenshots', 'screenshots', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public screenshot read access"
    ON storage.objects FOR SELECT TO anon
    USING (bucket_id = 'screenshots');

CREATE POLICY "Authenticated screenshot upload"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'screenshots');

CREATE POLICY "Service role screenshot upload"
    ON storage.objects FOR INSERT TO anon
    WITH CHECK (bucket_id = 'screenshots');

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Function to mark stale agents as offline (run periodically or via cron)
CREATE OR REPLACE FUNCTION mark_stale_agents_offline()
RETURNS void AS $$
BEGIN
    UPDATE agents
    SET status = 'offline'
    WHERE status != 'offline'
      AND last_seen < NOW() - INTERVAL '2 minutes';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old command results (keep last 1000 per agent)
CREATE OR REPLACE FUNCTION cleanup_old_results()
RETURNS void AS $$
BEGIN
    DELETE FROM command_results
    WHERE id NOT IN (
        SELECT id FROM command_results
        ORDER BY created_at DESC
        LIMIT 10000
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- REALTIME
-- ============================================================

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE agents;
ALTER PUBLICATION supabase_realtime ADD TABLE commands;
ALTER PUBLICATION supabase_realtime ADD TABLE command_results;
ALTER PUBLICATION supabase_realtime ADD TABLE event_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE file_listings;
ALTER PUBLICATION supabase_realtime ADD TABLE screenshots;

-- ============================================================
-- SEED DATA: Default listener
-- ============================================================

INSERT INTO listeners (port, protocol, status) VALUES (443, 'https', 'active')
ON CONFLICT (port) DO NOTHING;
