const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const electronDirectory = path.dirname(require.resolve('electron/package.json'));
const electronPathFile = path.join(electronDirectory, 'path.txt');

function executablePathForPlatform(platform) {
  if (platform === 'darwin' || platform === 'mas') {
    return 'Electron.app/Contents/MacOS/Electron';
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return 'electron';
  }
  if (platform === 'win32') {
    return 'electron.exe';
  }
  throw new Error(`Electron is not available for platform: ${platform}`);
}

async function repairElectron() {
  const { downloadArtifact } = require(require.resolve('@electron/get', { paths: [electronDirectory] }));
  const extractModule = await import(require.resolve('@electron-internal/extract-zip', { paths: [electronDirectory] }));
  const extract = extractModule.extract || extractModule.default;
  const electronPackage = require('electron/package.json');
  const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
  const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
  const executablePath = executablePathForPlatform(platform);

  console.log('Electron binary is missing. Attempting to repair the installation...');

  const archivePath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    platform,
    arch,
    checksums: require('electron/checksums.json')
  });

  await extract(archivePath, { dir: path.join(electronDirectory, 'dist') });
  await fs.promises.writeFile(electronPathFile, executablePath);
}

async function main() {
  if (!fs.existsSync(electronPathFile)) {
    try {
      await repairElectron();
    } catch (error) {
      console.error('');
      console.error('Electron could not be downloaded.');
      console.error(error && error.message ? error.message : error);
      console.error('Check the internet connection, then run: npm start');
      process.exit(1);
    }
  }

  const electronPath = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env
  });

  child.on('error', (error) => {
    console.error(`Could not start Electron: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}

main();
