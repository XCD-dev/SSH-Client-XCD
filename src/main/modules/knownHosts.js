const fs = require('fs');
const path = require('path');

function hostKey(host, port) {
  return `${String(host).trim()}:${Number(port)}`;
}

function now() {
  return new Date().toISOString();
}

function createKnownHostsManager(storagePath) {
  function readStore() {
    try {
      if (!fs.existsSync(storagePath)) return { hosts: {} };
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      return { hosts: parsed && parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {} };
    } catch (_error) {
      return { hosts: {} };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify(store, null, 2));
  }

  function checkHost({ host, port, fingerprint }) {
    const store = readStore();
    const key = hostKey(host, port);
    const known = store.hosts[key];

    if (!known) {
      return { state: 'unknown', knownFingerprint: '' };
    }

    if (known.fingerprint === fingerprint) {
      return { state: 'trusted', knownFingerprint: known.fingerprint };
    }

    return { state: 'changed', knownFingerprint: known.fingerprint };
  }

  function trustHost({ host, port, fingerprint }) {
    const store = readStore();
    const key = hostKey(host, port);
    store.hosts[key] = {
      host: String(host).trim(),
      port: Number(port),
      fingerprint,
      updatedAt: now()
    };
    writeStore(store);
    return store.hosts[key];
  }

  return {
    checkHost,
    trustHost
  };
}

module.exports = { createKnownHostsManager };
