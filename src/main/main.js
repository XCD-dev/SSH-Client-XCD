const { app, BrowserWindow, Menu, ipcMain, powerMonitor, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { createSshService } = require('./services/sshService');
const { collectSystemInfo } = require('./modules/systemInfo');
const { createServerManager } = require('./modules/serverManager');
const { createSessionManager } = require('./modules/sessionManager');
const { createKnownHostsManager } = require('./modules/knownHosts');
const { migrateUserData } = require('./modules/userDataMigration');
const { createVpnManager } = require('./modules/vpnManager');
const { buildProxyEnvironmentCommand, createRemoteVpnManager } = require('./modules/remoteVpnManager');
const { createVpnService } = require('./services/vpnService');
const { createBotManager } = require('./modules/botManager');
const fileManager = require('./modules/fileManager');

let mainWindow;
let sshService;
let serverManager;
let sessionManager;
let knownHostsManager;
let vpnManager;
let vpnService;
let remoteVpnManager;
let botManager;
let remoteVpnRuntimeActive = false;
let forceClose = false;
const terminalState = new Map();
const pendingHostVerifications = new Map();
const pendingDangerousConfirmations = new Map();
const botLogStreams = new Map();
const rendererPagePath = path.join(__dirname, '../renderer/index.html');
const rendererPageUrl = pathToFileURL(rendererPagePath).href;

app.setName('XCD SSH Client');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#16191d',
    title: 'XCD SSH Client',
    icon: path.join(__dirname, '../../build/icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.split('#', 1)[0] !== rendererPageUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`);
  });

  mainWindow.on('close', (event) => {
    if (forceClose) return;
    const localRunning = Boolean(vpnService && vpnService.getRuntimeStatus().running);
    const remoteRunning = remoteVpnRuntimeActive;
    if (!localRunning && !remoteRunning) return;

    event.preventDefault();
    send('app:close-request', { localRunning, remoteRunning });
  });

  mainWindow.loadFile(rendererPagePath);
}

function handleIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    const sender = event.sender;
    if (
      !mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents ||
      event.senderFrame !== sender.mainFrame || event.senderFrame.url !== rendererPageUrl
    ) {
      throw new Error('Rejected IPC from an untrusted renderer.');
    }
    return listener(event, ...args);
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  migrateUserData({
    appDataPath: app.getPath('appData'),
    userDataPath: app.getPath('userData'),
    legacyDirectoryNames: ['desktop-ssh-client', 'Desktop SSH Client']
  });

  serverManager = createServerManager(path.join(app.getPath('userData'), 'servers.json'));
  knownHostsManager = createKnownHostsManager(path.join(app.getPath('userData'), 'known-hosts.json'));
  const binaryRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '../..');
  vpnService = createVpnService({
    appRoot: binaryRoot,
    userDataPath: app.getPath('userData'),
    onLog: (entry) => send('vpn:log', entry)
  });
  vpnManager = createVpnManager(path.join(app.getPath('userData'), 'vpn-profiles.json'), vpnService);
  remoteVpnManager = createRemoteVpnManager({ vpnService, appRoot: binaryRoot });
  botManager = createBotManager(path.join(app.getPath('userData'), 'bots.json'));
  sshService = createSshService({
    onLog: (entry) => send('ssh:log', entry),
    onDisconnect: (session) => send('ssh:disconnect', session),
    onReconnect: (session) => send('ssh:reconnected', session),
    onHostVerification: verifyHostFingerprint
  });
  sessionManager = createSessionManager(sshService);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // The laptop going to sleep (or the screen locking for a long stretch)
  // very often silently kills the underlying TCP connection without
  // either side seeing a clean close. Left alone, the app would only
  // notice once the SSH keepalive eventually times out (up to ~60s), so
  // proactively re-verify every session the moment the system is back.
  powerMonitor.on('resume', () => sshService.handleSystemResume());
  powerMonitor.on('unlock-screen', () => sshService.handleSystemResume());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (vpnService) vpnService.stop();
});

