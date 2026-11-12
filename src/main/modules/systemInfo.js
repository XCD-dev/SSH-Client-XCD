// How long each system-probe command may run. System discovery commands
// (especially PowerShell / CIM on Windows and system_profiler on macOS) can
// be slow on the first call, so these are deliberately generous - a probe
// that times out is what previously left every field showing "Not available".
const PROBE_TIMEOUT_MS = 12000;
const DETECT_TIMEOUT_MS = 8000;

async function execFirst(sshService, commands, timeoutMs = PROBE_TIMEOUT_MS) {
  for (const command of commands) {
    try {
      const result = await sshService.exec(command, { timeoutMs });
      if (result.exitCode !== 0) continue;
      const value = (result.stdout || '').trim();
      if (value) return value;
    } catch (_error) {
      // Try the next platform-specific command.
    }
  }

  return '';
}

// Runs a single probe command and returns its raw stdout (even on a non-zero
// exit code, so partial output from a script that had one failing sub-command
// is still usable).
async function execRaw(sshService, command, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const result = await sshService.exec(command, { timeoutMs });
    return (result.stdout || '').trim();
  } catch (_error) {
    return '';
  }
}

// Parses "KEY=value" lines (one per row) emitted by the combined probe
// scripts below into a plain object. Everything after the first "=" is the
// value, so values may themselves contain "=".
function parseKeyValues(stdout) {
  const map = {};
  String(stdout || '').split(/\r?\n/).forEach((line) => {
    const index = line.indexOf('=');
    if (index === -1) return;
    map[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  });
  return map;
}

function clean(value) {
  const text = String(value || '').trim();
  // A few probes can leave behind a stray unit with no number in front of it
  // (e.g. RAM came back as just "GB" because the size lookup failed). Treat
  // those as "not available" so the UI shows the honest fallback instead.
  if (!text || text === 'GB' || text === 'MB') return '';
  return text;
}

function parseOsRelease(text) {
  const values = {};
  text.split('\n').forEach((line) => {
    const index = line.indexOf('=');
    if (index === -1) return;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).replace(/^"|"$/g, '');
    values[key] = value;
  });
  return values;
}

async function detectPlatform(sshService) {
  const probe = await execFirst(sshService, [
    'uname -s',
    'powershell -NoProfile -Command "$PSVersionTable.OS"',
    'cmd /c ver',
    'cmd /c echo %OS%'
  ], DETECT_TIMEOUT_MS);

  const normalized = probe.toLowerCase();
  if (normalized.includes('darwin')) return 'macos';
  if (normalized.includes('linux')) return 'linux';
  if (normalized.includes('windows') || normalized.includes('microsoft')) return 'windows';
  return 'unknown';
}

