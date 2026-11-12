const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fileManager = require('../src/main/modules/fileManager');

function missingPathError() {
  const error = new Error('No such file');
  error.code = 2;
  return error;
}

function createSshService(sftp) {
  return {
    async getSftp() { return sftp; },
    async exec() { return { stdout: '/home/tester\n', stderr: '', exitCode: 0 }; }
  };
}

test('does not follow local symlinks while uploading a folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-sftp-local-'));
  const target = path.join(root, 'outside.txt');
  const folder = path.join(root, 'upload');
  fs.writeFileSync(target, 'private data');
  fs.mkdirSync(folder);
  fs.symlinkSync(target, path.join(folder, 'linked.txt'));
  const uploaded = [];
  const sftp = {
    lstat(_remotePath, callback) { callback(missingPathError()); },
    mkdir(_remotePath, callback) { callback(null); },
    fastPut(localPath, remotePath, _options, callback) {
      uploaded.push({ localPath, remotePath });
      callback(null);
    }
  };

  try {
    const result = await fileManager.uploadItems(createSshService(sftp), {
      sessionId: 'session-1', directory: '/uploads', paths: [folder]
    });

    assert.equal(result.uploaded, 0);
    assert.match(result.errors[0].message, /Symbolic links are not uploaded/);
    assert.deepEqual(uploaded, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not overwrite a remote symbolic link during upload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-sftp-remote-'));
  const source = path.join(root, 'file.txt');
  fs.writeFileSync(source, 'safe content');
  const uploaded = [];
  const sftp = {
    lstat(_remotePath, callback) {
      callback(null, { isSymbolicLink: () => true, isDirectory: () => false });
    },
    fastPut(localPath, remotePath, _options, callback) {
      uploaded.push({ localPath, remotePath });
      callback(null);
    }
  };

  try {
    const result = await fileManager.uploadItems(createSshService(sftp), {
      sessionId: 'session-1', directory: '/uploads', paths: [source]
    });

    assert.equal(result.uploaded, 0);
    assert.match(result.errors[0].message, /remote symbolic link/);
    assert.deepEqual(uploaded, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not treat SFTP connection errors as a missing destination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-sftp-error-'));
  const source = path.join(root, 'file.txt');
  fs.writeFileSync(source, 'safe content');
  const sftp = {
    lstat(_remotePath, callback) { callback(new Error('SFTP connection reset')); },
    fastPut(_localPath, _remotePath, _options, callback) { callback(null); }
  };

  try {
    const result = await fileManager.uploadItems(createSshService(sftp), {
      sessionId: 'session-1', directory: '/uploads', paths: [source]
    });

    assert.equal(result.uploaded, 0);
    assert.equal(result.errors[0].message, 'SFTP connection reset');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
