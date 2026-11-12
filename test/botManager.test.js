const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBotManager } = require('../src/main/modules/botManager');

function createManager(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-client-bot-manager-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'bots.json');
  return { manager: createBotManager(storagePath), storagePath };
}

test('starts a bot before persisting it and derives a usable process pattern', async (t) => {
  const { manager, storagePath } = createManager(t);
  const commands = [];
  const ssh = {
    exec: async (command, options) => {
      commands.push({ command, stdin: options && options.stdin });
      return command.includes('pgrep')
        ? { stdout: '4242 python3 main.py\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    }
  };

  const result = await manager.addAndStart(ssh, {
    host: 'server.example.com',
    name: 'Alerts',
    startCommand: 'cd /srv/alerts && nohup python3 main.py > bot.log 2>&1 & disown',
    matchPattern: '',
    envPrefix: 'export ALL_PROXY=socks5://127.0.0.1:2080; '
  });

  assert.equal(result.running, true);
  const [bot] = manager.getBots('server.example.com');
  assert.equal(bot.name, 'Alerts');
  assert.equal(bot.matchPattern, 'python3 main.py');
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).bots.length, 1);
  assert.match(commands[0].command, /^export ALL_PROXY=/);
  assert.match(commands[0].command, /nohup python3 main\.py/);
});

test('does not persist a bot when its start command fails', async (t) => {
  const { manager } = createManager(t);
  const ssh = { exec: async () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }) };

  await assert.rejects(
    manager.addAndStart(ssh, {
      host: 'server.example.com',
      name: 'Broken',
      startCommand: '/srv/broken/start.sh',
      matchPattern: 'broken/start.sh',
      envPrefix: ''
    }),
    /permission denied/
  );
  assert.deepEqual(manager.getBots('server.example.com'), []);
});

test('builds a bounded tail command for a relative redirected log', async (t) => {
  const { manager } = createManager(t);
  const ssh = {
    exec: async (command) => command.includes('pgrep')
      ? { stdout: '99 python3 worker.py\n', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 }
  };
  await manager.addAndStart(ssh, {
    host: 'server.example.com',
    name: 'Worker',
    startCommand: 'cd /srv/worker && nohup python3 worker.py >> logs/worker.log 2>&1 &',
    matchPattern: '',
    envPrefix: ''
  });
  const bot = manager.getBots('server.example.com')[0];

  assert.equal(manager.buildTailCommand(bot.id, 5000), "tail -n 2000 -F -- '/srv/worker/logs/worker.log'");
});

test('creates a persistent systemd bot from a remote folder with SOCKS5 and crash restart', async (t) => {
  const { manager, storagePath } = createManager(t);
  const commands = [];
  const ssh = {
    exec: async (command, options) => {
      commands.push({ command, stdin: options && options.stdin });
      if (command.includes('loginctl show-user')) return { stdout: 'yes\n', stderr: '', exitCode: 0 };
      if (command.includes('systemctl --user show')) return {
        stdout: 'ActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=0\n', stderr: '', exitCode: 0
      };
      if (command.includes('curl') && command.includes('socks5h://')) return { stdout: '50.7.88.194\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  };

  const result = await manager.addAndStart(ssh, {
    host: 'server.example.com',
    name: 'Alerts',
    mode: 'systemd',
    workingDirectory: '/srv/alerts',
    startCommand: '.venv/bin/python main.py',
    sudoPassword: ''
  });

  assert.equal(result.running, true);
  const [bot] = manager.getBots('server.example.com');
  assert.equal(bot.mode, 'systemd');
  assert.equal(bot.workingDirectory, '/srv/alerts');
  assert.equal(bot.proxy, 'socks5h://127.0.0.1:2080');
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).bots.length, 1);
  assert.ok(commands.some(({ command }) => command === "test -d '/srv/alerts'"));
  assert.ok(commands.some(({ command }) => command.includes('curl') && command.includes('socks5h://127.0.0.1:2080')));
  assert.ok(commands.some(({ stdin }) => String(stdin).includes('Restart=on-failure') && String(stdin).includes('socks5h://127.0.0.1:2080')));
  assert.ok(commands.some(({ command }) => command.includes('systemctl --user enable --now')));
  assert.ok(commands.some(({ command }) => command.includes('systemctl --user daemon-reload') && !command.includes('daemon-reload ssh-client-')));
  assert.match(manager.buildTailCommand(bot.id), /journalctl --user -u/);

  await manager.restartBot(ssh, bot.id);
  await manager.stopBot(ssh, bot.id);
  assert.ok(commands.some(({ command }) => command.includes('systemctl --user restart')));
  assert.ok(commands.some(({ command }) => command.includes('systemctl --user stop')));
});

test('refuses a systemd bot when SOCKS5 egress is unavailable', async (t) => {
  const { manager } = createManager(t);
  const commands = [];
  const ssh = { exec: async (command) => {
    commands.push(command);
    if (command.includes('curl') && command.includes('socks5h://')) return { stdout: '', stderr: 'connection refused', exitCode: 7 };
    return { stdout: '', stderr: '', exitCode: 0 };
  } };

  await assert.rejects(manager.addAndStart(ssh, {
    host: 'server.example.com', name: 'Alerts', mode: 'systemd',
    workingDirectory: '/srv/alerts', startCommand: 'python3 main.py'
  }), /SOCKS5/);
  assert.deepEqual(manager.getBots('server.example.com'), []);
  assert.ok(!commands.some((command) => command.includes('systemctl --user enable --now')));
});

test('cleans up a systemd service that fails to start and does not save sudo credentials', async (t) => {
  const { manager, storagePath } = createManager(t);
  const calls = [];
  let lingerChecks = 0;
  const ssh = { exec: async (command, options = {}) => {
    calls.push({ command, stdin: options.stdin });
    if (command.includes('loginctl show-user')) return { stdout: `${++lingerChecks > 1 ? 'yes' : 'no'}\n`, exitCode: 0 };
    if (command.includes('loginctl enable-linger') && !command.includes('sudo')) return { stderr: 'permission denied', exitCode: 1 };
    if (command.includes('curl') && command.includes('socks5h://')) return { stdout: '50.7.88.194\n', exitCode: 0 };
    if (command.includes('systemctl --user show')) return { stdout: 'ActiveState=failed\nSubState=failed\nMainPID=0\n', exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  } };

  await assert.rejects(manager.addAndStart(ssh, {
    host: 'server.example.com', name: 'Alerts', mode: 'systemd',
    workingDirectory: '/srv/alerts', startCommand: 'python3 main.py', sudoPassword: 'test-secret'
  }), /did not stay running/);
  assert.deepEqual(manager.getBots('server.example.com'), []);
  assert.ok(calls.some(({ command, stdin }) => command.includes('sudo -S') && stdin === 'test-secret\n'));
  assert.ok(calls.every(({ command }) => !command.includes('test-secret')));
  assert.ok(calls.some(({ command }) => command.includes('systemctl --user disable --now')));
  assert.ok(calls.some(({ command }) => command.includes('rm -f --')));
  if (fs.existsSync(storagePath)) assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /test-secret/);
});
