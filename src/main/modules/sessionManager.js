function createSessionManager(sshService) {
  async function createSession(serverConfig) {
    return sshService.connect(serverConfig);
  }

  function getActiveSessions() {
    return sshService.getActiveSessions();
  }

  function switchSession(sessionId) {
    return sshService.switchSession(sessionId);
  }

  function closeSession(sessionId) {
    sshService.disconnect(sessionId);
    return {
      currentSession: sshService.getCurrentSession(),
      sessions: sshService.getActiveSessions()
    };
  }

  function getCurrentSession() {
    return sshService.getCurrentSession();
  }

  return {
    createSession,
    getActiveSessions,
    switchSession,
    closeSession,
    getCurrentSession
  };
}

module.exports = { createSessionManager };
