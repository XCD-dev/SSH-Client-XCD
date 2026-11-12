const app = document.querySelector('#app');

const themeStorageKey = 'xcd-ssh-client-theme';

function readSavedTheme() {
  try {
    return localStorage.getItem(themeStorageKey) === 'light' ? 'light' : 'dark';
  } catch (error) {
    console.warn(`Could not read saved theme: ${error.message}`);
    return 'dark';
  }
}

function applyTheme(theme, persist = false) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.textContent = selected === 'light' ? 'Use dark theme' : 'Use light theme';
    button.setAttribute('aria-label', `Switch to ${selected === 'light' ? 'dark' : 'light'} theme`);
  });
  if (persist) {
    try {
      localStorage.setItem(themeStorageKey, selected);
    } catch (error) {
      console.warn(`Could not save theme preference: ${error.message}`);
    }
  }
}

function bindThemeToggle() {
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
    });
  });
  applyTheme(document.documentElement.dataset.theme);
}

function showRendererFailure(error) {
  const message = String(error && error.message ? error.message : error || 'Unknown renderer error');
  app.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'login-screen';
  const card = document.createElement('div');
  card.className = 'login-panel';
  const title = document.createElement('h1');
  title.textContent = 'XCD SSH Client could not load';
  const details = document.createElement('pre');
  details.className = 'remote-vpn-log';
  details.textContent = message;
  card.append(title, details);
  panel.appendChild(card);
  app.appendChild(panel);
}

window.addEventListener('error', (event) => showRendererFailure(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => showRendererFailure(event.reason));

// Must match the rows passed to window.sshClient.openShell() further below.
// Cursor positioning escape sequences (CSI H/A/B) are relative to the PTY's
// own fixed-size screen, so our buffer's active row count has to match
// exactly - otherwise absolute cursor moves (arrow-key menus, sudo prompts,
// nano, etc.) land on the wrong row once the buffer has scrolled at least
// once. Declared up here (not next to createTerminalBuffer()) because
// state.terminalBuffer below calls createTerminalBuffer() immediately at
// module load time, before later top-level const declarations would
// otherwise be initialized.
const TERMINAL_ROWS = 32;

const state = {
  connected: false,
  currentView: 'status',
  logs: [],
  terminalBuffer: createTerminalBuffer(),
  shellOpen: false,
  shellOpening: false,
  passwordPromptOpen: false,
  passwordPromptSessionId: '',
  systemInfo: null,
  savedServers: [],
  serverSearch: '',
  sessions: [],
  activeSessionId: '',
  sessionData: {},
  activeServer: null,
  fileManager: {
    path: '.',
    items: [],
    selected: null,
    loading: false,
    error: '',
    busyLabel: ''
  },
  vpn: {
    profiles: [],
    engine: null,
    compatibility: null,
    runtime: null,
    remote: null,
    remoteFull: null,
    remoteFullPreflight: null,
    remoteIp: null,
    remoteLogs: null,
    installProgress: null,
    loading: false,
    error: ''
  },
  bots: {
    list: [],
    statuses: {},
    ping: null,
    loading: false,
    adding: false,
    error: '',
    pollTimer: null,
    logs: {}
  }
};

let pendingFullRoutingSudoPassword = '';

function createSessionUiState() {
  return {
    terminalBuffer: createTerminalBuffer(),
    shellOpen: false,
    shellOpening: false,
    systemInfo: null,
    fileManager: {
      path: '.',
      items: [],
      selected: null,
      loading: false,
      error: '',
      busyLabel: ''
    }
  };
}

function saveCurrentSessionState() {
  if (!state.activeSessionId) return;
  state.sessionData[state.activeSessionId] = {
    terminalBuffer: state.terminalBuffer,
    shellOpen: state.shellOpen,
    shellOpening: state.shellOpening,
    systemInfo: state.systemInfo,
    fileManager: state.fileManager
  };
}

function applySessionState(sessionId) {
  const data = state.sessionData[sessionId] || createSessionUiState();
  state.sessionData[sessionId] = data;
  state.terminalBuffer = data.terminalBuffer;
  state.shellOpen = data.shellOpen;
  state.shellOpening = data.shellOpening;
  state.systemInfo = data.systemInfo;
  state.fileManager = data.fileManager;
}

function ensureSessionData(sessionId) {
  if (!state.sessionData[sessionId]) state.sessionData[sessionId] = createSessionUiState();
  return state.sessionData[sessionId];
}

function setActiveSession(sessionId) {
  saveCurrentSessionState();
  state.activeSessionId = sessionId;
  applySessionState(sessionId);
  const session = state.sessions.find((item) => item.id === sessionId);
  state.activeServer = session ? {
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username,
    savedId: state.activeServer && state.activeServer.host === session.host ? state.activeServer.savedId : ''
  } : null;
  ensureShellOpen(sessionId);
}

const viewTitles = {
  status: 'Status / Logs',
  files: 'File Manager',
  terminal: 'Terminal',
  system: 'System Info',
  vpn: 'VPN',
  bots: 'Центр управления'
};

function cloneTemplate(id) {
  return document.querySelector(id).content.cloneNode(true);
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function pushLog(type, message) {
  state.logs.unshift({ type, message, time: new Date().toISOString() });
  state.logs = state.logs.slice(0, 300);
  renderLogs();
}

function renderLogin(error = '') {
  app.innerHTML = '';
  app.appendChild(cloneTemplate('#login-template'));

  const form = document.querySelector('#login-form');
  const errorNode = document.querySelector('#login-error');
  const search = document.querySelector('#server-search');
  errorNode.textContent = error;

  document.querySelector('#about-button').addEventListener('click', showAboutDialog);
  bindThemeToggle();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const credentials = {
      host: form.host.value.trim(),
      port: Number(form.port.value),
      username: form.username.value.trim(),
      password: form.password.value
    };

    await connectWithCredentials(credentials, {
      button: form.querySelector('button'),
      errorNode,
      activeServer: {
        name: credentials.host,
        host: credentials.host,
        port: credentials.port,
        username: credentials.username,
        savedId: ''
      }
    });
    form.password.value = '';
  });

  search.addEventListener('input', () => {
    state.serverSearch = search.value.trim().toLowerCase();
    renderSavedServers();
  });

  loadSavedServers();
}

function renderDashboard() {
  app.innerHTML = '';
  app.appendChild(cloneTemplate('#dashboard-template'));
  bindNavigation();
  buildStatusView();
  buildFilesView();
  buildTerminalView();
  buildSystemView();
  buildVpnView();
  buildBotsView();
  renderActiveServer();
  renderSessionSwitcher();
  // Saved servers are pulled in so the sidebar can offer quick reconnect
  // straight from the dashboard (updates the switcher again once loaded).
  loadSavedServers();
  setView(state.currentView);

  const saveServerButton = document.querySelector('#save-server-button');
  document.querySelector('#about-button').addEventListener('click', showAboutDialog);
  bindThemeToggle();
  updateSaveServerButton(saveServerButton);
  saveServerButton.addEventListener('click', requestSaveActiveServer);
  document.querySelector('#new-session-button').addEventListener('click', requestNewSession);
  document.querySelector('#disconnect-button').addEventListener('click', async () => {
    await window.sshClient.disconnect();
    handleDisconnect();
  });
}

async function showAboutDialog() {
  let appInfo = { name: 'XCD SSH Client', version: 'unknown' };
  try {
    appInfo = await window.sshClient.getAppInfo();
  } catch (error) {
    pushLog('error', `Could not load application information: ${error.message}`);
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'presentation');
  const modal = document.createElement('section');
  modal.className = 'modal about-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'about-title');

  const icon = document.createElement('img');
  icon.src = '../../build/xcd-icon.svg';
  icon.alt = 'XCD';
  icon.className = 'about-icon';
  const title = document.createElement('h2');
  title.id = 'about-title';
  title.textContent = appInfo.name || 'XCD SSH Client';
  const version = document.createElement('p');
  version.className = 'muted';
  version.textContent = `Version ${appInfo.version || 'unknown'}`;
  const description = document.createElement('p');
  description.textContent = 'Desktop SSH administration client.';
  const footer = document.createElement('div');
  footer.className = 'about-footer';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'primary-btn';
  close.textContent = 'Close';

  const dismiss = () => {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') dismiss();
  };
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  document.addEventListener('keydown', onKeyDown);
  footer.appendChild(close);
  modal.append(icon, title, version, description, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  close.focus();
}

// Identity of a server/session used to tell "already connected" saved
// servers apart from ones that still need a fresh connection.
function serverIdentityKey(entry) {
  if (!entry) return '';
  return `${String(entry.host || '').trim()}:${Number(entry.port)}:${String(entry.username || '').trim()}`;
}

function renderSessionSwitcher() {
  const list = document.querySelector('#session-list');
  if (!list) return;

  // One combined list: live sessions on top (switch instantly, no password),
  // then any saved servers that aren't currently connected as quick-connect
  // rows (click -> ask password once -> opens a new session).
  const activeKeys = new Set(state.sessions.map((session) => serverIdentityKey(session)));
  const savedInactive = (state.savedServers || []).filter((server) => !activeKeys.has(serverIdentityKey(server)));

  if (!state.sessions.length && !savedInactive.length) {
    list.innerHTML = '<p class="muted">No active or saved servers.</p>';
    return;
  }

  const activeHtml = state.sessions.map((session) => `
    <div class="session-row ${session.id === state.activeSessionId ? 'active' : ''}">
      <button class="session-switch" type="button" data-id="${escapeHtml(session.id)}">
        <span class="status-dot ${session.status === 'online' ? 'online' : 'offline'}"></span>
        <span>
          <strong>${escapeHtml(session.name || session.host)}</strong>
          <small>${escapeHtml(session.username)}@${escapeHtml(session.host)}</small>
        </span>
      </button>
      <button class="session-close" type="button" data-id="${escapeHtml(session.id)}">x</button>
    </div>
  `).join('');

  const savedHtml = savedInactive.map((server) => `
    <div class="session-row saved">
      <button class="session-switch session-connect" type="button" data-saved-id="${escapeHtml(server.id)}" title="Connect to ${escapeHtml(server.name || server.host)}">
        <span class="status-dot"></span>
        <span>
          <strong>${escapeHtml(server.name || server.host)}</strong>
          <small>${escapeHtml(server.username)}@${escapeHtml(server.host)}</small>
        </span>
      </button>
    </div>
  `).join('');

  list.innerHTML = activeHtml + savedHtml;

  list.querySelectorAll('.session-switch:not(.session-connect)').forEach((button) => {
    button.addEventListener('click', () => switchToSession(button.dataset.id));
  });
  list.querySelectorAll('.session-connect').forEach((button) => {
    button.addEventListener('click', () => requestSavedServerPassword(button.dataset.savedId));
  });
  list.querySelectorAll('.session-close').forEach((button) => {
    button.addEventListener('click', () => closeSession(button.dataset.id));
  });
}

async function switchToSession(sessionId) {
  if (!sessionId || sessionId === state.activeSessionId) return;

  try {
    const result = await window.sshClient.switchSession(sessionId);
    state.sessions = result.sessions || state.sessions;
    setActiveSession(sessionId);
    renderActiveServer();
    renderSessionSwitcher();
    buildStatusView();
    buildFilesView();
    buildTerminalView();
    buildSystemView();
    buildVpnView();
    buildBotsView();
    setView(state.currentView);
    pushLog('system', `Switched to ${state.activeServer.host}`);
  } catch (error) {
    pushLog('error', error.message || 'Could not switch session');
  }
}

async function closeSession(sessionId) {
  try {
    saveCurrentSessionState();
    const result = await window.sshClient.closeSession(sessionId);
    delete state.sessionData[sessionId];
    state.sessions = result.sessions || [];

    if (!state.sessions.length) {
      handleDisconnect('All SSH sessions closed. Please reconnect.');
      return;
    }

    const nextSessionId = result.currentSession ? result.currentSession.id : state.sessions[0].id;
    setActiveSession(nextSessionId);
    renderDashboard();
  } catch (error) {
    pushLog('error', error.message || 'Could not close session');
  }
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
}

function setView(view) {
  state.currentView = view;
  document.querySelector('#view-title').textContent = viewTitles[view];
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.id === `${view}-view`);
  });

  if (view === 'system' && !state.systemInfo) loadSystemInfo();
  if (view === 'files' && !state.fileManager.items.length) loadDirectory(state.fileManager.path);
  if (view === 'vpn' && !state.vpn.engine && !state.vpn.compatibility) loadVpnData();
  if (view === 'terminal') {
    const screen = document.querySelector('#terminal-screen');
    if (screen) screen.focus();
  }
  if (view === 'bots') {
    loadBotsData();
    startBotPolling();
  } else {
    stopBotPolling();
  }
}

function validateCredentials({ host, port, username, password }) {
  if (!host) throw new Error('IP address or host is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a number from 1 to 65535.');
  if (!username) throw new Error('Login is required.');
  if (!password) throw new Error('Password is required.');
}