// One self-contained shell script that gathers everything in a single SSH
// round-trip. Each field has several fallbacks (os-release -> lsb_release ->
// uname; lscpu -> /proc/cpuinfo; free -> /proc/meminfo; lsblk -> df; ...) so
// even a minimal server returns real data instead of blanks. A normalized
// PATH is exported up front because non-interactive SSH shells frequently
// start with a bare PATH that is missing /sbin and /usr/sbin, which is why
// tools like `lspci` / `lsblk` silently produced nothing before.
const LINUX_PROBE = [
  "export PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH\"",
  "DISTRO=\"\"; VER=\"\"",
  "if [ -r /etc/os-release ]; then . /etc/os-release; DISTRO=\"${PRETTY_NAME:-$NAME}\"; VER=\"${VERSION:-$VERSION_ID}\"; fi",
  "if [ -z \"$DISTRO\" ] && command -v lsb_release >/dev/null 2>&1; then DISTRO=$(lsb_release -ds 2>/dev/null | tr -d '\"'); fi",
  "if [ -z \"$DISTRO\" ]; then DISTRO=$(uname -o 2>/dev/null); fi",
  "KERNEL=$(uname -r 2>/dev/null)",
  "[ -z \"$VER\" ] && VER=\"$KERNEL\"",
  "CPU=\"\"",
  "if command -v lscpu >/dev/null 2>&1; then CPU=$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n1); fi",
  "[ -z \"$CPU\" ] && CPU=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n1)",
  "[ -z \"$CPU\" ] && CPU=$(sed -n 's/^Hardware[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n1)",
  "CORES=$(nproc 2>/dev/null)",
  "if [ -n \"$CPU\" ] && [ -n \"$CORES\" ]; then CPU=\"$CPU ($CORES vCPU)\"; fi",
  "[ -z \"$CPU\" ] && [ -n \"$CORES\" ] && CPU=\"$CORES vCPU\"",
  "RAM=\"\"",
  "if command -v free >/dev/null 2>&1; then RAM=$(free -h 2>/dev/null | awk '/^Mem:/{print $2}'); fi",
  "[ -z \"$RAM\" ] && RAM=$(awk '/MemTotal/{printf \"%.1f GB\", $2/1048576}' /proc/meminfo 2>/dev/null)",
  "GPU=\"\"",
  "if command -v lspci >/dev/null 2>&1; then GPU=$(lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -n1 | cut -d: -f3- | sed 's/^[[:space:]]*//'); fi",
  "STORAGE=\"\"",
  "if command -v lsblk >/dev/null 2>&1; then STORAGE=$(lsblk -dno NAME,SIZE,MODEL 2>/dev/null | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | head -n3 | paste -sd ';' -); fi",
  "[ -z \"$STORAGE\" ] && STORAGE=$(df -h / 2>/dev/null | awk 'NR==2{print $2\" total, \"$4\" free\"}')",
  "printf 'DISTRO=%s\\n' \"$DISTRO\"",
  "printf 'VER=%s\\n' \"$VER\"",
  "printf 'KERNEL=%s\\n' \"$KERNEL\"",
  "printf 'CPU=%s\\n' \"$CPU\"",
  "printf 'RAM=%s\\n' \"$RAM\"",
  "printf 'GPU=%s\\n' \"$GPU\"",
  "printf 'STORAGE=%s\\n' \"$STORAGE\""
].join('\n');

async function linuxInfo(sshService) {
  const map = parseKeyValues(await execRaw(sshService, LINUX_PROBE));

  // Fallback path if the combined script produced nothing at all (e.g. a very
  // locked-down shell): fetch the essentials the old way so we still show
  // something instead of an all-blank card.
  if (!map.DISTRO && !map.KERNEL && !map.CPU) {
    const osRelease = parseOsRelease(await execFirst(sshService, ['cat /etc/os-release']));
    const kernel = await execFirst(sshService, ['uname -r']);
    return {
      os: {
        os: 'Linux',
        version: osRelease.VERSION || osRelease.VERSION_ID || kernel || '',
        distribution: osRelease.PRETTY_NAME || osRelease.NAME || 'Linux',
        kernel
      },
      hardware: {
        cpu: await execFirst(sshService, ['sed -n "s/^model name[[:space:]]*:[[:space:]]*//p" /proc/cpuinfo | head -1']),
        ram: await execFirst(sshService, ['free -h | awk "/Mem:/ {print \\$2}"']),
        gpu: await execFirst(sshService, ['lspci | grep -Ei "vga|3d|display" | head -1']),
        storage: await execFirst(sshService, ['df -h / | awk "NR==2{print \\$2}"'])
      }
    };
  }

  return {
    os: {
      os: 'Linux',
      version: clean(map.VER) || clean(map.KERNEL),
      distribution: clean(map.DISTRO) || 'Linux',
      kernel: clean(map.KERNEL)
    },
    hardware: {
      cpu: clean(map.CPU),
      ram: clean(map.RAM),
      gpu: clean(map.GPU),
      storage: clean(map.STORAGE)
    }
  };
}

// Single PowerShell call that emits KEY=value lines. Uses single-quoted
// PowerShell strings and "+" concatenation throughout so the whole thing can
// be wrapped in the outer double quotes cmd.exe needs without any escaping
// conflicts. Errors are silenced so one missing CIM class doesn't abort the
// rest of the fields.
const WINDOWS_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$os=Get-CimInstance Win32_OperatingSystem',
  '$cs=Get-CimInstance Win32_ComputerSystem',
  '$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1',
  '$disk=Get-CimInstance Win32_DiskDrive | Select-Object -First 1',
  "Write-Output ('CAPTION=' + $os.Caption)",
  "Write-Output ('VERSION=' + $os.Version)",
  "Write-Output ('BUILD=' + $os.BuildNumber)",
  "Write-Output ('TYPE=' + $os.ProductType)",
  "Write-Output ('CPU=' + $cpu.Name)",
  "if ($cs.TotalPhysicalMemory) { Write-Output ('RAM=' + [math]::Round($cs.TotalPhysicalMemory/1GB,1) + ' GB') }",
  "Write-Output ('GPU=' + $gpu.Name)",
  "Write-Output ('STORAGE=' + $disk.Model)"
].join('; ');

