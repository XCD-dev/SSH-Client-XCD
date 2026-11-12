const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');

const LOCAL_PROXY_HOST = '127.0.0.1';
const LOCAL_PROXY_PORT = 2080;

function now() {
  return new Date().toISOString();
}

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout || 10000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function createVpnService({ appRoot, userDataPath, onLog = () => {} }) {
  const runtimeDirectory = path.join(userDataPath, 'vpn-runtime');
  const configPath = path.join(runtimeDirectory, 'sing-box.json');
  let child = null;
  let activeProfile = null;
  let activeEnginePath = '';

  function log(type, message) {
    onLog({ type, message, time: now() });
  }

  function engineCandidates() {
    if (process.platform === 'win32') {
      return [path.join(appRoot, 'bin', 'sing-box', 'win32', 'sing-box.exe'), 'sing-box'];
    }
    if (process.platform === 'darwin') {
      return [path.join(appRoot, 'bin', 'sing-box', 'macos', 'sing-box'), 'sing-box'];
    }
    return [path.join(appRoot, 'bin', 'sing-box', 'linux', 'sing-box'), 'sing-box'];
  }

  async function detectEngine() {
    const errors = [];
    for (const candidate of engineCandidates()) {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) {
        errors.push(`${candidate}: file not found`);
        continue;
      }
      try {
        const result = await runFile(candidate, ['version'], { timeout: 5000 });
        activeEnginePath = candidate;
        return {
          available: true,
          path: candidate,
          version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || 'sing-box',
          error: ''
        };
      } catch (error) {
        errors.push(`${candidate}: ${String(error.stderr || error.message).trim()}`);
      }
    }
    activeEnginePath = '';
    return {
      available: false,
      path: engineCandidates()[0],
      version: '',
      error: errors.join('; ') || 'sing-box was not found.'
    };
  }

  function getCompatibility() {
    return {
      windows: {
        supported: process.platform === 'win32',
        engine: 'Bundled sing-box executable or sing-box from PATH',
        routing: 'Local mixed SOCKS/HTTP proxy',
        tun: 'Not enabled by this application',
        permissions: 'Standard user for local proxy mode'
      },
      linux: {
        supported: process.platform === 'linux',
        engine: 'Bundled sing-box executable or sing-box from PATH',
        routing: 'Local mixed SOCKS/HTTP proxy',
        tun: 'Not enabled by this application',
        permissions: 'Standard user for local proxy mode'
      },
      macos: {
        supported: process.platform === 'darwin',
        engine: 'Bundled sing-box executable or sing-box from PATH',
        routing: 'Local mixed SOCKS/HTTP proxy',
        tun: 'Not enabled by this application',
        permissions: 'Standard user for local proxy mode'
      }
    };
  }

  function selectedEndpoint(profile) {
    if (!profile || !Array.isArray(profile.endpoints) || !profile.endpoints.length) {
      throw new Error('VPN profile does not contain endpoints.');
    }
    return profile.endpoints.find((endpoint) => endpoint.id === profile.selectedEndpointId) || profile.endpoints[0];
  }

  function buildTls(endpoint) {
    const source = endpoint.tls || {};
    if (!source.enabled) return undefined;
    const tls = {
      enabled: true,
      server_name: source.serverName || endpoint.host,
      insecure: Boolean(source.insecure)
    };
    if (source.alpn && source.alpn.length) tls.alpn = source.alpn;
    if (source.fingerprint) {
      tls.utls = { enabled: true, fingerprint: source.fingerprint };
    }
    if (source.reality && source.reality.enabled) {
      tls.reality = {
        enabled: true,
        public_key: source.reality.publicKey,
        short_id: source.reality.shortId || ''
      };
    }
    return tls;
  }

  function buildTransport(endpoint) {
    const source = endpoint.transport || {};
    const type = String(source.type || 'tcp').toLowerCase();
    if (type === 'tcp' || type === 'none') return undefined;
    if (type === 'ws') {
      const transport = { type: 'ws', path: source.path || '/' };
      if (source.host) transport.headers = { Host: source.host };
      return transport;
    }
    if (type === 'grpc') {
      return { type: 'grpc', service_name: source.serviceName || '' };
    }
    if (type === 'http' || type === 'h2') {
      const transport = { type: 'http', path: source.path || '/' };
      if (source.host) transport.host = [source.host];
      return transport;
    }
    if (type === 'httpupgrade') {
      const transport = { type: 'httpupgrade', path: source.path || '/' };
      if (source.host) transport.headers = { Host: source.host };
      return transport;
    }
    throw new Error(`Unsupported VLESS transport: ${type}`);
  }

  function buildConfig(profile) {
    const endpoint = selectedEndpoint(profile);
    if (endpoint.type !== 'vless' || !endpoint.uuid) {
      throw new Error('Selected endpoint is not a usable VLESS endpoint.');
    }
    const outbound = {
      type: 'vless',
      tag: 'proxy',
      server: endpoint.host,
      server_port: Number(endpoint.port),
      uuid: endpoint.uuid
    };
    if (endpoint.flow) outbound.flow = endpoint.flow;
    if (endpoint.packetEncoding) outbound.packet_encoding = endpoint.packetEncoding;
    const tls = buildTls(endpoint);
    if (tls) outbound.tls = tls;
    const transport = buildTransport(endpoint);
    if (transport) outbound.transport = transport;

    return {
      log: { level: 'info', timestamp: true },
      inbounds: [{
        type: 'mixed',
        tag: 'mixed-in',
        listen: LOCAL_PROXY_HOST,
        listen_port: LOCAL_PROXY_PORT
      }],
      outbounds: [outbound, { type: 'direct', tag: 'direct' }],
      route: { final: 'proxy' }
    };
  }

  function getRuntimeStatus() {
    const running = Boolean(child && child.exitCode === null && !child.killed);
    return {
      running,
      pid: running ? child.pid : null,
      profile: running && activeProfile ? { id: activeProfile.id, name: activeProfile.name } : null,
      localProxy: running ? `${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}` : '',
      routing: 'System routing is not enabled.'
    };
  }

  async function start(profile) {
    if (getRuntimeStatus().running) throw new Error('VPN engine is already running.');
    const engine = await detectEngine();
    if (!engine.available) throw new Error(`sing-box is unavailable: ${engine.error}`);

    const config = buildConfig(profile);
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      await runFile(activeEnginePath, ['check', '-c', configPath], { timeout: 10000 });
    } catch (error) {
      throw new Error(`sing-box rejected the VPN configuration: ${String(error.stderr || error.message).trim()}`);
    }

    child = spawn(activeEnginePath, ['run', '-c', configPath], {
      cwd: runtimeDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeProfile = JSON.parse(JSON.stringify(profile));
    child.stdout.on('data', (data) => log('info', String(data).trim()));
    child.stderr.on('data', (data) => log('error', String(data).trim()));
    child.once('error', (error) => log('error', `sing-box failed to start: ${error.message}`));
    child.once('exit', (code, signal) => {
      log(code === 0 ? 'info' : 'error', `sing-box exited (${signal || code}).`);
      child = null;
      activeProfile = null;
    });
    log('info', `sing-box started for profile ${profile.name || profile.id}.`);
    return getRuntimeStatus();
  }

  async function stop() {
    const runningChild = child;
    if (!runningChild || runningChild.exitCode !== null) {
      child = null;
      activeProfile = null;
      return getRuntimeStatus();
    }

    runningChild.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (runningChild.exitCode === null) runningChild.kill('SIGKILL');
        resolve();
      }, 3000);
      runningChild.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child === runningChild) child = null;
    activeProfile = null;
    log('info', 'sing-box stopped.');
    return getRuntimeStatus();
  }

  async function restart(profile) {
    await stop();
    return start(profile);
  }

  function measureLatency(host, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const socket = net.createConnection({ host, port: Number(port) });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(Date.now() - startedAt));
      socket.once('timeout', () => finish(null));
      socket.once('error', () => finish(null));
    });
  }

  return {
    detectEngine,
    getCompatibility,
    getRuntimeStatus,
    buildConfig,
    start,
    stop,
    restart,
    measureLatency
  };
}

module.exports = { createVpnService };
