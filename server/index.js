'use strict';

/**
 * MobiSSH PWA — WebSocket SSH Bridge + Static File Server
 *
 * Serves the PWA frontend on HTTP and the SSH bridge on WebSocket,
 * both on the same port so only one endpoint needs to be exposed.
 *
 * Protocol (JSON messages):
 *
 *   Client → Server:
 *     { type: 'connect', host, port, username, password? }
 *     { type: 'connect', host, port, username, privateKey? }
 *     { type: 'input', data: string }
 *     { type: 'resize', cols: number, rows: number }
 *     { type: 'disconnect' }
 *     { type: 'hostkey_response', accepted: boolean }
 *     { type: 'sftp_open' }
 *     { type: 'sftp_readdir', path: string }
 *     { type: 'sftp_download', path: string, transferId: string }
 *     { type: 'sftp_download_dir', path: string, transferId: string }
 *     { type: 'sftp_download_batch', paths: string[], transferId: string }
 *     { type: 'sftp_upload_start', remotePath: string, transferId: string, size: number }
 *     { type: 'sftp_upload_chunk', transferId: string, data: string }  (base64)
 *     { type: 'sftp_upload_end', transferId: string }
 *     { type: 'sftp_mkdir', path: string }
 *     { type: 'sftp_rm', path: string }
 *     { type: 'sftp_rm_recursive', path: string, transferId: string }
 *     { type: 'sftp_rename', oldPath: string, newPath: string }
 *     { type: 'sftp_close' }
 *
 *   Server → Client:
 *     { type: 'connected' }
 *     { type: 'output', data: string }
 *     { type: 'error', message: string }
 *     { type: 'disconnected', reason: string }
 *     { type: 'hostkey', host, port, keyType, fingerprint }
 *     { type: 'sftp_ready', homedir: string }
 *     { type: 'sftp_readdir_result', path: string, entries: SftpEntry[] }
 *     { type: 'sftp_download_start', transferId: string, size: number|null, filename: string }
 *     { type: 'sftp_download_chunk', transferId: string, data: string }  (base64)
 *     { type: 'sftp_download_end', transferId: string }
 *     { type: 'sftp_download_dir_progress', transferId: string, filesProcessed: number, totalFiles: number }
 *     { type: 'sftp_upload_progress', transferId: string, received: number }
 *     { type: 'sftp_upload_done', transferId: string, remotePath: string }
 *     { type: 'sftp_rm_recursive_result', transferId: string }
 *     { type: 'sftp_rename_result', oldPath: string, newPath: string }
 *     { type: 'sftp_error', op: string, path: string, message: string, transferId?: string }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const { Client } = require('ssh2');
let archiver;
try { archiver = require('archiver'); } catch (_) { archiver = null; }

const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';
// BASE_PATH: set when served behind a reverse-proxy at a subpath (e.g. /ssh).
// Must start with / and have no trailing slash.  Example: BASE_PATH=/ssh
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ─── WS upgrade authentication (issue #93) ────────────────────────────────────
// Per-boot secret — never stored, never logged, never leaves this process.
const SESSION_SECRET = randomBytes(32);
// Token expiry: 1 hour by default; covers normal sessions and auto-reconnects.
const WS_TOKEN_EXPIRY_MS = parseInt(process.env.WS_TOKEN_EXPIRY_MS || '') || 3_600_000;

/** Produces a `timestamp:nonce:hmac` token signed with SESSION_SECRET. */
function generateWsToken() {
  const ts = Date.now().toString();
  const nonce = randomBytes(16).toString('hex');
  const mac = createHmac('sha256', SESSION_SECRET).update(`${ts}:${nonce}`).digest('hex');
  return `${ts}:${nonce}:${mac}`;
}

