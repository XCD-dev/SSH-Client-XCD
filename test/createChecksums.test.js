const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('writes SHA-256 entries for release assets without reading whole files into memory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xcd-checksums-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const name = 'XCD SSH Client-2.0.0-arm64.dmg';
  const contents = Buffer.from('example release artifact');
  fs.writeFileSync(path.join(directory, name), contents);

  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/create-checksums.js'), directory], {
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8'),
    `${crypto.createHash('sha256').update(contents).digest('hex')}  ${name}\n`
  );
});
