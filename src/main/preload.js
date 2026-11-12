const { contextBridge, ipcRenderer } = require('electron');

function controlCharacterForTerminal({ ctrlKey, key, code } = {}) {
  if (!ctrlKey) return null;

  const physicalKey = /^Key([A-Z])$/.exec(String(code || ''));
  const letter = physicalKey
    ? physicalKey[1]
    : (/^[a-zA-Z]$/.test(String(key || '')) ? String(key).toUpperCase() : '');
  if (!letter) return null;

  return String.fromCharCode(letter.charCodeAt(0) - 64);
}

function cleanIpcError(error) {
  const message = String(error && error.message ? error.message : error || 'Operation failed.');
  const cleaned = message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
  throw new Error(cleaned);
}

async function invoke(channel, payload) {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (error) {
    cleanIpcError(error);
  }
}

contextBridge.exposeInMainWorld('sshClient', {
  connect: (credentials) => invoke('ssh:connect', credentials),
  disconnect: () => invoke('ssh:disconnect'),
  runTerminal: (payload) => invoke('terminal:run', payload),
  sendTerminalInput: (payload) => invoke('terminal:send-input', payload),
  stopTerminal: (sessionId) => invoke('terminal:stop', sessionId),
  openShell: (payload) => invoke('terminal:shell-open', payload),
  writeShell: (payload) => invoke('terminal:shell-write', payload),
  terminalControlCharacter: (payload) => controlCharacterForTerminal(payload),
  resizeShell: (payload) => invoke('terminal:shell-resize', payload),
  closeShell: (payload) => invoke('terminal:shell-close', payload),
  getSystemInfo: (sessionId) => invoke('system:info', sessionId),
  listDirectory: (payload) => invoke('files:list', payload),
  openFile: (payload) => invoke('files:open', payload),
  createFile: (payload) => invoke('files:create-file', payload),
  createFolder: (payload) => invoke('files:create-folder', payload),
  deleteItem: (payload) => invoke('files:delete', payload),
  navigateFiles: (path) => invoke('files:navigate', path),
  uploadItems: (payload) => invoke('files:upload', payload),
  getServers: () => invoke('servers:list'),
  saveServer: (payload) => invoke('servers:save', payload),
  updateServer: (payload) => invoke('servers:update', payload),
  deleteServer: (id) => invoke('servers:delete', id),
  markServerConnected: (id) => invoke('servers:mark-connected', id),
  createSession: (serverConfig) => invoke('sessions:create', serverConfig),
  listSessions: () => invoke('sessions:list'),
  switchSession: (sessionId) => invoke('sessions:switch', sessionId),
  closeSession: (sessionId) => invoke('sessions:close', sessionId),
  getCurrentSession: () => invoke('sessions:current'),
  getVpnProfiles: () => invoke('vpn:profiles'),
  addVpnProfile: (payload) => invoke('vpn:add-profile', payload),
  deleteVpnProfile: (id) => invoke('vpn:delete-profile', id),
  selectVpnEndpoint: (payload) => invoke('vpn:select-endpoint', payload),
  checkVpnLatency: (profileId) => invoke('vpn:check-latency', profileId),
  getVpnEngineStatus: () => invoke('vpn:engine-status'),
  getVpnCompatibility: () => invoke('vpn:compatibility'),
  getVpnRuntimeStatus: () => invoke('vpn:runtime-status'),
  startVpn: (profileId) => invoke('vpn:start', profileId),
  stopVpn: () => invoke('vpn:stop'),
  restartVpn: (profileId) => invoke('vpn:restart', profileId),
  getRemoteVpnStatus: (sessionId) => invoke('vpn:remote-status', sessionId),
  installBundledRemoteVpn: (sessionId) => invoke('vpn:remote-install-bundled', sessionId),
  startRemoteVpn: (payload) => invoke('vpn:remote-start', payload),
  applyRemoteVpnShellProxy: (payload) => invoke('vpn:remote-apply-shell-proxy', payload),
  stopRemoteVpn: (sessionId) => invoke('vpn:remote-stop', sessionId),
  checkRemoteVpnIp: (sessionId) => invoke('vpn:remote-check-ip', sessionId),
  getRemoteVpnLogs: (sessionId) => invoke('vpn:remote-logs', sessionId),
  getRemoteVpnFullRoutingPreflight: (sessionId) => invoke('vpn:remote-full-preflight', sessionId),
  getRemoteVpnFullRoutingStatus: (sessionId) => invoke('vpn:remote-full-status', sessionId),
  enableRemoteVpnFullRouting: (payload) => invoke('vpn:remote-full-enable', payload),
  confirmRemoteVpnFullRouting: (payload) => invoke('vpn:remote-full-confirm', payload),
  disableRemoteVpnFullRouting: (payload) => invoke('vpn:remote-full-disable', payload),
  confirmAppClose: (confirmed) => invoke('app:close-confirm', confirmed),
  getAppInfo: () => invoke('app:info'),
  verifyHost: (payload) => invoke('ssh:verify-host', payload),
  confirmDangerousOperation: (payload) => invoke('security:confirm-dangerous', payload),
  createSavedSession: (payload) => invoke('sessions:create-saved', payload),
  getBots: (sessionId) => invoke('bots:list', sessionId),
  addAndStartBot: (payload) => invoke('bots:add-and-start', payload),
  getBotStatus: (payload) => invoke('bots:status', payload),
  getBotPing: (payload) => invoke('bots:ping', payload),
  startBot: (payload) => invoke('bots:start', payload),
  stopBot: (payload) => invoke('bots:stop', payload),
  restartBot: (payload) => invoke('bots:restart', payload),
  deleteBot: (payload) => invoke('bots:delete', payload),
  startBotLogs: (payload) => invoke('bots:logs-start', payload),
  stopBotLogs: (payload) => invoke('bots:logs-stop', payload),
  onBotLogData: (callback) => {
    ipcRenderer.on('bots:log-data', (_event, payload) => callback(payload));
  },
  onLog: (callback) => {
    ipcRenderer.on('ssh:log', (_event, entry) => callback(entry));
  },
  onDisconnect: (callback) => {
    ipcRenderer.on('ssh:disconnect', (_event, payload) => callback(payload));
  },
  onReconnect: (callback) => {
    ipcRenderer.on('ssh:reconnected', (_event, payload) => callback(payload));
  },
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal:data', (_event, chunk) => callback(chunk));
  },
  onShellData: (callback) => {
    ipcRenderer.on('terminal:shell-data', (_event, chunk) => callback(chunk));
  },
  onShellClosed: (callback) => {
    ipcRenderer.on('terminal:shell-closed', (_event, payload) => callback(payload));
  },
  onTerminalPasswordRequest: (callback) => {
    ipcRenderer.on('terminal:password-request', (_event, payload) => callback(payload));
  },
  onHostVerificationRequest: (callback) => {
    ipcRenderer.on('ssh:host-verification-request', (_event, payload) => callback(payload));
  },
  onDangerousOperationRequest: (callback) => {
    ipcRenderer.on('security:dangerous-operation-request', (_event, payload) => callback(payload));
  },
  onVpnLog: (callback) => {
    ipcRenderer.on('vpn:log', (_event, payload) => callback(payload));
  },
  onVpnInstallProgress: (callback) => {
    ipcRenderer.on('vpn:install-progress', (_event, payload) => callback(payload));
  },
  onUploadProgress: (callback) => {
    ipcRenderer.on('files:upload-progress', (_event, payload) => callback(payload));
  },
  onAppCloseRequest: (callback) => {
    ipcRenderer.on('app:close-request', (_event, payload) => callback(payload));
  }
});