handleIpc('ssh:connect', async (_event, credentials) => {
  validateConnectionPayload(credentials);
  const result = await sessionManager.createSession(credentials);
  return { ok: true, ...result, sessions: sessionManager.getActiveSessions() };
});

handleIpc('app:info', async () => ({
  name: app.getName(),
  version: app.getVersion()
}));

handleIpc('ssh:disconnect', async () => {
  Array.from(botLogStreams.values()).forEach((control) => control.stop());
  botLogStreams.clear();
  sshService.disconnectAll();
  return { ok: true };
});

handleIpc('terminal:run', async (_event, payload) => {
  if (typeof payload !== 'string') assertObject(payload, 'Terminal payload');
  const sessionId = typeof payload === 'object' ? payload.sessionId : undefined;
  const command = typeof payload === 'object' ? payload.command : payload;
  assertString(command, 'Command', 20000);
  if (sessionId !== undefined) assertString(sessionId, 'Session id', 128);
  terminalState.set(sessionId || 'current', { awaitingPassword: false, promptBuffer: '' });

  try {
    return await (sessionId
      ? sshService.execInteractive(sessionId, command, handleTerminalChunk)
      : sshService.execInteractive(command, handleTerminalChunk));

    function handleTerminalChunk(chunk) {
      send('terminal:data', chunk);

      const key = chunk.sessionId || sessionId || 'current';
      const state = terminalState.get(key) || { awaitingPassword: false, promptBuffer: '' };
      state.promptBuffer = `${state.promptBuffer}${chunk.text}`.slice(-500).toLowerCase();
      const asksPassword = /(\[sudo\].*password|password.*:)\s*$/.test(state.promptBuffer);
      if (asksPassword && !state.awaitingPassword) {
        state.awaitingPassword = true;
        send('terminal:password-request', { sessionId: key, time: new Date().toISOString() });
      }
      terminalState.set(key, state);
    }
  } finally {
    terminalState.delete(sessionId || 'current');
  }
});

handleIpc('terminal:send-input', async (_event, payload) => {
  if (typeof payload !== 'string') assertObject(payload, 'Terminal input payload');
  const sessionId = typeof payload === 'object' ? payload.sessionId : undefined;
  const input = typeof payload === 'object' ? payload.input : payload;
  assertString(input, 'Terminal input', 20000);
  if (sessionId !== undefined) assertString(sessionId, 'Session id', 128);
  if (sessionId) sshService.sendInteractiveInput(sessionId, input);
  else sshService.sendInteractiveInput(input);
  terminalState.delete(sessionId || 'current');
  return { ok: true };
});

handleIpc('terminal:stop', async (_event, sessionId) => {
  if (sessionId !== undefined) assertString(sessionId, 'Session id', 128);
  const stopped = sshService.stopInteractive(sessionId);
  terminalState.delete(sessionId || 'current');
  return { stopped };
});

handleIpc('system:info', async (_event, sessionId) => {
  if (sessionId !== undefined) assertString(sessionId, 'Session id', 128);
  return collectSystemInfo(sessionId ? sessionSshService(sessionId) : sshService);
});

handleIpc('terminal:shell-open', async (_event, payload) => {
  assertObject(payload, 'Shell payload');
  assertString(payload.sessionId, 'Session id', 128);
  const cols = Number(payload.cols) || 100;
  const rows = Number(payload.rows) || 30;
  return sshService.openShell(payload.sessionId, (chunk) => {
    if (chunk.type === 'close') send('terminal:shell-closed', { sessionId: chunk.sessionId });
    else send('terminal:shell-data', chunk);
  }, { cols, rows });
});

handleIpc('terminal:shell-write', async (_event, payload) => {
  assertObject(payload, 'Shell input payload');
  assertString(payload.sessionId, 'Session id', 128);
  if (typeof payload.data !== 'string' || !payload.data.length) {
    throw new Error('Shell input data is required.');
  }
  if (payload.data.length > 8192) throw new Error('Shell input is too long.');
  sshService.writeShell(payload.sessionId, payload.data);
  return { ok: true };
});

