# SSH keys

SSH private key authentication and SSH-agent support are not implemented in this version. The connection screen accepts a password only.

Do not paste a private key into the terminal, a bot command, or a server profile. The file manager's upload dialog is for files intentionally selected for transfer; it is not an authentication workflow.

For now, use an account that permits password authentication and follow your server's access policy. Key authentication should be added only with passphrase handling, agent behavior, and platform-specific tests in place.
