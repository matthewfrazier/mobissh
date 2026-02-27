/**
 * modules/sftp-ui.ts — SFTP file browser panel rendering and interaction
 *
 * Renders the Files panel: breadcrumb, file list with skeleton/empty states,
 * multi-select mode, upload action sheet, transfer progress rows, and
 * inline rename during upload.
 */
import { escHtml } from './constants.js';
import { appState } from './state.js';
import { sftpState, openSftp, navigate, navigateUp, refreshCurrentDir, downloadFile, downloadToClipboard, downloadDir, batchDownload, uploadFiles, uploadDirectory, uploadFromClipboard, setTransferPendingRename, enterSelectMode, exitSelectMode, toggleSelect, selectAll, selectNone, rm, rmRecursive, mkdir, rename, formatFileSize, formatMtime, } from './sftp.js';
let _toast = (_msg) => { };
const SKELETON_COUNT = 6;
// ── Init ──────────────────────────────────────────────────────────────────────
export function initSftpUI({ toast }) {
    _toast = toast;
    _attachTabListener();
}
/** Called from sftp.ts whenever state changes — re-renders the panel. */
export function renderFilesPanel() {
    _renderToolbar();
    _renderFileList();
    _renderTransferList();
    _renderActionBar();
}
// ── Tab activation ────────────────────────────────────────────────────────────
function _attachTabListener() {
    document.querySelector('[data-panel="files"]')?.addEventListener('click', () => {
        if (!appState.sshConnected) {
            _toast('Connect via SSH first');
            // Switch back to terminal tab
            setTimeout(() => {
                document.querySelector('[data-panel="terminal"]')?.click();
            }, 0);
            return;
        }
        if (!sftpState.ready) {
            openSftp();
        }
        else {
            renderFilesPanel();
        }
    });
}
// ── Toolbar ───────────────────────────────────────────────────────────────────
function _renderToolbar() {
    const toolbar = document.getElementById('sftp-toolbar');
    if (!toolbar)
        return;
    const crumbs = _buildBreadcrumbs(sftpState.currentPath);
    const loading = sftpState.loadingPaths.has(sftpState.currentPath);
    toolbar.innerHTML = `
    <div id="sftp-breadcrumb" role="navigation" aria-label="Directory path">
      ${crumbs.map((c, i) => `
        <span class="sftp-crumb ${i === crumbs.length - 1 ? 'sftp-crumb-active' : ''}"
              data-path="${escHtml(c.path)}">${escHtml(c.label)}</span>
        ${i < crumbs.length - 1 ? '<span class="sftp-crumb-sep">/</span>' : ''}
      `).join('')}
    </div>
    <div class="sftp-toolbar-btns">
      ${sftpState.currentPath !== '/' ? '<button class="sftp-toolbar-btn" id="sftp-up-btn" title="Parent directory" aria-label="Parent directory">↑</button>' : ''}
      <button class="sftp-toolbar-btn" id="sftp-add-btn" title="Upload or new folder" aria-label="Upload or new folder">+</button>
      <button class="sftp-toolbar-btn ${loading ? 'sftp-loading-spin' : ''}" id="sftp-refresh-btn" title="Refresh" aria-label="Refresh">↻</button>
    </div>
  `;
    toolbar.querySelector('#sftp-up-btn')?.addEventListener('click', () => { navigateUp(); });
    toolbar.querySelector('#sftp-refresh-btn')?.addEventListener('click', () => { refreshCurrentDir(); });
    toolbar.querySelector('#sftp-add-btn')?.addEventListener('click', () => { _showUploadSheet(); });
    toolbar.querySelectorAll('.sftp-crumb').forEach((crumb) => {
        crumb.addEventListener('click', () => {
            const p = crumb.dataset.path;
            if (p && p !== sftpState.currentPath)
                navigate(p);
        });
    });
}
function _buildBreadcrumbs(fullPath) {
    const parts = fullPath.replace(/^\//, '').split('/').filter(Boolean);
    const crumbs = [{ label: '~', path: sftpState.homedir }];
    // Show path relative to homedir if possible
    if (fullPath.startsWith(sftpState.homedir)) {
        const rel = fullPath.slice(sftpState.homedir.length).replace(/^\//, '').split('/').filter(Boolean);
        let current = sftpState.homedir;
        for (const part of rel) {
            current = current.replace(/\/$/, '') + '/' + part;
            crumbs.push({ label: part, path: current });
        }
        return crumbs;
    }
    // Absolute path from root
    const rootCrumbs = [{ label: '/', path: '/' }];
    let current = '';
    for (const part of parts) {
        current = current + '/' + part;
        rootCrumbs.push({ label: part, path: current });
    }
    return rootCrumbs;
}
// ── File list ─────────────────────────────────────────────────────────────────
function _renderFileList() {
    const list = document.getElementById('sftp-file-list');
    if (!list)
        return;
    const isLoading = sftpState.loadingPaths.has(sftpState.currentPath);
    const hasEntries = sftpState.entries.length > 0;
    if (!sftpState.ready) {
        list.innerHTML = '<div class="sftp-empty sftp-connecting"><span class="sftp-spinner"></span> Opening file browser…</div>';
        return;
    }
    if (isLoading && !hasEntries) {
        // Skeleton rows
        list.innerHTML = Array.from({ length: SKELETON_COUNT }, () => `
      <div class="sftp-row sftp-skeleton" aria-hidden="true">
        <span class="sftp-skeleton-icon"></span>
        <span class="sftp-skeleton-name"></span>
        <span class="sftp-skeleton-meta"></span>
      </div>
    `).join('');
        return;
    }
    if (!isLoading && !hasEntries) {
        list.innerHTML = '<div class="sftp-empty">Empty directory</div>';
        return;
    }
    list.innerHTML = sftpState.entries.map((entry) => _renderEntry(entry)).join('');
    // Wire interactions
    list.querySelectorAll('.sftp-row').forEach((row) => {
        const entryName = row.dataset.name ?? '';
        const entryPath = row.dataset.path ?? '';
        const entryType = row.dataset.type ?? 'file';
        // Long press → enter select mode
        let longPressTimer = null;
        row.addEventListener('pointerdown', () => {
            longPressTimer = setTimeout(() => {
                if ('vibrate' in navigator)
                    navigator.vibrate(20);
                enterSelectMode(entryPath);
                renderFilesPanel();
            }, 500);
        });
        row.addEventListener('pointerup', () => { if (longPressTimer)
            clearTimeout(longPressTimer); });
        row.addEventListener('pointercancel', () => { if (longPressTimer)
            clearTimeout(longPressTimer); });
        if (sftpState.selectMode) {
            row.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleSelect(entryPath);
                renderFilesPanel();
            });
        }
        else if (entryType === 'dir') {
            row.addEventListener('click', () => { navigate(entryPath); });
        }
        // Action buttons
        row.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const entry = sftpState.entries.find((x) => x.name === entryName);
            if (!entry)
                return;
            if (entry.type === 'dir') {
                downloadDir(entryPath);
            }
            else {
                downloadFile(entry, sftpState.currentPath);
            }
            renderFilesPanel();
        });
        row.querySelector('[data-action="clipboard"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const entry = sftpState.entries.find((x) => x.name === entryName);
            if (!entry)
                return;
            downloadToClipboard(entry, sftpState.currentPath);
            renderFilesPanel();
        });
        row.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            _confirmDelete([entryPath], entryType === 'dir');
        });
    });
}
function _renderEntry(entry) {
    const icon = entry.type === 'dir' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄';
    const fullPath = sftpState.currentPath.replace(/\/$/, '') + '/' + entry.name;
    const selected = sftpState.selectedPaths.has(fullPath);
    const sizeStr = entry.type !== 'dir' ? `<span class="sftp-size">${escHtml(formatFileSize(entry.size))}</span>` : '';
    const dateStr = entry.mtime ? `<span class="sftp-date">${escHtml(formatMtime(entry.mtime))}</span>` : '';
    const checkboxHtml = sftpState.selectMode
        ? `<span class="sftp-checkbox ${selected ? 'sftp-checked' : ''}" aria-hidden="true"></span>`
        : '';
    const actionsHtml = !sftpState.selectMode ? `
    <div class="sftp-row-actions">
      <button class="sftp-action-btn" data-action="download" title="${entry.type === 'dir' ? 'Download as ZIP' : 'Download'}" aria-label="${entry.type === 'dir' ? 'Download folder as ZIP' : 'Download ' + entry.name}">↓</button>
      ${entry.type !== 'dir' ? `<button class="sftp-action-btn sftp-action-clip" data-action="clipboard" title="Copy to clipboard" aria-label="Copy ${entry.name} to clipboard">📋</button>` : ''}
      <button class="sftp-action-btn sftp-action-del" data-action="delete" title="Delete" aria-label="Delete ${entry.name}">🗑</button>
    </div>
  ` : '';
    return `
    <div class="sftp-row ${selected ? 'sftp-selected' : ''}" data-name="${escHtml(entry.name)}" data-path="${escHtml(fullPath)}" data-type="${entry.type}" role="row">
      ${checkboxHtml}
      <span class="sftp-icon" aria-hidden="true">${icon}</span>
      <span class="sftp-name">${escHtml(entry.name)}</span>
      <span class="sftp-meta">${sizeStr}${dateStr}</span>
      ${actionsHtml}
      ${entry.type === 'dir' && !sftpState.selectMode ? '<span class="sftp-chevron" aria-hidden="true">›</span>' : ''}
    </div>
  `;
}
// ── Transfer progress rows ────────────────────────────────────────────────────
function _renderTransferList() {
    const area = document.getElementById('sftp-transfers');
    if (!area)
        return;
    if (sftpState.transfers.size === 0) {
        area.innerHTML = '';
        return;
    }
    area.innerHTML = [...sftpState.transfers.values()].map((t) => _renderTransferRow(t)).join('');
    area.querySelectorAll('.sftp-transfer-row').forEach((row) => {
        const tid = row.dataset.transferId ?? '';
        row.querySelector('[data-action="rename"]')?.addEventListener('click', () => {
            _startInlineRename(row, tid);
        });
    });
}
function _renderTransferRow(t) {
    const dirIcon = t.direction === 'upload' ? '↑' : '↓';
    const pct = t.totalSize && t.totalSize > 0 ? Math.min(100, Math.round((t.receivedSize / t.totalSize) * 100)) : 0;
    const statusClass = t.status === 'done' ? 'sftp-transfer-done' : t.status === 'error' ? 'sftp-transfer-error' : '';
    const progressBar = t.status === 'active' ? `
    <div class="sftp-progress-bar">
      <div class="sftp-progress-fill" style="width:${String(pct)}%"></div>
    </div>
    <span class="sftp-progress-pct">${t.totalSize ? `${String(pct)}%` : '…'}</span>
  ` : (t.status === 'done' ? '<span class="sftp-transfer-check">✓</span>' : `<span class="sftp-transfer-err">${escHtml(t.error ?? 'Error')}</span>`);
    const renameBtn = t.direction === 'upload' ? '<button class="sftp-action-btn" data-action="rename" title="Rename" aria-label="Rename upload">✎</button>' : '';
    return `
    <div class="sftp-transfer-row ${statusClass}" data-transfer-id="${escHtml(t.id)}">
      <span class="sftp-transfer-dir">${dirIcon}</span>
      <span class="sftp-transfer-name">${escHtml(t.filename)}</span>
      ${renameBtn}
      <div class="sftp-transfer-progress">${progressBar}</div>
    </div>
  `;
}
function _startInlineRename(row, transferId) {
    const nameEl = row.querySelector('.sftp-transfer-name');
    if (!nameEl)
        return;
    const currentName = nameEl.textContent || '';
    nameEl.innerHTML = `<input class="sftp-rename-input" type="text" value="${escHtml(currentName)}" />`;
    const input = nameEl.querySelector('.sftp-rename-input');
    if (!input)
        return;
    input.focus();
    input.select();
    const commit = () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
            setTransferPendingRename(transferId, newName);
        }
        renderFilesPanel();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        }
        if (e.key === 'Escape') {
            renderFilesPanel();
        }
    });
}
// ── Multi-select action bar ───────────────────────────────────────────────────
function _renderActionBar() {
    const bar = document.getElementById('sftp-action-bar');
    if (!bar)
        return;
    if (!sftpState.selectMode) {
        bar.classList.add('sftp-action-bar-hidden');
        // Update header for non-select mode
        const header = document.getElementById('sftp-select-header');
        if (header)
            header.classList.add('hidden');
        return;
    }
    bar.classList.remove('sftp-action-bar-hidden');
    const count = sftpState.selectedPaths.size;
    // Select mode header
    const header = document.getElementById('sftp-select-header');
    if (header) {
        header.classList.remove('hidden');
        header.innerHTML = `
      <span class="sftp-select-count">${String(count)} selected</span>
      <button class="sftp-select-btn" id="sftp-sel-all">All</button>
      <button class="sftp-select-btn" id="sftp-sel-none">None</button>
      <button class="sftp-select-btn sftp-select-exit" id="sftp-sel-exit">✗</button>
    `;
        header.querySelector('#sftp-sel-all')?.addEventListener('click', () => { selectAll(); renderFilesPanel(); });
        header.querySelector('#sftp-sel-none')?.addEventListener('click', () => { selectNone(); renderFilesPanel(); });
        header.querySelector('#sftp-sel-exit')?.addEventListener('click', () => { exitSelectMode(); renderFilesPanel(); });
    }
    bar.innerHTML = `
    <button class="sftp-bar-btn sftp-bar-download" id="sftp-batch-dl" ${count === 0 ? 'disabled' : ''}>
      ↓ Download (${String(count)})
    </button>
    <button class="sftp-bar-btn sftp-bar-delete" id="sftp-batch-del" ${count === 0 ? 'disabled' : ''}>
      🗑 Delete (${String(count)})
    </button>
  `;
    bar.querySelector('#sftp-batch-dl')?.addEventListener('click', () => {
        if (count === 0)
            return;
        batchDownload([...sftpState.selectedPaths]);
        exitSelectMode();
        renderFilesPanel();
    });
    bar.querySelector('#sftp-batch-del')?.addEventListener('click', () => {
        if (count === 0)
            return;
        _confirmDelete([...sftpState.selectedPaths], false);
    });
}
// ── Upload action sheet ───────────────────────────────────────────────────────
function _showUploadSheet() {
    const existing = document.getElementById('sftp-upload-sheet');
    if (existing) {
        existing.remove();
        return;
    }
    const sheet = document.createElement('div');
    sheet.id = 'sftp-upload-sheet';
    sheet.className = 'sftp-upload-sheet';
    const dirSupported = 'webkitdirectory' in HTMLInputElement.prototype;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const clipSupported = 'read' in navigator.clipboard;
    sheet.innerHTML = `
    <div class="sftp-sheet-backdrop"></div>
    <div class="sftp-sheet-content">
      <div class="sftp-sheet-title">Upload to ${escHtml(sftpState.currentPath)}</div>
      <button class="sftp-sheet-btn" id="sftp-pick-files">📂 Choose files…</button>
      ${dirSupported ? '<button class="sftp-sheet-btn" id="sftp-pick-dir">📁 Choose folder…</button>' : ''}
      ${clipSupported ? '<button class="sftp-sheet-btn" id="sftp-paste-clip">📋 Paste from clipboard</button>' : '<!-- no clipboard --!>'}
      <button class="sftp-sheet-btn" id="sftp-new-folder">📝 New folder</button>
      <button class="sftp-sheet-btn sftp-sheet-cancel" id="sftp-sheet-close">✗ Cancel</button>
    </div>
  `;
    document.body.appendChild(sheet);
    const close = () => { sheet.remove(); };
    sheet.querySelector('.sftp-sheet-backdrop')?.addEventListener('click', close);
    sheet.querySelector('#sftp-sheet-close')?.addEventListener('click', close);
    sheet.querySelector('#sftp-pick-files')?.addEventListener('click', () => {
        close();
        _openFilePicker(false);
    });
    sheet.querySelector('#sftp-pick-dir')?.addEventListener('click', () => {
        close();
        _openFilePicker(true);
    });
    sheet.querySelector('#sftp-paste-clip')?.addEventListener('click', () => {
        close();
        void uploadFromClipboard(sftpState.currentPath).then(() => { renderFilesPanel(); });
    });
    sheet.querySelector('#sftp-new-folder')?.addEventListener('click', () => {
        close();
        _promptNewFolder();
    });
}
function _openFilePicker(dirMode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (dirMode) {
        input.webkitdirectory = true;
    }
    input.addEventListener('change', () => {
        if (!input.files?.length)
            return;
        if (dirMode) {
            void uploadDirectory(input.files, sftpState.currentPath).then(() => { renderFilesPanel(); });
        }
        else {
            void uploadFiles(input.files, sftpState.currentPath).then(() => { renderFilesPanel(); });
        }
    });
    input.click();
}
function _promptNewFolder() {
    const overlay = document.createElement('div');
    overlay.className = 'sftp-prompt-overlay';
    overlay.innerHTML = `
    <div class="sftp-prompt-dialog">
      <div class="sftp-prompt-title">New folder</div>
      <input class="sftp-prompt-input" type="text" placeholder="folder-name" autocorrect="off" autocapitalize="none" />
      <div class="sftp-prompt-btns">
        <button class="sftp-prompt-cancel">Cancel</button>
        <button class="sftp-prompt-ok">Create</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.sftp-prompt-input');
    input?.focus();
    const close = () => { overlay.remove(); };
    const commit = () => {
        const name = input?.value.trim();
        if (!name) {
            close();
            return;
        }
        mkdir(sftpState.currentPath, name);
        close();
        setTimeout(() => { renderFilesPanel(); }, 400);
    };
    overlay.querySelector('.sftp-prompt-cancel')?.addEventListener('click', close);
    overlay.querySelector('.sftp-prompt-ok')?.addEventListener('click', commit);
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        }
        if (e.key === 'Escape')
            close();
    });
}
// ── Delete confirmation ───────────────────────────────────────────────────────
function _confirmDelete(paths, hasDir) {
    const overlay = document.createElement('div');
    overlay.className = 'sftp-prompt-overlay';
    const label = paths.length === 1
        ? (paths[0] ?? '').split('/').pop() ?? 'item'
        : `${String(paths.length)} items`;
    overlay.innerHTML = `
    <div class="sftp-prompt-dialog">
      <div class="sftp-prompt-title sftp-prompt-danger">Delete ${escHtml(label)}?</div>
      <p class="sftp-prompt-body">This cannot be undone.</p>
      <div class="sftp-prompt-btns">
        <button class="sftp-prompt-cancel">Cancel</button>
        <button class="sftp-prompt-ok sftp-prompt-danger-btn">Delete</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); };
    overlay.querySelector('.sftp-prompt-cancel')?.addEventListener('click', close);
    overlay.querySelector('.sftp-prompt-ok')?.addEventListener('click', () => {
        close();
        for (const p of paths) {
            if (hasDir) {
                rmRecursive(p);
            }
            else {
                rm(p);
            }
        }
        if (sftpState.selectMode)
            exitSelectMode();
        setTimeout(() => { renderFilesPanel(); }, 500);
    });
}
//# sourceMappingURL=sftp-ui.js.map