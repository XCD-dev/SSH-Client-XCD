const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const SUBSCRIPTION_TIMEOUT_MS = 12000;
const MAX_SUBSCRIPTION_REDIRECTS = 3;

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function decodeBase64(value) {
  const normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[a-zA-Z0-9+/=]+$/.test(normalized)) return '';
  try {
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch (_error) {
    return '';
  }
}

function collectVlessLinks(input) {
  const queue = [String(input || '').trim()];
  const visited = new Set();
  const links = [];

  while (queue.length && visited.size < 30) {
    const candidate = queue.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);

    const matches = candidate.match(/vless:\/\/[^\s<>"']+/gi) || [];
    matches.forEach((link) => links.push(link.replace(/[),.;]+$/, '')));
    if (matches.length) continue;

    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded !== candidate) queue.push(decoded);
    } catch (_error) {
      // The candidate is not percent encoded.
    }

    const decodedBase64 = decodeBase64(candidate);
    if (decodedBase64 && decodedBase64 !== candidate) queue.push(decodedBase64);

    try {
      const wrapper = new URL(candidate);
      wrapper.searchParams.forEach((value) => queue.push(value));
      wrapper.pathname.split('/').filter(Boolean).forEach((part) => queue.push(part));
    } catch (_error) {
      // Direct subscription contents are not necessarily a URL.
    }
  }

  return Array.from(new Set(links));
}

