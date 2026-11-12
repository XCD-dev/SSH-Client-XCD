const fs = require('fs');
const path = require('path');

const REMOTE_DIR = '$HOME/.ssh-client-vpn';
const REMOTE_BIN_DIR = `${REMOTE_DIR}/bin`;
const REMOTE_BIN = `${REMOTE_BIN_DIR}/sing-box`;
const REMOTE_CONFIG = `${REMOTE_DIR}/sing-box.json`;
const REMOTE_CONFIG_B64 = `${REMOTE_DIR}/sing-box.json.b64`;
const REMOTE_LOG = `${REMOTE_DIR}/sing-box.log`;
const REMOTE_PID = `${REMOTE_DIR}/sing-box.pid`;
const REMOTE_FULL_CONFIG = `${REMOTE_DIR}/sing-box-full-routing.json`;
const REMOTE_FULL_LOG = `${REMOTE_DIR}/sing-box-full-routing.log`;
const REMOTE_FULL_PID = `${REMOTE_DIR}/sing-box-full-routing.pid`;
const REMOTE_ROLLBACK_PID = `${REMOTE_DIR}/rollback.pid`;
const REMOTE_ROLLBACK_SCRIPT = `${REMOTE_DIR}/rollback-full-routing.sh`;
const REMOTE_BACKUP = `${REMOTE_DIR}/route-backup.env`;
const REMOTE_PROXY = '127.0.0.1:2080';