handleIpc('terminal:shell-resize', async (_event, payload) => {
  assertObject(payload, 'Shell resize payload');
  assertString(payload.sessionId, 'Session id', 128);
  sshService.resizeShell(payload.sessionId, Number(payload.cols) || 80, Number(payload.rows) || 24);
  return { ok: true };
});

handleIpc('terminal:shell-close', async (_event, payload) => {
  assertObject(payload, 'Shell close payload');
  assertString(payload.sessionId, 'Session id', 128);
  sshService.closeShell(payload.sessionId);
  return { ok: true };
});

handleIpc('files:list', async (_event, payload) => {
  validateFileLookupPayload(payload);
  return fileManager.listDirectory(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.path || payload);
});

handleIpc('files:open', async (_event, payload) => {
  validateFileLookupPayload(payload);
  return fileManager.openFile(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.path || payload);
});

handleIpc('files:create-file', async (_event, payload) => {
  validateFileMutationPayload(payload);
  return fileManager.createFile(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.directory, payload.name);
});

handleIpc('files:create-folder', async (_event, payload) => {
  validateFileMutationPayload(payload);
  return fileManager.createFolder(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.directory, payload.name);
});

handleIpc('files:delete', async (_event, payload) => {
  assertObject(payload, 'Delete payload');
  assertString(payload.path, 'Path', 4096);
  assertString(payload.currentPath, 'Current path', 4096);
  if (payload.sessionId !== undefined) assertString(payload.sessionId, 'Session id', 128);
  const confirmed = await requestDangerousConfirmation({
    action: 'delete-remote-item',
    target: payload.path,
    sessionId: payload.sessionId
  });
  if (!confirmed) throw new Error('Operation cancelled.');
  return fileManager.deleteItem(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.path, payload.currentPath);
});

handleIpc('files:navigate', async (_event, payload) => {
  validateFileLookupPayload(payload);
  return fileManager.navigate(payload.sessionId ? sessionSshService(payload.sessionId) : sshService, payload.path || payload);
});

handleIpc('files:upload', async (_event, payload) => {
  validateUploadPayload(payload);
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Select files or folders to upload',
    properties: ['openFile', 'openDirectory', 'multiSelections']
  });
  if (selection.canceled || !selection.filePaths.length) return { canceled: true };

  return fileManager.uploadItems(
    sshService,
    { ...payload, paths: selection.filePaths },
    (chunk) => send('files:upload-progress', chunk),
    (name) => requestDangerousConfirmation({
      action: 'file-exists',
      target: name,
      sessionId: payload.sessionId
    })
  );
});

handleIpc('servers:list', async () => {
  return serverManager.getServers();
});

handleIpc('servers:save', async (_event, payload) => {
  assertObject(payload, 'Server payload');
  return serverManager.saveServer(payload);
});

handleIpc('servers:update', async (_event, payload) => {
  assertObject(payload, 'Server payload');
  assertString(payload.id, 'Server id', 128);
  return serverManager.updateServer(payload.id, payload);
});

handleIpc('servers:delete', async (_event, id) => {
  assertString(id, 'Server id', 128);
  return serverManager.deleteServer(id);
});

handleIpc('servers:mark-connected', async (_event, id) => {
  assertString(id, 'Server id', 128);
  return serverManager.markConnected(id);
});

handleIpc('sessions:create', async (_event, serverConfig) => {
  validateConnectionPayload(serverConfig);
  const result = await sessionManager.createSession(serverConfig);
  return { ok: true, ...result, sessions: sessionManager.getActiveSessions() };
});

handleIpc('sessions:create-saved', async (_event, payload) => {
  assertObject(payload, 'Saved session payload');
  assertString(payload.id, 'Server id', 128);
  assertString(payload.password, 'Password', 4096);
  const serverConfig = serverManager.connectToSavedServer(payload.id, payload.password);
  const result = await sessionManager.createSession(serverConfig);
  serverManager.markConnected(payload.id);
  return { ok: true, ...result, savedId: payload.id, sessions: sessionManager.getActiveSessions() };
});