/** Returns true iff the token is well-formed, unexpired, and HMAC-valid. */
function validateWsToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [ts, nonce, mac] = parts;
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Date.now() - tsNum > WS_TOKEN_EXPIRY_MS) return false;
  const expected = createHmac('sha256', SESSION_SECRET).update(`${ts}:${nonce}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const macBuf = Buffer.from(mac);
  if (expectedBuf.length !== macBuf.length) return false;
  return timingSafeEqual(expectedBuf, macBuf);
}

const APP_VERSION = require('./package.json').version || '0.0.0';
let GIT_HASH = 'unknown';
try { GIT_HASH = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch (_) {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

/**
 * Rewrite manifest.json fields so the PWA installs correctly under any
 * reverse-proxy subpath (#83).
 *
 * - id: stable "mobissh" identity prevents collision with other apps
 * - start_url / scope: "./" is relative to the manifest URL, so Chrome
 *   resolves them to the correct subpath regardless of where the app is hosted
 */
function rewriteManifest(buf) {
  const manifest = JSON.parse(buf.toString());
  manifest.id = 'mobissh';
  manifest.start_url = './';
  manifest.scope = './';
  return Buffer.from(JSON.stringify(manifest));
}

// ─── HTTP server (static files) ───────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // /clear — nuke SW cache + storage so mobile browsers get a fresh start.
  // Visit https://<host>/ssh/clear after a bad SW deploy.
  // Uses JS instead of Clear-Site-Data header (which hangs on some mobile browsers).
  if (req.url === '/clear') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"></head>
<body><pre id="log">Clearing...</pre><script>
(async()=>{const l=document.getElementById('log');function log(m){l.textContent+=m+'\\n'}
try{const regs=await navigator.serviceWorker.getRegistrations();
for(const r of regs){await r.unregister();log('Unregistered SW: '+r.scope)}
}catch(e){log('SW: '+e.message)}
try{const keys=await caches.keys();
for(const k of keys){await caches.delete(k);log('Deleted cache: '+k)}
}catch(e){log('Cache: '+e.message)}
try{localStorage.clear();log('localStorage cleared')}catch(e){}
try{sessionStorage.clear();log('sessionStorage cleared')}catch(e){}
log('\\nDone. Redirecting...');setTimeout(()=>location.href='./',1500)})();
</script></body></html>`);
    return;
  }

  const urlPath = req.url.split('?')[0];
  const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, rel === '/' || rel === '' ? 'index.html' : rel);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      let html = data.toString();
      // Inject version meta tag so the client can display build info.
      html = html.replace(
        '<head>',
        `<head><meta name="app-version" content="${APP_VERSION}:${GIT_HASH}">`
      );
      // Inject base path so the client knows the subpath without unsafe-inline CSP.
      if (BASE_PATH) {
        html = html.replace(
          '<head>',
          `<head><meta name="app-base-path" content="${BASE_PATH}">`
        );
      }
      // Inject a fresh per-page-load HMAC token for WS upgrade auth (#93).
      html = html.replace(
        '<head>',
        `<head><meta name="ws-token" content="${generateWsToken()}">`
      );
      data = Buffer.from(html);
    }
    // Rewrite manifest.json when serving under a subpath so the PWA installs
    // at the correct path and has a stable identity (#83).
    if (path.basename(filePath) === 'manifest.json' && BASE_PATH) {
      try { data = rewriteManifest(data); } catch (_) {}
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' wss: ws:",
        "img-src 'self' data: blob:",
        "worker-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    res.end(data);
  });
});

// ─── WebSocket server (SSH bridge) ────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 4 * 1024 * 1024;
const WS_PING_INTERVAL_MS = 25_000;

// ─── Rate limiting / concurrency guard (issue #92) ────────────────────────────
const MAX_CONNS_PER_IP    = 5;        // max new connection attempts per window
const THROTTLE_WINDOW_MS  = 10_000;  // sliding window duration (ms)
const MAX_ACTIVE_PER_IP   = 3;        // max concurrent WS/SSH sessions per IP

// ip → { attempts: number, windowStart: number, active: number }
const connTracker = new Map();

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_MESSAGE_SIZE,
  verifyClient({ req }, callback) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!validateWsToken(token)) {
      callback(false, 401, 'Unauthorized');
      return;
    }
    callback(true);
  },
});

