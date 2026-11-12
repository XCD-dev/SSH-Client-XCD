const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createVpnManager } = require('../src/main/modules/vpnManager');

function withStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-vpn-manager-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'vpn-profiles.json');
}

test('adds a VLESS profile without exposing its UUID through the renderer contract', async (t) => {
  const storagePath = withStore(t);
  const manager = createVpnManager(storagePath, { measureLatency: async () => 15 });
  const uuid = '11111111-2222-4333-8444-555555555555';

  const profile = await manager.addProfile({
    name: 'Amsterdam',
    input: `vless://${uuid}@vpn.example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fws&sni=vpn.example.com#NL-1`
  });

  assert.equal(profile.name, 'Amsterdam');
  assert.equal(profile.provider, 'VLESS');
  assert.equal(profile.type, 'vless');
  assert.equal(profile.endpointCount, 1);
  assert.equal(profile.endpoints[0].host, 'vpn.example.com');
  assert.equal(profile.endpoints[0].port, 443);
  assert.equal(profile.endpoints[0].country, 'NL');
  assert.equal(JSON.stringify(profile).includes(uuid), false);
  assert.match(profile.redactedSource, /\[redacted\]/);

  const runtime = manager.runtimeProfile(profile.id);
  assert.equal(runtime.endpoints[0].uuid, uuid);
  assert.equal(runtime.endpoints[0].transport.type, 'ws');
  assert.equal(runtime.endpoints[0].transport.path, '/ws');
  assert.equal(runtime.endpoints[0].tls.serverName, 'vpn.example.com');
});

test('persists endpoint selection and latency results', async (t) => {
  const storagePath = withStore(t);
  const checked = [];
  const manager = createVpnManager(storagePath, {
    measureLatency: async (host, port) => {
      checked.push(`${host}:${port}`);
      return host.startsWith('one.') ? 21 : null;
    }
  });

  const first = await manager.addProfile({
    name: 'Two endpoints',
    input: [
      'vless://11111111-2222-4333-8444-555555555555@one.example.com:443?security=tls#DE-1',
      'vless://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@two.example.com:8443?security=tls#US-2'
    ].join('\n')
  });

  const selected = manager.selectEndpoint(first.id, first.endpoints[1].id);
  assert.equal(selected.selectedEndpointId, first.endpoints[1].id);

  const checkedProfile = await manager.checkLatency(first.id);
  assert.deepEqual(checked, ['one.example.com:443', 'two.example.com:8443']);
  assert.equal(checkedProfile.endpoints[0].latencyMs, 21);
  assert.equal(checkedProfile.endpoints[0].status, 'online');
  assert.equal(checkedProfile.endpoints[1].latencyMs, null);
  assert.equal(checkedProfile.endpoints[1].status, 'offline');

  const reloaded = createVpnManager(storagePath, { measureLatency: async () => null });
  assert.equal(reloaded.getProfiles()[0].selectedEndpointId, first.endpoints[1].id);
  assert.equal(reloaded.getProfiles()[0].endpoints[0].latencyMs, 21);
});

test('rejects unsupported input instead of saving an unusable profile', async (t) => {
  const manager = createVpnManager(withStore(t), { measureLatency: async () => null });
  await assert.rejects(
    manager.addProfile({ name: 'Broken', input: 'not-a-subscription' }),
    /supported VLESS/i
  );
  assert.deepEqual(manager.getProfiles(), []);
});

test('unwraps an encoded Hiddify import link into the same VLESS runtime format', async (t) => {
  const manager = createVpnManager(withStore(t), { measureLatency: async () => null });
  const vless = 'vless://11111111-2222-4333-8444-555555555555@vpn.example.com:443?security=reality&pbk=public-key&sid=abcd&sni=edge.example.com#US';
  const profile = await manager.addProfile({ input: `hiddify://import/${encodeURIComponent(vless)}` });

  assert.equal(profile.provider, 'Hiddify');
  assert.equal(profile.endpointCount, 1);
  const endpoint = manager.runtimeProfile(profile.id).endpoints[0];
  assert.equal(endpoint.tls.reality.enabled, true);
  assert.equal(endpoint.tls.reality.publicKey, 'public-key');
  assert.equal(endpoint.tls.reality.shortId, 'abcd');
});

test('downloads a bounded Hiddify subscription URL and imports its VLESS endpoints', async (t) => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const subscription = Buffer.from(`vless://${uuid}@sub.example.com:443?security=tls#DE`).toString('base64');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(subscription);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const manager = createVpnManager(withStore(t), { measureLatency: async () => null });

  const profile = await manager.addProfile({
    name: 'Subscription',
    input: `hiddify://import/http://127.0.0.1:${address.port}/subscription#Local`
  });

  assert.equal(profile.provider, 'Hiddify');
  assert.equal(profile.endpointCount, 1);
  assert.equal(profile.endpoints[0].host, 'sub.example.com');
  assert.equal(JSON.stringify(profile).includes(uuid), false);
});