async function connectWithCredentials(credentials, { button, errorNode, activeServer, savedId } = {}) {
  const originalText = button ? button.textContent : '';

  try {
    validateCredentials(credentials);
    if (errorNode) errorNode.textContent = '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Connecting...';
    }

    const connection = await window.sshClient.connect({ ...credentials, name: activeServer.name });
    state.sessions = connection.sessions || (connection.session ? [connection.session] : state.sessions);

    if (savedId) {
      const updatedServer = await window.sshClient.markServerConnected(savedId);
      activeServer.name = updatedServer.name;
      activeServer.savedId = updatedServer.id;
    }

    state.connected = true;
    const session = connection.session || {};
    activeServer.host = session.host || activeServer.host;
    activeServer.port = session.port || activeServer.port;
    activeServer.username = session.username || activeServer.username;
    state.activeServer = activeServer;
    setActiveSession(connection.sessionId);
    pushLog('connection', `Connected to ${credentials.username}@${credentials.host}:${credentials.port}`);
    renderDashboard();
  } catch (error) {
    if (errorNode) errorNode.textContent = error.message || 'Connection failed';
    else pushLog('error', error.message || 'Connection failed');
  } finally {
    credentials.password = '';
    if (button) {
      button.disabled = false;
      button.textContent = originalText || 'Connect';
    }
  }
}

async function loadSavedServers() {
  try {
    state.savedServers = await window.sshClient.getServers();
  } catch (error) {
    pushLog('error', error.message || 'Could not load saved servers');
  }
  // Both renderers are guarded on element presence, so this safely updates
  // whichever screen is currently mounted: the login list and/or the
  // dashboard sidebar switcher.
  renderSavedServers();
  renderSessionSwitcher();
}

