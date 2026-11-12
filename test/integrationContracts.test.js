const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildProxyEnvironmentCommand, createRemoteVpnManager } = require('../src/main/modules/remoteVpnManager');
const { createServerManager } = require('../src/main/modules/serverManager');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const itemPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(itemPath) : [itemPath];
  });
}

test('every local CommonJS import in source and scripts resolves to a real file', () => {
  const root = path.resolve(__dirname, '..');
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]
    .filter((file) => file.endsWith('.js'));
  const missing = [];

  files.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        missing.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
  });

  assert.deepEqual(missing, []);
});

test('Electron repair uses the extractor provided by the installed Electron package', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/start-electron.js'), 'utf8');
  assert.match(source, /@electron-internal\/extract-zip/);
  assert.doesNotMatch(source, /require\.resolve\('extract-zip'/);
});

test('saved server manager persists metadata without persisting a password', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-server-manager-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'servers.json');
  const manager = createServerManager(storagePath);

  const saved = manager.saveServer({
    name: 'Test server',
    host: '127.0.0.1',
    port: 22,
    username: 'tester',
    password: 'must-not-be-stored'
  });

  assert.equal(manager.getServers()[0].id, saved.id);
  assert.equal(fs.readFileSync(storagePath, 'utf8').includes('must-not-be-stored'), false);
});

test('remote VPN manager builds and uploads the selected runtime configuration', async () => {
  const profile = {
    id: 'profile-1',
    selectedEndpointId: 'endpoint-1',
    endpoints: [{ id: 'endpoint-1', host: 'vpn.example.com', port: 443 }]
  };
  const expectedConfig = { inbounds: [{ type: 'mixed' }], outbounds: [{ type: 'vless' }] };
  const commands = [];
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: {
      buildConfig(received) {
        assert.deepEqual(received, profile);
        return expectedConfig;
      }
    }
  });
  const ssh = {
    async exec(command, options) {
      commands.push({ command, options });
      if (options.redactedCommand === 'Check remote VPN status') {
        return {
          stdout: ['Linux', 'x86_64', '/usr/bin/sing-box', 'sing-box version 1.12.0', 'yes', 'yes', 'yes', 'no'].join('\n'),
          stderr: '',
          exitCode: 0
        };
      }
      return { stdout: 'started\n', stderr: '', exitCode: 0 };
    }
  };

  const status = await manager.start(ssh, profile);
  assert.equal(status.running, true);
  assert.equal(status.proxy, '127.0.0.1:2080');
  assert.equal(commands[0].options.redactedCommand, 'Upload remote VPN config');
  const encoded = commands[0].command.match(/<<'SSH_CLIENT_VPN_CONFIG'\n([^\n]+)\nSSH_CLIENT_VPN_CONFIG/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), expectedConfig);
  assert.equal(commands[1].options.redactedCommand, 'Start remote VPN local proxy');
});

test('remote VPN shell environment uses the working HTTP side of the mixed proxy', () => {
  assert.equal(
    buildProxyEnvironmentCommand('127.0.0.1:2080'),
    'export HTTP_PROXY=http://127.0.0.1:2080 HTTPS_PROXY=http://127.0.0.1:2080 ALL_PROXY=http://127.0.0.1:2080 http_proxy=http://127.0.0.1:2080 https_proxy=http://127.0.0.1:2080 all_proxy=http://127.0.0.1:2080'
  );
  assert.equal(
    buildProxyEnvironmentCommand(''),
    'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy'
  );
});

test('remote VPN IP check uses the HTTP side of the mixed proxy', async () => {
  let command = '';
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: { buildConfig() { return {}; } }
  });
  const result = await manager.checkIp({
    async exec(received) {
      command = received;
      return { stdout: '198.51.100.10\n203.0.113.20\n', stderr: '', exitCode: 0 };
    }
  });

  assert.match(command, /--proxy http:\/\/127\.0\.0\.1:2080/);
  assert.equal(result.changed, true);
});

test('remote VPN persists and clears Codex proxy settings outside the active TUI', async () => {
  const commands = [];
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: { buildConfig() { return {}; } }
  });
  const ssh = {
    async exec(command, options) {
      commands.push({ command, options });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  };

  await manager.configureCodexProxy(ssh, true);
  await manager.configureCodexProxy(ssh, false);

  assert.match(commands[0].command, /HTTP_PROXY=http:\/\/127\.0\.0\.1:2080/);
  assert.match(commands[0].command, /# ssh-client-vpn proxy begin/);
  assert.match(commands[1].command, /# ssh-client-vpn proxy end/);
  assert.doesNotMatch(commands[1].command, /HTTP_PROXY=http:/);
  assert.equal(commands[0].options.redactedCommand, 'Enable Codex remote VPN proxy');
  assert.equal(commands[1].options.redactedCommand, 'Disable Codex remote VPN proxy');
});

test('remote VPN manager exposes guarded full-routing operations', () => {
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: { buildConfig() { return {}; } }
  });

  assert.equal(typeof manager.fullRoutingPreflight, 'function');
  assert.equal(typeof manager.enableFullRouting, 'function');
  assert.equal(typeof manager.disableFullRouting, 'function');
  assert.equal(typeof manager.fullRoutingStatus, 'function');
  assert.equal(typeof manager.confirmFullRouting, 'function');
});

