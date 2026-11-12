const fs = require('fs');
const path = require('path');

function shellQuote(value) {
  return `'${String(value || '.').replace(/'/g, `'\\''`)}'`;
}

function assertItemName(name) {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid file or folder name.');
  }
}

function assertPath(path) {
  if (!path) {
    throw new Error('Path is required.');
  }
}

function ensureSuccess(result, fallbackMessage) {
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || fallbackMessage).trim());
  }
}

function itemPath(directory, name) {
  const base = directory || '.';
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function parseDirectoryList(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  const currentPath = lines.shift() || '/';

  const items = lines.map((line) => {
    const [kind, name, size, modified] = line.split('\t');
    return {
      name,
      type: kind === 'd' ? 'directory' : 'file',
      size: Number(size) || 0,
      modified: modified || ''
    };
  }).filter((item) => item.name);

  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  return { path: currentPath, items };
}

async function listDirectory(sshService, path = '.') {
  const command = [
    `target=${shellQuote(path)}`,
    'cd -- "$target" || exit 1',
    'pwd -P',
    'if find . -mindepth 1 -maxdepth 1 -printf "" >/dev/null 2>&1; then',
    '  find . -mindepth 1 -maxdepth 1 -printf "%y\\t%f\\t%s\\t%TY-%Tm-%Td %TH:%TM\\n"',
    'else',
    '  for item in ./* ./.[!.]* ./..?*; do',
    '    [ -e "$item" ] || continue',
    '    [ -d "$item" ] && kind=d || kind=f',
    '    name=${item#./}',
    '    size=$(wc -c < "$item" 2>/dev/null || echo 0)',
    '    printf "%s\\t%s\\t%s\\t\\n" "$kind" "$name" "$size"',
    '  done',
    'fi'
  ].join('\n');

  const result = await sshService.exec(command, { timeoutMs: 15000 });
  ensureSuccess(result, 'Could not list directory.');
  return parseDirectoryList(result.stdout);
}

async function openFile(sshService, path) {
  assertPath(path);
  const command = [
    `target=${shellQuote(path)}`,
    '[ -f "$target" ] || { echo "Not a regular file"; exit 1; }',
    'size=$(wc -c < "$target" 2>/dev/null) || exit 1',
    '[ "$size" -le 262144 ] || { echo "File is too large to preview. Limit is 256 KB."; exit 1; }',
    'cat -- "$target"'
  ].join('\n');
  const result = await sshService.exec(command, { timeoutMs: 15000 });
  ensureSuccess(result, 'Could not open file.');
  return { path, content: result.stdout };
}

async function createFile(sshService, directory, name) {
  assertItemName(name);
  const path = itemPath(directory, name);
  const result = await sshService.exec(`touch -- ${shellQuote(path)}`, { timeoutMs: 10000 });
  ensureSuccess(result, 'Could not create file.');
  return listDirectory(sshService, directory);
}

async function createFolder(sshService, directory, name) {
  assertItemName(name);
  const path = itemPath(directory, name);
  const result = await sshService.exec(`mkdir -- ${shellQuote(path)}`, { timeoutMs: 10000 });
  ensureSuccess(result, 'Could not create folder.');
  return listDirectory(sshService, directory);
}

async function deleteItem(sshService, path, currentPath = '.') {
  assertPath(path);
  const result = await sshService.exec(`rm -r -- ${shellQuote(path)}`, { timeoutMs: 15000 });
  ensureSuccess(result, 'Could not delete item.');
  return listDirectory(sshService, currentPath);
}

async function navigate(sshService, path) {
  return listDirectory(sshService, path);
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (!error) {
        resolve();
        return;
      }

      sftp.lstat(remotePath, (statError, attributes) => {
        if (!statError && attributes.isDirectory()) resolve();
        else reject(error);
      });
    });
  });
}

function isMissingSftpPath(error) {
  return error && (
    error.code === 2 || error.status === 2 || error.code === 'ENOENT' ||
    /no such file/i.test(String(error.message || ''))
  );
}

function sftpLstat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error, attributes) => {
      if (!error) {
        resolve(attributes);
      } else if (isMissingSftpPath(error)) {
        resolve(null);
      } else {
        reject(error);
      }
    });
  });
}

// "document.txt" -> ["document", ".txt"], "archive.tar.gz" -> keeps the
// last extension only (good enough for the common cases), "README" (no
// dot) -> ["README", ""].
function splitNameExtension(name) {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return [name, ''];
  return [name.slice(0, dotIndex), name.slice(dotIndex)];
}

// Finds a name that doesn't collide with anything already in `directory`,
// following the familiar "name (2)", "name (3)"... pattern used by
// Finder/Explorer when you choose to keep both files instead of replacing.
async function findAvailableName(sftp, directory, name) {
  const [base, ext] = splitNameExtension(name);
  let candidate = name;
  let attempt = 1;

  while (await sftpLstat(sftp, itemPath(directory, candidate))) {
    attempt += 1;
    candidate = `${base} (${attempt})${ext}`;
  }

  return candidate;
}

function sftpFastPut(sftp, localPath, remotePath, onStep) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { step: onStep }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function uploadEntry(sftp, localPath, remotePath, onProgress) {
  const stat = fs.lstatSync(localPath);
  if (stat.isSymbolicLink()) {
    throw new Error('Symbolic links are not uploaded. Select the target file or folder directly.');
  }

  const remoteEntry = await sftpLstat(sftp, remotePath);
  if (remoteEntry && remoteEntry.isSymbolicLink()) {
    throw new Error('Cannot upload through a remote symbolic link.');
  }

  if (stat.isDirectory()) {
    await sftpMkdir(sftp, remotePath);
    const children = fs.readdirSync(localPath);
    for (const child of children) {
      await uploadEntry(sftp, path.join(localPath, child), `${remotePath}/${child}`, onProgress);
    }
    return;
  }

  if (!stat.isFile()) return;

  onProgress({ type: 'start', path: remotePath, size: stat.size });
  await sftpFastPut(sftp, localPath, remotePath, (transferred, _chunk, total) => {
    onProgress({ type: 'progress', path: remotePath, transferred, total });
  });
  onProgress({ type: 'done', path: remotePath, size: stat.size });
}

// onConflict(name) is asked once per top-level dropped item, only when
// something with that name already exists at the destination. It must
// resolve to `true` (replace in place) or `false` (keep both - the upload
// proceeds under an automatically renamed "name (2)" instead).
async function uploadItems(sshService, { sessionId, directory, paths } = {}, onProgress = () => {}, onConflict = async () => true) {
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error('No files or folders were provided.');
  }

  const sftp = await sshService.getSftp(sessionId);
  const errors = [];
  let uploaded = 0;

  for (const localPath of paths) {
    const name = path.basename(localPath);
    if (!name) continue;

    try {
      if (!fs.existsSync(localPath)) {
        throw new Error('Local file or folder no longer exists.');
      }

      let targetName = name;
      const existing = await sftpLstat(sftp, itemPath(directory, name));
      if (existing && existing.isSymbolicLink()) {
        throw new Error('Cannot replace a remote symbolic link during upload.');
      }
      if (existing) {
        const shouldReplace = await onConflict(name);
        if (!shouldReplace) {
          targetName = await findAvailableName(sftp, directory, name);
        }
      }

      const remotePath = itemPath(directory, targetName);
      await uploadEntry(sftp, localPath, remotePath, onProgress);
      uploaded += 1;
    } catch (error) {
      const message = error.message || 'Upload failed.';
      errors.push({ path: localPath, message });
      onProgress({ type: 'error', path: localPath, message });
    }
  }

  const listing = await listDirectory(sshService, directory);
  return { ...listing, uploaded, errors };
}

module.exports = {
  listDirectory,
  openFile,
  createFile,
  createFolder,
  deleteItem,
  navigate,
  uploadItems
};