async function windowsInfo(sshService) {
  const map = parseKeyValues(await execRaw(sshService, `powershell -NoProfile -Command "${WINDOWS_PS}"`));

  let cpu = clean(map.CPU);
  const ram = clean(map.RAM);
  let caption = clean(map.CAPTION);
  const version = clean(map.VERSION);

  // Fallback for boxes where PowerShell is missing/blocked (older Windows,
  // hardened OpenSSH-only installs): pull the same essentials via wmic.
  if (!cpu) {
    const wmicCpu = await execFirst(sshService, ['wmic cpu get Name /value']);
    cpu = clean((wmicCpu.split('=')[1] || '').trim());
  }
  if (!caption) {
    const wmicOs = await execFirst(sshService, ['wmic os get Caption /value']);
    caption = clean((wmicOs.split('=')[1] || '').trim());
  }

  const build = clean(map.BUILD);

  return {
    os: {
      os: 'Windows',
      version: caption || version || 'Windows',
      distribution: build ? `Build ${build}` : '',
      kernel: version || '',
      type: Number(map.TYPE) === 1 ? 'Desktop' : (map.TYPE ? 'Server' : '')
    },
    hardware: {
      cpu,
      ram,
      gpu: clean(map.GPU),
      storage: clean(map.STORAGE)
    }
  };
}

async function macosInfo(sshService) {
  const version = await execFirst(sshService, ['sw_vers -productVersion']);
  const productName = await execFirst(sshService, ['sw_vers -productName']);
  const model = await execFirst(sshService, [
    'system_profiler SPHardwareDataType | awk -F": " \'/Model Name/ {print $2; exit}\'',
    'sysctl -n hw.model'
  ]);
  const chip = await execFirst(sshService, [
    'sysctl -n machdep.cpu.brand_string',
    'system_profiler SPHardwareDataType | awk -F": " \'/Chip/ {print $2; exit}\''
  ]);
  const type = model.includes('MacBook Air') ? 'Air' : model.includes('MacBook Pro') ? 'Pro' : '';

  return {
    os: 'macOS',
    version,
    distribution: model,
    kernel: productName ? `${productName} ${version}`.trim() : '',
    type,
    chip
  };
}

async function macHardwareInfo(sshService) {
  return {
    cpu: await execFirst(sshService, ['sysctl -n machdep.cpu.brand_string']),
    ram: await execFirst(sshService, [
      'system_profiler SPHardwareDataType | awk -F": " \'/Memory/ {print $2}\'',
      'echo "$(( $(sysctl -n hw.memsize) / 1073741824 )) GB"'
    ]),
    gpu: await execFirst(sshService, ['system_profiler SPDisplaysDataType | awk -F": " \'/Chipset Model/ {print $2; exit}\'']),
    storage: await execFirst(sshService, ['diskutil info / | awk -F": *" \'/Device / {print $2; exit}\''])
  };
}

async function collectSystemInfo(sshService) {
  const platform = await detectPlatform(sshService);

  if (platform === 'windows') {
    return { platform, ...(await windowsInfo(sshService)) };
  }

  if (platform === 'macos') {
    const osInfo = await macosInfo(sshService);
    const hardware = await macHardwareInfo(sshService);
    return { platform, os: osInfo, hardware };
  }

  // Linux and any unknown/fallback platform are probed with the Linux script:
  // it degrades gracefully and, on a truly unknown POSIX-ish host, still tends
  // to surface a kernel string and CPU model rather than nothing.
  const linux = await linuxInfo(sshService);
  return { platform: platform === 'unknown' ? 'linux' : platform, os: linux.os, hardware: linux.hardware };
}

module.exports = { collectSystemInfo };