handleIpc('sessions:list', async () => {
  return sessionManager.getActiveSessions();
});

handleIpc('sessions:switch', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return {
    currentSession: sessionManager.switchSession(sessionId),
    sessions: sessionManager.getActiveSessions()
  };
});

handleIpc('sessions:close', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  stopBotLogStreamsForSession(sessionId);
  return sessionManager.closeSession(sessionId);
});

handleIpc('sessions:current', async () => {
  return sessionManager.getCurrentSession();
});

handleIpc('vpn:profiles', async () => {
  return vpnManager.getProfiles();
});

handleIpc('vpn:add-profile', async (_event, payload) => {
  assertObject(payload, 'VPN profile payload');
  assertString(payload.input, 'VPN profile link', 20000);
  if (payload.name !== undefined && String(payload.name).trim()) assertString(payload.name, 'VPN profile name', 255);
  return vpnManager.addProfile(payload);
});

handleIpc('vpn:delete-profile', async (_event, id) => {
  assertString(id, 'VPN profile id', 128);
  return vpnManager.deleteProfile(id);
});

handleIpc('vpn:select-endpoint', async (_event, payload) => {
  assertObject(payload, 'VPN endpoint payload');
  assertString(payload.profileId, 'VPN profile id', 128);
  assertString(payload.endpointId, 'VPN endpoint id', 128);
  return vpnManager.selectEndpoint(payload.profileId, payload.endpointId);
});

handleIpc('vpn:check-latency', async (_event, profileId) => {
  assertString(profileId, 'VPN profile id', 128);
  return vpnManager.checkLatency(profileId);
});

handleIpc('vpn:engine-status', async () => {
  return vpnService.detectEngine();
});

handleIpc('vpn:compatibility', async () => {
  return vpnService.getCompatibility();
});

handleIpc('vpn:runtime-status', async () => {
  return vpnService.getRuntimeStatus();
});

handleIpc('vpn:start', async (_event, profileId) => {
  assertString(profileId, 'VPN profile id', 128);
  return vpnService.start(vpnManager.runtimeProfile(profileId));
});

handleIpc('vpn:stop', async () => {
  return vpnService.stop();
});

handleIpc('vpn:restart', async (_event, profileId) => {
  assertString(profileId, 'VPN profile id', 128);
  return vpnService.restart(vpnManager.runtimeProfile(profileId));
});

handleIpc('vpn:remote-status', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.status(sessionSshService(sessionId));
});

handleIpc('vpn:remote-start', async (_event, payload) => {
  assertObject(payload, 'Remote VPN payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.profileId, 'VPN profile id', 128);
  const ssh = sessionSshService(payload.sessionId);
  const result = await remoteVpnManager.start(ssh, vpnManager.runtimeProfile(payload.profileId));
  await remoteVpnManager.configureCodexProxy(ssh, true);
  remoteVpnRuntimeActive = Boolean(result.running);
  return result;
});

handleIpc('vpn:remote-apply-shell-proxy', async (_event, payload) => {
  assertObject(payload, 'Remote VPN shell proxy payload');
  assertString(payload.sessionId, 'Session id', 128);
  let proxy = '';
  if (payload.enabled) {
    const status = await remoteVpnManager.status(sessionSshService(payload.sessionId));
    if (!status.running || !status.proxy) throw new Error('Remote VPN proxy is not running.');
    proxy = status.proxy;
  }
  await remoteVpnManager.configureCodexProxy(sessionSshService(payload.sessionId), Boolean(proxy));
  sshService.writeShell(payload.sessionId, `${buildProxyEnvironmentCommand(proxy)}\r`);
  return { ok: true, proxy };
});

handleIpc('vpn:remote-install-bundled', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.installBundled(sessionSshService(sessionId), (progress) => {
    send('vpn:install-progress', { sessionId, ...progress });
  });
});

