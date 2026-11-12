const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createVpnService } = require('../src/main/services/vpnService');

function createService(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-vpn-service-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return createVpnService({ appRoot: path.resolve(__dirname, '..'), userDataPath, onLog: () => {} });
}

test('builds a sing-box local SOCKS configuration from the selected VLESS endpoint', (t) => {
  const service = createService(t);
  const config = service.buildConfig({
    id: 'profile-1',
    name: 'NL',
    selectedEndpointId: 'endpoint-1',
    endpoints: [{
      id: 'endpoint-1',
      type: 'vless',
      host: 'vpn.example.com',
      port: 443,
      uuid: '11111111-2222-4333-8444-555555555555',
      flow: '',
      tls: { enabled: true, serverName: 'vpn.example.com', insecure: false, fingerprint: 'chrome' },
      transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' }
    }]
  });

  assert.equal(config.inbounds[0].type, 'mixed');
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].listen_port, 2080);
  assert.deepEqual(config.outbounds[0], {
    type: 'vless',
    tag: 'proxy',
    server: 'vpn.example.com',
    server_port: 443,
    uuid: '11111111-2222-4333-8444-555555555555',
    tls: {
      enabled: true,
      server_name: 'vpn.example.com',
      insecure: false,
      utls: { enabled: true, fingerprint: 'chrome' }
    },
    transport: {
      type: 'ws',
      path: '/ws',
      headers: { Host: 'cdn.example.com' }
    }
  });
  assert.equal(config.route.final, 'proxy');
});

test('reports a stopped runtime before the engine starts', (t) => {
  const service = createService(t);
  assert.deepEqual(service.getRuntimeStatus(), {
    running: false,
    pid: null,
    profile: null,
    localProxy: '',
    routing: 'System routing is not enabled.'
  });
});
