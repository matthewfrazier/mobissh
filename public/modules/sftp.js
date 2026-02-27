/**
 * modules/sftp.ts — SFTP file browser state and transfer logic
 *
 * Manages SFTP channel lifecycle, directory cache with background refresh,
 * file upload/download (single, directory, batch), and clipboard operations.
 * Communicates with the server via the existing WebSocket connection.
 */
import { registerMessageHandler, sendWsMessage } from './connection.js';
import { appState } from './state.js';
export const sftpState = {
    ready: false,
    homedir: '/',
    currentPath: '/',
    loadingPaths: new Set(),
    entries: [],
    dirCache: new Map(),
    transfers: new Map(),
    selectMode: false,
    selectedPaths: new Set(),
};
// ── Internal ──────────────────────────────────────────────────────────────────
const DIR_CACHE_TTL_MS = 30_000;
const UPLOAD_CHUNK_SIZE = 65536; // 64 KB
let _toast = (_msg) => { };
let _onStateChange = () => { };
let _nextTransferId = 0;
function _genId() {
    return `t${String(Date.now())}_${String(_nextTransferId++)}`;
}
function _notify() {
    _onStateChange();
}
function _sortEntries(entries) {
    return [...entries].sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir')
            return -1;
        if (a.type !== 'dir' && b.type === 'dir')
            return 1;
        return a.name.localeCompare(b.name);
    });
}
// ── Init ──────────────────────────────────────────────────────────────────────
export function initSftp({ toast, onStateChange }) {
    _toast = toast;
    _onStateChange = onStateChange;
    registerMessageHandler('sftp_', _handleSftpMessage);
}
// ── Message handler ───────────────────────────────────────────────────────────
function _handleSftpMessage(rawMsg) {
    const msg = rawMsg;
    switch (msg.type) {
        case 'sftp_ready':
            sftpState.ready = true;
            sftpState.homedir = msg.homedir || '/';
            sftpState.currentPath = sftpState.homedir;
            _fetchDir(sftpState.homedir);
            _notify();
            break;
        case 'sftp_readdir_result':
            sftpState.loadingPaths.delete(msg.path);
            sftpState.dirCache.set(msg.path, { entries: msg.entries, fetchedAt: Date.now() });
            if (msg.path === sftpState.currentPath) {
                sftpState.entries = _sortEntries(msg.entries);
            }
            // Eagerly pre-fetch one level of dirs for instant sub-navigation
            for (const entry of msg.entries) {
                if (entry.type === 'dir') {
                    const childPath = _joinPath(msg.path, entry.name);
                    _fetchDir(childPath, /* background */ true);
                }
            }
            _notify();
            break;
        case 'sftp_download_start': {
            const t = sftpState.transfers.get(msg.transferId);
            if (t) {
                t.totalSize = msg.size;
                t.filename = msg.filename || t.filename;
                _notify();
            }
            break;
        }
        case 'sftp_download_chunk': {
            const t = sftpState.transfers.get(msg.transferId);
            if (t) {
                t.chunks.push(msg.data);
                t.receivedSize += Math.round(msg.data.length * 0.75); // approx decoded size
                _notify();
            }
            break;
        }
        case 'sftp_download_end': {
            const t = sftpState.transfers.get(msg.transferId);
            if (!t)
                break;
            t.status = 'done';
            const mimeType = t.clipboardMime ?? _guessMime(t.filename);
            const binaryChunks = t.chunks.map((b64) => {
                const bin = atob(b64);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++)
                    arr[i] = bin.charCodeAt(i);
                return arr;
            });
            const blob = new Blob(binaryChunks, { type: mimeType });
            if (t.toClipboard) {
                void _saveToClipboard(blob, mimeType, t.filename, t.id);
            }
            else {
                _triggerDownload(blob, t.filename);
            }
            // Keep transfer in list briefly so user sees Done state
            setTimeout(() => { sftpState.transfers.delete(t.id); _notify(); }, 3000);
            _notify();
            break;
        }
        case 'sftp_download_dir_progress': {
            const t = sftpState.transfers.get(msg.transferId);
            if (t) {
                t.totalSize = msg.totalFiles;
                t.receivedSize = msg.filesProcessed;
                _notify();
            }
            break;
        }
        case 'sftp_upload_progress': {
            const t = sftpState.transfers.get(msg.transferId);
            if (t) {
                t.receivedSize = msg.received;
                _notify();
            }
            break;
        }
        case 'sftp_upload_done': {
            const t = sftpState.transfers.get(msg.transferId);
            if (!t)
                break;
            // Apply pending rename if set
            if (t.pendingRename && t.serverPath) {
                const newPath = _joinPath(_parentPath(t.serverPath), t.pendingRename);
                sendWsMessage({ type: 'sftp_rename', oldPath: t.serverPath, newPath });
                t.serverPath = newPath;
                t.filename = t.pendingRename;
                t.pendingRename = undefined;
            }
            t.status = 'done';
            // Refresh current directory
            _fetchDir(sftpState.currentPath, false, true);
            setTimeout(() => { sftpState.transfers.delete(t.id); _notify(); }, 3000);
            _notify();
            break;
        }
        case 'sftp_rm_recursive_result':
            _fetchDir(sftpState.currentPath, false, true);
            break;
        case 'sftp_rename_result':
            _fetchDir(sftpState.currentPath, false, true);
            break;
        case 'sftp_error': {
            const errTransfer = msg.transferId ? sftpState.transfers.get(msg.transferId) : null;
            if (errTransfer) {
                errTransfer.status = 'error';
                errTransfer.error = msg.message;
                setTimeout(() => { sftpState.transfers.delete(errTransfer.id); _notify(); }, 5000);
            }
            _toast(`SFTP error (${msg.op}): ${msg.message}`);
            _notify();
            break;
        }
    }
}
// ── Internal helpers ──────────────────────────────────────────────────────────
function _joinPath(dir, name) {
    return dir.replace(/\/$/, '') + '/' + name;
}
function _parentPath(p) {
    const parts = p.replace(/\/$/, '').split('/');
    parts.pop();
    return parts.join('/') || '/';
}
function _fetchDir(dirPath, background = false, force = false) {
    if (sftpState.loadingPaths.has(dirPath))
        return;
    const cached = sftpState.dirCache.get(dirPath);
    const stale = !cached || Date.now() - cached.fetchedAt > DIR_CACHE_TTL_MS;
    if (!stale && !force) {
        // Serve from cache immediately; no server request needed
        if (dirPath === sftpState.currentPath) {
            sftpState.entries = _sortEntries(cached.entries);
            _notify();
        }
        return;
    }
    if (!background) {
        // Show cache immediately while fetching
        if (cached && dirPath === sftpState.currentPath) {
            sftpState.entries = _sortEntries(cached.entries);
            _notify();
        }
        sftpState.loadingPaths.add(dirPath);
        _notify();
    }
    else {
        sftpState.loadingPaths.add(dirPath);
    }
    sendWsMessage({ type: 'sftp_readdir', path: dirPath });
}
function _triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}
async function _saveToClipboard(blob, mimeType, filename, transferId) {
    try {
        if (mimeType.startsWith('text/')) {
            const text = await blob.text();
            await navigator.clipboard.writeText(text);
            _toast(`Copied ${filename} to clipboard`);
        }
        else if (mimeType.startsWith('image/') && 'write' in navigator.clipboard) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
            _toast(`Copied ${filename} to clipboard`);
        }
        else {
            // Fall back to file download for unsupported types
            _triggerDownload(blob, filename);
            _toast('Binary file — downloaded instead');
        }
        const t = sftpState.transfers.get(transferId);
        if (t) {
            t.status = 'done';
            _notify();
        }
    }
    catch {
        _toast('Clipboard access denied — downloading instead');
        _triggerDownload(blob, filename);
    }
}
function _isTextFile(filename) {
    const textExts = new Set(['txt', 'md', 'json', 'yaml', 'yml', 'log', 'sh', 'bash', 'zsh',
        'py', 'js', 'ts', 'css', 'html', 'htm', 'xml', 'toml', 'ini', 'conf', 'cfg',
        'env', 'sql', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'swift', 'kt']);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return textExts.has(ext);
}
function _isImageFile(filename) {
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return imageExts.has(ext);
}
function _guessMime(filename) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const mimes = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
        txt: 'text/plain', md: 'text/plain', json: 'application/json',
        html: 'text/html', css: 'text/css', js: 'application/javascript',
        zip: 'application/zip', pdf: 'application/pdf',
    };
    return mimes[ext] ?? 'application/octet-stream';
}
// ── Public API ────────────────────────────────────────────────────────────────
export function openSftp() {
    if (!appState.sshConnected) {
        _toast('Connect via SSH first');
        return;
    }
    if (sftpState.ready) {
        // Already open — navigate to currentPath
        _fetchDir(sftpState.currentPath);
        return;
    }
    sendWsMessage({ type: 'sftp_open' });
}
export function closeSftp() {
    sendWsMessage({ type: 'sftp_close' });
    sftpState.ready = false;
    sftpState.entries = [];
    sftpState.transfers.clear();
    sftpState.selectMode = false;
    sftpState.selectedPaths.clear();
    _notify();
}
export function navigate(dirPath) {
    // Exit select mode on navigation
    sftpState.selectMode = false;
    sftpState.selectedPaths.clear();
    sftpState.currentPath = dirPath;
    // Serve from cache immediately if available
    const cached = sftpState.dirCache.get(dirPath);
    if (cached) {
        sftpState.entries = _sortEntries(cached.entries);
        _notify();
        // Background refresh if stale
        if (Date.now() - cached.fetchedAt > DIR_CACHE_TTL_MS) {
            _fetchDir(dirPath, true, true);
        }
    }
    else {
        sftpState.entries = [];
        _notify();
        _fetchDir(dirPath);
    }
}
export function navigateUp() {
    if (sftpState.currentPath === '/')
        return;
    navigate(_parentPath(sftpState.currentPath));
}
export function refreshCurrentDir() {
    sftpState.dirCache.delete(sftpState.currentPath);
    _fetchDir(sftpState.currentPath, false, true);
}
export function downloadFile(entry, destDir) {
    const remotePath = _joinPath(destDir, entry.name);
    const id = _genId();
    sftpState.transfers.set(id, {
        id, direction: 'download', filename: entry.name,
        remotePath, totalSize: entry.size, receivedSize: 0,
        status: 'active', chunks: [],
    });
    sendWsMessage({ type: 'sftp_download', path: remotePath, transferId: id });
    _notify();
}
export function downloadToClipboard(entry, destDir) {
    const remotePath = _joinPath(destDir, entry.name);
    const mime = _guessMime(entry.name);
    const isText = _isTextFile(entry.name);
    const isImage = _isImageFile(entry.name);
    if (!isText && !isImage) {
        _toast('Binary file — use download button instead');
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!navigator.clipboard) {
        _toast('Clipboard not available');
        return;
    }
    const id = _genId();
    sftpState.transfers.set(id, {
        id, direction: 'download', filename: entry.name,
        remotePath, totalSize: entry.size, receivedSize: 0,
        status: 'active', chunks: [], toClipboard: true, clipboardMime: mime,
    });
    sendWsMessage({ type: 'sftp_download', path: remotePath, transferId: id });
    _notify();
}
export function downloadDir(dirPath) {
    const id = _genId();
    const name = dirPath.split('/').pop() ?? 'download';
    sftpState.transfers.set(id, {
        id, direction: 'download', filename: name + '.zip',
        remotePath: dirPath, totalSize: null, receivedSize: 0,
        status: 'active', chunks: [],
    });
    sendWsMessage({ type: 'sftp_download_dir', path: dirPath, transferId: id });
    _notify();
}
export function batchDownload(paths) {
    const id = _genId();
    sftpState.transfers.set(id, {
        id, direction: 'download', filename: 'download.zip',
        remotePath: '', totalSize: null, receivedSize: 0,
        status: 'active', chunks: [],
    });
    sendWsMessage({ type: 'sftp_download_batch', paths, transferId: id });
    _notify();
}
export async function uploadFiles(files, destDir) {
    for (const file of files) {
        await _uploadOneFile(file, destDir);
    }
}
export async function uploadDirectory(files, destDir) {
    // Build directory structure from webkitRelativePath
    const dirsNeeded = new Set();
    for (const file of files) {
        const rel = file.webkitRelativePath || file.name;
        const parts = rel.split('/');
        parts.pop(); // remove filename
        let current = destDir;
        for (const part of parts) {
            current = _joinPath(current, part);
            dirsNeeded.add(current);
        }
    }
    // Create dirs depth-first
    const sortedDirs = [...dirsNeeded].sort();
    for (const dir of sortedDirs) {
        await new Promise((resolve) => {
            sendWsMessage({ type: 'sftp_mkdir', path: dir });
            setTimeout(resolve, 100); // small delay between mkdir calls
        });
    }
    // Upload files
    for (const file of files) {
        const rel = file.webkitRelativePath || file.name;
        const remotePath = _joinPath(destDir, rel);
        await _uploadOneFile(file, destDir, remotePath);
    }
}
async function _uploadOneFile(file, destDir, remotePath) {
    const rPath = remotePath ?? _joinPath(destDir, file.name);
    const id = _genId();
    sftpState.transfers.set(id, {
        id, direction: 'upload', filename: file.name,
        remotePath: rPath, serverPath: rPath,
        totalSize: file.size, receivedSize: 0,
        status: 'active', chunks: [],
    });
    sendWsMessage({ type: 'sftp_upload_start', remotePath: rPath, transferId: id, size: file.size });
    _notify();
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < bytes.length) {
        const slice = bytes.slice(offset, offset + UPLOAD_CHUNK_SIZE);
        const b64 = _uint8ToBase64(slice);
        sendWsMessage({ type: 'sftp_upload_chunk', transferId: id, data: b64 });
        offset += UPLOAD_CHUNK_SIZE;
        // Yield briefly to avoid blocking the event loop
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    sendWsMessage({ type: 'sftp_upload_end', transferId: id });
}
export async function uploadFromClipboard(destDir) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!('read' in navigator.clipboard)) {
        _toast('Clipboard paste not supported on this browser');
        return;
    }
    let items;
    try {
        items = await navigator.clipboard.read();
    }
    catch {
        _toast('Clipboard access denied');
        return;
    }
    for (const item of items) {
        for (const mimeType of item.types) {
            try {
                const blob = await item.getType(mimeType);
                const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
                const extMap = {
                    'text/plain': 'txt', 'image/png': 'png',
                    'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
                };
                const ext = extMap[mimeType] ?? 'bin';
                const defaultName = `clipboard_${ts}.${ext}`;
                const file = new File([blob], defaultName, { type: mimeType });
                await _uploadOneFile(file, destDir);
                return; // Upload first item only
            }
            catch {
                continue;
            }
        }
    }
    _toast('Nothing useful in clipboard');
}
export function setTransferPendingRename(transferId, newName) {
    const t = sftpState.transfers.get(transferId);
    if (!t)
        return;
    if (t.status === 'done' && t.serverPath) {
        // Already completed — rename immediately
        const newPath = _joinPath(_parentPath(t.serverPath), newName);
        sendWsMessage({ type: 'sftp_rename', oldPath: t.serverPath, newPath });
        t.filename = newName;
        t.serverPath = newPath;
        _notify();
    }
    else {
        // Still uploading — store for post-completion rename
        t.pendingRename = newName;
        t.filename = newName;
        _notify();
    }
}
export function enterSelectMode(firstPath) {
    sftpState.selectMode = true;
    sftpState.selectedPaths.clear();
    if (firstPath)
        sftpState.selectedPaths.add(firstPath);
    _notify();
}
export function exitSelectMode() {
    sftpState.selectMode = false;
    sftpState.selectedPaths.clear();
    _notify();
}
export function toggleSelect(entryPath) {
    if (sftpState.selectedPaths.has(entryPath)) {
        sftpState.selectedPaths.delete(entryPath);
    }
    else {
        sftpState.selectedPaths.add(entryPath);
    }
    _notify();
}
export function selectAll() {
    for (const entry of sftpState.entries) {
        sftpState.selectedPaths.add(_joinPath(sftpState.currentPath, entry.name));
    }
    _notify();
}
export function selectNone() {
    sftpState.selectedPaths.clear();
    _notify();
}
export function mkdir(parentDir, name) {
    sendWsMessage({ type: 'sftp_mkdir', path: _joinPath(parentDir, name) });
    // Refresh after a brief delay to let server process
    setTimeout(() => { refreshCurrentDir(); }, 300);
}
export function rm(remotePath) {
    sendWsMessage({ type: 'sftp_rm', path: remotePath });
    setTimeout(() => { refreshCurrentDir(); }, 300);
}
export function rmRecursive(remotePath) {
    const id = _genId();
    sendWsMessage({ type: 'sftp_rm_recursive', path: remotePath, transferId: id });
}
export function rename(oldPath, newName) {
    const newPath = _joinPath(_parentPath(oldPath), newName);
    sendWsMessage({ type: 'sftp_rename', oldPath, newPath });
}
// ── Utility ───────────────────────────────────────────────────────────────────
function _uint8ToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
export function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${String(bytes)} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
export function formatMtime(unixTs) {
    if (!unixTs)
        return '';
    const d = new Date(unixTs * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
//# sourceMappingURL=sftp.js.map