handleIpc('vpn:remote-stop', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  const ssh = sessionSshService(sessionId);
  await remoteVpnManager.configureCodexProxy(ssh, false);
  const result = await remoteVpnManager.stop(ssh);
  remoteVpnRuntimeActive = Boolean(result.running);
  return result;
});

handleIpc('vpn:remote-check-ip', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.checkIp(sessionSshService(sessionId));
});

handleIpc('vpn:remote-full-preflight', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.fullRoutingPreflight(sessionSshService(sessionId));
});

handleIpc('vpn:remote-full-status', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.fullRoutingStatus(sessionSshService(sessionId));
});

handleIpc('vpn:remote-full-enable', async (_event, payload) => {
  assertObject(payload, 'Remote VPN full routing payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.profileId, 'VPN profile id', 128);
  assertString(payload.sudoPassword, 'Sudo password', 4096);
  const result = await remoteVpnManager.enableFullRouting(
    sessionSshService(payload.sessionId),
    vpnManager.runtimeProfile(payload.profileId),
    payload.sudoPassword
  );
  remoteVpnRuntimeActive = Boolean(result.running);
  return result;
});

handleIpc('vpn:remote-full-confirm', async (_event, payload) => {
  assertObject(payload, 'Remote VPN full routing confirmation');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.sudoPassword, 'Sudo password', 4096);
  return remoteVpnManager.confirmFullRouting(
    sessionSshService(payload.sessionId),
    payload.sudoPassword
  );
});

handleIpc('vpn:remote-full-disable', async (_event, payload) => {
  assertObject(payload, 'Remote VPN full routing disable payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.sudoPassword, 'Sudo password', 4096);
  const result = await remoteVpnManager.disableFullRouting(
    sessionSshService(payload.sessionId),
    payload.sudoPassword
  );
  const proxyStatus = await remoteVpnManager.status(sessionSshService(payload.sessionId));
  remoteVpnRuntimeActive = Boolean(proxyStatus.running);
  return result;
});

handleIpc('vpn:remote-logs', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return remoteVpnManager.logs(sessionSshService(sessionId));
});

handleIpc('bots:list', async (_event, sessionId) => {
  assertString(sessionId, 'Session id', 128);
  return botManager.getBots(sessionHostForId(sessionId));
});

