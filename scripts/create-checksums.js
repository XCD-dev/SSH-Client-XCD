const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const directory = path.resolve(process.argv[2] || 'release');
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Artifact directory does not exist: ${directory}`);
  }

  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS.txt')
    .map((entry) => entry.name)
    .sort();
  if (!files.length) throw new Error(`No release files found in ${directory}`);

  const lines = [];
  for (const name of files) lines.push(`${await sha256(path.join(directory, name))}  ${name}`);
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