function buildProxyEnvironmentCommand(proxy) {
  const address = String(proxy || '').trim();
  if (!address) {
    return 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy';
  }

  const proxyUrl = `http://${address}`;
  return `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} ALL_PROXY=${proxyUrl} http_proxy=${proxyUrl} https_proxy=${proxyUrl} all_proxy=${proxyUrl}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sudoPrefix() {
  return "sudo -S -p ''";
}

function sudoInputFor(command, password) {
  const value = String(password || '');
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Sudo password cannot contain line breaks.');
  }
  const calls = (command.match(/sudo -S -p ''/g) || []).length;
  return calls ? `${Array(calls).fill(value).join('\n')}\n` : '';
}

function archHint(arch) {
  const value = String(arch || '').trim().toLowerCase();
  if (value === 'x86_64' || value === 'amd64') return 'linux-amd64';
  if (value === 'aarch64' || value === 'arm64') return 'linux-arm64';
  return value || 'unknown';
}

function sanitizeRemoteLog(text) {
  return String(text || '')
    .replace(/vless:\/\/\S+/gi, 'vless://[redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[redacted-uuid]');
}

function createRemoteVpnManager({ vpnService, appRoot }) {
  const bundledLinuxDir = path.join(appRoot, 'bin', 'sing-box', 'linux');
  const bundledLinuxBinary = path.join(bundledLinuxDir, 'sing-box');
  const bundledLinuxLibcronet = path.join(bundledLinuxDir, 'libcronet.so');

  async function status(ssh) {
    const command = [
      'set -u',
      'OS="$(uname -s 2>/dev/null || echo unknown)"',
      'ARCH="$(uname -m 2>/dev/null || echo unknown)"',
      `SING_BOX=""`,
      `if [ -x ${REMOTE_BIN} ]; then SING_BOX="${REMOTE_BIN}"; else SING_BOX="$(command -v sing-box 2>/dev/null || true)"; fi`,
      'VERSION=""',
      'if [ -n "$SING_BOX" ]; then VERSION="$("$SING_BOX" version 2>/dev/null | head -n 1 || true)"; fi',
      `PID_FILE="${REMOTE_PID}"`,
      'RUNNING="no"',
      'PID=""',
      'if [ -f "$PID_FILE" ]; then PID="$(cat "$PID_FILE" 2>/dev/null || true)"; fi',
      'if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then RUNNING="yes"; fi',
      'HAS_BASE64="no"; command -v base64 >/dev/null 2>&1 && HAS_BASE64="yes"',
      'HAS_CURL="no"; command -v curl >/dev/null 2>&1 && HAS_CURL="yes"',
      'HAS_WGET="no"; command -v wget >/dev/null 2>&1 && HAS_WGET="yes"',
      'printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n" "$OS" "$ARCH" "$SING_BOX" "$VERSION" "$RUNNING" "$HAS_BASE64" "$HAS_CURL" "$HAS_WGET"'
    ].join('\n');

    const result = await ssh.exec(command, { timeoutMs: 8000, redactedCommand: 'Check remote VPN status' });
    const [os, arch, binary, version, running, hasBase64, hasCurl, hasWget] = result.stdout.trim().split(/\r?\n/);
    return {
      os: os || 'unknown',
      arch: arch || 'unknown',
      packageHint: archHint(arch),
      installed: Boolean(binary),
      binary: binary || '',
      version: version || '',
      running: running === 'yes',
      dependencies: {
        base64: hasBase64 === 'yes',
        curl: hasCurl === 'yes',
        wget: hasWget === 'yes'
      },
      proxy: running === 'yes' ? REMOTE_PROXY : '',
      mode: 'Remote server local proxy',
      routing: 'Server routing is not modified.'
    };
  }

  async function start(ssh, profile) {
    const config = vpnService.buildConfig(profile);
    const encodedConfig = Buffer.from(JSON.stringify(config, null, 2), 'utf8').toString('base64');

    await ssh.exec(`mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_CONFIG_B64} <<'SSH_CLIENT_VPN_CONFIG'\n${encodedConfig}\nSSH_CLIENT_VPN_CONFIG\nbase64 -d ${REMOTE_CONFIG_B64} > ${REMOTE_CONFIG}\nrm -f ${REMOTE_CONFIG_B64}`, {
      timeoutMs: 10000,
      redactedCommand: 'Upload remote VPN config'
    });

    const command = [
      'set -e',
      `SING_BOX=""`,
      `if [ -x ${REMOTE_BIN} ]; then SING_BOX="${REMOTE_BIN}"; else SING_BOX="$(command -v sing-box 2>/dev/null || true)"; fi`,
      'if [ -z "$SING_BOX" ]; then echo "sing-box is not installed on the remote server. Install bundled engine first." >&2; exit 127; fi',
      `mkdir -p ${REMOTE_DIR}`,
      `if [ -f ${REMOTE_PID} ]; then OLD_PID="$(cat ${REMOTE_PID} 2>/dev/null || true)"; if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then kill "$OLD_PID" || true; sleep 1; fi; fi`,
      `"$SING_BOX" check -c ${REMOTE_CONFIG} >/tmp/ssh-client-vpn-check.log 2>&1 || { cat /tmp/ssh-client-vpn-check.log >&2; exit 1; }`,
      `nohup "$SING_BOX" run -c ${REMOTE_CONFIG} > ${REMOTE_LOG} 2>&1 & echo $! > ${REMOTE_PID}`,
      'sleep 1',
      `PID="$(cat ${REMOTE_PID} 2>/dev/null || true)"`,
      'if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then tail -n 20 ' + REMOTE_LOG + ' >&2 || true; exit 1; fi',
      'printf "started\\n"'
    ].join('\n');

    await ssh.exec(command, { timeoutMs: 12000, redactedCommand: 'Start remote VPN local proxy' });
    return status(ssh);
  }

  async function stop(ssh) {
    const command = [
      'set +e',
      `if [ -f ${REMOTE_PID} ]; then PID="$(cat ${REMOTE_PID} 2>/dev/null || true)"; if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi; rm -f ${REMOTE_PID}; fi`,
      'printf "stopped\\n"'
    ].join('\n');
    await ssh.exec(command, { timeoutMs: 8000, redactedCommand: 'Stop remote VPN local proxy' });
    return status(ssh);
  }

  async function configureCodexProxy(ssh, enabled) {
    const command = [
      'set -e',
      'CODEX_DIR="$HOME/.codex"',
      'ENV_FILE="$CODEX_DIR/.env"',
      'TMP_FILE="$CODEX_DIR/.env.ssh-client-vpn.tmp"',
      'mkdir -p "$CODEX_DIR"',
      'touch "$ENV_FILE"',
      `awk '$0 == "# ssh-client-vpn proxy begin" { skip=1; next } $0 == "# ssh-client-vpn proxy end" { skip=0; next } !skip { print }' "$ENV_FILE" > "$TMP_FILE"`,
      ...(enabled ? [
        `cat >> "$TMP_FILE" <<'SSH_CLIENT_CODEX_PROXY'`,
        '# ssh-client-vpn proxy begin',
        'HTTP_PROXY=http://127.0.0.1:2080',
        'HTTPS_PROXY=http://127.0.0.1:2080',
        'ALL_PROXY=http://127.0.0.1:2080',
        'http_proxy=http://127.0.0.1:2080',
        'https_proxy=http://127.0.0.1:2080',
        'all_proxy=http://127.0.0.1:2080',
        '# ssh-client-vpn proxy end',
        'SSH_CLIENT_CODEX_PROXY'
      ] : []),
      'mv "$TMP_FILE" "$ENV_FILE"',
      'chmod 600 "$ENV_FILE"'
    ].join('\n');
    await ssh.exec(command, {
      timeoutMs: 8000,
      redactedCommand: `${enabled ? 'Enable' : 'Disable'} Codex remote VPN proxy`
    });
    return { enabled: Boolean(enabled), proxy: enabled ? REMOTE_PROXY : '' };
  }

  async function checkIp(ssh) {
    const command = [
      'set +e',
      'DIRECT=""',
      'for URL in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do',
      '  if command -v curl >/dev/null 2>&1; then DIRECT="$(curl -4 -sS -m 6 "$URL" 2>/dev/null | head -n 1)"; fi',
      '  if [ -z "$DIRECT" ] && command -v wget >/dev/null 2>&1; then DIRECT="$(wget -qO- -T 6 "$URL" 2>/dev/null | head -n 1)"; fi',
      '  [ -n "$DIRECT" ] && break',
      'done',
      'PROXY=""',
      'if command -v curl >/dev/null 2>&1; then',
      `  PROXY="$(curl -4 -sS -m 6 --proxy http://${REMOTE_PROXY} https://api.ipify.org 2>/dev/null | head -n 1)"`,
      'fi',
      'printf "%s\\n%s\\n" "$DIRECT" "$PROXY"'
    ].join('\n');
    const result = await ssh.exec(command, { timeoutMs: 30000, redactedCommand: 'Check remote VPN external IP' });
    const [directIp, proxyIp] = result.stdout.trim().split(/\r?\n/);
    return {
      directIp: directIp || '',
      proxyIp: proxyIp || '',
      changed: Boolean(directIp && proxyIp && directIp !== proxyIp),
      checkedAt: new Date().toISOString()
    };
  }

  async function logs(ssh) {
    const command = [
      'printf "%s\\n" "--- proxy log: sing-box.log ---"',
      `if [ -f ${REMOTE_LOG} ]; then tail -n 80 ${REMOTE_LOG}; else echo "Proxy log is empty."; fi`
    ].join('\n');
    const result = await ssh.exec(command, { timeoutMs: 8000, redactedCommand: 'Read remote VPN logs' });
    return {
      content: sanitizeRemoteLog(result.stdout || result.stderr || ''),
      readAt: new Date().toISOString()
    };
  }

  async function fullRoutingPreflight(ssh) {
    const command = [
      'set +e',
      'OS="$(uname -s 2>/dev/null || echo unknown)"',
      'ARCH="$(uname -m 2>/dev/null || echo unknown)"',
      'USER_ID="$(id -u 2>/dev/null || echo unknown)"',
      'SING_BOX=""',
      `if [ -x ${REMOTE_BIN} ]; then SING_BOX="${REMOTE_BIN}"; else SING_BOX="$(command -v sing-box 2>/dev/null || true)"; fi`,
      'HAS_IP="no"; command -v ip >/dev/null 2>&1 && HAS_IP="yes"',
      'HAS_SUDO="no"; command -v sudo >/dev/null 2>&1 && HAS_SUDO="yes"',
      'SUDO_NOPASS="no"; sudo -n true >/dev/null 2>&1 && SUDO_NOPASS="yes"',
      'TUN="no"; [ -c /dev/net/tun ] && TUN="yes"',
      'CLIENT_IP="$(printf "%s" "${SSH_CLIENT:-}" | awk \'{print $1}\')"',
      'DEFAULT_ROUTE="$(ip route show default 2>/dev/null | head -n 1 || true)"',
      'CLIENT_ROUTE=""',
      'if [ -n "$CLIENT_IP" ]; then CLIENT_ROUTE="$(ip route get "$CLIENT_IP" 2>/dev/null | head -n 1 || true)"; fi',
      'printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n" "$OS" "$ARCH" "$USER_ID" "$SING_BOX" "$HAS_IP" "$HAS_SUDO" "$SUDO_NOPASS" "$TUN" "$CLIENT_IP" "$DEFAULT_ROUTE" "$CLIENT_ROUTE"'
    ].join('\n');

    const result = await ssh.exec(command, { timeoutMs: 10000, redactedCommand: 'Remote VPN full routing preflight' });
    const [
      os,
      arch,
      userId,
      singBox,
      hasIp,
      hasSudo,
      sudoNoPassword,
      tun,
      sshClientIp,
      defaultRoute,
      sshClientRoute
    ] = result.stdout.trim().split(/\r?\n/);

    const warnings = [];
    if (os !== 'Linux') warnings.push('Full routing is currently planned for Linux servers only.');
    if (!singBox) warnings.push('sing-box is not installed or bundled on the remote server.');
    if (hasIp !== 'yes') warnings.push('The ip command is required for route inspection and future route changes.');
    if (tun !== 'yes') warnings.push('/dev/net/tun is not available. TUN mode will not work until it is enabled.');
    if (userId !== '0' && sudoNoPassword !== 'yes') warnings.push('Passwordless sudo is not available. Future full routing will need an interactive/admin permission flow.');
    if (!sshClientIp) warnings.push('Could not detect SSH client IP from SSH_CLIENT.');
    if (!defaultRoute) warnings.push('Could not read default route.');
    if (!sshClientRoute) warnings.push('Could not read route back to SSH client. SSH bypass cannot be planned safely yet.');

    const blockingWarnings = warnings.filter((warning) => !warning.includes('Passwordless sudo'));
    return {
      os: os || 'unknown',
      arch: arch || 'unknown',
      userId: userId || 'unknown',
      singBox: singBox || '',
      hasIp: hasIp === 'yes',
      hasSudo: hasSudo === 'yes',
      sudoNoPassword: sudoNoPassword === 'yes',
      tunAvailable: tun === 'yes',
      sshClientIp: sshClientIp || '',
      defaultRoute: defaultRoute || '',
      sshClientRoute: sshClientRoute || '',
      readyForFullRouting: blockingWarnings.length === 0,
      warnings
    };
  }

  function buildFullRoutingConfig(profile) {
    const config = vpnService.buildConfig(profile);
    config.dns = {
      servers: [
        {
          tag: 'remote-dns',
          address: 'https://1.1.1.1/dns-query',
          detour: 'proxy'
        },
        {
          tag: 'local-dns',
          address: 'local',
          detour: 'direct'
        }
      ],
      final: 'remote-dns'
    };
    config.inbounds = [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'sshclienttun0',
        address: ['172.19.0.1/30'],
        mtu: 9000,
        auto_route: false,
        strict_route: false,
        stack: 'gvisor'
      }
    ];
    config.route = {
      rules: [
        {
          protocol: 'dns',
          action: 'hijack-dns'
        }
      ],
      final: 'proxy'
    };
    return config;
  }

  async function resolveEndpointIp(ssh, host) {
    const command = [
      `ENDPOINT_HOST=${shellQuote(host)}`,
      'ENDPOINT_IP="$(getent ahostsv4 "$ENDPOINT_HOST" 2>/dev/null | awk \'{print $1; exit}\' || true)"',
      'if [ -z "$ENDPOINT_IP" ] && command -v dig >/dev/null 2>&1; then ENDPOINT_IP="$(dig +short A "$ENDPOINT_HOST" | head -n 1)"; fi',
      'if [ -z "$ENDPOINT_IP" ]; then echo "Could not resolve VPN endpoint before route switch: $ENDPOINT_HOST" >&2; exit 1; fi',
      'printf "%s\\n" "$ENDPOINT_IP"'
    ].join('\n');
    const result = await ssh.exec(command, {
      timeoutMs: 10000,
      redactedCommand: 'Resolve remote VPN endpoint'
    });
    return result.stdout.trim().split(/\r?\n/)[0];
  }

  async function enableFullRouting(ssh, profile, sudoPassword) {
    if (!String(sudoPassword || '').trim()) throw new Error('Sudo password is required for full routing.');

    const preflight = await fullRoutingPreflight(ssh);
    const allowedWarnings = preflight.warnings.filter((warning) => !warning.includes('Passwordless sudo'));
    if (allowedWarnings.length) {
      throw new Error(`Full routing preflight is not ready: ${allowedWarnings.join(' ')}`);
    }

    const endpoint = profile.endpoints.find((item) => item.id === profile.selectedEndpointId) || profile.endpoints[0];
    if (!endpoint || !endpoint.host) throw new Error('Selected VPN endpoint host was not found.');
    const endpointIp = await resolveEndpointIp(ssh, endpoint.host);
    const runtimeProfile = JSON.parse(JSON.stringify(profile));
    const runtimeEndpoint = runtimeProfile.endpoints.find((item) => item.id === runtimeProfile.selectedEndpointId) || runtimeProfile.endpoints[0];
    runtimeEndpoint.originalHost = endpoint.host;
    runtimeEndpoint.host = endpointIp;
    runtimeEndpoint.sni = runtimeEndpoint.sni || endpoint.host;
    const config = buildFullRoutingConfig(runtimeProfile);
    const encodedConfig = Buffer.from(JSON.stringify(config, null, 2), 'utf8').toString('base64');
    await ssh.exec(`mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_FULL_CONFIG}.b64 <<'SSH_CLIENT_VPN_CONFIG'\n${encodedConfig}\nSSH_CLIENT_VPN_CONFIG\nbase64 -d ${REMOTE_FULL_CONFIG}.b64 > ${REMOTE_FULL_CONFIG}\nrm -f ${REMOTE_FULL_CONFIG}.b64`, {
      timeoutMs: 10000,
      redactedCommand: 'Upload remote full routing VPN config'
    });

    const sudo = sudoPrefix();
    const command = [
      'set -e',
      `SING_BOX=""`,
      `if [ -x ${REMOTE_BIN} ]; then SING_BOX="${REMOTE_BIN}"; else SING_BOX="$(command -v sing-box 2>/dev/null || true)"; fi`,
      'if [ -z "$SING_BOX" ]; then echo "sing-box is not installed on the remote server." >&2; exit 127; fi',
      'CLIENT_IP="$(printf "%s" "${SSH_CLIENT:-}" | awk \'{print $1}\')"',
      'if [ -z "$CLIENT_IP" ]; then echo "Could not detect SSH client IP." >&2; exit 1; fi',
      `ENDPOINT_IP=${shellQuote(endpointIp)}`,
      'DEFAULT_ROUTE="$(ip route show default | head -n 1)"',
      'DEFAULT_ROUTE_B64="$(printf %s "$DEFAULT_ROUTE" | base64 | tr -d "\\n")"',
      'DEFAULT_GW="$(printf "%s" "$DEFAULT_ROUTE" | sed -n "s/.* via \\([^ ]*\\).*/\\1/p")"',
      'DEFAULT_DEV="$(printf "%s" "$DEFAULT_ROUTE" | sed -n "s/.* dev \\([^ ]*\\).*/\\1/p")"',
      'SSH_ROUTE="$(ip route get "$CLIENT_IP" | head -n 1)"',
      'SSH_DEV="$(printf "%s" "$SSH_ROUTE" | sed -n "s/.* dev \\([^ ]*\\).*/\\1/p")"',
      'SSH_GW="$(printf "%s" "$SSH_ROUTE" | sed -n "s/.* via \\([^ ]*\\).*/\\1/p")"',
      'SSH_SRC="$(printf "%s" "$SSH_ROUTE" | sed -n "s/.* src \\([^ ]*\\).*/\\1/p")"',
      'if [ -z "$SSH_DEV" ]; then echo "Could not detect SSH route device." >&2; exit 1; fi',
      'if [ -z "$DEFAULT_DEV" ]; then DEFAULT_DEV="$SSH_DEV"; fi',
      `printf "CLIENT_IP=%s\\nSSH_DEV=%s\\nSSH_GW=%s\\nSSH_SRC=%s\\nENDPOINT_IP=%s\\nDEFAULT_GW=%s\\nDEFAULT_DEV=%s\\nDEFAULT_ROUTE_B64=%s\\n" "$CLIENT_IP" "$SSH_DEV" "$SSH_GW" "$SSH_SRC" "$ENDPOINT_IP" "$DEFAULT_GW" "$DEFAULT_DEV" "$DEFAULT_ROUTE_B64" > ${REMOTE_BACKUP}`,
      `"$SING_BOX" check -c ${REMOTE_FULL_CONFIG} >/tmp/ssh-client-vpn-full-check.log 2>&1 || { cat /tmp/ssh-client-vpn-full-check.log >&2; exit 1; }`,
      `if [ -f ${REMOTE_FULL_PID} ]; then OLD_PID="$(cat ${REMOTE_FULL_PID} 2>/dev/null || true)"; if [ -n "$OLD_PID" ] && ${sudo} kill "$OLD_PID" 2>/dev/null; then sleep 1; fi; fi`,
      `printf "=== full routing start $(date -Iseconds) stack=gvisor endpoint=$ENDPOINT_IP ===\\n" > ${REMOTE_FULL_LOG}`,
      `${sudo} sh -c 'nohup "$1" run -c "$2" >> "$3" 2>&1 & echo $!' sh "$SING_BOX" ${REMOTE_FULL_CONFIG} ${REMOTE_FULL_LOG} > ${REMOTE_FULL_PID}`,
      'sleep 2',
      `PID="$(cat ${REMOTE_FULL_PID} 2>/dev/null || true)"`,
      'if [ -z "$PID" ] || ! ps -p "$PID" >/dev/null 2>&1; then tail -n 30 ' + REMOTE_FULL_LOG + ' >&2 || true; exit 1; fi',
      `if [ -n "$SSH_GW" ]; then ${sudo} ip route replace "$CLIENT_IP"/32 via "$SSH_GW" dev "$SSH_DEV" ${'${SSH_SRC:+src "$SSH_SRC"}'}; else ${sudo} ip route replace "$CLIENT_IP"/32 dev "$SSH_DEV" ${'${SSH_SRC:+src "$SSH_SRC"}'}; fi`,
      `if [ -n "$DEFAULT_GW" ]; then ${sudo} ip route replace "$ENDPOINT_IP"/32 via "$DEFAULT_GW" dev "$DEFAULT_DEV" ${'${SSH_SRC:+src "$SSH_SRC"}'}; else ${sudo} ip route replace "$ENDPOINT_IP"/32 dev "$DEFAULT_DEV" ${'${SSH_SRC:+src "$SSH_SRC"}'}; fi`,
      `${sudo} ip route replace default dev sshclienttun0`,
      `cat > ${REMOTE_ROLLBACK_SCRIPT} <<'SSH_CLIENT_ROLLBACK_SCRIPT'`,
      '#!/bin/sh',
      'if [ "${1:-}" = "--delayed" ]; then sleep 60; fi',
      'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
      'if [ -f "$SCRIPT_DIR/route-backup.env" ]; then . "$SCRIPT_DIR/route-backup.env"; fi',
      'DEFAULT_ROUTE="$(printf %s "${DEFAULT_ROUTE_B64:-}" | base64 -d 2>/dev/null || true)"',
      'if [ -n "$DEFAULT_ROUTE" ]; then ip route replace $DEFAULT_ROUTE; fi',
      'if [ -n "$ENDPOINT_IP" ]; then ip route del "$ENDPOINT_IP"/32 2>/dev/null || true; fi',
      'if [ -f "$SCRIPT_DIR/sing-box-full-routing.pid" ]; then PID="$(cat "$SCRIPT_DIR/sing-box-full-routing.pid" 2>/dev/null || true)"; if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi; rm -f "$SCRIPT_DIR/sing-box-full-routing.pid"; fi',
      'ip link delete sshclienttun0 2>/dev/null || true',
      'rm -f "$SCRIPT_DIR/rollback.pid"',
      'SSH_CLIENT_ROLLBACK_SCRIPT',
      `chmod 700 ${REMOTE_ROLLBACK_SCRIPT}`,
      `${sudo} sh -c 'nohup "$1" --delayed >/dev/null 2>&1 & echo $!' sh ${REMOTE_ROLLBACK_SCRIPT} > ${REMOTE_ROLLBACK_PID}`,
      'printf "enabled\\n"'
    ].join('\n');

    await ssh.exec(command, {
      timeoutMs: 20000,
      redactedCommand: 'Enable remote VPN full routing',
      stdin: sudoInputFor(command, sudoPassword)
    });
    return fullRoutingStatus(ssh);
  }

  async function disableFullRouting(ssh, sudoPassword) {
    if (!String(sudoPassword || '').trim()) throw new Error('Sudo password is required to disable full routing.');
    const sudo = sudoPrefix();
    const command = [
      'set +e',
      `if [ -f ${REMOTE_ROLLBACK_PID} ]; then ROLLBACK_PID="$(cat ${REMOTE_ROLLBACK_PID} 2>/dev/null || true)"; if [ -n "$ROLLBACK_PID" ]; then ${sudo} kill "$ROLLBACK_PID" 2>/dev/null || true; fi; rm -f ${REMOTE_ROLLBACK_PID}; fi`,
      `if [ -f ${REMOTE_BACKUP} ]; then . ${REMOTE_BACKUP}; fi`,
      'DEFAULT_ROUTE="$(printf %s "${DEFAULT_ROUTE_B64:-}" | base64 -d 2>/dev/null || true)"',
      `if [ -n "$DEFAULT_ROUTE" ]; then ${sudo} ip route replace $DEFAULT_ROUTE; fi`,
      `if [ -n "$ENDPOINT_IP" ]; then ${sudo} ip route del "$ENDPOINT_IP"/32 2>/dev/null || true; fi`,
      `if [ -f ${REMOTE_FULL_PID} ]; then PID="$(cat ${REMOTE_FULL_PID} 2>/dev/null || true)"; if [ -n "$PID" ]; then ${sudo} kill "$PID" 2>/dev/null || true; fi; rm -f ${REMOTE_FULL_PID}; fi`,
      `${sudo} ip link delete sshclienttun0 2>/dev/null || true`,
      'printf "disabled\\n"'
    ].join('\n');

    await ssh.exec(command, {
      timeoutMs: 15000,
      redactedCommand: 'Disable remote VPN full routing',
      stdin: sudoInputFor(command, sudoPassword)
    });
    return fullRoutingStatus(ssh);
  }

  async function fullRoutingStatus(ssh) {
    const command = [
      'set +e',
      'RUNNING="no"',
      'ROLLBACK="no"',
      'ENDPOINT_IP=""',
      `if [ -f ${REMOTE_BACKUP} ]; then . ${REMOTE_BACKUP}; fi`,
      `if [ -f ${REMOTE_FULL_PID} ]; then PID="$(cat ${REMOTE_FULL_PID} 2>/dev/null || true)"; if [ -n "$PID" ] && ps -p "$PID" >/dev/null 2>&1; then RUNNING="yes"; fi; fi`,
      `if [ -f ${REMOTE_ROLLBACK_PID} ]; then ROLLBACK_PID="$(cat ${REMOTE_ROLLBACK_PID} 2>/dev/null || true)"; if [ -n "$ROLLBACK_PID" ] && ps -p "$ROLLBACK_PID" >/dev/null 2>&1; then ROLLBACK="yes"; fi; fi`,
      'TUN_LINK="$(ip link show sshclienttun0 2>/dev/null | head -n 1 || true)"',
      'DEFAULT_ROUTE="$(ip route show default 2>/dev/null | head -n 1 || true)"',
      'ENDPOINT_ROUTE=""',
      'if [ -n "$ENDPOINT_IP" ]; then ENDPOINT_ROUTE="$(ip route get "$ENDPOINT_IP" 2>/dev/null | head -n 1 || true)"; fi',
      'printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n" "$RUNNING" "$ROLLBACK" "$TUN_LINK" "$DEFAULT_ROUTE" "$ENDPOINT_IP" "$ENDPOINT_ROUTE"'
    ].join('\n');
    const result = await ssh.exec(command, { timeoutMs: 8000, redactedCommand: 'Check remote VPN full routing status' });
    const [running, rollbackPending, tunLink, defaultRoute, endpointIp, endpointRoute] = result.stdout.trim().split(/\r?\n/);
    return {
      running: running === 'yes',
      rollbackPending: rollbackPending === 'yes',
      rollbackSeconds: rollbackPending === 'yes' ? 60 : 0,
      tun: tunLink || '',
      defaultRoute: defaultRoute || '',
      endpointIp: endpointIp || '',
      endpointRoute: endpointRoute || '',
      mode: 'Remote server full routing'
    };
  }

  async function confirmFullRouting(ssh, sudoPassword) {
    if (!String(sudoPassword || '').trim()) throw new Error('Sudo password is required to confirm full routing.');
    const sudo = sudoPrefix();
    const command = [
      'set +e',
      `if [ -f ${REMOTE_ROLLBACK_PID} ]; then ROLLBACK_PID="$(cat ${REMOTE_ROLLBACK_PID} 2>/dev/null || true)"; if [ -n "$ROLLBACK_PID" ]; then ${sudo} kill "$ROLLBACK_PID" 2>/dev/null || true; fi; rm -f ${REMOTE_ROLLBACK_PID}; fi`,
      'printf "confirmed\\n"'
    ].join('\n');
    await ssh.exec(command, {
      timeoutMs: 8000,
      redactedCommand: 'Confirm remote VPN full routing',
      stdin: sudoInputFor(command, sudoPassword)
    });
    return fullRoutingStatus(ssh);
  }

  async function installBundled(ssh, onProgress = () => {}) {
    if (!fs.existsSync(bundledLinuxBinary)) {
      throw new Error(`Bundled Linux sing-box binary was not found: ${bundledLinuxBinary}`);
    }

    const preflight = [
      'set -e',
      'OS="$(uname -s 2>/dev/null || echo unknown)"',
      'ARCH="$(uname -m 2>/dev/null || echo unknown)"',
      'if [ "$OS" != "Linux" ]; then echo "Remote bundled install currently supports Linux only." >&2; exit 1; fi',
      'if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then echo "Bundled linux-amd64 engine does not match remote architecture: $ARCH" >&2; exit 1; fi',
      `mkdir -p ${REMOTE_BIN_DIR}`,
      'REMOTE_HOME="$(cd "$HOME" && pwd -P)"',
      'printf "ready\\n%s\\n" "$REMOTE_HOME"'
    ].join('\n');

    const preflightResult = await ssh.exec(preflight, {
      timeoutMs: 10000,
      redactedCommand: 'Prepare remote bundled sing-box install'
    });
    if (preflightResult.exitCode !== 0) {
      throw new Error((preflightResult.stderr || preflightResult.stdout || 'Could not prepare remote VPN installation.').trim());
    }

    if (typeof ssh.uploadFile !== 'function') {
      throw new Error('SFTP upload is not available for the active SSH session.');
    }

    const remoteHome = preflightResult.stdout.trim().split(/\r?\n/)[1];
    if (!remoteHome || !remoteHome.startsWith('/')) throw new Error('Could not determine the remote home directory.');

    const files = [{
      localPath: bundledLinuxBinary,
      remotePath: `${remoteHome}/.ssh-client-vpn/bin/sing-box`,
      mode: '700'
    }];
    if (fs.existsSync(bundledLinuxLibcronet)) {
      files.push({
        localPath: bundledLinuxLibcronet,
        remotePath: `${remoteHome}/.ssh-client-vpn/bin/libcronet.so`,
        mode: '600'
      });
    }

    const total = files.reduce((sum, file) => sum + fs.statSync(file.localPath).size, 0);
    let completed = 0;
    onProgress({ transferred: 0, total, percent: 0 });
    for (const file of files) {
      const size = fs.statSync(file.localPath).size;
      await ssh.uploadFile(file.localPath, file.remotePath, ({ transferred }) => {
        const overallTransferred = completed + Math.min(Number(transferred) || 0, size);
        onProgress({
          file: path.basename(file.localPath),
          transferred: overallTransferred,
          total,
          percent: Math.min(100, Math.round((overallTransferred / total) * 100))
        });
      });
      completed += size;
    }

    const chmodCommand = files.map((file) => `chmod ${file.mode} ${shellQuote(file.remotePath)}`).join(' && ');
    const chmodResult = await ssh.exec(chmodCommand, { timeoutMs: 10000, redactedCommand: 'Finalize remote bundled sing-box install' });
    if (chmodResult.exitCode !== 0) throw new Error((chmodResult.stderr || 'Could not finalize remote VPN installation.').trim());
    onProgress({ transferred: total, total, percent: 100 });

    const verify = [
      'set -e',
      `${REMOTE_BIN} version | head -n 1`
    ].join('\n');

    await ssh.exec(verify, {
      timeoutMs: 10000,
      redactedCommand: 'Verify remote bundled sing-box install'
    });
    return status(ssh);
  }

  return {
    status,
    installBundled,
    start,
    stop,
    configureCodexProxy,
    checkIp,
    logs,
    fullRoutingPreflight,
    enableFullRouting,
    disableFullRouting,
    fullRoutingStatus,
    confirmFullRouting,
    remoteDir: path.posix.normalize('~/.ssh-client-vpn')
  };
}

module.exports = { buildProxyEnvironmentCommand, createRemoteVpnManager };
