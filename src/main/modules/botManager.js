const fs = require('fs');
const net = require('net');
const path = require('path');
const SOCKS_PROXY = 'socks5h://127.0.0.1:2080';

function now() {
  return new Date().toISOString();
}

function createId() {
  return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function inferProcessPattern(startCommand) {
  let command = String(startCommand || '').trim();
  const segments = command.split(/\s*&&\s*/);
  command = segments[segments.length - 1] || command;
  command = command.replace(/^nohup\s+/, '');
  command = command.replace(/\s+(?:[12]?>|[12]?>>)\s*(?:&\d+|[^\s;&]+).*$/, '');
  command = command.replace(/\s*&\s*(?:disown)?\s*$/, '').trim();
  return command || String(startCommand || '').trim();
}

function publicBot(bot) {
  return {
    id: bot.id,
    host: bot.host,
    name: bot.name,
    startCommand: bot.startCommand,
    matchPattern: bot.matchPattern,
    mode: bot.mode || 'command',
    workingDirectory: bot.workingDirectory || '',
    proxy: bot.mode === 'systemd' ? SOCKS_PROXY : '',
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt
  };
}

function serviceName(bot) {
  if (!/^bot-[a-z0-9-]+$/.test(bot.id)) throw new Error('Invalid bot id.');
  return `ssh-client-${bot.id}.service`;
}

function userSystemctl(action, bot) {
  return `XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" systemctl --user ${action}${action === 'daemon-reload' ? '' : ` ${serviceName(bot)}`}`;
}

function systemdFiles(bot) {
  const unit = serviceName(bot);
  return {
    script: `"$HOME/.local/share/ssh-client/bots/${bot.id}/run.sh"`,
    scriptDir: `"$HOME/.local/share/ssh-client/bots/${bot.id}"`,
    unit: `"$HOME/.config/systemd/user/${unit}"`
  };
}

function serviceScript(bot) {
  return `#!/bin/sh\ncd ${shellQuote(bot.workingDirectory)} || exit 1\nexec /bin/sh -c ${shellQuote(bot.startCommand)}\n`;
}

function serviceUnit(bot) {
  const description = bot.name.replace(/[\x00-\x1f\x7f%]/g, ' ');
  return [
    '[Unit]',
    `Description=XCD SSH Client bot ${description}`,
    'Wants=network-online.target',
    'After=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `Environment=HTTP_PROXY=${SOCKS_PROXY}`,
    `Environment=HTTPS_PROXY=${SOCKS_PROXY}`,
    `Environment=ALL_PROXY=${SOCKS_PROXY}`,
    `Environment=http_proxy=${SOCKS_PROXY}`,
    `Environment=https_proxy=${SOCKS_PROXY}`,
    `Environment=all_proxy=${SOCKS_PROXY}`,
    'Environment=NO_PROXY=localhost,127.0.0.1',
    'Environment=no_proxy=localhost,127.0.0.1',
    `ExecStartPre=/usr/bin/env curl --fail --silent --show-error --max-time 12 --output /dev/null --proxy ${SOCKS_PROXY} https://api.ipify.org`,
    `ExecStart=/bin/sh %h/.local/share/ssh-client/bots/${bot.id}/run.sh`,
    'Restart=on-failure',
    'RestartSec=5s',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function ensureCommandSuccess(result, fallback) {
  if (!result || result.exitCode !== 0) {
    throw new Error(String(result && (result.stderr || result.stdout) || fallback).trim());
  }
}

function createBotManager(storagePath) {
  function readStore() {
    try {
      if (!fs.existsSync(storagePath)) return { bots: [] };
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      return { bots: Array.isArray(parsed.bots) ? parsed.bots : [] };
    } catch (_error) {
      return { bots: [] };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  function findBot(store, botId) {
    const bot = store.bots.find((item) => item.id === botId);
    if (!bot) throw new Error('Bot was not found.');
    return bot;
  }

  function getBots(host) {
    return readStore().bots
      .filter((bot) => bot.host === host)
      .map(publicBot)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async function statusForBot(ssh, bot) {
    if (bot.mode === 'systemd') {
      const result = await ssh.exec(userSystemctl('show -p ActiveState -p SubState -p MainPID -p NRestarts -p Result', bot), {
        timeoutMs: 8000,
        redactedCommand: `Check bot service: ${bot.name}`
      });
      ensureCommandSuccess(result, 'Could not read bot service status.');
      const properties = Object.fromEntries(String(result.stdout || '').split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      return {
        running: properties.ActiveState === 'active',
        pid: properties.MainPID && properties.MainPID !== '0' ? properties.MainPID : '',
        command: bot.startCommand,
        activeState: properties.ActiveState || 'unknown',
        subState: properties.SubState || '',
        restarts: Number(properties.NRestarts) || 0,
        result: properties.Result || '',
        checkedAt: now()
      };
    }
    const command = `pgrep -af -- ${shellQuote(bot.matchPattern)} | grep -v '[p]grep -af' | head -n 1`;
    const result = await ssh.exec(command, { timeoutMs: 8000, redactedCommand: `Check bot status: ${bot.name}` });
    const line = String(result.stdout || '').trim().split(/\r?\n/)[0] || '';
    const match = line.match(/^(\d+)\s*(.*)$/);
    return {
      running: Boolean(match),
      pid: match ? match[1] : '',
      command: match ? match[2] : '',
      checkedAt: now()
    };
  }

  async function execChecked(ssh, command, label, options = {}) {
    const result = await ssh.exec(command, { timeoutMs: 15000, redactedCommand: label, ...options });
    ensureCommandSuccess(result, `${label} failed.`);
    return result;
  }

  async function ensureUserServiceManager(ssh, sudoPassword) {
    const tools = await ssh.exec('command -v systemctl && command -v loginctl && command -v curl', {
      timeoutMs: 8000, redactedCommand: 'Check server bot service dependencies'
    });
    ensureCommandSuccess(tools, 'systemd, loginctl, and curl are required on the server.');

    const linger = await execChecked(ssh, 'loginctl show-user "$(id -un)" -p Linger --value', 'Check user service persistence');
    if (String(linger.stdout).trim() !== 'yes') {
      const direct = await ssh.exec('loginctl enable-linger "$(id -un)"', {
        timeoutMs: 8000, redactedCommand: 'Enable persistent user services'
      });
      if (direct.exitCode !== 0) {
        if (!sudoPassword) throw new Error('Server sudo password is required to enable persistent user services.');
        await execChecked(ssh, 'sudo -S -p "" loginctl enable-linger "$(id -un)"',
          'Enable persistent user services with sudo', { stdin: `${sudoPassword}\n` });
      }
      const verified = await execChecked(ssh, 'loginctl show-user "$(id -un)" -p Linger --value', 'Verify user service persistence');
      if (String(verified.stdout).trim() !== 'yes') throw new Error('Could not enable persistent user services.');
    }
  }

  async function checkSocksProxy(ssh) {
    const result = await ssh.exec(
      `curl --fail --silent --show-error --max-time 12 --noproxy '' --proxy ${SOCKS_PROXY} https://api.ipify.org`,
      { timeoutMs: 15000, redactedCommand: 'Check server SOCKS5 VPN egress' }
    );
    const ip = String(result.stdout || '').trim();
    if (result.exitCode !== 0 || !net.isIP(ip)) {
      throw new Error(`SOCKS5 VPN proxy is not working on the server: ${String(result.stderr || 'no public IP returned').trim()}`);
    }
    return ip;
  }

  async function removeSystemdFiles(ssh, bot, { incompleteInstall = false } = {}) {
    const files = systemdFiles(bot);
    if (incompleteInstall) {
      await ssh.exec(userSystemctl('disable --now', bot), {
        timeoutMs: 15000, redactedCommand: `Stop incomplete bot service: ${bot.name}`
      });
    } else {
      await execChecked(ssh, userSystemctl('disable --now', bot), `Stop and disable bot service: ${bot.name}`);
    }
    await execChecked(ssh, `rm -f -- ${files.unit} ${files.script} && (rmdir -- ${files.scriptDir} 2>/dev/null || true)`,
      `Remove bot service files: ${bot.name}`);
    await execChecked(ssh, userSystemctl('daemon-reload', bot), `Reload bot services: ${bot.name}`);
  }

  async function installSystemdBot(ssh, bot, sudoPassword) {
    const directoryCheck = await ssh.exec(`test -d ${shellQuote(bot.workingDirectory)}`, {
      timeoutMs: 8000, redactedCommand: `Check bot folder: ${bot.name}`
    });
    if (directoryCheck.exitCode !== 0) throw new Error(`Bot folder does not exist on the server: ${bot.workingDirectory}`);
    await checkSocksProxy(ssh);
    await ensureUserServiceManager(ssh, sudoPassword);

    const files = systemdFiles(bot);
    try {
      await execChecked(ssh, `mkdir -p -- ${files.scriptDir} "$HOME/.config/systemd/user" && umask 077 && cat > ${files.script} && chmod 700 ${files.script}`,
        `Install bot launcher: ${bot.name}`, { stdin: serviceScript(bot) });
      await execChecked(ssh, `umask 077 && cat > ${files.unit} && chmod 600 ${files.unit}`,
        `Install bot service: ${bot.name}`, { stdin: serviceUnit(bot) });
      await execChecked(ssh, userSystemctl('daemon-reload', bot), `Reload bot services: ${bot.name}`);
      await execChecked(ssh, userSystemctl('enable --now', bot), `Enable and start bot service: ${bot.name}`);
      await execChecked(ssh, 'sleep 1', `Wait for bot startup: ${bot.name}`, { timeoutMs: 3000 });
      const status = await statusForBot(ssh, bot);
      if (!status.running) throw new Error(`Bot service did not stay running (${status.activeState}/${status.subState}). Check the folder and foreground command.`);
      return status;
    } catch (error) {
      try { await removeSystemdFiles(ssh, bot, { incompleteInstall: true }); }
      catch (cleanupError) { error.message += ` Cleanup also failed: ${cleanupError.message}`; }
      throw error;
    }
  }

  async function runStart(ssh, bot, envPrefix) {
    const result = await ssh.exec(`${envPrefix || ''}${bot.startCommand}`, {
      timeoutMs: 15000,
      redactedCommand: `Start bot: ${bot.name}`
    });
    ensureCommandSuccess(result, 'Bot start command failed.');
    const status = await statusForBot(ssh, bot);
    if (!status.running) {
      throw new Error(`Bot process did not start. Check the command and match pattern: ${bot.matchPattern}`);
    }
    return status;
  }

  async function addAndStart(ssh, { host, name, startCommand, matchPattern, envPrefix, mode, workingDirectory, sudoPassword }) {
    const cleanHost = String(host || '').trim();
    const cleanName = String(name || '').trim();
    const cleanCommand = String(startCommand || '').trim();
    if (!cleanHost || !cleanName || !cleanCommand) {
      throw new Error('Bot host, name, and start command are required.');
    }
    if (mode === 'systemd') {
      const folder = String(workingDirectory || '').trim();
      if (!path.posix.isAbsolute(folder) || /[\r\n\0]/.test(folder)) {
        throw new Error('Enter an absolute bot folder path on the server.');
      }
      if (/[\0\r]/.test(cleanCommand) || /(?:^|\s)nohup\s|\bdisown\b|&\s*$/.test(cleanCommand)) {
        throw new Error('Use a foreground start command without nohup, disown, or a trailing &.');
      }
      const timestamp = now();
      const bot = {
        id: createId(), host: cleanHost, name: cleanName, mode: 'systemd',
        workingDirectory: folder, startCommand: cleanCommand, matchPattern: '',
        createdAt: timestamp, updatedAt: timestamp
      };
      const status = await installSystemdBot(ssh, bot, sudoPassword);
      const store = readStore();
      store.bots.push(bot);
      try { writeStore(store); }
      catch (error) {
        try { await removeSystemdFiles(ssh, bot); }
        catch (cleanupError) { error.message += ` Cleanup also failed: ${cleanupError.message}`; }
        throw error;
      }
      return { ...publicBot(bot), ...status };
    }
    const timestamp = now();
    const bot = {
      id: createId(),
      host: cleanHost,
      name: cleanName,
      startCommand: cleanCommand,
      matchPattern: String(matchPattern || '').trim() || inferProcessPattern(cleanCommand),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const status = await runStart(ssh, bot, envPrefix);
    const store = readStore();
    store.bots.push(bot);
    writeStore(store);
    return { ...publicBot(bot), ...status };
  }

  async function checkStatus(ssh, botId) {
    return statusForBot(ssh, findBot(readStore(), botId));
  }

  async function startBot(ssh, botId, envPrefix) {
    const store = readStore();
    const bot = findBot(store, botId);
    if (bot.mode === 'systemd') {
      await execChecked(ssh, userSystemctl('start', bot), `Start bot service: ${bot.name}`);
      const status = await statusForBot(ssh, bot);
      bot.updatedAt = now();
      writeStore(store);
      return status;
    }
    const status = await runStart(ssh, bot, envPrefix);
    bot.updatedAt = now();
    writeStore(store);
    return status;
  }

  async function stopBot(ssh, botId) {
    const bot = findBot(readStore(), botId);
    if (bot.mode === 'systemd') {
      await execChecked(ssh, userSystemctl('stop', bot), `Stop bot service: ${bot.name}`);
      return statusForBot(ssh, bot);
    }
    const status = await statusForBot(ssh, bot);
    if (status.running) {
      const result = await ssh.exec(`pkill -TERM -f -- ${shellQuote(bot.matchPattern)} || true`, {
        timeoutMs: 8000,
        redactedCommand: `Stop bot: ${bot.name}`
      });
      if (result && result.exitCode !== 0) ensureCommandSuccess(result, 'Bot stop command failed.');
    }
    return statusForBot(ssh, bot);
  }

  async function restartBot(ssh, botId, envPrefix) {
    const bot = findBot(readStore(), botId);
    if (bot.mode === 'systemd') {
      await execChecked(ssh, userSystemctl('restart', bot), `Restart bot service: ${bot.name}`);
      return statusForBot(ssh, bot);
    }
    await stopBot(ssh, botId);
    return startBot(ssh, botId, envPrefix);
  }

  async function deleteBot(ssh, botId) {
    const store = readStore();
    const bot = findBot(store, botId);
    if (bot.mode === 'systemd') {
      if (!ssh) throw new Error('Connect to the server to remove the bot service.');
      await removeSystemdFiles(ssh, bot);
    } else if (ssh) await stopBot(ssh, botId);
    writeStore({ bots: store.bots.filter((bot) => bot.id !== botId) });
    return { ok: true };
  }

  function measureLatency(host, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const socket = net.createConnection({ host, port: Number(port) });
      let settled = false;
      const finish = (latencyMs) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ latencyMs, checkedAt: now() });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(Date.now() - startedAt));
      socket.once('timeout', () => finish(null));
      socket.once('error', () => finish(null));
    });
  }

  function buildTailCommand(botId, lines = 200) {
    const bot = findBot(readStore(), botId);
    const safeLines = Math.min(2000, Math.max(1, Number.parseInt(lines, 10) || 200));
    if (bot.mode === 'systemd') {
      return `XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" journalctl --user -u ${serviceName(bot)} -n ${safeLines} -f --no-pager -o cat`;
    }
    const command = bot.startCommand;
    const redirectPattern = /(?:^|\s)([12]?)(>>?)\s*(?!&)(?:"([^"]+)"|'([^']+)'|([^\s;&]+))/g;
    let match;
    let logPath = '';
    while ((match = redirectPattern.exec(command))) {
      if (match[1] === '2') continue;
      const candidate = match[3] || match[4] || match[5] || '';
      if (candidate && candidate !== '/dev/null') {
        logPath = candidate;
        break;
      }
    }
    if (!logPath) return '';

    if (!path.posix.isAbsolute(logPath)) {
      const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&/);
      const workingDirectory = cdMatch && (cdMatch[1] || cdMatch[2] || cdMatch[3]);
      if (workingDirectory) logPath = path.posix.join(workingDirectory, logPath);
    }
    return `tail -n ${safeLines} -F -- ${shellQuote(logPath)}`;
  }

  return {
    getBots,
    addAndStart,
    checkStatus,
    measureLatency,
    startBot,
    stopBot,
    restartBot,
    deleteBot,
    buildTailCommand
  };
}

module.exports = { createBotManager };
