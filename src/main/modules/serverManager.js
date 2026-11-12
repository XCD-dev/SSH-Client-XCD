const fs = require('fs');

function now() {
  return new Date().toISOString();
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertServerInput({ name, host, port, username }) {
  const sshPort = Number(port);

  if (!String(name || '').trim()) {
    throw new Error('Server name is required.');
  }

  if (!String(host || '').trim()) {
    throw new Error('IP address or host is required.');
  }

  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error('SSH port must be a number from 1 to 65535.');
  }

  if (!String(username || '').trim()) {
    throw new Error('Username is required.');
  }
}

function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    lastConnectedAt: server.lastConnectedAt || ''
  };
}

function createServerManager(storagePath) {
  function readStore() {
    try {
      if (!fs.existsSync(storagePath)) return { servers: [] };
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
    } catch (_error) {
      return { servers: [] };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(require('path').dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify(store, null, 2));
  }

  function getServers() {
    return readStore().servers
      .map(publicServer)
      .sort((left, right) => String(right.lastConnectedAt || right.updatedAt).localeCompare(String(left.lastConnectedAt || left.updatedAt)));
  }

  function saveServer(payload) {
    assertServerInput(payload);

    const store = readStore();
    const timestamp = now();
    const server = {
      id: createId(),
      name: String(payload.name).trim(),
      host: String(payload.host).trim(),
      port: Number(payload.port),
      username: String(payload.username).trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastConnectedAt: payload.lastConnectedAt || ''
    };

    store.servers.push(server);
    writeStore(store);
    return publicServer(server);
  }

  function updateServer(id, payload) {
    assertServerInput(payload);

    const store = readStore();
    const index = store.servers.findIndex((server) => server.id === id);
    if (index === -1) throw new Error('Saved server was not found.');

    store.servers[index] = {
      ...store.servers[index],
      name: String(payload.name).trim(),
      host: String(payload.host).trim(),
      port: Number(payload.port),
      username: String(payload.username).trim(),
      updatedAt: now()
    };

    writeStore(store);
    return publicServer(store.servers[index]);
  }

  function deleteServer(id) {
    const store = readStore();
    const nextServers = store.servers.filter((server) => server.id !== id);
    if (nextServers.length === store.servers.length) throw new Error('Saved server was not found.');
    writeStore({ servers: nextServers });
    return { ok: true };
  }

  function markConnected(id) {
    const store = readStore();
    const server = store.servers.find((item) => item.id === id);
    if (!server) throw new Error('Saved server was not found.');
    server.lastConnectedAt = now();
    server.updatedAt = server.updatedAt || server.lastConnectedAt;
    writeStore(store);
    return publicServer(server);
  }

  function connectToSavedServer(id, password) {
    const server = readStore().servers.find((item) => item.id === id);
    if (!server) throw new Error('Saved server was not found.');
    return {
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      password
    };
  }

  return {
    saveServer,
    getServers,
    deleteServer,
    updateServer,
    markConnected,
    connectToSavedServer
  };
}

module.exports = { createServerManager };
