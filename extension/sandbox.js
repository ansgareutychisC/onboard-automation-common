/**
 * Notion Bridge Sandbox — Page Context (zstd-native)
 *
 * Connects to the bridge via WebSocket. The sandbox page runs in a full
 * Chrome page context where Chrome's network stack handles zstd natively.
 */

let ws = null;
let keepalive = null;
const stats = { fetched: 0, bytes: 0, errors: 0 };

function log(level, msg, data) {
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + (level || 'info');
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    entry.textContent = `[${time}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    const logEl = document.getElementById('log');
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 100) logEl.removeChild(logEl.firstChild);
}

function updateStatus(connected) {
    const el = document.getElementById('status');
    el.className = 'status ' + (connected ? 'connected' : 'disconnected');
    el.textContent = connected ? '✓ Connected to bridge' : '✗ Disconnected — will retry in 5s';
}

function updateStats() {
    document.getElementById('fetched').textContent = stats.fetched;
    document.getElementById('bytes').textContent = (stats.bytes / 1024).toFixed(1) + 'K';
    document.getElementById('errors').textContent = stats.errors;
}

function getBridgeUrl() {
    // Check URL query param first: ?server=ws://host:port
    const params = new URLSearchParams(location.search);
    const fromParam = params.get('server');
    if (fromParam) return fromParam;

    // Default: use the public preview URL (same as the extension service worker)
    return 'wss://preview-chat-672657de-8fc2-47b1-8770-916464a90553.space-z.ai/?XTransformPort=8787';
}

function connect() {
    const url = getBridgeUrl();
    log('info', 'Connecting to ' + url);
    updateStatus(false);

    try {
        ws = new WebSocket(url);
    } catch (e) {
        log('error', 'WebSocket failed: ' + e.message);
        setTimeout(connect, 5000);
        return;
    }

    ws.onopen = () => {
        log('success', 'Connected to bridge');
        updateStatus(true);
        ws.send(JSON.stringify({
            type: 'connect',
            agentId: 'sandbox-page',
            userAgent: navigator.userAgent,
            hostname: 'sandbox-page',
            context: 'page',
        }));
        keepalive = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            }
        }, 25000);
    };

    ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }

        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            return;
        }

        if (msg.type === 'sandbox.fetch') {
            await handleFetch(msg);
        }
    };

    ws.onerror = () => {
        log('error', 'WebSocket error');
    };

    ws.onclose = () => {
        updateStatus(false);
        if (keepalive) { clearInterval(keepalive); keepalive = null; }
        setTimeout(connect, 5000);
    };
}

async function handleFetch(cmd) {
    const { id, url, method, headers, body, credentials, timeoutMs } = cmd;
    log('info', `→ ${method || 'GET'} ${url.slice(0, 80)}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);

    try {
        const options = {
            method: method || 'GET',
            headers: headers || {},
            credentials: credentials || 'include',
            signal: controller.signal,
        };
        if (body && method !== 'GET' && method !== 'HEAD') {
            options.body = body;
        }

        // KEY: This is a PAGE context. Chrome's network stack handles
        // zstd/gzip/deflate decompression natively. res.text() returns
        // the FULL decompressed response.
        const res = await fetch(url, options);
        const text = await res.text();

        const responseHeaders = {};
        res.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });

        stats.fetched++;
        stats.bytes += text.length;
        updateStats();

        log('success', `← ${res.status} ${text.length} bytes (encoding: ${responseHeaders['content-encoding'] || 'none'})`);

        ws.send(JSON.stringify({
            type: 'result',
            id,
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            body: text,
            finalUrl: res.url,
            headers: responseHeaders,
        }));
    } catch (err) {
        stats.errors++;
        updateStats();
        log('error', `✗ ${err.message}`);
        ws.send(JSON.stringify({
            type: 'result',
            id,
            ok: false,
            error: err.message,
        }));
    } finally {
        clearTimeout(timer);
    }
}

connect();