function renderSavedServers() {
  const list = document.querySelector('#saved-server-list');
  if (!list) return;

  const servers = state.savedServers.filter((server) => {
    const value = `${server.name} ${server.host} ${server.username}`.toLowerCase();
    return value.includes(state.serverSearch);
  });

  if (!servers.length) {
    list.innerHTML = '<p class="muted">No saved servers yet.</p>';
    return;
  }

  list.innerHTML = servers.map((server) => `
    <article class="saved-server-card">
      <div class="saved-server-main">
        <strong>${escapeHtml(server.name)}</strong>
        <span>${escapeHtml(server.username)}@${escapeHtml(server.host)}:${server.port}</span>
        <small>${server.lastConnectedAt ? `Last connected ${formatDateTime(server.lastConnectedAt)}` : 'Not connected yet'}</small>
      </div>
      <div class="saved-server-actions">
        <button class="secondary-btn server-connect" type="button" data-id="${escapeHtml(server.id)}">Connect</button>
        <button class="secondary-btn server-edit" type="button" data-id="${escapeHtml(server.id)}">Edit</button>
        <button class="danger-btn server-delete" type="button" data-id="${escapeHtml(server.id)}">Delete</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('.server-connect').forEach((button) => {
    button.addEventListener('click', () => requestSavedServerPassword(button.dataset.id));
  });
  list.querySelectorAll('.server-edit').forEach((button) => {
    button.addEventListener('click', () => requestEditServer(button.dataset.id));
  });
  list.querySelectorAll('.server-delete').forEach((button) => {
    button.addEventListener('click', () => deleteSavedServer(button.dataset.id));
  });
}

function fillLoginForm(server) {
  const form = document.querySelector('#login-form');
  if (!form) return;
  form.host.value = server.host;
  form.port.value = server.port;
  form.username.value = server.username;
  form.password.value = '';
}

function requestSavedServerPassword(id) {
  const server = state.savedServers.find((item) => item.id === id);
  if (!server) return;
  fillLoginForm(server);

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="saved-password-form">
      <div class="modal-body">
        <h3>Connect to ${escapeHtml(server.name)}</h3>
        <p class="muted">${escapeHtml(server.username)}@${escapeHtml(server.host)}:${server.port}</p>
        <input id="saved-password-input" type="password" autocomplete="current-password" placeholder="Password" autofocus>
        <p class="form-error" id="saved-password-error"></p>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-saved-password" type="button">Cancel</button>
          <button class="primary-btn" type="submit">Connect</button>
        </div>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('#saved-password-form');
  const input = backdrop.querySelector('#saved-password-input');
  const errorNode = backdrop.querySelector('#saved-password-error');
  const button = form.querySelector('.primary-btn');
  setTimeout(() => input.focus(), 0);

  backdrop.querySelector('#cancel-saved-password').addEventListener('click', () => backdrop.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      button.disabled = true;
      button.textContent = 'Connecting...';
      const connection = await window.sshClient.createSavedSession({ id, password: input.value });
      state.sessions = connection.sessions || (connection.session ? [connection.session] : state.sessions);
      state.connected = true;
      state.activeServer = {
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        savedId: id
      };
      setActiveSession(connection.sessionId);
      pushLog('connection', `Connected to ${server.username}@${server.host}:${server.port}`);
      renderDashboard();
      input.value = '';
      if (state.connected) backdrop.remove();
    } catch (error) {
      input.value = '';
      errorNode.textContent = error.message || 'Connection failed';
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  });
}

function requestEditServer(id) {
  const server = state.savedServers.find((item) => item.id === id);
  if (!server) return;
  requestServerDetails('Edit Server', server, async (payload) => {
    await window.sshClient.updateServer({ ...payload, id });
    await loadSavedServers();
    pushLog('system', `Saved server updated: ${payload.name}`);
  });
}

function deleteSavedServer(id) {
  const server = state.savedServers.find((item) => item.id === id);
  if (!server) return;

  confirmDanger(`Delete saved server "${server.name}"?`, async () => {
    try {
      await window.sshClient.deleteServer(id);
      await loadSavedServers();
      pushLog('system', `Saved server deleted: ${server.name}`);
    } catch (error) {
      pushLog('error', error.message || 'Could not delete saved server');
    }
  });
}

function requestSaveActiveServer() {
  if (!state.activeServer) return;

  requestServerDetails('Save Server', {
    name: state.activeServer.name || state.activeServer.host,
    host: state.activeServer.host,
    port: state.activeServer.port,
    username: state.activeServer.username
  }, async (payload) => {
    const server = await window.sshClient.saveServer({
      ...payload,
      lastConnectedAt: new Date().toISOString()
    });
    state.activeServer = { ...server, savedId: server.id };
    renderActiveServer();
    await loadSavedServers();
    pushLog('system', `Saved server: ${server.name}`);
  });
}

function requestNewSession() {
  requestConnectionDetails('New SSH Session', {
    name: '',
    host: '',
    port: 22,
    username: ''
  }, async (payload, password) => {
    await connectWithCredentials({
      host: payload.host,
      port: payload.port,
      username: payload.username,
      password
    }, {
      activeServer: {
        name: payload.name || payload.host,
        host: payload.host,
        port: payload.port,
        username: payload.username,
        savedId: ''
      }
    });
  });
}

function requestConnectionDetails(title, server, onSubmit) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="connection-details-form">
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        <label>
          <span>Name</span>
          <input id="connection-name-input" value="${escapeHtml(server.name || '')}" autocomplete="off">
        </label>
        <div class="connection-grid">
          <label>
            <span>IP address</span>
            <input id="connection-host-input" value="${escapeHtml(server.host || '')}" autocomplete="off" required>
          </label>
          <label>
            <span>Port</span>
            <input id="connection-port-input" type="number" min="1" max="65535" step="1" value="${escapeHtml(server.port || 22)}" required>
          </label>
        </div>
        <label>
          <span>Login</span>
          <input id="connection-username-input" value="${escapeHtml(server.username || '')}" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input id="connection-password-input" type="password" autocomplete="current-password" required>
        </label>
        <p class="form-error" id="connection-details-error"></p>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-connection-details" type="button">Cancel</button>
          <button class="primary-btn" type="submit">Connect</button>
        </div>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('#connection-details-form');
  const errorNode = backdrop.querySelector('#connection-details-error');
  const passwordInput = backdrop.querySelector('#connection-password-input');
  setTimeout(() => backdrop.querySelector('#connection-host-input').focus(), 0);

  backdrop.querySelector('#cancel-connection-details').addEventListener('click', () => backdrop.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: backdrop.querySelector('#connection-name-input').value.trim(),
      host: backdrop.querySelector('#connection-host-input').value.trim(),
      port: Number(backdrop.querySelector('#connection-port-input').value),
      username: backdrop.querySelector('#connection-username-input').value.trim()
    };

    try {
      validateCredentials({ ...payload, password: passwordInput.value });
      await onSubmit(payload, passwordInput.value);
      passwordInput.value = '';
      backdrop.remove();
    } catch (error) {
      passwordInput.value = '';
      errorNode.textContent = error.message || 'Could not connect.';
    }
  });
}

function requestServerDetails(title, server, onSubmit) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="server-details-form">
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        <label>
          <span>Name</span>
          <input id="server-name-input" value="${escapeHtml(server.name || '')}" autocomplete="off" required>
        </label>
        <div class="connection-grid">
          <label>
            <span>IP address</span>
            <input id="server-host-input" value="${escapeHtml(server.host || '')}" autocomplete="off" required>
          </label>
          <label>
            <span>Port</span>
            <input id="server-port-input" type="number" min="1" max="65535" step="1" value="${escapeHtml(server.port || 22)}" required>
          </label>
        </div>
        <label>
          <span>Login</span>
          <input id="server-username-input" value="${escapeHtml(server.username || '')}" autocomplete="username" required>
        </label>
        <p class="form-error" id="server-details-error"></p>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-server-details" type="button">Cancel</button>
          <button class="primary-btn" type="submit">Save</button>
        </div>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('#server-details-form');
  const errorNode = backdrop.querySelector('#server-details-error');
  setTimeout(() => backdrop.querySelector('#server-name-input').focus(), 0);

  backdrop.querySelector('#cancel-server-details').addEventListener('click', () => backdrop.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: backdrop.querySelector('#server-name-input').value.trim(),
      host: backdrop.querySelector('#server-host-input').value.trim(),
      port: Number(backdrop.querySelector('#server-port-input').value),
      username: backdrop.querySelector('#server-username-input').value.trim()
    };

    try {
      validateCredentials({ ...payload, password: 'placeholder' });
      await onSubmit(payload);
      backdrop.remove();
    } catch (error) {
      errorNode.textContent = error.message || 'Could not save server.';
    }
  });
}

function renderActiveServer() {
  const line = document.querySelector('#active-server-line');
  if (!line || !state.activeServer) return;
  line.textContent = `${state.activeServer.name || state.activeServer.host} - ${state.activeServer.username}@${state.activeServer.host}:${state.activeServer.port}`;
  updateSaveServerButton(document.querySelector('#save-server-button'));
  return;
  line.textContent = `${state.activeServer.name || state.activeServer.host} · ${state.activeServer.username}@${state.activeServer.host}:${state.activeServer.port}`;
}

function updateSaveServerButton(button) {
  if (!button) return;
  const saved = Boolean(state.activeServer && state.activeServer.savedId);
  button.textContent = saved ? 'Saved' : 'Save Server';
  button.disabled = saved;
}

function buildStatusView() {
  const view = document.querySelector('#status-view');
  view.innerHTML = `
    <div class="grid-2">
      <article class="panel">
        <div class="panel-header">
          <h3>SSH status</h3>
          <span class="status-pill online">online</span>
        </div>
        <div class="panel-body">
          <p class="muted">Connection is active. If the session closes, the app returns to the connection screen.</p>
          <div class="session-details" id="session-details"></div>
        </div>
      </article>
      <article class="panel">
        <div class="panel-header">
          <h3>Events</h3>
          <button class="secondary-btn" id="clear-logs">Clear</button>
        </div>
        <div class="panel-body">
          <div class="log-list" id="log-list"></div>
        </div>
      </article>
    </div>
  `;

  document.querySelector('#clear-logs').addEventListener('click', () => {
    state.logs = [];
    renderLogs();
  });
  renderSessionDetails();
  renderLogs();
}

function renderSessionDetails() {
  const node = document.querySelector('#session-details');
  if (!node || !state.activeServer) return;
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  const statusLabel = session ? session.status : (state.connected ? 'online' : 'unknown');
  node.innerHTML = `
    <div class="info-list compact-info">
      ${infoRow('Server', state.activeServer.name || state.activeServer.host)}
      ${infoRow('Host', `${state.activeServer.host}:${state.activeServer.port}`)}
      ${infoRow('User', state.activeServer.username)}
      ${infoRow('Status', statusLabel)}
      ${infoRow('Connected since', session ? formatDateTime(session.createdAt) : 'Unknown')}
      ${infoRow('Last activity', session ? formatDateTime(session.lastActiveAt) : 'Unknown')}
      ${infoRow('Active sessions', String(state.sessions.length))}
    </div>
  `;
}

function renderLogs() {
  const list = document.querySelector('#log-list');
  if (!list) return;

  if (!state.logs.length) {
    list.innerHTML = '<p class="muted">No events yet.</p>';
    return;
  }

  list.innerHTML = state.logs.map((entry) => `
    <div class="log-row">
      <span>${formatTime(entry.time)}</span>
      <span class="log-type">${entry.type}</span>
      <span>${escapeHtml(entry.message)}</span>
    </div>
  `).join('');
}

function buildFilesView() {
  const view = document.querySelector('#files-view');
  view.innerHTML = `
    <div class="file-manager">
      <article class="panel">
        <div class="panel-header file-toolbar">
          <div class="path-group">
            <span class="muted">Current path</span>
            <strong id="file-current-path">.</strong>
          </div>
          <div class="file-actions">
            <button class="secondary-btn" id="file-back">Back</button>
            <button class="secondary-btn" id="file-refresh">Refresh</button>
            <button class="secondary-btn" id="file-create-file">New file</button>
            <button class="secondary-btn" id="file-create-folder">New folder</button>
            <button class="secondary-btn" id="file-upload">Upload files</button>
            <button class="danger-btn" id="file-delete" disabled>Delete</button>
          </div>
        </div>
        <div class="panel-body">
          <p class="form-error" id="file-error"></p>
          <p class="muted">Choose files or folders from this device to upload them into the current path.</p>
          <div class="file-list" id="file-list"></div>
        </div>
      </article>
    </div>
  `;

  document.querySelector('#file-back').addEventListener('click', () => loadDirectory(`${state.fileManager.path}/..`));
  document.querySelector('#file-refresh').addEventListener('click', () => loadDirectory(state.fileManager.path));
  document.querySelector('#file-create-file').addEventListener('click', () => requestFileName('Create file', 'File name', createRemoteFile));
  document.querySelector('#file-create-folder').addEventListener('click', () => requestFileName('Create folder', 'Folder name', createRemoteFolder));
  document.querySelector('#file-upload').addEventListener('click', uploadSelectedItems);
  document.querySelector('#file-delete').addEventListener('click', deleteSelectedFileItem);
  renderFiles();
}

async function uploadSelectedItems() {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.fileManager.loading) return;

  const directory = state.fileManager.path;
  state.fileManager.loading = true;
  state.fileManager.error = '';
  state.fileManager.busyLabel = 'Uploading files...';
  renderFiles();
  pushLog('system', `Choose files or folders to upload to ${directory}...`);

  try {
    const result = await window.sshClient.uploadItems({ sessionId, directory });
    if (state.activeSessionId !== sessionId) return;
    if (result.canceled) return;

    state.fileManager.path = result.path;
    state.fileManager.items = result.items;
    state.fileManager.selected = null;

    if (result.errors && result.errors.length) {
      state.fileManager.error = `${result.uploaded} uploaded, ${result.errors.length} failed.`;
    } else {
      pushLog('system', `Uploaded ${result.uploaded} item(s) to ${result.path}`);
    }
  } catch (error) {
    state.fileManager.error = error.message || 'Upload failed';
    pushLog('error', state.fileManager.error);
  } finally {
    state.fileManager.loading = false;
    state.fileManager.busyLabel = '';
    renderFiles();
  }
}

function fileItemPath(item) {
  const base = state.fileManager.path;
  return base.endsWith('/') ? `${base}${item.name}` : `${base}/${item.name}`;
}

async function loadDirectory(path) {
  const sessionId = state.activeSessionId;
  const data = ensureSessionData(sessionId);
  state.fileManager.loading = true;
  state.fileManager.error = '';
  data.fileManager = state.fileManager;
  renderFiles();

  try {
    const result = await window.sshClient.navigateFiles({ sessionId, path });
    data.fileManager.path = result.path;
    data.fileManager.items = result.items;
    data.fileManager.selected = null;
    pushLog('system', `File manager opened ${result.path}`);
  } catch (error) {
    data.fileManager.error = error.message || 'Could not load directory';
    pushLog('error', data.fileManager.error);
  } finally {
    data.fileManager.loading = false;
    if (state.activeSessionId === sessionId) {
      state.fileManager = data.fileManager;
      renderFiles();
    }
  }
}

function renderFiles() {
  const pathNode = document.querySelector('#file-current-path');
  const list = document.querySelector('#file-list');
  const error = document.querySelector('#file-error');
  const deleteButton = document.querySelector('#file-delete');
  const refreshButton = document.querySelector('#file-refresh');
  const backButton = document.querySelector('#file-back');

  if (!list || !pathNode || !error || !deleteButton || !refreshButton || !backButton) return;

  pathNode.textContent = state.fileManager.path;
  error.textContent = state.fileManager.error;
  deleteButton.disabled = !state.fileManager.selected || state.fileManager.loading;
  refreshButton.disabled = state.fileManager.loading;
  backButton.disabled = state.fileManager.loading || state.fileManager.path === '/';

  if (state.fileManager.loading) {
    list.innerHTML = `<p class="muted">${escapeHtml(state.fileManager.busyLabel || 'Loading files...')}</p>`;
    return;
  }

  if (!state.fileManager.items.length) {
    list.innerHTML = '<p class="muted">Directory is empty.</p>';
    return;
  }

  list.innerHTML = state.fileManager.items.map((item) => `
    <div class="file-row ${state.fileManager.selected && state.fileManager.selected.name === item.name ? 'selected' : ''}">
      <button class="file-open" type="button" data-name="${escapeHtml(item.name)}">
        <span class="file-kind">${item.type === 'directory' ? 'DIR' : 'FILE'}</span>
        <span class="file-name">${escapeHtml(item.name)}</span>
        <span class="file-meta">${item.type === 'directory' ? '' : `${formatBytes(item.size)}`}</span>
        <span class="file-meta">${escapeHtml(item.modified)}</span>
      </button>
      <button class="secondary-btn file-select" type="button" data-name="${escapeHtml(item.name)}">Select</button>
    </div>
  `).join('');

  list.querySelectorAll('.file-open').forEach((button) => {
    button.addEventListener('click', () => openFileRow(button.dataset.name));
  });

  list.querySelectorAll('.file-select').forEach((button) => {
    button.addEventListener('click', () => selectFileRow(button.dataset.name));
  });
}

function selectFileRow(name) {
  state.fileManager.selected = state.fileManager.items.find((item) => item.name === name) || null;
  renderFiles();
}

async function openFileRow(name) {
  const item = state.fileManager.items.find((entry) => entry.name === name);
  if (!item) return;

  if (item.type === 'directory') {
    await loadDirectory(fileItemPath(item));
    return;
  }

  try {
    const result = await window.sshClient.openFile({ sessionId: state.activeSessionId, path: fileItemPath(item) });
    showFileContent(result.path, result.content);
    pushLog('system', `Opened file ${result.path}`);
  } catch (error) {
    state.fileManager.error = error.message || 'Could not open file';
    pushLog('error', state.fileManager.error);
    renderFiles();
  }
}

function requestFileName(title, placeholder, onSubmit) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="file-name-form">
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        <input id="file-name-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" autofocus>
        <p class="form-error" id="file-name-error"></p>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-file-name" type="button">Cancel</button>
          <button class="primary-btn" type="submit">Create</button>
        </div>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('#file-name-form');
  const input = backdrop.querySelector('#file-name-input');
  const error = backdrop.querySelector('#file-name-error');
  setTimeout(() => input.focus(), 0);

  backdrop.querySelector('#cancel-file-name').addEventListener('click', () => backdrop.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) {
      error.textContent = 'Name is required.';
      return;
    }

    try {
      await onSubmit(name);
      backdrop.remove();
    } catch (err) {
      error.textContent = err.message || 'Operation failed.';
    }
  });
}

async function createRemoteFile(name) {
  const result = await window.sshClient.createFile({ sessionId: state.activeSessionId, directory: state.fileManager.path, name });
  state.fileManager.path = result.path;
  state.fileManager.items = result.items;
  state.fileManager.selected = null;
  pushLog('system', `Created file ${name}`);
  renderFiles();
}

async function createRemoteFolder(name) {
  const result = await window.sshClient.createFolder({ sessionId: state.activeSessionId, directory: state.fileManager.path, name });
  state.fileManager.path = result.path;
  state.fileManager.items = result.items;
  state.fileManager.selected = null;
  pushLog('system', `Created folder ${name}`);
  renderFiles();
}

function deleteSelectedFileItem() {
  const item = state.fileManager.selected;
  if (!item) return;

  const path = fileItemPath(item);
  deleteRemoteItem(path);
}

async function deleteRemoteItem(path) {
  try {
    state.fileManager.loading = true;
    renderFiles();
    const result = await window.sshClient.deleteItem({ sessionId: state.activeSessionId, path, currentPath: state.fileManager.path });
    state.fileManager.path = result.path;
    state.fileManager.items = result.items;
    state.fileManager.selected = null;
    pushLog('system', `Deleted ${path}`);
  } catch (error) {
    state.fileManager.error = error.message || 'Could not delete item';
    pushLog('error', state.fileManager.error);
  } finally {
    state.fileManager.loading = false;
    renderFiles();
  }
}

function showFileContent(path, content) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal file-preview-modal">
      <div class="modal-body">
        <div class="panel-header preview-header">
          <h3>${escapeHtml(path)}</h3>
          <button class="secondary-btn" id="close-file-preview" type="button">Close</button>
        </div>
        <pre class="file-preview"></pre>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.querySelector('.file-preview').textContent = content || '';
  backdrop.querySelector('#close-file-preview').addEventListener('click', () => backdrop.remove());
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

const MAX_TERMINAL_SCROLLBACK = 5000;

function createTerminalBuffer() {
  return {
    scrollback: [],
    rows: Array.from({ length: TERMINAL_ROWS }, () => ''),
    cursorRow: 0,
    cursorCol: 0,
    pending: '',
    scrollbackHtmlCache: '',
    scrollbackRenderedCount: 0
  };
}

function terminalBufferClear(buffer) {
  buffer.scrollback = [];
  buffer.rows = Array.from({ length: TERMINAL_ROWS }, () => '');
  buffer.cursorRow = 0;
  buffer.cursorCol = 0;
  buffer.scrollbackHtmlCache = '';
  buffer.scrollbackRenderedCount = 0;
}

// Minimal VT100/ANSI interpreter: enough to render an interactive shell
// prompt correctly (line editing, history recall, tab completion, `clear`,
// and arrow-key driven selection menus that redraw a few lines in place via
// cursor-up/cursor-down) without pulling in a full terminal-emulator
// library. Full-screen programs that rely on an alternate screen buffer or
// absolute cursor positioning across a fixed grid (vim, htop, less) are out
// of scope.
function feedTerminalBuffer(buffer, chunk) {
  const text = (buffer.pending || '') + chunk;
  buffer.pending = '';
  const len = text.length;
  let i = 0;

  function currentLine() {
    return buffer.rows[buffer.cursorRow] || '';
  }

  function setCurrentLine(line) {
    buffer.rows[buffer.cursorRow] = line;
  }

  function newline() {
    if (buffer.cursorRow < buffer.rows.length - 1) {
      buffer.cursorRow += 1;
    } else {
      // Already at the bottom of the fixed-size viewport: scroll it up by
      // one line, same as a real terminal. Row count never changes, so
      // cursor-position escapes keep working correctly afterwards.
      buffer.scrollback.push(buffer.rows.shift());
      buffer.rows.push('');
      if (buffer.scrollback.length > MAX_TERMINAL_SCROLLBACK) {
        buffer.scrollback.splice(0, buffer.scrollback.length - MAX_TERMINAL_SCROLLBACK);
      }
    }
    buffer.cursorCol = 0;
  }

  function writeChar(ch) {
    const line = currentLine();
    if (buffer.cursorCol < line.length) {
      setCurrentLine(line.slice(0, buffer.cursorCol) + ch + line.slice(buffer.cursorCol + 1));
    } else {
      setCurrentLine(line + ' '.repeat(buffer.cursorCol - line.length) + ch);
    }
    buffer.cursorCol += 1;
  }

  while (i < len) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (ch === '\n') {
      newline();
      i += 1;
      continue;
    }

    if (ch === '\r') {
      buffer.cursorCol = 0;
      i += 1;
      continue;
    }

    if (code === 8 || code === 127) {
      buffer.cursorCol = Math.max(0, buffer.cursorCol - 1);
      i += 1;
      continue;
    }

    if (ch === '\x1b') {
      if (i + 1 >= len) {
        buffer.pending = text.slice(i);
        break;
      }

      const next = text[i + 1];

      if (next === '[') {
        let j = i + 2;
        while (j < len && !/[a-zA-Z@]/.test(text[j])) j += 1;
        if (j >= len) {
          buffer.pending = text.slice(i);
          break;
        }

        const params = text.slice(i + 2, j);
        const final = text[j];
        const nums = params.split(';').filter(Boolean).map(Number);
        const n = nums.length ? nums[0] : 1;

        if (final === 'K') {
          const mode = nums[0] || 0;
          const line = currentLine();
          if (mode === 0) setCurrentLine(line.slice(0, buffer.cursorCol));
          else if (mode === 1) setCurrentLine(' '.repeat(buffer.cursorCol) + line.slice(buffer.cursorCol));
          else setCurrentLine('');
        } else if (final === 'J') {
          terminalBufferClear(buffer);
        } else if (final === 'A') {
          buffer.cursorRow = Math.max(0, buffer.cursorRow - n);
          buffer.cursorCol = Math.min(buffer.cursorCol, currentLine().length);
        } else if (final === 'B') {
          buffer.cursorRow = Math.min(buffer.rows.length - 1, buffer.cursorRow + n);
          buffer.cursorCol = Math.min(buffer.cursorCol, currentLine().length);
        } else if (final === 'C') {
          buffer.cursorCol = Math.min(currentLine().length, buffer.cursorCol + n);
        } else if (final === 'D') {
          buffer.cursorCol = Math.max(0, buffer.cursorCol - n);
        } else if (final === 'G') {
          buffer.cursorCol = Math.max(0, Math.min(currentLine().length, n - 1));
        } else if (final === 'H' || final === 'f') {
          const row = nums[0] || 1;
          const col = nums[1] || 1;
          buffer.cursorRow = Math.max(0, Math.min(buffer.rows.length - 1, row - 1));
          buffer.cursorCol = Math.max(0, col - 1);
        }
        // Other CSI sequences (colors, cursor save/restore, mode toggles) are ignored.

        i = j + 1;
        continue;
      }

      if (next === ']') {
        let j = i + 2;
        while (j < len && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j += 1;
        if (j >= len) {
          buffer.pending = text.slice(i);
          break;
        }
        i = text[j] === '\x07' ? j + 1 : j + 2;
        continue;
      }

      i += 2;
      continue;
    }

    if (code < 32) {
      i += 1;
      continue;
    }

    writeChar(ch);
    i += 1;
  }
}

async function ensureShellOpen(sessionId) {
  if (!sessionId) return;
  const data = ensureSessionData(sessionId);
  if (data.shellOpen || data.shellOpening) return;

  data.shellOpening = true;
  if (sessionId === state.activeSessionId) state.shellOpening = true;

  try {
    await window.sshClient.openShell({ sessionId, cols: 120, rows: 32 });
    data.shellOpen = true;

    try {
      const remoteStatus = await window.sshClient.getRemoteVpnStatus(sessionId);
      if (remoteStatus && remoteStatus.running && remoteStatus.proxy) {
        await applyVpnProxyToTerminal(sessionId, remoteStatus.proxy);
      }
    } catch (_error) {
      // Best effort - if the remote VPN status check fails we just skip auto-proxying.
    }
  } catch (error) {
    pushLog('error', `Could not start terminal shell: ${error.message}`);
  } finally {
    data.shellOpening = false;
    if (sessionId === state.activeSessionId) {
      state.shellOpen = data.shellOpen;
      state.shellOpening = false;
      renderTerminalScreen();
    }
  }
}

// Pushes the VPN's HTTP-compatible mixed proxy (or clears it) into the persistent remote
// shell as standard proxy env vars, so CLI tools started in the Terminal
// tab (like `codex`) route through the VPN automatically instead of
// requiring the user to type `export` by hand every time.
async function applyVpnProxyToTerminal(sessionId, proxy) {
  const data = ensureSessionData(sessionId);
  if (!data.shellOpen) return;

  try {
    if (proxy) {
      await window.sshClient.applyRemoteVpnShellProxy({ sessionId, enabled: true });
      pushLog('system', `Terminal now routes through the VPN proxy at ${proxy} (codex and other CLI tools started here will use it automatically).`);
    } else {
      await window.sshClient.applyRemoteVpnShellProxy({ sessionId, enabled: false });
      pushLog('system', 'Terminal VPN proxy variables cleared.');
    }
  } catch (_error) {
    // Best effort - the shell may not be open yet or the session may have changed.
  }
}

function buildTerminalView() {
  const view = document.querySelector('#terminal-view');
  view.innerHTML = `
    <div class="terminal">
      <article class="panel">
        <div class="panel-header">
          <h3>Terminal</h3>
          <div class="file-actions">
            <button class="secondary-btn" id="copy-output">Copy output</button>
            <button class="secondary-btn" id="clear-terminal">Clear</button>
            <button class="secondary-btn" id="restart-shell">Restart shell</button>
          </div>
        </div>
        <div class="panel-body">
          <p class="muted terminal-hint">Click the screen below and type. Arrow keys, Ctrl+C, Tab completion, command history, and sudo password prompts all work like a normal SSH terminal.</p>
        </div>
      </article>
      <div class="terminal-screen" id="terminal-screen" tabindex="0"></div>
    </div>
  `;

  const screen = document.querySelector('#terminal-screen');
  screen.addEventListener('keydown', handleTerminalKeydown);
  screen.addEventListener('paste', handleTerminalPaste);
  screen.addEventListener('click', () => screen.focus());

  document.querySelector('#clear-terminal').addEventListener('click', () => {
    terminalBufferClear(ensureSessionData(state.activeSessionId).terminalBuffer);
    renderTerminalScreen();
  });

  document.querySelector('#copy-output').addEventListener('click', async () => {
    const buffer = ensureSessionData(state.activeSessionId).terminalBuffer;
    const text = [...buffer.scrollback, ...buffer.rows].join('\n');
    await navigator.clipboard.writeText(text);
    pushLog('system', 'Terminal output copied');
  });

  document.querySelector('#restart-shell').addEventListener('click', async () => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await window.sshClient.closeShell({ sessionId });
    } catch (_error) {
      // shell may already be closed - ignore
    }

    const data = ensureSessionData(sessionId);
    data.shellOpen = false;
    terminalBufferClear(data.terminalBuffer);
    renderTerminalScreen();
    pushLog('system', 'Restarting terminal shell...');
    await ensureShellOpen(sessionId);
  });

  ensureShellOpen(state.activeSessionId);
  renderTerminalScreen();
}

function handleTerminalKeydown(event) {
  const sessionId = state.activeSessionId;
  if (!sessionId) return;

  let data = '';

  if (event.metaKey || event.altKey) {
    return;
  }

  if (event.ctrlKey) {
    const controlCharacter = window.sshClient.terminalControlCharacter({
      ctrlKey: true,
      key: event.key,
      code: event.code
    });
    if (controlCharacter === null) return;
    data = controlCharacter;
  } else if (event.key === 'Enter') {
    data = '\r';
  } else if (event.key === 'Backspace') {
    data = '\x7f';
  } else if (event.key === 'Tab') {
    data = '\t';
  } else if (event.key === 'Escape') {
    data = '\x1b';
  } else if (event.key === 'ArrowUp') {
    data = '\x1b[A';
  } else if (event.key === 'ArrowDown') {
    data = '\x1b[B';
  } else if (event.key === 'ArrowRight') {
    data = '\x1b[C';
  } else if (event.key === 'ArrowLeft') {
    data = '\x1b[D';
  } else if (event.key === 'Home') {
    data = '\x01';
  } else if (event.key === 'End') {
    data = '\x05';
  } else if (event.key === 'Delete') {
    data = '\x1b[3~';
  } else if (event.key.length === 1) {
    data = event.key;
  } else {
    return;
  }

  event.preventDefault();

  // The shell may still be opening (or was just closed and is being
  // reopened). Silently ignore keystrokes until it is ready instead of
  // firing "No active terminal shell" into the event log on every key.
  if (!ensureSessionData(sessionId).shellOpen) return;

  window.sshClient.writeShell({ sessionId, data }).catch((error) => {
    pushLog('error', error.message || 'Could not send input to terminal.');
  });
}

function handleTerminalPaste(event) {
  event.preventDefault();
  const sessionId = state.activeSessionId;
  if (!sessionId) return;
  if (!ensureSessionData(sessionId).shellOpen) return;

  const text = event.clipboardData.getData('text');
  if (!text) return;

  // Wrap in "bracketed paste" markers (\e[200~ ... \e[201~). Bash's readline
  // recognizes this and inserts the pasted text as literal characters
  // instead of treating every newline inside it as pressing Enter - which
  // is what was causing pasted multi-line snippets to auto-run immediately.
  const bracketed = `\x1b[200~${text}\x1b[201~`;

  window.sshClient.writeShell({ sessionId, data: bracketed }).catch((error) => {
    pushLog('error', error.message || 'Could not paste into terminal.');
  });
}

let terminalRenderScheduled = false;

// Shell data can arrive in many small chunks in quick succession (e.g. `cat`
// on a big file). Rendering on every single chunk forces a full innerHTML
// rebuild + reflow each time. Coalescing into one render per animation frame
// keeps the terminal feeling identical while cutting redundant paints.
function scheduleTerminalRender() {
  if (terminalRenderScheduled) return;
  terminalRenderScheduled = true;
  requestAnimationFrame(() => {
    terminalRenderScheduled = false;
    renderTerminalScreen();
  });
}

// Building the scrollback HTML used to re-escape and re-join the entire
// scrollback array (up to MAX_TERMINAL_SCROLLBACK lines) on every single
// render call. Instead, cache the rendered HTML on the buffer and only
// escape newly-added lines, so a render is O(new lines) instead of
// O(total scrollback).
function scrollbackHtml(buffer) {
  if (buffer.scrollbackRenderedCount === undefined || buffer.scrollbackRenderedCount > buffer.scrollback.length) {
    // First render, or the scrollback array got trimmed/cleared - rebuild once.
    buffer.scrollbackHtmlCache = buffer.scrollback.map((line) => escapeHtml(line)).join('\n');
    buffer.scrollbackRenderedCount = buffer.scrollback.length;
    return buffer.scrollbackHtmlCache;
  }

  if (buffer.scrollbackRenderedCount < buffer.scrollback.length) {
    const newLines = buffer.scrollback.slice(buffer.scrollbackRenderedCount).map((line) => escapeHtml(line)).join('\n');
    buffer.scrollbackHtmlCache = buffer.scrollbackHtmlCache ? `${buffer.scrollbackHtmlCache}\n${newLines}` : newLines;
    buffer.scrollbackRenderedCount = buffer.scrollback.length;
  }

  return buffer.scrollbackHtmlCache || '';
}

function renderTerminalScreen() {
  const node = document.querySelector('#terminal-screen');
  if (!node) return;

  const buffer = ensureSessionData(state.activeSessionId).terminalBuffer;

  if (!buffer.scrollback.length && buffer.rows.every((line) => !line)) {
    node.innerHTML = '<span class="muted">Waiting for the shell to connect...</span>';
    return;
  }

  const scrollback = scrollbackHtml(buffer);
  const rowsHtml = buffer.rows.map((line, index) => {
    if (index !== buffer.cursorRow) return escapeHtml(line);
    const before = escapeHtml(line.slice(0, buffer.cursorCol));
    const after = escapeHtml(line.slice(buffer.cursorCol));
    return `${before}<span class="terminal-cursor"></span>${after}`;
  }).join('\n');

  // "Stick to bottom" behaviour: only auto-scroll to the newest output when
  // the user is already at (or very near) the bottom. If they've scrolled up
  // to read earlier output, leave their position where it is instead of
  // yanking them back down on every incoming chunk.
  const prevScrollTop = node.scrollTop;
  const atBottom = node.scrollHeight - prevScrollTop - node.clientHeight < 40;

  node.innerHTML = `${scrollback ? `${scrollback}\n` : ''}${rowsHtml}`;

  if (atBottom) {
    node.scrollTop = node.scrollHeight;
  } else {
    node.scrollTop = prevScrollTop;
  }
}

function buildSystemView() {
  const view = document.querySelector('#system-view');
  view.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3>System Info</h3>
        <button class="secondary-btn" id="refresh-system">Refresh</button>
      </div>
      <div class="panel-body" id="system-info-body">
        <p class="muted">Open this section to load remote system data.</p>
      </div>
    </div>
  `;

  document.querySelector('#refresh-system').addEventListener('click', () => {
    state.systemInfo = null;
    ensureSessionData(state.activeSessionId).systemInfo = null;
    loadSystemInfo();
  });
}

async function loadSystemInfo() {
  const body = document.querySelector('#system-info-body');
  if (!body) return;
  const sessionId = state.activeSessionId;
  body.innerHTML = '<p class="muted">Loading system information...</p>';

  try {
    const info = await window.sshClient.getSystemInfo(sessionId);
    ensureSessionData(sessionId).systemInfo = info;
    if (state.activeSessionId === sessionId) {
      state.systemInfo = info;
      renderSystemInfo();
    }
    pushLog('system', 'System information refreshed');
  } catch (error) {
    body.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    pushLog('error', error.message);
  }
}

function renderSystemInfo() {
  const info = state.systemInfo;
  const body = document.querySelector('#system-info-body');
  if (!body || !info) return;

  body.innerHTML = `
    <div class="info-grid">
      <article>
        <h3 style="margin-bottom: 16px;">OS</h3>
        <div class="info-list">
          ${infoRow('OS', info.os.os)}
          ${infoRow('Version', info.os.version)}
          ${infoRow('Distribution', info.os.distribution)}
          ${infoRow('Kernel', info.os.kernel)}
          ${info.os.type ? infoRow('Type', info.os.type) : ''}
          ${info.os.chip ? infoRow('Chip', info.os.chip) : ''}
        </div>
      </article>
      <article>
        <h3 style="margin-bottom: 16px;">Hardware</h3>
        <div class="info-list">
          ${infoRow('CPU', info.hardware.cpu)}
          ${infoRow('RAM', info.hardware.ram)}
          ${infoRow('GPU', info.hardware.gpu)}
          ${infoRow('Storage', info.hardware.storage)}
        </div>
      </article>
    </div>
  `;
}

function buildVpnView() {
  const view = document.querySelector('#vpn-view');
  view.innerHTML = `
    <div class="vpn-layout">
      <article class="panel">
        <div class="panel-header">
          <h3>VPN Profiles</h3>
          <button class="secondary-btn" id="refresh-vpn">Refresh</button>
        </div>
        <div class="panel-body">
          <form class="vpn-add-form" id="vpn-add-form">
            <input id="vpn-profile-name" placeholder="Profile name">
            <textarea id="vpn-profile-input" placeholder="Paste VLESS / Hiddify / Happ link"></textarea>
            <button class="primary-btn" type="submit">Add profile</button>
          </form>
          <p class="form-error" id="vpn-error"></p>
          <div class="vpn-profile-list" id="vpn-profile-list"></div>
        </div>
      </article>
      <article class="panel">
        <div class="panel-header">
          <h3>Engine / Compatibility</h3>
          <button class="secondary-btn" id="check-vpn-engine">Check engine</button>
        </div>
        <div class="panel-body" id="vpn-status-body"></div>
      </article>
    </div>
  `;

  document.querySelector('#vpn-add-form').addEventListener('submit', addVpnProfile);
  document.querySelector('#refresh-vpn').addEventListener('click', loadVpnData);
  document.querySelector('#check-vpn-engine').addEventListener('click', loadVpnData);
  renderVpn();
}

async function loadVpnData() {
  state.vpn.loading = true;
  state.vpn.error = '';
  renderVpn();

  try {
    const [profiles, engine, compatibility, runtime] = await Promise.all([
      window.sshClient.getVpnProfiles(),
      window.sshClient.getVpnEngineStatus(),
      window.sshClient.getVpnCompatibility(),
      window.sshClient.getVpnRuntimeStatus()
    ]);
    state.vpn.profiles = profiles;
    state.vpn.engine = engine;
    state.vpn.compatibility = compatibility;
    state.vpn.runtime = runtime;
    if (state.activeSessionId) {
      try {
        [state.vpn.remote, state.vpn.remoteFull] = await Promise.all([
          window.sshClient.getRemoteVpnStatus(state.activeSessionId),
          window.sshClient.getRemoteVpnFullRoutingStatus(state.activeSessionId)
        ]);
      } catch (_error) {
        state.vpn.remote = null;
        state.vpn.remoteFull = null;
      }
    }
  } catch (error) {
    state.vpn.error = error.message || 'Could not load VPN data';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

function renderVpn() {
  const list = document.querySelector('#vpn-profile-list');
  const statusBody = document.querySelector('#vpn-status-body');
  const error = document.querySelector('#vpn-error');
  if (!list || !statusBody || !error) return;

  error.textContent = state.vpn.error;
  renderVpnStatus(statusBody);

  if (state.vpn.loading) {
    list.innerHTML = '<p class="muted">Loading VPN profiles...</p>';
    return;
  }

  if (!state.vpn.profiles.length) {
    list.innerHTML = '<p class="muted">No VPN profiles yet. Paste a VLESS, Hiddify, or Happ link to add one.</p>';
    return;
  }

  list.innerHTML = state.vpn.profiles.map((profile) => {
    const selected = profile.endpoints.find((endpoint) => endpoint.id === profile.selectedEndpointId) || profile.endpoints[0];
    const runtime = state.vpn.runtime || {};
    const isRunningProfile = runtime.running && runtime.profile && runtime.profile.id === profile.id;
    const engineAvailable = state.vpn.engine && state.vpn.engine.available;
    const hasRemoteSession = Boolean(state.activeSessionId);
    const remoteRunning = state.vpn.remote && state.vpn.remote.running;
    const statusText = isRunningProfile ? 'local running' : (remoteRunning ? 'server running' : 'inactive');
    const statusClass = isRunningProfile || remoteRunning ? 'online' : 'offline';
    return `
      <article class="vpn-profile-card">
        <div class="vpn-profile-head">
          <div>
            <strong>${escapeHtml(profile.name)}</strong>
            <small>${escapeHtml(profile.provider)} - ${escapeHtml(profile.type)} - ${profile.endpointCount} endpoint${profile.endpointCount === 1 ? '' : 's'}</small>
          </div>
          <span class="status-pill ${statusClass}">${statusText}</span>
        </div>
        <div class="vpn-secret-line">${escapeHtml(profile.redactedSource)}</div>
        <div class="vpn-endpoint-row">
          <label>
            <span>Country / endpoint</span>
            <select class="vpn-endpoint-select" data-profile-id="${escapeHtml(profile.id)}">
              ${profile.endpoints.map((endpoint) => `
                <option value="${escapeHtml(endpoint.id)}" ${endpoint.id === profile.selectedEndpointId ? 'selected' : ''}>
                  ${escapeHtml(endpoint.country || endpoint.name)} - ${escapeHtml(endpoint.host)}:${endpoint.port}
                </option>
              `).join('')}
            </select>
          </label>
          <div class="vpn-latency">
            <span class="status-dot ${selected && selected.status === 'online' ? 'online' : ''}"></span>
            <strong>${selected && selected.latencyMs !== null && selected.latencyMs !== undefined ? `${selected.latencyMs} ms` : 'Not checked'}</strong>
            <small>${escapeHtml(selected ? selected.status : 'unknown')}</small>
          </div>
        </div>
        <div class="vpn-actions">
          <button class="secondary-btn vpn-ping" type="button" data-profile-id="${escapeHtml(profile.id)}">Check latency</button>
          <button class="secondary-btn vpn-start" type="button" data-profile-id="${escapeHtml(profile.id)}" ${engineAvailable && !runtime.running ? '' : 'disabled'}>Start engine</button>
          <button class="secondary-btn vpn-restart" type="button" data-profile-id="${escapeHtml(profile.id)}" ${engineAvailable && runtime.running ? '' : 'disabled'}>Restart</button>
          <button class="secondary-btn vpn-stop" type="button" ${runtime.running ? '' : 'disabled'}>Stop</button>
          <button class="secondary-btn vpn-remote-start" type="button" data-profile-id="${escapeHtml(profile.id)}" ${hasRemoteSession ? '' : 'disabled'}>Start on server</button>
          <button class="secondary-btn vpn-remote-stop" type="button" ${hasRemoteSession && remoteRunning ? '' : 'disabled'}>Stop server</button>
          <button class="danger-btn vpn-delete" type="button" data-profile-id="${escapeHtml(profile.id)}">Delete</button>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('.vpn-ping').forEach((button) => {
    button.addEventListener('click', () => checkVpnLatency(button.dataset.profileId));
  });
  list.querySelectorAll('.vpn-delete').forEach((button) => {
    button.addEventListener('click', () => deleteVpnProfile(button.dataset.profileId));
  });
  list.querySelectorAll('.vpn-start').forEach((button) => {
    button.addEventListener('click', () => startVpnEngine(button.dataset.profileId));
  });
  list.querySelectorAll('.vpn-restart').forEach((button) => {
    button.addEventListener('click', () => restartVpnEngine(button.dataset.profileId));
  });
  list.querySelectorAll('.vpn-stop').forEach((button) => {
    button.addEventListener('click', stopVpnEngine);
  });
  list.querySelectorAll('.vpn-remote-start').forEach((button) => {
    button.addEventListener('click', () => startRemoteVpn(button.dataset.profileId));
  });
  list.querySelectorAll('.vpn-remote-stop').forEach((button) => {
    button.addEventListener('click', stopRemoteVpn);
  });
  list.querySelectorAll('.vpn-endpoint-select').forEach((select) => {
    select.addEventListener('change', () => selectVpnEndpoint(select.dataset.profileId, select.value));
  });
}

function renderVpnStatus(node) {
  const engine = state.vpn.engine;
  const compatibility = state.vpn.compatibility;
  const remoteFull = state.vpn.remoteFull;
  const fullRunning = Boolean(remoteFull && remoteFull.running);
  const fullProfileOptions = state.vpn.profiles.map((profile) => `
    <option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>
  `).join('');

  node.innerHTML = `
    <div class="info-list">
      ${infoRow('Engine', 'sing-box')}
      ${infoRow('Bundled binary', engine ? engine.path : 'Not checked')}
      ${infoRow('Engine status', engine ? (engine.available ? 'Available' : `Missing / unavailable: ${engine.error}`) : 'Not checked')}
      ${infoRow('Version', engine && engine.version ? engine.version : 'Not available')}
      ${infoRow('Runtime', state.vpn.runtime && state.vpn.runtime.running ? 'Running' : 'Stopped')}
      ${infoRow('Local proxy', state.vpn.runtime && state.vpn.runtime.localProxy ? state.vpn.runtime.localProxy : 'Not active')}
      ${infoRow('Routing', state.vpn.runtime && state.vpn.runtime.routing ? state.vpn.runtime.routing : 'System routing is not enabled.')}
    </div>
    <div class="remote-vpn-card">
      <div class="panel-header compact-panel-header">
        <h3>Remote SSH Server VPN</h3>
        <div class="vpn-actions">
          <button class="secondary-btn" id="check-remote-vpn" ${state.activeSessionId ? '' : 'disabled'}>Check server</button>
          <button class="secondary-btn" id="install-remote-vpn" ${state.activeSessionId && state.vpn.installProgress === null ? '' : 'disabled'}>${state.vpn.installProgress === null ? 'Install bundled' : `Installing ${state.vpn.installProgress}%`}</button>
          <button class="secondary-btn" id="check-remote-vpn-ip" ${state.activeSessionId && state.vpn.remote && state.vpn.remote.running ? '' : 'disabled'}>Check IP</button>
          <button class="secondary-btn" id="show-remote-vpn-logs" ${state.activeSessionId ? '' : 'disabled'}>Logs</button>
        </div>
      </div>
      <div class="info-list remote-vpn-info">
        ${infoRow('Mode', 'Server local proxy only')}
        ${infoRow('Server status', state.vpn.remote ? (state.vpn.remote.running ? 'Running' : 'Stopped') : 'Not checked')}
        ${infoRow('Server OS', state.vpn.remote ? `${state.vpn.remote.os} / ${state.vpn.remote.arch}` : 'Not checked')}
        ${infoRow('sing-box', state.vpn.remote ? (state.vpn.remote.installed ? state.vpn.remote.version || state.vpn.remote.binary : `Not installed (${state.vpn.remote.packageHint})`) : 'Not checked')}
        ${infoRow('Dependencies', remoteDependencyText(state.vpn.remote))}
        ${infoRow('Server proxy', state.vpn.remote && state.vpn.remote.proxy ? state.vpn.remote.proxy : 'Not active')}
        ${state.vpn.remoteIp ? infoRow('VPN check', vpnIpCheckText(state.vpn.remoteIp)) : ''}
        ${state.vpn.remoteIp ? infoRow('Direct IP', state.vpn.remoteIp.directIp || 'Not available') : ''}
        ${state.vpn.remoteIp ? infoRow('Proxy IP', state.vpn.remoteIp.proxyIp || 'Not available') : ''}
        ${infoRow('Full system routing', fullRunning ? 'Running through TUN' : 'Stopped')}
        ${remoteFull && remoteFull.tun ? infoRow('TUN interface', remoteFull.tun) : ''}
        ${remoteFull && remoteFull.defaultRoute ? infoRow('Default route', remoteFull.defaultRoute) : ''}
        ${remoteFull && remoteFull.rollbackPending ? infoRow('Safety rollback', `Pending (${remoteFull.rollbackSeconds || 60}s). Confirm after checking SSH.`) : ''}
      </div>
      <div class="vpn-full-routing-controls">
        <select id="remote-full-routing-profile" ${state.vpn.profiles.length ? '' : 'disabled'}>
          ${fullProfileOptions || '<option value="">No VPN profile</option>'}
        </select>
        <input id="remote-full-routing-password" type="password" autocomplete="off" placeholder="Server sudo password">
        <button class="secondary-btn" id="check-remote-full-routing" ${state.activeSessionId ? '' : 'disabled'}>Check TUN</button>
        <button class="secondary-btn" id="enable-remote-full-routing" ${state.activeSessionId && state.vpn.profiles.length && !fullRunning ? '' : 'disabled'}>Route whole server</button>
        <button class="primary-btn" id="confirm-remote-full-routing" ${fullRunning && remoteFull.rollbackPending ? '' : 'disabled'}>Confirm route</button>
        <button class="danger-btn" id="disable-remote-full-routing" ${fullRunning ? '' : 'disabled'}>Disable route</button>
      </div>
      ${state.vpn.remoteFullPreflight ? `<p class="muted vpn-note">${escapeHtml(fullRoutingPreflightText(state.vpn.remoteFullPreflight))}</p>` : ''}
      <p class="muted vpn-note">Full routing changes the server default route. The SSH client and VPN endpoint are excluded first; an automatic rollback restores the route after 60 seconds unless you confirm it.</p>
      ${state.vpn.remoteLogs ? `<pre class="remote-vpn-log">${escapeHtml(state.vpn.remoteLogs.content || 'No remote VPN logs.')}</pre>` : ''}
    </div>
    <details class="compat-details">
      <summary>Platform compatibility (planned)</summary>
      <div class="compat-grid">
        ${compatBlock('Windows', compatibility && compatibility.windows)}
        ${compatBlock('Linux', compatibility && compatibility.linux)}
        ${compatBlock('macOS', compatibility && compatibility.macos)}
      </div>
      <p class="muted vpn-note">Server mode starts sing-box as a local proxy on the remote server. It does not change the server default route, TUN, or full system routing.</p>
    </details>
  `;

  const checkRemote = document.querySelector('#check-remote-vpn');
  const installRemote = document.querySelector('#install-remote-vpn');
  const checkRemoteIp = document.querySelector('#check-remote-vpn-ip');
  const showRemoteLogs = document.querySelector('#show-remote-vpn-logs');
  const checkRemoteFull = document.querySelector('#check-remote-full-routing');
  const enableRemoteFull = document.querySelector('#enable-remote-full-routing');
  const confirmRemoteFull = document.querySelector('#confirm-remote-full-routing');
  const disableRemoteFull = document.querySelector('#disable-remote-full-routing');
  if (checkRemote) checkRemote.addEventListener('click', checkRemoteVpnStatus);
  if (installRemote) installRemote.addEventListener('click', installBundledRemoteVpn);
  if (checkRemoteIp) checkRemoteIp.addEventListener('click', checkRemoteVpnIp);
  if (showRemoteLogs) showRemoteLogs.addEventListener('click', loadRemoteVpnLogs);
  if (checkRemoteFull) checkRemoteFull.addEventListener('click', checkRemoteFullRouting);
  if (enableRemoteFull) enableRemoteFull.addEventListener('click', enableRemoteFullRouting);
  if (confirmRemoteFull) confirmRemoteFull.addEventListener('click', confirmRemoteFullRouting);
  if (disableRemoteFull) disableRemoteFull.addEventListener('click', disableRemoteFullRouting);
}

function fullRoutingPreflightText(preflight) {
  if (!preflight) return 'TUN has not been checked.';
  if (preflight.readyForFullRouting) return 'TUN preflight passed.';
  return preflight.warnings && preflight.warnings.length
    ? preflight.warnings.join(' ')
    : 'TUN preflight is not ready.';
}

function remoteDependencyText(remote) {
  if (!remote || !remote.dependencies) return 'Not checked';
  const deps = [];
  deps.push(`base64: ${remote.dependencies.base64 ? 'ok' : 'missing'}`);
  deps.push(`curl: ${remote.dependencies.curl ? 'ok' : 'missing'}`);
  deps.push(`wget: ${remote.dependencies.wget ? 'ok' : 'missing'}`);
  return deps.join(', ');
}

function vpnIpCheckText(result) {
  if (!result) return 'Not checked';
  if (result.changed) return 'Proxy IP is different';
  if (result.proxyIp) return 'Proxy IP did not change';
  return 'Direct IP checked';
}

function compatBlock(title, data) {
  if (!data) {
    return `
      <div class="compat-card">
        <strong>${escapeHtml(title)}</strong>
        <span>Not checked</span>
      </div>
    `;
  }

  return `
    <div class="compat-card">
      <strong>${escapeHtml(title)}</strong>
      <span>${data.supported ? 'Production target' : 'Compatibility planned'}</span>
      <small>Engine: ${escapeHtml(data.engine)}</small>
      <small>Routing: ${escapeHtml(data.routing)}</small>
      <small>TUN: ${escapeHtml(data.tun || 'Not available')}</small>
      <small>Permissions: ${escapeHtml(data.permissions)}</small>
    </div>
  `;
}

async function addVpnProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const name = document.querySelector('#vpn-profile-name').value.trim();
  const input = document.querySelector('#vpn-profile-input').value.trim();
  const originalText = button.textContent;

  try {
    button.disabled = true;
    button.textContent = 'Adding...';
    const profile = await window.sshClient.addVpnProfile({ name, input });
    state.vpn.profiles = [profile, ...state.vpn.profiles.filter((item) => item.id !== profile.id)];
    document.querySelector('#vpn-profile-name').value = '';
    document.querySelector('#vpn-profile-input').value = '';
    state.vpn.error = '';
    pushLog('system', `VPN profile added: ${profile.provider} (${profile.endpointCount} endpoint${profile.endpointCount === 1 ? '' : 's'})`);
  } catch (error) {
    state.vpn.error = error.message || 'Could not add VPN profile';
    pushLog('error', state.vpn.error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    renderVpn();
  }
}

async function checkVpnLatency(profileId) {
  try {
    state.vpn.loading = true;
    renderVpn();
    const profile = await window.sshClient.checkVpnLatency(profileId);
    state.vpn.profiles = state.vpn.profiles.map((item) => (item.id === profile.id ? profile : item));
    pushLog('system', `VPN latency checked for ${profile.name}`);
  } catch (error) {
    state.vpn.error = error.message || 'Could not check VPN latency';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function selectVpnEndpoint(profileId, endpointId) {
  try {
    const profile = await window.sshClient.selectVpnEndpoint({ profileId, endpointId });
    state.vpn.profiles = state.vpn.profiles.map((item) => (item.id === profile.id ? profile : item));
  } catch (error) {
    state.vpn.error = error.message || 'Could not select VPN endpoint';
    pushLog('error', state.vpn.error);
    renderVpn();
  }
}

function deleteVpnProfile(profileId) {
  const profile = state.vpn.profiles.find((item) => item.id === profileId);
  if (!profile) return;

  confirmDanger(`Delete VPN profile "${profile.name}"?`, async () => {
    try {
      await window.sshClient.deleteVpnProfile(profileId);
      state.vpn.profiles = state.vpn.profiles.filter((item) => item.id !== profileId);
      renderVpn();
      pushLog('system', `VPN profile deleted: ${profile.name}`);
    } catch (error) {
      state.vpn.error = error.message || 'Could not delete VPN profile';
      pushLog('error', state.vpn.error);
      renderVpn();
    }
  });
}

async function startVpnEngine(profileId) {
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.runtime = await window.sshClient.startVpn(profileId);
    pushLog('system', 'VPN engine started in local proxy mode');
  } catch (error) {
    state.vpn.error = error.message || 'Could not start VPN engine';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function restartVpnEngine(profileId) {
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.runtime = await window.sshClient.restartVpn(profileId);
    pushLog('system', 'VPN engine restarted in local proxy mode');
  } catch (error) {
    state.vpn.error = error.message || 'Could not restart VPN engine';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function stopVpnEngine() {
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.runtime = await window.sshClient.stopVpn();
    pushLog('system', 'VPN engine stopped');
  } catch (error) {
    state.vpn.error = error.message || 'Could not stop VPN engine';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function checkRemoteVpnStatus() {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    [state.vpn.remote, state.vpn.remoteFull] = await Promise.all([
      window.sshClient.getRemoteVpnStatus(state.activeSessionId),
      window.sshClient.getRemoteVpnFullRoutingStatus(state.activeSessionId)
    ]);
    if (state.vpn.remote && !state.vpn.remote.running) state.vpn.remoteIp = null;
    pushLog('system', 'Remote VPN status checked');
  } catch (error) {
    state.vpn.error = error.message || 'Could not check remote VPN status';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function checkRemoteFullRouting() {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    [state.vpn.remoteFullPreflight, state.vpn.remoteFull] = await Promise.all([
      window.sshClient.getRemoteVpnFullRoutingPreflight(state.activeSessionId),
      window.sshClient.getRemoteVpnFullRoutingStatus(state.activeSessionId)
    ]);
    pushLog('system', fullRoutingPreflightText(state.vpn.remoteFullPreflight));
  } catch (error) {
    state.vpn.error = error.message || 'Could not check remote full routing';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

function readRemoteFullRoutingCredentials() {
  const profileId = document.querySelector('#remote-full-routing-profile')?.value || '';
  const sudoPassword = document.querySelector('#remote-full-routing-password')?.value || pendingFullRoutingSudoPassword;
  if (!sudoPassword) throw new Error('Enter the server sudo password.');
  return { profileId, sudoPassword };
}

async function enableRemoteFullRouting() {
  if (!state.activeSessionId) return;
  let credentials;
  try {
    credentials = readRemoteFullRoutingCredentials();
    if (!credentials.profileId) throw new Error('Select a VPN profile.');
  } catch (error) {
    state.vpn.error = error.message;
    renderVpn();
    return;
  }

  confirmDanger(
    'Route all server traffic through the selected VPN? The SSH route is preserved first and an automatic rollback runs after 60 seconds unless you confirm the connection.',
    async () => {
      try {
        state.vpn.loading = true;
        renderVpn();
        pendingFullRoutingSudoPassword = credentials.sudoPassword;
        state.vpn.remoteFull = await window.sshClient.enableRemoteVpnFullRouting({
          sessionId: state.activeSessionId,
          profileId: credentials.profileId,
          sudoPassword: credentials.sudoPassword
        });
        pushLog('system', 'Full server routing enabled. Check SSH and click Confirm route before the safety rollback expires.');
      } catch (error) {
        pendingFullRoutingSudoPassword = '';
        state.vpn.error = error.message || 'Could not enable remote full routing';
        pushLog('error', state.vpn.error);
      } finally {
        state.vpn.loading = false;
        renderVpn();
      }
    },
    () => {},
    { title: 'Enable full server routing', confirmLabel: 'Enable with rollback' }
  );
}

async function confirmRemoteFullRouting() {
  if (!state.activeSessionId) return;
  try {
    const { sudoPassword } = readRemoteFullRoutingCredentials();
    state.vpn.loading = true;
    renderVpn();
    state.vpn.remoteFull = await window.sshClient.confirmRemoteVpnFullRouting({
      sessionId: state.activeSessionId,
      sudoPassword
    });
    pendingFullRoutingSudoPassword = '';
    pushLog('system', 'Full server routing confirmed; automatic rollback cancelled.');
  } catch (error) {
    state.vpn.error = error.message || 'Could not confirm remote full routing';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function disableRemoteFullRouting() {
  if (!state.activeSessionId) return;
  let sudoPassword;
  try {
    ({ sudoPassword } = readRemoteFullRoutingCredentials());
  } catch (error) {
    state.vpn.error = error.message;
    renderVpn();
    return;
  }

  confirmDanger('Restore the original server route and stop the full-routing TUN?', async () => {
    try {
      state.vpn.loading = true;
      renderVpn();
      state.vpn.remoteFull = await window.sshClient.disableRemoteVpnFullRouting({
        sessionId: state.activeSessionId,
        sudoPassword
      });
      pendingFullRoutingSudoPassword = '';
      pushLog('system', 'Full server routing disabled and original default route restored.');
    } catch (error) {
      state.vpn.error = error.message || 'Could not disable remote full routing';
      pushLog('error', state.vpn.error);
    } finally {
      state.vpn.loading = false;
      renderVpn();
    }
  });
}

async function installBundledRemoteVpn() {
  if (!state.activeSessionId) return;
  confirmDanger('Install bundled sing-box binary on the active SSH server?', async () => {
    try {
      state.vpn.loading = true;
      state.vpn.installProgress = 0;
      renderVpn();
      state.vpn.remote = await window.sshClient.installBundledRemoteVpn(state.activeSessionId);
      pushLog('system', 'Bundled sing-box installed on remote server');
    } catch (error) {
      state.vpn.error = error.message || 'Could not install bundled sing-box on remote server';
      pushLog('error', state.vpn.error);
    } finally {
      state.vpn.loading = false;
      state.vpn.installProgress = null;
      renderVpn();
    }
  });
}

async function startRemoteVpn(profileId) {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.remote = await window.sshClient.startRemoteVpn({ sessionId: state.activeSessionId, profileId });
    state.vpn.remoteIp = null;
    pushLog('system', 'Remote VPN started on server in local proxy mode');
    await applyVpnProxyToTerminal(state.activeSessionId, state.vpn.remote.proxy);
  } catch (error) {
    state.vpn.error = error.message || 'Could not start remote VPN';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function stopRemoteVpn() {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.remote = await window.sshClient.stopRemoteVpn(state.activeSessionId);
    state.vpn.remoteIp = null;
    state.vpn.remoteLogs = null;
    pushLog('system', 'Remote VPN stopped on server');
    await applyVpnProxyToTerminal(state.activeSessionId, '');
  } catch (error) {
    state.vpn.error = error.message || 'Could not stop remote VPN';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

function buildBotsView() {
  const view = document.querySelector('#bots-view');
  if (!view) return;
  Object.keys(state.bots.logs).forEach((botId) => stopBotLogs(botId, { silent: true }));
  state.bots.logs = {};
  view.innerHTML = `
    <div class="vpn-layout">
      <article class="panel">
        <div class="panel-header">
          <h3>Боты</h3>
          <button class="secondary-btn" id="refresh-bots">Обновить</button>
        </div>
        <div class="panel-body">
          <button class="primary-btn" type="button" id="toggle-bot-form">Добавить бота</button>
          <form class="vpn-add-form bot-add-form-collapsed" id="bot-add-form">
            <label for="bot-name">Имя бота</label>
            <input id="bot-name" placeholder="Например, Telegram-бот" maxlength="128" required>
            <label for="bot-working-directory">Папка бота на сервере</label>
            <input id="bot-working-directory" placeholder="/home/trivx/my-bot" maxlength="2000" required>
            <label for="bot-start-command">Команда запуска из этой папки</label>
            <textarea id="bot-start-command" placeholder=".venv/bin/python main.py" required></textarea>
            <label for="bot-sudo-password">Пароль sudo, если потребуется включить фоновую работу после выхода из SSH</label>
            <input id="bot-sudo-password" type="password" autocomplete="off" placeholder="Необязательно, не сохраняется">
            <p class="muted bot-form-hint">Бот запускается службой systemd. При сбое она перезапустит его. Для сети используется SOCKS5 127.0.0.1:2080; сам бот должен поддерживать переменные HTTP_PROXY/HTTPS_PROXY. Команда должна работать в переднем плане, без nohup и &amp;.</p>
            <div class="bot-form-actions">
              <button class="primary-btn" type="submit">Сохранить и запустить</button>
              <button class="secondary-btn" type="button" id="cancel-bot-form">Отмена</button>
            </div>
          </form>
          <p class="form-error" id="bot-error"></p>
          <div class="bot-list" id="bot-list"></div>
        </div>
      </article>
    </div>
  `;

  const form = document.querySelector('#bot-add-form');
  const toggleButton = document.querySelector('#toggle-bot-form');

  function openBotForm() {
    form.classList.remove('bot-add-form-collapsed');
    toggleButton.classList.add('is-hidden');
  }

  function closeBotForm() {
    form.classList.add('bot-add-form-collapsed');
    toggleButton.classList.remove('is-hidden');
    form.reset();
    document.querySelector('#bot-error').textContent = '';
  }

  toggleButton.addEventListener('click', openBotForm);
  document.querySelector('#cancel-bot-form').addEventListener('click', closeBotForm);
  form.addEventListener('submit', async (event) => {
    await addAndStartBot(event);
    if (!document.querySelector('#bot-error').textContent) closeBotForm();
  });
  document.querySelector('#refresh-bots').addEventListener('click', () => loadBotsData());
  renderBots();
}

async function loadBotsData() {
  if (!state.activeSessionId) return;
  state.bots.loading = true;
  state.bots.error = '';
  renderBots();

  try {
    state.bots.list = await window.sshClient.getBots(state.activeSessionId);
    await refreshBotStatuses();
  } catch (error) {
    state.bots.error = error.message || 'Не удалось загрузить список ботов';
    pushLog('error', state.bots.error);
  } finally {
    state.bots.loading = false;
    renderBots();
  }
}

async function refreshBotStatuses() {
  if (!state.activeSessionId || !state.bots.list.length) return;

  try {
    state.bots.ping = await window.sshClient.getBotPing({ sessionId: state.activeSessionId });
  } catch (_error) {
    state.bots.ping = null;
  }

  await Promise.all(state.bots.list.map(async (bot) => {
    try {
      state.bots.statuses[bot.id] = await window.sshClient.getBotStatus({ sessionId: state.activeSessionId, botId: bot.id });
    } catch (_error) {
      state.bots.statuses[bot.id] = { running: false, pid: '', checkedAt: '' };
    }
  }));

  renderBots();
}

function startBotPolling() {
  stopBotPolling();
  state.bots.pollTimer = setInterval(() => {
    if (state.currentView === 'bots' && state.activeSessionId) refreshBotStatuses();
  }, 6000);
}

function stopBotPolling() {
  if (state.bots.pollTimer) {
    clearInterval(state.bots.pollTimer);
    state.bots.pollTimer = null;
  }
}

async function addAndStartBot(event) {
  event.preventDefault();
  const errorNode = document.querySelector('#bot-error');
  const nameInput = document.querySelector('#bot-name');
  const directoryInput = document.querySelector('#bot-working-directory');
  const commandInput = document.querySelector('#bot-start-command');
  const sudoInput = document.querySelector('#bot-sudo-password');
  const button = event.target.querySelector('button[type="submit"]');
  errorNode.textContent = '';

  if (!state.activeSessionId) {
    errorNode.textContent = 'Нет активной SSH-сессии.';
    return;
  }

  const name = nameInput.value.trim();
  const workingDirectory = directoryInput.value.trim();
  const startCommand = commandInput.value.trim();

  if (!name || !workingDirectory || !startCommand) {
    errorNode.textContent = 'Укажите имя, папку на сервере и команду запуска.';
    return;
  }

  try {
    button.disabled = true;
    button.textContent = 'Запуск...';
    await window.sshClient.addAndStartBot({
      sessionId: state.activeSessionId,
      name,
      startCommand,
      mode: 'systemd',
      workingDirectory,
      sudoPassword: sudoInput.value
    });
    nameInput.value = '';
    directoryInput.value = '';
    commandInput.value = '';
    sudoInput.value = '';
    pushLog('system', `Бот "${name}" запущен и добавлен в Центр управления`);
    await loadBotsData();
  } catch (error) {
    errorNode.textContent = error.message || 'Не удалось запустить бота';
    pushLog('error', errorNode.textContent);
  } finally {
    button.disabled = false;
    button.textContent = 'Сохранить и запустить';
  }
}

async function botAction(botId, action) {
  if (!state.activeSessionId) return;
  const methodMap = {
    start: 'startBot',
    stop: 'stopBot',
    restart: 'restartBot'
  };
  const method = methodMap[action];
  if (!method) return;

  try {
    state.bots.statuses[botId] = { ...(state.bots.statuses[botId] || {}), pending: true };
    renderBots();
    state.bots.statuses[botId] = await window.sshClient[method]({ sessionId: state.activeSessionId, botId });
    pushLog('system', `Бот: действие "${action}" выполнено`);
  } catch (error) {
    state.bots.error = error.message || `Не удалось выполнить действие "${action}"`;
    pushLog('error', state.bots.error);
  } finally {
    renderBots();
  }
}

async function deleteBotEntry(botId) {
  try {
    await window.sshClient.deleteBot({ sessionId: state.activeSessionId, botId });
    state.bots.list = state.bots.list.filter((bot) => bot.id !== botId);
    delete state.bots.statuses[botId];
    renderBots();
  } catch (error) {
    state.bots.error = error.message || 'Не удалось удалить бота';
    pushLog('error', state.bots.error);
    renderBots();
  }
}

function renderBots() {
  const list = document.querySelector('#bot-list');
  const error = document.querySelector('#bot-error');
  if (!list || !error) return;

  if (state.bots.error) error.textContent = state.bots.error;

  if (state.bots.loading && !state.bots.list.length) {
    list.innerHTML = '<p class="muted">Загрузка ботов...</p>';
    return;
  }

  if (!state.bots.list.length) {
    list.innerHTML = '<p class="muted">Пока нет ботов. Укажите папку бота и команду запуска — после успешного старта он появится здесь.</p>';
    return;
  }

  const ping = state.bots.ping && state.bots.ping.latencyMs !== null && state.bots.ping.latencyMs !== undefined
    ? `${state.bots.ping.latencyMs} ms`
    : 'н/д';

  list.innerHTML = state.bots.list.map((bot) => {
    const status = state.bots.statuses[bot.id] || {};
    const running = Boolean(status.running);
    const statusText = status.pending ? 'обновление...' : (running ? 'запущен' : status.activeState === 'failed' ? 'ошибка' : 'остановлен');
    const statusClass = running ? 'online' : 'offline';
    const logState = state.bots.logs[bot.id];
    const managed = bot.mode === 'systemd';
    return `
      <article class="vpn-profile-card">
        <div class="vpn-profile-head">
          <div>
            <strong>Бот: ${escapeHtml(bot.name)}</strong>
            <small>${escapeHtml(managed ? `${bot.workingDirectory} · ${bot.startCommand}` : bot.matchPattern)}</small>
          </div>
          <span class="status-pill ${statusClass}">${statusText}</span>
        </div>
        <div class="vpn-endpoint-row">
          <div class="vpn-latency">
            <span class="status-dot ${statusClass}"></span>
            <strong>Пинг: ${ping}</strong>
            <small>Статус: ${statusText}</small>
            ${managed ? `<small>systemd · автоперезапуск при сбое · SOCKS5 ${escapeHtml(bot.proxy || '')}${status.restarts ? ` · перезапусков: ${escapeHtml(status.restarts)}` : ''}</small>` : ''}
          </div>
        </div>
        <div class="vpn-actions">
          <button class="secondary-btn bot-start" type="button" data-bot-id="${escapeHtml(bot.id)}" ${running ? 'disabled' : ''}>Запустить</button>
          <button class="secondary-btn bot-stop" type="button" data-bot-id="${escapeHtml(bot.id)}" ${running ? '' : 'disabled'}>Стоп</button>
          <button class="secondary-btn bot-restart" type="button" data-bot-id="${escapeHtml(bot.id)}">Перезагрузить</button>
          <button class="secondary-btn bot-logs-toggle" type="button" data-bot-id="${escapeHtml(bot.id)}">${logState && logState.open ? 'Скрыть логи' : 'Логи'}</button>
          <button class="danger-btn bot-delete" type="button" data-bot-id="${escapeHtml(bot.id)}">Удалить</button>
        </div>
        ${logState && logState.open ? `<pre class="bot-log" data-bot-id="${escapeHtml(bot.id)}">${escapeHtml(logState.text || 'Ждём данные из лога...')}</pre>` : ''}
      </article>
    `;
  }).join('');

  list.querySelectorAll('.bot-start').forEach((button) => {
    button.addEventListener('click', () => botAction(button.dataset.botId, 'start'));
  });
  list.querySelectorAll('.bot-stop').forEach((button) => {
    button.addEventListener('click', () => botAction(button.dataset.botId, 'stop'));
  });
  list.querySelectorAll('.bot-restart').forEach((button) => {
    button.addEventListener('click', () => botAction(button.dataset.botId, 'restart'));
  });
  list.querySelectorAll('.bot-logs-toggle').forEach((button) => {
    button.addEventListener('click', () => toggleBotLogs(button.dataset.botId));
  });
  list.querySelectorAll('.bot-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const botId = button.dataset.botId;
      const bot = state.bots.list.find((item) => item.id === botId);
      const target = bot?.mode === 'systemd' ? 'его службу' : 'его процесс';
      confirmDanger(`Удалить бота «${bot?.name || ''}» и остановить ${target} на сервере? Файлы бота останутся на сервере.`,
        () => deleteBotEntry(botId), () => {}, { title: 'Удалить бота', confirmLabel: 'Удалить' });
    });
  });

  list.querySelectorAll('.bot-log').forEach((node) => {
    node.scrollTop = node.scrollHeight;
  });
}

async function toggleBotLogs(botId) {
  const current = state.bots.logs[botId];
  if (current && current.open) {
    await stopBotLogs(botId);
  } else {
    await startBotLogsView(botId);
  }
  renderBots();
}

async function startBotLogsView(botId) {
  if (!state.activeSessionId) return;
  state.bots.logs[botId] = { open: true, text: '' };
  try {
    await window.sshClient.startBotLogs({ sessionId: state.activeSessionId, botId, lines: 200 });
  } catch (error) {
    state.bots.logs[botId] = { open: true, text: `Не удалось открыть логи: ${error.message || error}` };
    pushLog('error', state.bots.logs[botId].text);
  }
}

async function stopBotLogs(botId, { silent } = {}) {
  delete state.bots.logs[botId];
  if (!state.activeSessionId) return;
  try {
    await window.sshClient.stopBotLogs({ sessionId: state.activeSessionId, botId });
  } catch (error) {
    if (!silent) pushLog('error', error.message || 'Не удалось остановить логи бота');
  }
}

function requestCloseWithVpnWarning(payload) {
  if (localStorage.getItem('sshClientSkipVpnCloseWarning') === 'true') {
    window.sshClient.confirmAppClose(true);
    return;
  }

  const activeParts = [];
  if (payload && payload.remoteRunning) activeParts.push('remote server VPN');
  if (payload && payload.localRunning) activeParts.push('local VPN engine');
  const activeLabel = activeParts.length ? activeParts.join(' and ') : 'VPN';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-body">
        <h3>Close XCD SSH Client?</h3>
        <p class="muted">VPN is currently active: ${escapeHtml(activeLabel)}.</p>
        <p class="muted">If you close the app, remote server VPN may continue running on the server.</p>
        <label class="checkbox-row">
          <input id="skip-vpn-close-warning" type="checkbox">
          <span>Do not remind me again</span>
        </label>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-app-close" type="button">No</button>
          <button class="primary-btn" id="confirm-app-close" type="button">Yes</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.querySelector('#cancel-app-close').addEventListener('click', async () => {
    backdrop.remove();
    await window.sshClient.confirmAppClose(false);
  });
  backdrop.querySelector('#confirm-app-close').addEventListener('click', async () => {
    if (backdrop.querySelector('#skip-vpn-close-warning').checked) {
      localStorage.setItem('sshClientSkipVpnCloseWarning', 'true');
    }
    backdrop.remove();
    await window.sshClient.confirmAppClose(true);
  });
}

async function checkRemoteVpnIp() {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.remoteIp = await window.sshClient.checkRemoteVpnIp(state.activeSessionId);
    pushLog('system', state.vpn.remoteIp.changed ? 'Remote VPN proxy IP is different' : 'Remote VPN proxy IP did not change');
  } catch (error) {
    state.vpn.error = error.message || 'Could not check remote VPN IP';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

async function loadRemoteVpnLogs() {
  if (!state.activeSessionId) return;
  try {
    state.vpn.loading = true;
    renderVpn();
    state.vpn.remoteLogs = await window.sshClient.getRemoteVpnLogs(state.activeSessionId);
    pushLog('system', 'Remote VPN logs loaded');
  } catch (error) {
    state.vpn.error = error.message || 'Could not load remote VPN logs';
    pushLog('error', state.vpn.error);
  } finally {
    state.vpn.loading = false;
    renderVpn();
  }
}

function infoRow(label, value) {
  return `
    <div class="info-row">
      <span class="info-label">${escapeHtml(label)}</span>
      <span class="info-value">${escapeHtml(value || 'Not available')}</span>
    </div>
  `;
}

function confirmDanger(message, onConfirm, onCancel = () => {}, options = {}) {
  const title = options.title || 'Confirm dangerous operation';
  const cancelLabel = options.cancelLabel || 'Cancel';
  const confirmLabel = options.confirmLabel || 'Confirm';
  const confirmClass = options.confirmClass || 'danger-btn';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        <p class="muted">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-danger">${escapeHtml(cancelLabel)}</button>
          <button class="${confirmClass}" id="confirm-danger">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#cancel-danger').addEventListener('click', () => {
    backdrop.remove();
    onCancel();
  });
  backdrop.querySelector('#confirm-danger').addEventListener('click', () => {
    backdrop.remove();
    onConfirm();
  });
}

function requestTerminalPassword(payload = {}) {
  if (state.passwordPromptOpen) return;

  const promptSessionId = payload.sessionId || state.activeSessionId;
  state.passwordPromptOpen = true;
  state.passwordPromptSessionId = promptSessionId;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="terminal-password-form">
      <div class="modal-body">
        <h3>Password required</h3>
        <p class="muted">The remote command is asking for a password.</p>
        <input id="terminal-password-input" type="password" autocomplete="current-password" autofocus>
        <div class="modal-actions">
          <button class="secondary-btn" id="cancel-terminal-password" type="button">Cancel</button>
          <button class="primary-btn" type="submit">Send</button>
        </div>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  const form = backdrop.querySelector('#terminal-password-form');
  const input = backdrop.querySelector('#terminal-password-input');
  setTimeout(() => input.focus(), 0);

  function close() {
    state.passwordPromptOpen = false;
    backdrop.remove();
  }

  backdrop.querySelector('#cancel-terminal-password').addEventListener('click', async () => {
    try {
      await window.sshClient.sendTerminalInput({ sessionId: promptSessionId, input: '\u0003' });
    } catch (error) {
      pushLog('error', error.message);
    }
    state.passwordPromptSessionId = '';
    close();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await window.sshClient.sendTerminalInput({ sessionId: promptSessionId, input: `${input.value}\n` });
    } catch (error) {
      pushLog('error', error.message);
    } finally {
      input.value = '';
      state.passwordPromptSessionId = '';
      close();
    }
  });
}

function requestHostVerification(payload) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const changed = payload.state === 'changed';
  backdrop.innerHTML = `
    <div class="modal host-verification-modal">
      <div class="modal-body">
        <h3>${changed ? 'SSH host key changed' : 'Trust SSH host key?'}</h3>
        <p class="muted">${escapeHtml(payload.username)}@${escapeHtml(payload.host)}:${payload.port}</p>
        ${changed ? '<p class="form-error">The stored host fingerprint is different. Continue only if you trust this server.</p>' : ''}
        <div class="fingerprint-box">
          <span>Fingerprint</span>
          <strong>${escapeHtml(payload.fingerprint)}</strong>
        </div>
        ${changed ? `
          <div class="fingerprint-box">
            <span>Known fingerprint</span>
            <strong>${escapeHtml(payload.knownFingerprint)}</strong>
          </div>
        ` : ''}
        <div class="modal-actions">
          <button class="secondary-btn" id="reject-host-key" type="button">Cancel</button>
          <button class="${changed ? 'danger-btn' : 'primary-btn'}" id="trust-host-key" type="button">${changed ? 'Trust new key' : 'Trust and connect'}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  async function finish(trusted) {
    await window.sshClient.verifyHost({ requestId: payload.requestId, trusted });
    backdrop.remove();
  }

  backdrop.querySelector('#reject-host-key').addEventListener('click', () => finish(false));
  backdrop.querySelector('#trust-host-key').addEventListener('click', () => finish(true));
}

function handleDisconnect(messageOrSession = 'SSH connection closed. Please reconnect.') {
  stopBotPolling();
  if (typeof messageOrSession === 'object' && messageOrSession && messageOrSession.id) {
    state.sessions = state.sessions.map((session) => (
      session.id === messageOrSession.id ? { ...session, status: 'disconnected', error: messageOrSession.error || '' } : session
    ));

    if (state.activeSessionId === messageOrSession.id) {
      const next = state.sessions.find((session) => session.id !== messageOrSession.id && session.status === 'online');
      if (next) {
        setActiveSession(next.id);
        renderDashboard();
        return;
      }
    } else {
      renderSessionSwitcher();
      return;
    }
  }

  state.connected = false;
  state.systemInfo = null;
  state.activeServer = null;
  state.sessions = [];
  state.activeSessionId = '';
  state.sessionData = {};
  state.fileManager = {
    path: '.',
    items: [],
    selected: null,
    loading: false,
    error: ''
  };
  state.currentView = 'status';
  renderLogin(typeof messageOrSession === 'string' ? messageOrSession : 'SSH connection closed. Please reconnect.');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.sshClient.onLog((entry) => {
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 300);
  renderLogs();
});

window.sshClient.onDisconnect((payload) => {
  handleDisconnect(payload);
});

window.sshClient.onReconnect((payload) => {
  if (!payload || !payload.id) return;

  state.sessions = state.sessions.map((session) => (
    session.id === payload.id ? { ...session, status: 'online', error: '' } : session
  ));
  renderSessionSwitcher();
  pushLog('system', `Соединение с ${payload.name || payload.host} восстановлено.`);

  if (payload.id === state.activeSessionId) {
    renderActiveServer();
    ensureShellOpen(payload.id);
    if (state.currentView === 'files') loadDirectory(state.fileManager.path);
    if (state.currentView === 'system') loadSystemInfo();
    if (state.currentView === 'bots') loadBotsData();
  }
});

window.sshClient.onUploadProgress((chunk) => {
  if (chunk.type === 'error') {
    pushLog('error', `Upload failed for ${chunk.path}: ${chunk.message}`);
  } else if (chunk.type === 'start') {
    pushLog('system', `Uploading ${chunk.path} (${formatBytes(chunk.size)})...`);
  } else if (chunk.type === 'done') {
    pushLog('system', `Uploaded ${chunk.path}`);
  }
});

window.sshClient.onBotLogData((payload) => {
  const current = state.bots.logs[payload.botId];
  if (!current || !current.open) return;

  if (payload.type === 'close') {
    current.text = `${current.text}\n[поток логов завершён]`.trim();
  } else if (payload.type === 'data') {
    current.text = `${current.text}${payload.text}`.slice(-20000);
  }

  if (state.currentView === 'bots') renderBots();
});

function handleShellChunk(sessionId, text) {
  if (!sessionId || !text) return;
  const data = ensureSessionData(sessionId);
  feedTerminalBuffer(data.terminalBuffer, text);
  if (sessionId === state.activeSessionId) scheduleTerminalRender();
}

window.sshClient.onShellData((chunk) => {
  handleShellChunk(chunk.sessionId || state.activeSessionId, chunk.text);
});

window.sshClient.onShellClosed((payload) => {
  const sessionId = payload && payload.sessionId;
  if (!sessionId) return;
  const data = ensureSessionData(sessionId);
  data.shellOpen = false;

  // The Terminal tab is meant to hold a persistent working shell. If the
  // shell closed while the SSH session is still up (a stray `exit`, an idle
  // timeout on the remote side, etc.), quietly reopen it instead of leaving
  // a dead screen that forces the user to click "Restart shell" by hand.
  const session = state.sessions.find((item) => item.id === sessionId);
  const stillConnected = state.connected && session && session.status === 'online';

  if (sessionId === state.activeSessionId) {
    state.shellOpen = false;
    pushLog('system', stillConnected ? 'Terminal shell closed - reopening...' : 'Terminal shell closed.');
    renderTerminalScreen();
  }

  if (stillConnected) {
    setTimeout(() => {
      const current = state.sessions.find((item) => item.id === sessionId);
      // Re-check right before reopening: don't fight a real disconnect /
      // reconnect (which drives its own shell reopen) or a manual close.
      if (state.connected && current && current.status === 'online' && !ensureSessionData(sessionId).shellOpen) {
        ensureShellOpen(sessionId);
      }
    }, 800);
  }
});

window.sshClient.onTerminalData((chunk) => {
  handleShellChunk(chunk.sessionId || state.activeSessionId, chunk.text);
});

window.sshClient.onTerminalPasswordRequest((payload) => {
  requestTerminalPassword(payload);
});

window.sshClient.onHostVerificationRequest((payload) => {
  requestHostVerification(payload);
});

window.sshClient.onDangerousOperationRequest((payload) => {
  const confirm = (confirmed) => window.sshClient.confirmDangerousOperation({ requestId: payload.requestId, confirmed });

  if (payload.action === 'file-exists') {
    confirmDanger(
      `Файл или папка "${payload.target}" уже есть в этой папке. Заменить существующий?`,
      () => confirm(true),
      () => confirm(false),
      {
        title: 'Файл уже существует',
        confirmLabel: 'Заменить',
        cancelLabel: 'Не заменять (оставить оба)',
        confirmClass: 'primary-btn'
      }
    );
    return;
  }

  const label = payload.action === 'remove-package'
    ? `Remove package "${payload.target}"?`
    : `Delete remote item "${payload.target}"?`;

  confirmDanger(
    label,
    () => confirm(true),
    () => confirm(false)
  );
});

window.sshClient.onVpnLog((entry) => {
  state.logs.unshift({ type: `vpn:${entry.type}`, message: entry.message, time: entry.time });
  state.logs = state.logs.slice(0, 300);
  renderLogs();
});

window.sshClient.onVpnInstallProgress((payload) => {
  if (!payload || payload.sessionId !== state.activeSessionId) return;
  state.vpn.installProgress = Number(payload.percent) || 0;
  const button = document.querySelector('#install-remote-vpn');
  if (button) button.textContent = `Installing ${state.vpn.installProgress}%`;
});

window.sshClient.onAppCloseRequest((payload) => {
  requestCloseWithVpnWarning(payload);
});

applyTheme(readSavedTheme());
renderLogin();
