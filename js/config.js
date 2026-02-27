// DeskMan Configuration
// Replace these values with your Supabase project credentials
const DESKMAN_CONFIG = {
    SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',
    SUPABASE_ANON_KEY: 'YOUR_ANON_KEY_HERE',
    // GitHub repo for agent source downloads (used by the build command generator)
    GITHUB_REPO: 'shafferelisa9-cell/deskman',
    GITHUB_BRANCH: 'main',
    // How often (ms) to poll for agent status updates as a fallback
    AGENT_POLL_INTERVAL: 30000,
    // Seconds after which an agent is considered stale
    AGENT_STALE_THRESHOLD: 120,
    // Maximum event logs to keep in the UI
    MAX_UI_LOGS: 200,
    // Maximum console output lines
    MAX_CONSOLE_LINES: 500,
};
