const { Client } = require('ssh2');

function now() {
  return new Date().toISOString();
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Generous, slowly-growing backoff schedule so brief network blips (Wi-Fi
// roaming, laptop sleep/wake, a server-side reboot) don't kick the user back
// to the connection screen. After the schedule is exhausted we keep retrying
// forever at the last (longest) interval instead of giving up - only a
// manual disconnect stops retries.
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 15000, 20000, 30000, 45000, 60000];

function createSshService({ onLog, onDisconnect, onReconnect, onHostVerification }) {
  const sessions = new Map();
  let currentSessionId = '';

  function log(type, message, sessionId = currentSessionId) {
    onLog({ type, message, sessionId, time: now() });
  }

  function publicSession(session) {
    return {
      id: session.id,
      name: session.name || session.host,
      host: session.host,
      port: session.port,
      username: session.username,
      status: session.status,
      error: session.error || '',
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt
    };
  }

  function getSession(sessionId = currentSessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.client || !session.connected) {
      throw new Error('SSH session is not connected.');
    }
    return session;
  }

  function parseExecArgs(first, second, third) {
    if (typeof second === 'string') {
      return { sessionId: first, command: second, options: third || {} };
    }
    return { sessionId: currentSessionId, command: first, options: second || {} };
  }

  function withTimeout(session, stream, timeoutMs, reject, message) {
    if (!timeoutMs) return null;

    return setTimeout(() => {
      try {
        stream.close();
      } catch (_error) {
        stream.destroy();
      }
      const error = new Error(message);
      log('error', error.message, session.id);
      reject(error);
    }, timeoutMs);
  }

  function exec(first, second, third) {
    const { sessionId, command, options } = parseExecArgs(first, second, third);
    const session = getSession(sessionId);
    log('command', options.redactedCommand || command, session.id);

    return new Promise((resolve, reject) => {
      session.client.exec(command, (error, stream) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = withTimeout(
          session,
          stream,
          options.timeoutMs === undefined ? 30000 : options.timeoutMs,
          reject,
          'Remote command timed out.'
        );

        stream.on('close', (exitCode) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode });
        });

        stream.on('error', (streamError) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          log('error', streamError.message, session.id);
          reject(streamError);
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        if (options.stdin !== undefined) stream.end(String(options.stdin));
      });
    });
  }

  function execStream(first, second, third, fourth) {
    const hasSession = typeof second === 'string';
    const sessionId = hasSession ? first : currentSessionId;
    const command = hasSession ? second : first;
    const onData = hasSession ? third : second;
    const options = hasSession ? fourth || {} : third || {};
    const session = getSession(sessionId);
    log('command', options.redactedCommand || command, session.id);

    return new Promise((resolve, reject) => {
      session.client.exec(command, { pty: true }, (error, stream) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        let output = '';
        let stderr = '';
        let settled = false;
        const timeout = withTimeout(session, stream, options.timeoutMs || 0, reject, 'Remote command timed out.');

        stream.on('close', (exitCode) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve({ stdout: output, stderr, exitCode });
        });

        stream.on('error', (streamError) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          log('error', streamError.message, session.id);
          reject(streamError);
        });

        stream.on('data', (data) => {
          const text = data.toString();
          output += text;
          onData({ stream: 'stdout', text, sessionId: session.id, time: now() });
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          onData({ stream: 'stderr', text, sessionId: session.id, time: now() });
        });
      });
    });
  }

  function execInteractive(first, second, third) {
    const hasSession = typeof second === 'string';
    const sessionId = hasSession ? first : currentSessionId;
    const command = hasSession ? second : first;
    const onData = hasSession ? third : second;
    const session = getSession(sessionId);

    if (session.interactiveStream) {
      throw new Error('Another terminal command is already running for this session.');
    }

    log('command', command, session.id);

    return new Promise((resolve, reject) => {
      session.client.exec(command, { pty: true }, (error, stream) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        session.interactiveStream = stream;
        let output = '';
        let stderr = '';

        stream.on('close', (exitCode) => {
          session.interactiveStream = null;
          resolve({ stdout: output, stderr, exitCode });
        });

        stream.on('error', (streamError) => {
          session.interactiveStream = null;
          log('error', streamError.message, session.id);
          reject(streamError);
        });

        stream.on('data', (data) => {
          const text = data.toString();
          output += text;
          onData({ stream: 'stdout', text, sessionId: session.id, time: now() });
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString();
          stderr += text;
          onData({ stream: 'stderr', text, sessionId: session.id, time: now() });
        });
      });
    });
  }

  function sendInteractiveInput(first, second) {
    const hasSession = second !== undefined;
    const session = getSession(hasSession ? first : currentSessionId);
    const input = hasSession ? second : first;

    if (!session.interactiveStream) {
      throw new Error('No active terminal command is waiting for input.');
    }

    session.interactiveStream.write(input);
  }

  function stopInteractive(sessionId = currentSessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.interactiveStream) return false;

    session.interactiveStream.write('\u0003');
    setTimeout(() => {
      if (session.interactiveStream) session.interactiveStream.close();
    }, 300);
    return true;
  }

  function connect({ host, port = 22, username, password, name }) {
    const sshPort = Number(port);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw new Error('SSH port must be a number from 1 to 65535.');
    }

    const session = {
      id: createId(),
      name: name || host,
      host,
      port: sshPort,
      username,
      password,
      client: new Client(),
      connected: false,
      status: 'connecting',
      error: '',
      manualDisconnect: false,
      reconnecting: false,
      interactiveStream: null,
      shellStream: null,
      sftp: null,
      createdAt: now(),
      lastActiveAt: now()
    };

    sessions.set(session.id, session);
    currentSessionId = session.id;

    return new Promise((resolve, reject) => wireClient(session, resolve, reject, { isReconnect: false }));
  }

  function wireClient(session, resolve, reject, { isReconnect }) {
    let settled = false;

    session.client
      .on('ready', () => {
        session.connected = true;
        session.status = 'online';
        session.error = '';
        session.lastActiveAt = now();
        session.reconnecting = false;
        settled = true;
        log('connection', `${isReconnect ? 'Reconnected to' : 'Connected to'} ${session.host}:${session.port}`, session.id);
        if (isReconnect && onReconnect) onReconnect(publicSession(session));
        resolve({ sessionId: session.id, session: publicSession(session) });
      })
      .on('error', (error) => {
        session.connected = false;
        session.status = 'error';
        session.error = error.message;
        log('error', error.message, session.id);
        if (!settled) {
          settled = true;
          if (!isReconnect) {
            sessions.delete(session.id);
            if (currentSessionId === session.id) currentSessionId = sessions.keys().next().value || '';
          }
          reject(error);
        }
      })
      .on('close', () => {
        const wasConnected = session.connected;
        const wasManual = session.manualDisconnect;
        session.connected = false;
        session.status = wasManual ? 'disconnected' : session.status;
        session.interactiveStream = null;
        session.shellStream = null;
        session.sftp = null;
        log('system', 'SSH connection closed', session.id);
        if (wasConnected && !wasManual && !session.reconnecting) {
          attemptReconnect(session);
        } else if (!session.reconnecting) {
          session.status = 'disconnected';
        }
      })
      .connect({
        host: session.host,
        username: session.username,
        password: session.password,
        port: session.port,
        hostHash: 'sha256',
        hostVerifier: (fingerprint, callback) => {
          if (!onHostVerification) {
            callback(true);
            return;
          }

          Promise.resolve(onHostVerification({
            sessionId: session.id,
            host: session.host,
            port: session.port,
            username: session.username,
            fingerprint
          }))
            .then((trusted) => callback(Boolean(trusted)))
            .catch(() => callback(false));
        },
        readyTimeout: 12000,
        // Tolerate ~1 minute of missed keepalives (e.g. laptop sleep/wake or
        // a brief Wi-Fi drop) before ssh2 itself decides the connection is
        // dead and fires 'close'. Previously this was only 30s total, which
        // was easy to trip on ordinary network blips.
        keepaliveInterval: 15000,
        keepaliveCountMax: 4
      });
  }

  function attemptReconnect(session, attempt = 0) {
    if (session.manualDisconnect || !sessions.has(session.id)) return;

    // Once the schedule is exhausted, keep retrying indefinitely at the
    // longest interval rather than declaring the session dead - a real,
    // permanently-gone server will just keep failing quietly in the
    // background, but a temporary drop (sleep/wake, Wi-Fi roam, server
    // reboot) recovers automatically without the user having to reconnect
    // by hand.
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];

    session.reconnecting = true;
    session.status = 'reconnecting';
    log('system', `Reconnect attempt ${attempt + 1} to ${session.host}:${session.port}...`, session.id);

    setTimeout(() => {
      if (session.manualDisconnect || !sessions.has(session.id)) return;

      session.client = new Client();
      new Promise((resolve, reject) => wireClient(session, resolve, reject, { isReconnect: true }))
        .catch(() => attemptReconnect(session, attempt + 1));
    }, delay);
  }

  function openShell(sessionId, onData, options = {}) {
    const session = getSession(sessionId);
    if (session.shellStream) {
      throw new Error('A terminal shell is already open for this session.');
    }

    return new Promise((resolve, reject) => {
      session.client.shell({
        term: 'xterm-256color',
        cols: options.cols || 100,
        rows: options.rows || 30
      }, (error, stream) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        session.shellStream = stream;
        log('system', 'Terminal shell started', session.id);

        stream.on('close', () => {
          session.shellStream = null;
          onData({ type: 'close', sessionId: session.id });
        });

        stream.on('error', () => {
          session.shellStream = null;
        });

        stream.on('data', (chunk) => {
          onData({ type: 'data', text: chunk.toString('utf8'), sessionId: session.id });
        });

        stream.stderr.on('data', (chunk) => {
          onData({ type: 'data', text: chunk.toString('utf8'), sessionId: session.id });
        });

        resolve({ ok: true });
      });
    });
  }

  function writeShell(sessionId, data) {
    const session = getSession(sessionId);
    if (!session.shellStream) {
      throw new Error('No active terminal shell for this session.');
    }
    session.shellStream.write(data);
  }

  function resizeShell(sessionId, cols, rows) {
    const session = getSession(sessionId);
    if (!session.shellStream) return;
    session.shellStream.setWindow(rows, cols, 0, 0);
  }

  function closeShell(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.shellStream) return;
    try {
      session.shellStream.end();
    } catch (_error) {
      session.shellStream.destroy();
    }
    session.shellStream = null;
  }

  function startTail(sessionId, command, onData) {
    const session = getSession(sessionId);
    log('command', command, session.id);

    return new Promise((resolve, reject) => {
      session.client.exec(command, (error, stream) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        let stopped = false;

        stream.on('close', () => {
          if (!stopped) onData({ type: 'close', sessionId: session.id });
        });

        stream.on('error', () => {
          // Swallow - a 'close' event follows and the caller treats that as the end.
        });

        stream.on('data', (data) => {
          if (!stopped) onData({ type: 'data', text: data.toString('utf8'), sessionId: session.id });
        });

        stream.stderr.on('data', (data) => {
          if (!stopped) onData({ type: 'data', text: data.toString('utf8'), sessionId: session.id });
        });

        resolve({
          stop: () => {
            stopped = true;
            try {
              stream.close();
            } catch (_closeError) {
              stream.destroy();
            }
          }
        });
      });
    });
  }

  function getSftp(sessionId = currentSessionId) {
    const session = getSession(sessionId);
    if (session.sftp) return Promise.resolve(session.sftp);

    return new Promise((resolve, reject) => {
      session.client.sftp((error, sftp) => {
        if (error) {
          log('error', error.message, session.id);
          reject(error);
          return;
        }

        session.sftp = sftp;
        sftp.on('close', () => {
          if (session.sftp === sftp) session.sftp = null;
        });
        sftp.on('error', () => {
          if (session.sftp === sftp) session.sftp = null;
        });
        resolve(sftp);
      });
    });
  }

  function switchSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('SSH session was not found.');
    currentSessionId = sessionId;
    session.lastActiveAt = now();
    return publicSession(session);
  }

  function disconnect(sessionId = currentSessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.manualDisconnect = true;
    if (session.interactiveStream) {
      try {
        session.interactiveStream.close();
      } catch (_error) {
        session.interactiveStream.destroy();
      }
      session.interactiveStream = null;
    }
    if (session.shellStream) {
      try {
        session.shellStream.end();
      } catch (_error) {
        session.shellStream.destroy();
      }
      session.shellStream = null;
    }
    if (session.sftp) {
      try {
        session.sftp.end();
      } catch (_error) {
        // ignore
      }
      session.sftp = null;
    }
    if (session.client) session.client.end();
    session.connected = false;
    session.status = 'disconnected';
    session.password = '';
    sessions.delete(sessionId);
    if (currentSessionId === sessionId) currentSessionId = sessions.keys().next().value || '';
  }

  function disconnectAll() {
    Array.from(sessions.keys()).forEach((sessionId) => disconnect(sessionId));
  }

  // Called when the OS reports the machine woke up from sleep (or the
  // screen was unlocked after a long idle stretch). After being asleep for
  // a while the old TCP socket is very often silently dead - the far end
  // (or a NAT/router in between) closed it without either side ever
  // seeing a FIN, so nothing will actually notice until the next SSH
  // keepalive round-trips, which can take up to ~60s. Proactively kicking
  // off a reconnect the moment we come back gets the user back online
  // immediately instead of waiting for that keepalive to notice.
  function handleSystemResume() {
    sessions.forEach((session) => {
      if (session.manualDisconnect || session.reconnecting || !session.connected) return;

      log('system', `System resumed - re-verifying connection to ${session.host}:${session.port}...`, session.id);

      const forceReconnect = () => {
        if (session.manualDisconnect || session.reconnecting) return;
        session.connected = false;
        try {
          if (session.client && session.client._sock) session.client._sock.destroy();
        } catch (_error) {
          // ignore - best effort
        }
        attemptReconnect(session);
      };

      // .end() waits for a graceful close handshake that a truly dead
      // socket will never send, so give it a few seconds before forcing
      // things - the normal 'close' handler already wired in wireClient()
      // will fire and handle reconnecting on its own if .end() actually
      // succeeds within that window.
      const forceTimer = setTimeout(forceReconnect, 3000);
      session.client.once('close', () => clearTimeout(forceTimer));

      try {
        session.client.end();
      } catch (_error) {
        clearTimeout(forceTimer);
        forceReconnect();
      }
    });
  }

  function getActiveSessions() {
    return Array.from(sessions.values()).map(publicSession);
  }

  function getCurrentSession() {
    const session = sessions.get(currentSessionId);
    return session ? publicSession(session) : null;
  }

  return {
    connect,
    disconnect,
    disconnectAll,
    handleSystemResume,
    exec,
    execStream,
    execInteractive,
    sendInteractiveInput,
    stopInteractive,
    openShell,
    writeShell,
    resizeShell,
    closeShell,
    startTail,
    getSftp,
    switchSession,
    getActiveSessions,
    getCurrentSession,
    isConnected: () => Boolean(currentSessionId && sessions.get(currentSessionId)?.connected)
  };
}

module.exports = { createSshService };