// WebSocket-level ping/pong to keep idle connections alive through proxies/NAT.
// Any client that doesn't pong within one interval is terminated.
// Only started when the server is actually running (not when imported for tests).
if (require.main === module) {
  const wsPingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client._pongPending) {
        client.terminate();
        return;
      }
      client._pongPending = true;
      client.ping();
    });
  }, WS_PING_INTERVAL_MS);

  // Periodically evict stale connTracker entries to prevent unbounded Map growth.
  // Only remove entries with no active sessions and an expired attempt window.
  const connSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, track] of connTracker) {
      if (track.active === 0 && now - track.windowStart > THROTTLE_WINDOW_MS) {
        connTracker.delete(ip);
      }
    }
  }, 60_000);

  wss.on('close', () => {
    clearInterval(wsPingInterval);
    clearInterval(connSweepInterval);
  });
}

// ─── SSRF prevention (issue #6) ───────────────────────────────────────────────
// Blocks RFC-1918 private, loopback, and link-local addresses by default.
// Clients may send allowPrivate:true to override (controlled by the danger zone
// setting in the frontend — only for users who explicitly opt in).

function isPrivateHost(host) {
  const h = host.trim().toLowerCase();
  // Loopback / unspecified
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.startsWith('127.')) return true;           // 127.0.0.0/8
  // RFC-1918 ranges
  if (h.startsWith('10.')) return true;            // 10.0.0.0/8
  if (h.startsWith('192.168.')) return true;       // 192.168.0.0/16
  // 172.16.0.0/12 = 172.16.x – 172.31.x
  const m = h.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1]) >= 16 && parseInt(m[1]) <= 31) return true;
  // IPv6 link-local and ULA
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