function extractSubscriptionUrl(input) {
  const source = String(input || '').trim();
  if (/^https?:\/\//i.test(source)) return source;
  if (/^happ:\/\/crypto/i.test(source)) {
    throw new Error('Encrypted Happ subscriptions cannot be imported without their decryption key.');
  }

  const importMatch = source.match(/^(?:hiddify:\/\/import\/|happ:\/\/(?:add|import)\/)(.+)$/i);
  if (importMatch) {
    const withoutName = importMatch[1].replace(/#[^#]*$/, '');
    try {
      const decoded = decodeURIComponent(withoutName);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (_error) {
      // Continue with legacy query parameter parsing.
    }
  }

  try {
    const parsed = new URL(source);
    const candidate = parsed.searchParams.get('url');
    if (candidate && /^https?:\/\//i.test(candidate)) return candidate;
  } catch (_error) {
    // The input is neither a supported deep link nor a subscription URL.
  }
  return '';
}

function downloadSubscription(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      reject(new Error('VPN subscription URL is invalid.'));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error('VPN subscription must use HTTP or HTTPS.'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, {
      headers: {
        accept: 'text/plain, application/json;q=0.9, */*;q=0.5',
        'user-agent': 'XCD-SSH-Client/2.0.0'
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_SUBSCRIPTION_REDIRECTS) {
          reject(new Error('VPN subscription redirected too many times.'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, parsed).toString();
        downloadSubscription(redirectUrl, redirects + 1).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Could not download VPN subscription (HTTP ${statusCode || 'error'}).`));
        return;
      }

      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > MAX_SUBSCRIPTION_BYTES) {
        response.destroy();
        reject(new Error('VPN subscription is too large.'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_SUBSCRIPTION_BYTES) {
          response.destroy(new Error('VPN subscription is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', (error) => reject(error));
    });
    request.setTimeout(SUBSCRIPTION_TIMEOUT_MS, () => {
      request.destroy(new Error('VPN subscription download timed out.'));
    });
    request.on('error', (error) => reject(new Error(`Could not download VPN subscription: ${error.message}`)));
  });
}

function countryFromName(name) {
  const value = String(name || '').trim();
  const match = value.match(/(?:^|[\s|_-])([A-Z]{2})(?:[\s|_-]|$)/);
  return match ? match[1] : '';
}

function parseBoolean(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function parseVlessLink(link) {
  let parsed;
  try {
    parsed = new URL(link);
  } catch (_error) {
    throw new Error('Invalid VLESS link.');
  }

  const uuid = decodeURIComponent(parsed.username || '').trim();
  const host = parsed.hostname;
  const port = Number(parsed.port || 443);
  if (!uuid || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VLESS link must include UUID, host, and a valid port.');
  }

  const params = parsed.searchParams;
  const name = decodeURIComponent(parsed.hash.slice(1) || host).trim() || host;
  const transportType = String(params.get('type') || 'tcp').toLowerCase();
  const security = String(params.get('security') || '').toLowerCase();
  const serverName = params.get('sni') || params.get('serverName') || host;
  const tlsEnabled = security === 'tls' || security === 'reality';

  return {
    id: createId('endpoint'),
    type: 'vless',
    name,
    country: countryFromName(name),
    host,
    port,
    uuid,
    flow: params.get('flow') || '',
    packetEncoding: params.get('packetEncoding') || params.get('packet_encoding') || '',
    tls: {
      enabled: tlsEnabled,
      serverName,
      insecure: parseBoolean(params.get('allowInsecure')),
      fingerprint: params.get('fp') || '',
      alpn: (params.get('alpn') || '').split(',').map((item) => item.trim()).filter(Boolean),
      reality: security === 'reality' ? {
        enabled: true,
        publicKey: params.get('pbk') || '',
        shortId: params.get('sid') || ''
      } : null
    },
    transport: {
      type: transportType,
      path: params.get('path') || '',
      host: params.get('host') || '',
      serviceName: params.get('serviceName') || params.get('service_name') || '',
      mode: params.get('mode') || ''
    },
    latencyMs: null,
    status: 'unknown',
    checkedAt: ''
  };
}

function redactedSource(source) {
  return String(source || '')
    .replace(/vless:\/\/[^@\s]+@/gi, 'vless://[redacted]@')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[redacted]');
}

function publicEndpoint(endpoint) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    country: endpoint.country || '',
    host: endpoint.host,
    port: endpoint.port,
    latencyMs: endpoint.latencyMs === undefined ? null : endpoint.latencyMs,
    status: endpoint.status || 'unknown',
    checkedAt: endpoint.checkedAt || ''
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    type: profile.type,
    endpointCount: profile.endpoints.length,
    selectedEndpointId: profile.selectedEndpointId,
    redactedSource: redactedSource(profile.source),
    endpoints: profile.endpoints.map(publicEndpoint),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function createVpnManager(storagePath, vpnService) {
  function readStore() {
    try {
      if (!fs.existsSync(storagePath)) return { profiles: [] };
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      return { profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
    } catch (_error) {
      return { profiles: [] };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  function findProfile(store, profileId) {
    const profile = store.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('VPN profile was not found.');
    return profile;
  }

  function getProfiles() {
    return readStore().profiles
      .map(publicProfile)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async function addProfile(payload) {
    const source = String(payload && payload.input || '').trim();
    if (!source) throw new Error('VPN profile link is required.');
    let links = collectVlessLinks(source);
    if (!links.length) {
      const subscriptionUrl = extractSubscriptionUrl(source);
      if (subscriptionUrl) {
        const subscription = await downloadSubscription(subscriptionUrl);
        links = collectVlessLinks(subscription);
      }
    }
    if (!links.length) {
      throw new Error('No supported VLESS endpoints were found in the supplied link.');
    }

    const endpoints = links.map(parseVlessLink);
    const timestamp = now();
    const wrapperScheme = source.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    const provider = wrapperScheme && !/^vless$/i.test(wrapperScheme[1])
      ? wrapperScheme[1].replace(/^./, (letter) => letter.toUpperCase())
      : 'VLESS';
    const profile = {
      id: createId('profile'),
      name: String(payload.name || '').trim() || endpoints[0].name || endpoints[0].host,
      provider,
      type: 'vless',
      source,
      endpoints,
      selectedEndpointId: endpoints[0].id,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const store = readStore();
    store.profiles.push(profile);
    writeStore(store);
    return publicProfile(profile);
  }

  function deleteProfile(profileId) {
    const store = readStore();
    const profiles = store.profiles.filter((profile) => profile.id !== profileId);
    if (profiles.length === store.profiles.length) throw new Error('VPN profile was not found.');
    writeStore({ profiles });
    return { ok: true };
  }

  function selectEndpoint(profileId, endpointId) {
    const store = readStore();
    const profile = findProfile(store, profileId);
    if (!profile.endpoints.some((endpoint) => endpoint.id === endpointId)) {
      throw new Error('VPN endpoint was not found.');
    }
    profile.selectedEndpointId = endpointId;
    profile.updatedAt = now();
    writeStore(store);
    return publicProfile(profile);
  }

  async function checkLatency(profileId) {
    const store = readStore();
    const profile = findProfile(store, profileId);
    const checkedAt = now();
    await Promise.all(profile.endpoints.map(async (endpoint) => {
      try {
        const latencyMs = await vpnService.measureLatency(endpoint.host, endpoint.port);
        endpoint.latencyMs = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null;
        endpoint.status = endpoint.latencyMs === null ? 'offline' : 'online';
      } catch (_error) {
        endpoint.latencyMs = null;
        endpoint.status = 'offline';
      }
      endpoint.checkedAt = checkedAt;
    }));
    profile.updatedAt = checkedAt;
    writeStore(store);
    return publicProfile(profile);
  }

  function runtimeProfile(profileId) {
    const profile = findProfile(readStore(), profileId);
    const copy = JSON.parse(JSON.stringify(profile));
    delete copy.source;
    return copy;
  }

  return {
    getProfiles,
    addProfile,
    deleteProfile,
    selectEndpoint,
    checkLatency,
    runtimeProfile
  };
}

module.exports = { createVpnManager };