test('full routing preserves SSH and endpoint routes before replacing the default route', async () => {
  const commands = [];
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: {
      buildConfig() {
        return { outbounds: [{ type: 'vless', tag: 'proxy' }, { type: 'direct', tag: 'direct' }] };
      }
    }
  });
  const profile = {
    id: 'profile-1',
    selectedEndpointId: 'endpoint-1',
    endpoints: [{ id: 'endpoint-1', host: 'vpn.example.com', port: 443, sni: 'vpn.example.com' }]
  };
  const ssh = {
    async exec(command, options) {
      commands.push({ command, options });
      if (options.redactedCommand === 'Remote VPN full routing preflight') {
        return {
          stdout: [
            'Linux', 'x86_64', '1000', '/home/test/.ssh-client-vpn/bin/sing-box',
            'yes', 'yes', 'no', 'yes', '100.64.0.10',
            'default via 192.0.2.1 dev eth0 src 192.0.2.20',
            '100.64.0.10 via 192.0.2.1 dev eth0 src 192.0.2.20'
          ].join('\n'),
          stderr: '',
          exitCode: 0
        };
      }
      if (options.redactedCommand === 'Resolve remote VPN endpoint') {
        return { stdout: '203.0.113.55\n', stderr: '', exitCode: 0 };
      }
      if (options.redactedCommand === 'Check remote VPN full routing status') {
        return {
          stdout: ['yes', 'yes', '7: sshclienttun0: <POINTOPOINT,UP>', 'default dev sshclienttun0', '203.0.113.55', '203.0.113.55 via 192.0.2.1 dev eth0'].join('\n'),
          stderr: '',
          exitCode: 0
        };
      }
      return { stdout: 'enabled\n', stderr: '', exitCode: 0 };
    }
  };

  const result = await manager.enableFullRouting(ssh, profile, 'sudo-password');
  const upload = commands.find((entry) => entry.options.redactedCommand === 'Upload remote full routing VPN config');
  const start = commands.find((entry) => entry.options.redactedCommand === 'Enable remote VPN full routing');
  const encoded = upload.command.match(/<<'SSH_CLIENT_VPN_CONFIG'\n([^\n]+)\nSSH_CLIENT_VPN_CONFIG/)[1];
  const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

  assert.equal(config.inbounds[0].type, 'tun');
  assert.equal(config.route.final, 'proxy');
  assert.ok(start.command.indexOf('ip route replace "$CLIENT_IP"/32') < start.command.indexOf('ip route replace default dev sshclienttun0'));
  assert.ok(start.command.indexOf('ip route replace "$ENDPOINT_IP"/32') < start.command.indexOf('ip route replace default dev sshclienttun0'));
  assert.doesNotMatch(start.command, /sudo-password/);
  const sudoCalls = (start.command.match(/sudo -S -p ''/g) || []).length;
  assert.ok(sudoCalls > 0);
  assert.equal(start.options.stdin, Array(sudoCalls).fill('sudo-password').join('\n') + '\n');
  assert.match(start.command, /DEFAULT_ROUTE_B64=/);
  assert.match(start.command, /sh -c 'nohup "\$1" run -c "\$2"/);
  assert.match(start.command, /SCRIPT_DIR=.*dirname -- "\$0"/);
  assert.match(start.command, /sleep 60/);
  assert.equal(result.running, true);
  assert.equal(result.rollbackPending, true);
});

test('remote full routing is wired through main, preload, and renderer', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');

  for (const channel of [
    'vpn:remote-full-preflight',
    'vpn:remote-full-status',
    'vpn:remote-full-enable',
    'vpn:remote-full-confirm',
    'vpn:remote-full-disable'
  ]) {
    assert.match(main, new RegExp(`handleIpc\\('${channel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'`));
  }
  for (const method of [
    'getRemoteVpnFullRoutingPreflight',
    'getRemoteVpnFullRoutingStatus',
    'enableRemoteVpnFullRouting',
    'confirmRemoteVpnFullRouting',
    'disableRemoteVpnFullRouting'
  ]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(renderer, /id="enable-remote-full-routing"/);
  assert.match(renderer, /id="confirm-remote-full-routing"/);
  assert.match(renderer, /id="disable-remote-full-routing"/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /event\.senderFrame !== sender\.mainFrame/);
});

test('local upload paths are selected in a native dialog', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');

  assert.match(main, /dialog\.showOpenDialog\(mainWindow/);
  assert.match(main, /Object\.hasOwn\(payload, 'paths'\)/);
  assert.match(main, /Local paths must be selected in the system file dialog/);
  assert.doesNotMatch(preload, /webUtils|getPathForFile/);
  assert.doesNotMatch(renderer, /getPathForFile|uploadDroppedPaths/);
});

test('bundled remote VPN installation uploads large files through SFTP', async () => {
  const uploads = [];
  const progress = [];
  const manager = createRemoteVpnManager({
    appRoot: path.resolve(__dirname, '..'),
    vpnService: { buildConfig() { return {}; } }
  });
  const ssh = {
    async exec(_command, options) {
      if (options.redactedCommand === 'Prepare remote bundled sing-box install') {
        return { stdout: 'ready\n/home/tester\n', stderr: '', exitCode: 0 };
      }
      if (options.redactedCommand === 'Check remote VPN status') {
        return {
          stdout: ['Linux', 'x86_64', '/home/tester/.ssh-client-vpn/bin/sing-box', 'sing-box version 1.13.14', 'no', 'yes', 'yes', 'yes'].join('\n'),
          stderr: '',
          exitCode: 0
        };
      }
      return { stdout: 'sing-box version 1.13.14\n', stderr: '', exitCode: 0 };
    },
    async uploadFile(localPath, remotePath, onProgress) {
      uploads.push({ localPath, remotePath });
      onProgress({ transferred: 1, total: 1 });
    }
  };

  const status = await manager.installBundled(ssh, (entry) => progress.push(entry));

  assert.equal(status.installed, true);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].remotePath, '/home/tester/.ssh-client-vpn/bin/sing-box');
  assert.equal(uploads[1].remotePath, '/home/tester/.ssh-client-vpn/bin/libcronet.so');
  assert.equal(progress.at(-1).percent, 100);
});