wss.on('connection', (ws, req) => {
  ws.on('pong', () => { ws._pongPending = false; });

  const clientIP = getIP(req);
  const now = Date.now();

  // Initialise or retrieve the tracker entry for this IP.
  if (!connTracker.has(clientIP)) {
    connTracker.set(clientIP, { attempts: 0, windowStart: now, active: 0 });
  }
  const track = connTracker.get(clientIP);

  // Reset attempt counter when the window has expired.
  if (now - track.windowStart > THROTTLE_WINDOW_MS) {
    track.attempts = 0;
    track.windowStart = now;
  }
  track.attempts++;

  if (track.attempts > MAX_CONNS_PER_IP) {
    console.warn(`[ssh-bridge] Rate limited: ${clientIP} (${track.attempts} attempts in window)`);
    ws.close(1008, 'Rate limited');
    return;
  }

  if (track.active >= MAX_ACTIVE_PER_IP) {
    console.warn(`[ssh-bridge] Connection cap reached: ${clientIP} (${track.active} active)`);
    ws.close(1008, 'Too many connections');
    return;
  }

  track.active++;
  console.log(`[ssh-bridge] Client connected: ${clientIP} (active: ${track.active})`);

  let sshClient = null;
  let sshStream = null;
  let connecting = false;
  let pendingVerify = null; // hostVerifier callback waiting for client response (#5)

  // ── SFTP state ────────────────────────────────────────────────────────────
  let sftpChannel = null;
  const sftpUploads = new Map(); // transferId → { stream, remotePath, received }
  const sftpDownloads = new Map(); // transferId → { cancelled: bool }

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function cleanup(reason) {
    pendingVerify = null; // discard any pending host-key verification (#5)
    // Clean up SFTP uploads
    for (const [, upload] of sftpUploads) {
      try { upload.stream.destroy(); } catch (_) {}
    }
    sftpUploads.clear();
    // Mark downloads as cancelled
    for (const [, dl] of sftpDownloads) { dl.cancelled = true; }
    sftpDownloads.clear();
    // Close SFTP channel
    if (sftpChannel) {
      try { sftpChannel.end(); } catch (_) {}
      sftpChannel = null;
    }
    if (sshStream) {
      try { sshStream.close(); } catch (_) {}
      sshStream = null;
    }
    if (sshClient) {
      try { sshClient.end(); } catch (_) {}
      sshClient = null;
    }
    connecting = false;
    if (reason) {
      send({ type: 'disconnected', reason });
      console.log(`[ssh-bridge] Session ended (${clientIP}): ${reason}`);
    }
  }

  // ── SFTP helpers ─────────────────────────────────────────────────────────

  /** Recursively walk a remote directory, returning all file paths. */
  async function sftpWalkDir(sftp, dirPath, basePath) {
    const results = [];
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) reject(err); else resolve(list);
      });
    });
    for (const entry of entries) {
      const fullPath = dirPath.replace(/\/$/, '') + '/' + entry.filename;
      if (entry.attrs.isDirectory()) {
        const sub = await sftpWalkDir(sftp, fullPath, basePath);
        results.push(...sub);
      } else {
        results.push({ fullPath, relPath: fullPath.slice(basePath.length).replace(/^\//, ''), size: entry.attrs.size });
      }
    }
    return results;
  }

  /** Stream a set of files as a ZIP archive over WebSocket. */
  async function sftpStreamZip(sftp, files, transferId, zipBaseName) {
    if (!archiver) {
      send({ type: 'sftp_error', op: 'download_zip', path: zipBaseName, message: 'archiver module not available — run npm install in server/' });
      return;
    }
    const dlState = { cancelled: false };
    sftpDownloads.set(transferId, dlState);

    send({ type: 'sftp_download_start', transferId, size: null, filename: zipBaseName + '.zip' });

    const arc = archiver('zip', { zlib: { level: 1 } });

    arc.on('data', (chunk) => {
      if (!dlState.cancelled && ws.readyState === WebSocket.OPEN) {
        send({ type: 'sftp_download_chunk', transferId, data: chunk.toString('base64') });
      }
    });

    arc.on('end', () => {
      sftpDownloads.delete(transferId);
      if (!dlState.cancelled) send({ type: 'sftp_download_end', transferId });
    });

    arc.on('error', (err) => {
      sftpDownloads.delete(transferId);
      send({ type: 'sftp_error', op: 'download_zip', path: zipBaseName, message: err.message, transferId });
    });

    for (let i = 0; i < files.length; i++) {
      if (dlState.cancelled) break;
      const file = files[i];
      arc.append(sftp.createReadStream(file.fullPath), { name: file.relPath });
      send({ type: 'sftp_download_dir_progress', transferId, filesProcessed: i + 1, totalFiles: files.length });
    }

    arc.finalize();
  }

  function connect(cfg) {
    if (connecting || sshClient) {
      send({ type: 'error', message: 'Already connected or connecting' });
      return;
    }
    connecting = true;

    if (!cfg.host || !cfg.username) {
      send({ type: 'error', message: 'host and username are required' });
      connecting = false;
      return;
    }

    if (isPrivateHost(cfg.host) && !cfg.allowPrivate) {
      send({ type: 'error', message: 'Connections to private/loopback addresses are blocked. Enable "Allow private addresses" in Settings → Danger Zone to override.' });
      connecting = false;
      return;
    }

    sshClient = new Client();

    sshClient.on('ready', () => {
      console.log(`[ssh-bridge] SSH ready: ${cfg.username}@${cfg.host}:${cfg.port || 22}`);
      sshClient.shell(
        { term: 'xterm-256color', cols: 80, rows: 24 },
        (err, stream) => {
          if (err) {
            send({ type: 'error', message: `Shell error: ${err.message}` });
            cleanup(err.message);
            return;
          }
          sshStream = stream;
          connecting = false;
          send({ type: 'connected' });

          stream.on('data', (chunk) => {
            send({ type: 'output', data: chunk.toString('utf8') });
          });
          stream.stderr.on('data', (chunk) => {
            send({ type: 'output', data: chunk.toString('utf8') });
          });
          stream.on('close', () => {
            cleanup('SSH stream closed');
          });

          if (cfg.initialCommand) {
            stream.write(cfg.initialCommand + '\r');
          }
        }
      );
    });

    // ssh2 fires both 'end' and 'close' for a single tear-down; only handle once.
    let sshClosed = false;
    function sshCleanup(reason) {
      if (sshClosed) return;
      sshClosed = true;
      cleanup(reason);
    }

    sshClient.on('error', (err) => {
      send({ type: 'error', message: err.message });
      sshCleanup(err.message);
    });
    sshClient.on('end', () => { sshCleanup('SSH connection ended'); });
    sshClient.on('close', () => { sshCleanup('SSH connection closed'); });

    const sshConfig = {
      host: cfg.host,
      port: parseInt(cfg.port) || 22,
      username: cfg.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,  // SSH-layer keepalive every 15s
      keepaliveCountMax: 4,       // drop after 4 unanswered (~60s)
      hostVerifier(keyBuffer, verify) {
        // Compute SHA-256 fingerprint in OpenSSH format (#5)
        const fp = createHash('sha256').update(keyBuffer).digest('base64');
        const fingerprint = `SHA256:${fp}`;

        // Parse key type from SSH wire-format: uint32 len + ASCII string
        let keyType = 'unknown';
        try {
          const typeLen = keyBuffer.readUInt32BE(0);
          keyType = keyBuffer.slice(4, 4 + typeLen).toString('ascii');
        } catch (_) {}

        // Suspend KEX until the browser client accepts or rejects the key
        pendingVerify = verify;
        send({ type: 'hostkey', host: cfg.host, port: parseInt(cfg.port) || 22, keyType, fingerprint });
      },
    };

    if (cfg.privateKey) {
      sshConfig.privateKey = cfg.privateKey;
      if (cfg.passphrase) sshConfig.passphrase = cfg.passphrase;
    } else if (cfg.password) {
      sshConfig.password = cfg.password;
    } else {
      send({ type: 'error', message: 'No authentication method provided' });
      connecting = false;
      sshClient = null;
      return;
    }

    try {
      sshClient.connect(sshConfig);
    } catch (err) {
      send({ type: 'error', message: `Connect failed: ${err.message}` });
      cleanup(err.message);
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) {
      send({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'connect':    connect(msg); break;
      case 'input':
        if (sshStream && typeof msg.data === 'string') sshStream.write(msg.data);
        break;
      case 'resize':
        if (sshStream && msg.cols && msg.rows)
          sshStream.setWindow(parseInt(msg.rows), parseInt(msg.cols), 0, 0);
        break;
      case 'disconnect': cleanup('User disconnected'); break;
      case 'ping': break; // application-layer keepalive (#29), no response needed
      case 'hostkey_response': // host key accept/reject from browser client (#5)
        if (pendingVerify) {
          const fn = pendingVerify;
          pendingVerify = null;
          fn(msg.accepted === true);
          // If rejected, ssh2 emits an error event which calls cleanup naturally
        }
        break;

      // ── SFTP handlers ──────────────────────────────────────────────────────
      case 'sftp_open':
        if (!sshClient) { send({ type: 'sftp_error', op: 'open', path: '', message: 'No SSH session active — connect first' }); break; }
        if (sftpChannel) { send({ type: 'sftp_ready', homedir: '' }); break; }
        sshClient.sftp((err, sftp) => {
          if (err) { send({ type: 'sftp_error', op: 'open', path: '', message: err.message }); return; }
          sftpChannel = sftp;
          sftp.realpath('.', (e, absPath) => {
            send({ type: 'sftp_ready', homedir: e ? '/' : absPath });
          });
          sftp.on('end', () => { sftpChannel = null; });
          sftp.on('close', () => { sftpChannel = null; });
          sftp.on('error', () => { sftpChannel = null; });
        });
        break;

      case 'sftp_close':
        if (sftpChannel) { try { sftpChannel.end(); } catch (_) {} sftpChannel = null; }
        break;

      case 'sftp_readdir':
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'readdir', path: msg.path || '', message: 'SFTP not open' }); break; }
        sftpChannel.readdir(msg.path, (err, list) => {
          if (err) { send({ type: 'sftp_error', op: 'readdir', path: msg.path, message: err.message }); return; }
          const entries = (list || []).map((e) => ({
            name: e.filename,
            type: e.attrs.isDirectory() ? 'dir' : (e.attrs.isSymbolicLink ? 'symlink' : 'file'),
            size: e.attrs.size || 0,
            mtime: e.attrs.mtime || 0,
            mode: e.attrs.mode || 0,
          }));
          send({ type: 'sftp_readdir_result', path: msg.path, entries });
        });
        break;

      case 'sftp_download': {
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'download', path: msg.path || '', message: 'SFTP not open', transferId: msg.transferId }); break; }
        const dlId = msg.transferId || randomBytes(8).toString('hex');
        const dlState = { cancelled: false };
        sftpDownloads.set(dlId, dlState);
        sftpChannel.stat(msg.path, (statErr, attrs) => {
          const fileSize = statErr ? null : attrs.size;
          const filename = msg.path.split('/').pop() || 'download';
          send({ type: 'sftp_download_start', transferId: dlId, size: fileSize, filename });
          const readStream = sftpChannel.createReadStream(msg.path);
          readStream.on('data', (chunk) => {
            if (!dlState.cancelled && ws.readyState === WebSocket.OPEN) {
              send({ type: 'sftp_download_chunk', transferId: dlId, data: chunk.toString('base64') });
            }
          });
          readStream.on('end', () => {
            sftpDownloads.delete(dlId);
            if (!dlState.cancelled) send({ type: 'sftp_download_end', transferId: dlId });
          });
          readStream.on('error', (err) => {
            sftpDownloads.delete(dlId);
            send({ type: 'sftp_error', op: 'download', path: msg.path, message: err.message, transferId: dlId });
          });
        });
        break;
      }

      case 'sftp_download_dir': {
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'download_dir', path: msg.path || '', message: 'SFTP not open', transferId: msg.transferId }); break; }
        const dirId = msg.transferId || randomBytes(8).toString('hex');
        const baseName = msg.path.replace(/\/$/, '').split('/').pop() || 'download';
        const sftp = sftpChannel;
        sftpWalkDir(sftp, msg.path, msg.path)
          .then((files) => sftpStreamZip(sftp, files, dirId, baseName))
          .catch((err) => send({ type: 'sftp_error', op: 'download_dir', path: msg.path, message: err.message, transferId: dirId }));
        break;
      }

      case 'sftp_download_batch': {
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'download_batch', path: '', message: 'SFTP not open', transferId: msg.transferId }); break; }
        if (!Array.isArray(msg.paths) || msg.paths.length === 0) { send({ type: 'sftp_error', op: 'download_batch', path: '', message: 'No paths provided', transferId: msg.transferId }); break; }
        const batchId = msg.transferId || randomBytes(8).toString('hex');
        const sftp = sftpChannel;
        // Determine common parent for relative paths
        const parentPath = msg.paths[0].split('/').slice(0, -1).join('/') || '/';
        const batchBaseName = 'download_' + new Date().toISOString().slice(0, 10);
        // Collect all files: for each path, if dir walk it, if file add directly
        (async () => {
          const allFiles = [];
          for (const p of msg.paths) {
            try {
              const statResult = await new Promise((resolve, reject) => {
                sftp.stat(p, (e, a) => { if (e) reject(e); else resolve(a); });
              });
              if (statResult.isDirectory()) {
                const sub = await sftpWalkDir(sftp, p, parentPath);
                allFiles.push(...sub);
              } else {
                allFiles.push({ fullPath: p, relPath: p.slice(parentPath.length).replace(/^\//, ''), size: statResult.size });
              }
            } catch (err) {
              console.warn(`[sftp-batch] stat failed for ${p}: ${err.message}`);
            }
          }
          await sftpStreamZip(sftp, allFiles, batchId, batchBaseName);
        })().catch((err) => send({ type: 'sftp_error', op: 'download_batch', path: '', message: err.message, transferId: batchId }));
        break;
      }

      case 'sftp_upload_start': {
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'upload', path: msg.remotePath || '', message: 'SFTP not open', transferId: msg.transferId }); break; }
        const upId = msg.transferId || randomBytes(8).toString('hex');
        const writeStream = sftpChannel.createWriteStream(msg.remotePath);
        sftpUploads.set(upId, { stream: writeStream, remotePath: msg.remotePath, received: 0 });
        writeStream.on('error', (err) => {
          sftpUploads.delete(upId);
          send({ type: 'sftp_error', op: 'upload', path: msg.remotePath, message: err.message, transferId: upId });
        });
        break;
      }

      case 'sftp_upload_chunk': {
        const upload = sftpUploads.get(msg.transferId);
        if (!upload) break;
        const chunk = Buffer.from(msg.data, 'base64');
        upload.received += chunk.length;
        upload.stream.write(chunk);
        send({ type: 'sftp_upload_progress', transferId: msg.transferId, received: upload.received });
        break;
      }

      case 'sftp_upload_end': {
        const upload = sftpUploads.get(msg.transferId);
        if (!upload) break;
        upload.stream.end(() => {
          sftpUploads.delete(msg.transferId);
          send({ type: 'sftp_upload_done', transferId: msg.transferId, remotePath: upload.remotePath });
        });
        break;
      }

      case 'sftp_mkdir':
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'mkdir', path: msg.path || '', message: 'SFTP not open' }); break; }
        sftpChannel.mkdir(msg.path, (err) => {
          if (err) send({ type: 'sftp_error', op: 'mkdir', path: msg.path, message: err.message });
          else send({ type: 'sftp_readdir_result', path: '', entries: [] }); // signal success via reload
        });
        break;

      case 'sftp_rm':
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'rm', path: msg.path || '', message: 'SFTP not open' }); break; }
        sftpChannel.unlink(msg.path, (err) => {
          if (err) send({ type: 'sftp_error', op: 'rm', path: msg.path, message: err.message });
        });
        break;

      case 'sftp_rm_recursive': {
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'rm_recursive', path: msg.path || '', message: 'SFTP not open', transferId: msg.transferId }); break; }
        const sftp = sftpChannel;
        const rmId = msg.transferId || randomBytes(8).toString('hex');
        const rmRecursive = async (p) => {
          const attrs = await new Promise((resolve, reject) => {
            sftp.stat(p, (e, a) => { if (e) reject(e); else resolve(a); });
          });
          if (attrs.isDirectory()) {
            const entries = await new Promise((resolve, reject) => {
              sftp.readdir(p, (e, l) => { if (e) reject(e); else resolve(l); });
            });
            for (const entry of entries) {
              await rmRecursive(p.replace(/\/$/, '') + '/' + entry.filename);
            }
            await new Promise((resolve, reject) => {
              sftp.rmdir(p, (e) => { if (e) reject(e); else resolve(); });
            });
          } else {
            await new Promise((resolve, reject) => {
              sftp.unlink(p, (e) => { if (e) reject(e); else resolve(); });
            });
          }
        };
        rmRecursive(msg.path)
          .then(() => send({ type: 'sftp_rm_recursive_result', transferId: rmId }))
          .catch((err) => send({ type: 'sftp_error', op: 'rm_recursive', path: msg.path, message: err.message, transferId: rmId }));
        break;
      }

      case 'sftp_rename':
        if (!sftpChannel) { send({ type: 'sftp_error', op: 'rename', path: msg.oldPath || '', message: 'SFTP not open' }); break; }
        sftpChannel.rename(msg.oldPath, msg.newPath, (err) => {
          if (err) send({ type: 'sftp_error', op: 'rename', path: msg.oldPath, message: err.message });
          else send({ type: 'sftp_rename_result', oldPath: msg.oldPath, newPath: msg.newPath });
        });
        break;

      default: send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    const t = connTracker.get(clientIP);
    if (t) t.active = Math.max(0, t.active - 1);
    console.log(`[ssh-bridge] WebSocket closed: ${clientIP}`);
    cleanup(null);
  });
  ws.on('error', (err) => {
    console.error(`[ssh-bridge] WebSocket error (${clientIP}):`, err.message);
    cleanup(err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[ssh-bridge] Listening on http://${HOST}:${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('[ssh-bridge] SIGTERM — shutting down');
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    console.log('[ssh-bridge] SIGINT — shutting down');
    server.close(() => process.exit(0));
  });
}

module.exports = { rewriteManifest, server };
