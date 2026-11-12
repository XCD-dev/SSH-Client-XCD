const SAFE_PACKAGE_NAME = /^[a-zA-Z0-9_.+:-]+$/;

function assertPackageName(name) {
  if (!name || !SAFE_PACKAGE_NAME.test(name)) {
    throw new Error('Invalid package name.');
  }
}

function buildPackageCommand({ action, packageName }) {
  if (action === 'update') {
    return 'if command -v apt >/dev/null 2>&1; then sudo -n apt update && sudo -n apt upgrade -y; elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -Syu --noconfirm; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf upgrade -y; elif command -v yum >/dev/null 2>&1; then sudo -n yum update -y; else echo "Unsupported package manager"; exit 1; fi';
  }

  if (action === 'install-base') {
    return 'if command -v apt >/dev/null 2>&1; then sudo -n apt install -y curl wget git htop unzip; elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --noconfirm curl wget git htop unzip; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y curl wget git htop unzip; elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y curl wget git htop unzip; else echo "Unsupported package manager"; exit 1; fi';
  }

  if (action === 'remove') {
    assertPackageName(packageName);
    return `if command -v apt >/dev/null 2>&1; then sudo -n apt remove -y ${packageName}; elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -R --noconfirm ${packageName}; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf remove -y ${packageName}; elif command -v yum >/dev/null 2>&1; then sudo -n yum remove -y ${packageName}; else echo "Unsupported package manager"; exit 1; fi`;
  }

  throw new Error('Unknown package action.');
}

module.exports = { buildPackageCommand };
