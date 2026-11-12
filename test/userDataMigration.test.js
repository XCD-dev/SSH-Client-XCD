const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { migrateUserData } = require('../src/main/modules/userDataMigration');

test('copies known legacy settings into the branded user data directory without replacing files', () => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-migration-'));
  const oldDirectory = path.join(appDataPath, 'Desktop SSH Client');
  const newDirectory = path.join(appDataPath, 'XCD SSH Client');
  fs.mkdirSync(oldDirectory);
  fs.writeFileSync(path.join(oldDirectory, 'servers.json'), '{"servers":[]}');
  fs.writeFileSync(path.join(oldDirectory, 'vpn-profiles.json'), '{"profiles":[]}');
  fs.mkdirSync(newDirectory);
  fs.writeFileSync(path.join(newDirectory, 'servers.json'), '{"servers":["new"]}');
  fs.writeFileSync(path.join(oldDirectory, 'unrelated.txt'), 'leave this file behind');

  try {
    const copied = migrateUserData({
      appDataPath,
      userDataPath: newDirectory,
      legacyDirectoryNames: ['desktop-ssh-client', 'Desktop SSH Client']
    });

    assert.deepEqual(copied, ['vpn-profiles.json']);
    assert.equal(fs.readFileSync(path.join(newDirectory, 'servers.json'), 'utf8'), '{"servers":["new"]}');
    assert.equal(fs.readFileSync(path.join(newDirectory, 'vpn-profiles.json'), 'utf8'), '{"profiles":[]}');
    assert.equal(fs.existsSync(path.join(newDirectory, 'unrelated.txt')), false);
  } finally {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  }
});

test('does not follow symlinked legacy configuration files', () => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-migration-link-'));
  const oldDirectory = path.join(appDataPath, 'desktop-ssh-client');
  const newDirectory = path.join(appDataPath, 'XCD SSH Client');
  const target = path.join(appDataPath, 'outside.json');
  fs.mkdirSync(oldDirectory);
  fs.writeFileSync(target, '{"private":"value"}');
  fs.symlinkSync(target, path.join(oldDirectory, 'vpn-profiles.json'));

  try {
    const copied = migrateUserData({
      appDataPath,
      userDataPath: newDirectory,
      legacyDirectoryNames: ['desktop-ssh-client']
    });

    assert.deepEqual(copied, []);
    assert.equal(fs.existsSync(path.join(newDirectory, 'vpn-profiles.json')), false);
  } finally {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  }
});
