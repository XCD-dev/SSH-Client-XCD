const fs = require('fs');
const path = require('path');

const CONFIG_FILES = [
  'servers.json',
  'known-hosts.json',
  'vpn-profiles.json',
  'bots.json'
];

function migrateUserData({ appDataPath, userDataPath, legacyDirectoryNames }) {
  const destination = path.resolve(userDataPath);
  const copied = [];

  for (const directoryName of legacyDirectoryNames) {
    const sourceDirectory = path.resolve(appDataPath, directoryName);
    if (sourceDirectory === destination || !fs.existsSync(sourceDirectory)) continue;

    for (const fileName of CONFIG_FILES) {
      const sourcePath = path.join(sourceDirectory, fileName);
      const destinationPath = path.join(destination, fileName);
      if (fs.existsSync(destinationPath)) continue;

      let sourceStat;
      try {
        sourceStat = fs.lstatSync(sourcePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;

      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destinationPath, 0o600);
      copied.push(fileName);
    }
  }

  return copied;
}

module.exports = { migrateUserData };
