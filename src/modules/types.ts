/**
 * Shared type definitions for MobiSSH modules.
 *
 * All interfaces used across module boundaries live here. Modules import
 * types with `import type { ... } from './types.js'` so there is zero
 * runtime cost — TypeScript erases type-only imports during compilation.
 */

// ── Domain types ────────────────────────────────────────────────────────────

export interface SSHProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  initialCommand?: string;
  vaultId?: string;
  hasVaultCreds?: boolean;
}

export type ThemeName = 'dark' | 'light' | 'solarizedDark' | 'solarizedLight' | 'highContrast';

export type VaultMethod = 'master-pw' | 'master-pw+bio' | null;

// Vault data stored in localStorage
export interface WrappedKey {
  iv: string;   // base64 AES-GCM IV
  ct: string;   // base64 ciphertext of the DEK
}

export interface VaultMeta {
  salt: string;         // base64 PBKDF2 salt (32 bytes)
  dekPw: WrappedKey;    // DEK wrapped by password-derived KEK
  dekBio?: WrappedKey;  // DEK wrapped by biometric-derived KEK (optional)
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

// ── Terminal theme ──────────────────────────────────────────────────────────

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export interface ThemeEntry {
  label: string;
  theme: TerminalTheme;
}

// ── Application state ───────────────────────────────────────────────────────

export interface AppState {
  // Core terminal and connection
  terminal: Terminal | null;
  fitAddon: FitAddon.FitAddon | null;
  ws: WebSocket | null;
  _wsConnected: boolean;
  sshConnected: boolean;
  currentProfile: SSHProfile | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  keepAliveTimer: ReturnType<typeof setInterval> | null;

  // Input state
  isComposing: boolean;
  ctrlActive: boolean;

  // Vault
  vaultKey: CryptoKey | null;
  vaultMethod: VaultMethod;
  vaultIdleTimer: ReturnType<typeof setTimeout> | null;

  // UI visibility
  keyBarVisible: boolean;
  imeMode: boolean;
  tabBarVisible: boolean;
  hasConnected: boolean;
  activeThemeName: ThemeName;

  // Session recording (#54)
  recording: boolean;
  recordingStartTime: number | null;
  recordingEvents: [number, string, string][];
}

// ── CSS layout constants ────────────────────────────────────────────────────

export interface RootCSS {
  tabHeight: string;
  keybarHeight: string;
}

// ── DI dependency interfaces ────────────────────────────────────────────────

export interface RecordingDeps {
  toast: (msg: string) => void;
}

export interface ProfilesDeps {
  toast: (msg: string) => void;
}

export interface SettingsDeps {
  toast: (msg: string) => void;
  applyFontSize: (size: number) => void;
  applyTheme: (name: string, opts?: { persist?: boolean }) => void;
}

export interface ConnectionDeps {
  toast: (msg: string) => void;
  setStatus: (state: ConnectionStatus, text: string) => void;
  focusIME: () => void;
  applyTabBarVisibility: () => void;
}

export interface UIDeps {
  keyboardVisible: () => boolean;
  ROOT_CSS: RootCSS;
  applyFontSize: (size: number) => void;
  applyTheme: (name: string, opts?: { persist?: boolean }) => void;
}

export interface IMEDeps {
  handleResize: () => void;
  applyFontSize: (size: number) => void;
}

// ── SSH bridge protocol messages ────────────────────────────────────────────

export type ServerMessage =
  | { type: 'connected' }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'hostkey'; host: string; port: number; keyType: string; fingerprint: string };

export interface ConnectMessage {
  type: 'connect';
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  initialCommand?: string;
  allowPrivate?: boolean;
}

export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface InputMessage {
  type: 'input';
  data: string;
}

export interface HostKeyResponseMessage {
  type: 'hostkey_response';
  accepted: boolean;
}

// ── Asciicast v2 recording ──────────────────────────────────────────────────

export interface AsciicastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  title: string;
}

export type AsciicastEvent = [number, 'o', string];

// ── SFTP file browser ────────────────────────────────────────────────────────

export interface SftpEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
  mode: number;
}

export interface SftpDirCache {
  entries: SftpEntry[];
  fetchedAt: number;
}

export type SftpTransferStatus = 'active' | 'done' | 'error' | 'paused';

export interface SftpTransfer {
  id: string;
  direction: 'download' | 'upload';
  filename: string;
  remotePath: string;
  totalSize: number | null;
  receivedSize: number;
  status: SftpTransferStatus;
  error?: string;
  // Download: accumulated base64 chunks → assembled into Blob
  chunks: string[];
  toClipboard?: boolean;
  clipboardMime?: string;
  // Upload: pending server-side rename after upload completes
  pendingRename?: string;
  // Current server path (may be renamed after upload)
  serverPath?: string;
}

export type SftpMessage =
  | { type: 'sftp_ready'; homedir: string }
  | { type: 'sftp_readdir_result'; path: string; entries: SftpEntry[] }
  | { type: 'sftp_download_start'; transferId: string; size: number | null; filename: string }
  | { type: 'sftp_download_chunk'; transferId: string; data: string }
  | { type: 'sftp_download_end'; transferId: string }
  | { type: 'sftp_download_dir_progress'; transferId: string; filesProcessed: number; totalFiles: number }
  | { type: 'sftp_upload_progress'; transferId: string; received: number }
  | { type: 'sftp_upload_done'; transferId: string; remotePath: string }
  | { type: 'sftp_rm_recursive_result'; transferId: string }
  | { type: 'sftp_rename_result'; oldPath: string; newPath: string }
  | { type: 'sftp_error'; op: string; path: string; message: string; transferId?: string };

/** Dependency interface for SFTP modules */
export interface SftpDeps {
  toast: (msg: string) => void;
  onStateChange: () => void;
}