handleIpc('bots:add-and-start', async (_event, payload) => {
  assertObject(payload, 'Bot payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.name, 'Bot name', 128);
  assertString(payload.startCommand, 'Start command', 8000);
  const mode = payload.mode || 'command';
  if (mode !== 'command' && mode !== 'systemd') throw new Error('Unsupported bot run mode.');
  if (mode === 'systemd') assertString(payload.workingDirectory, 'Bot folder', 2000);
  if (payload.sudoPassword !== undefined && payload.sudoPassword !== '') {
    assertString(payload.sudoPassword, 'Sudo password', 1000);
  }
  if (mode === 'command' && payload.matchPattern !== undefined && String(payload.matchPattern).trim()) {
    assertString(payload.matchPattern, 'Match pattern', 2000);
  }
  const host = sessionHostForId(payload.sessionId);
  const envPrefix = mode === 'command' ? await botProxyEnvPrefix(payload.sessionId) : '';
  return botManager.addAndStart(sessionSshService(payload.sessionId), {
    host,
    name: payload.name.trim(),
    startCommand: payload.startCommand,
    matchPattern: mode === 'command' ? (payload.matchPattern || '').trim() : '',
    envPrefix,
    mode,
    workingDirectory: payload.workingDirectory,
    sudoPassword: payload.sudoPassword || ''
  });
});

handleIpc('bots:status', async (_event, payload) => {
  assertObject(payload, 'Bot status payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  return botManager.checkStatus(sessionSshService(payload.sessionId), payload.botId);
});

handleIpc('bots:ping', async (_event, payload) => {
  assertObject(payload, 'Bot ping payload');
  assertString(payload.sessionId, 'Session id', 128);
  const info = findSessionInfo(payload.sessionId);
  if (!info) throw new Error('SSH session was not found.');
  return botManager.measureLatency(info.host, info.port);
});

handleIpc('bots:start', async (_event, payload) => {
  assertObject(payload, 'Bot start payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  const envPrefix = await botProxyEnvPrefix(payload.sessionId);
  return botManager.startBot(sessionSshService(payload.sessionId), payload.botId, envPrefix);
});

handleIpc('bots:stop', async (_event, payload) => {
  assertObject(payload, 'Bot stop payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  return botManager.stopBot(sessionSshService(payload.sessionId), payload.botId);
});

handleIpc('bots:restart', async (_event, payload) => {
  assertObject(payload, 'Bot restart payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  const envPrefix = await botProxyEnvPrefix(payload.sessionId);
  return botManager.restartBot(sessionSshService(payload.sessionId), payload.botId, envPrefix);
});

handleIpc('bots:delete', async (_event, payload) => {
  assertObject(payload, 'Bot delete payload');
  assertString(payload.botId, 'Bot id', 128);
  if (payload.sessionId !== undefined) assertString(payload.sessionId, 'Session id', 128);
  stopBotLogStream(payload.botId);
  const ssh = payload.sessionId ? sessionSshService(payload.sessionId) : null;
  return botManager.deleteBot(ssh, payload.botId);
});

handleIpc('bots:logs-start', async (_event, payload) => {
  assertObject(payload, 'Bot logs payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  const key = botLogKey(payload.sessionId, payload.botId);
  const existing = botLogStreams.get(key);
  if (existing) existing.stop();

  const command = botManager.buildTailCommand(payload.botId, payload.lines || 200);
  if (!command) {
    throw new Error('Не удалось определить файл логов из команды запуска (нет перенаправления в файл).');
  }

  const control = await sshService.startTail(payload.sessionId, command, (chunk) => {
    if (chunk.type === 'close' && botLogStreams.get(key)) botLogStreams.delete(key);
    send('bots:log-data', {
      sessionId: payload.sessionId,
      botId: payload.botId,
      type: chunk.type,
      text: chunk.text || ''
    });
  });
  botLogStreams.set(key, control);
  return { ok: true };
});

handleIpc('bots:logs-stop', async (_event, payload) => {
  assertObject(payload, 'Bot logs payload');
  assertString(payload.sessionId, 'Session id', 128);
  assertString(payload.botId, 'Bot id', 128);
  const key = botLogKey(payload.sessionId, payload.botId);
  const existing = botLogStreams.get(key);
  if (existing) {
    existing.stop();
    botLogStreams.delete(key);
  }
  return { ok: true };
});

handleIpc('app:close-confirm', async (_event, confirmed) => {
  if (!confirmed) return { ok: true, closing: false };
  forceClose = true;
  app.quit();
  return { ok: true, closing: true };
});

handleIpc('ssh:verify-host', async (_event, payload) => {
  assertObject(payload, 'Host verification payload');
  assertString(payload.requestId, 'Request id', 256);
  const pending = pendingHostVerifications.get(payload.requestId);
  if (!pending) return { ok: false };
  pendingHostVerifications.delete(payload.requestId);
  pending.resolve(Boolean(payload.trusted));
  return { ok: true };
});

handleIpc('security:confirm-dangerous', async (_event, payload) => {
  assertObject(payload, 'Danger confirmation payload');
  assertString(payload.requestId, 'Request id', 256);
  const pending = pendingDangerousConfirmations.get(payload.requestId);
  if (!pending) return { ok: false };
  pendingDangerousConfirmations.delete(payload.requestId);
  pending.resolve(Boolean(payload.confirmed));
  return { ok: true };
});

function sessionSshService(sessionId) {
  return {
    exec: (command, options) => sshService.exec(sessionId, command, options),
    execStream: (command, onData, options) => sshService.execStream(sessionId, command, onData, options),
    uploadFile: async (localPath, remotePath, onProgress = () => {}) => {
      const sftp = await sshService.getSftp(sessionId);
      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, {
          step: (transferred, _chunk, total) => onProgress({ transferred, total })
        }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

function findSessionInfo(sessionId) {
  return sshService.getActiveSessions().find((session) => session.id === sessionId) || null;
}

function sessionHostForId(sessionId) {
  const info = findSessionInfo(sessionId);
  if (!info) throw new Error('SSH session was not found.');
  return info.host;
}

function botLogKey(sessionId, botId) {
  return `${sessionId}:${botId}`;
}

function stopBotLogStream(botId) {
  Array.from(botLogStreams.keys())
    .filter((key) => key.endsWith(`:${botId}`))
    .forEach((key) => {
      botLogStreams.get(key).stop();
      botLogStreams.delete(key);
    });
}

function stopBotLogStreamsForSession(sessionId) {
  Array.from(botLogStreams.keys())
    .filter((key) => key.startsWith(`${sessionId}:`))
    .forEach((key) => {
      botLogStreams.get(key).stop();
      botLogStreams.delete(key);
    });
}

async function botProxyEnvPrefix(sessionId) {
  try {
    const remoteStatus = await remoteVpnManager.status(sessionSshService(sessionId));
    if (!remoteStatus.running || !remoteStatus.proxy) return '';
    return `${buildProxyEnvironmentCommand(remoteStatus.proxy)}; `;
  } catch (_error) {
    return '';
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
}

function validateFileLookupPayload(payload) {
  if (typeof payload === 'string') {
    assertString(payload, 'Path', 4096);
    return;
  }

  assertObject(payload, 'File payload');
  assertString(payload.path, 'Path', 4096);
  if (payload.sessionId !== undefined) assertString(payload.sessionId, 'Session id', 128);
}

function validateFileMutationPayload(payload) {
  assertObject(payload, 'File mutation payload');
  assertString(payload.directory, 'Directory', 4096);
  assertString(payload.name, 'Name', 255);
  if (payload.sessionId !== undefined) assertString(payload.sessionId, 'Session id', 128);
}

function validateUploadPayload(payload) {
  assertObject(payload, 'Upload payload');
  assertString(payload.directory, 'Directory', 4096);
  if (payload.sessionId !== undefined) assertString(payload.sessionId, 'Session id', 128);
  if (Object.hasOwn(payload, 'paths')) {
    throw new Error('Local paths must be selected in the system file dialog.');
  }
}

function validateConnectionPayload(payload) {
  assertObject(payload, 'Connection payload');
  assertString(payload.host, 'Host', 255);
  assertString(payload.username, 'Username', 255);
  assertString(payload.password, 'Password', 4096);
  if (payload.name !== undefined) assertString(payload.name, 'Session name', 255);

  const port = Number(payload.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be a number from 1 to 65535.');
  }
}

function verifyHostFingerprint(payload) {
  const check = knownHostsManager.checkHost(payload);
  if (check.state === 'trusted') return true;

  const requestId = `${payload.sessionId}-${Date.now()}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingHostVerifications.delete(requestId);
      resolve(false);
    }, 60000);

    pendingHostVerifications.set(requestId, {
      resolve: (trusted) => {
        clearTimeout(timeout);
        if (trusted) knownHostsManager.trustHost(payload);
        resolve(trusted);
      }
    });

    send('ssh:host-verification-request', {
      requestId,
      host: payload.host,
      port: payload.port,
      username: payload.username,
      fingerprint: payload.fingerprint,
      state: check.state,
      knownFingerprint: check.knownFingerprint
    });
  });
}

function requestDangerousConfirmation(payload) {
  const requestId = `danger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingDangerousConfirmations.delete(requestId);
      resolve(false);
    }, 60000);

    pendingDangerousConfirmations.set(requestId, {
      resolve: (confirmed) => {
        clearTimeout(timeout);
        resolve(confirmed);
      }
    });

    send('security:dangerous-operation-request', {
      requestId,
      ...payload
    });
  });
}
