# Security Policy

Vibration is designed for self-hosting and auditability. The Community edition
is intentionally limited so visitors can inspect and test the core philosophy:
browser-side encryption, a small Go server, SQLite storage, and no hosted
Vibration control plane.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability before it has been
triaged.

Send a private report to the project maintainer with:

- affected version or commit;
- deployment mode and operating system;
- clear reproduction steps;
- expected and observed impact;
- logs or screenshots when useful, without sharing private keys or real user
  message content.

If no private security contact is published for the repository, contact the
maintainer through the official Vibration website before disclosing details
publicly.

## Supported Security Scope

Security fixes are prioritized for:

- authentication and session handling;
- browser-side cryptography and key storage flows;
- message, file and call metadata exposure;
- WebSocket authorization;
- file upload/download authorization;
- push notification payload minimization;
- dependency vulnerabilities with a practical impact on Community.

The Community edition does not include the Enterprise administration console,
federation, private Coturn configuration, managed restart hooks, external
database deployment options, or the Tauri desktop/mobile wrapper.

## Security Model

Vibration aims to minimize server trust:

- message content, file metadata and conversation data are encrypted in the
  browser before being sent to the server;
- the server stores and routes encrypted payloads but is not expected to read
  clear message content;
- Web Push notifications intentionally avoid clear message content;
- Community uses local SQLite storage by default;
- no analytics or hosted Vibration telemetry service is required.

This model does not remove every trust boundary. Operators still control:

- the deployed server binary and static web assets;
- TLS termination and reverse proxy configuration;
- backups and filesystem permissions;
- database files and server-side logs;
- application secrets and VAPID keys.

## Hardening Checklist

For production-like self-hosted tests:

- serve the application over HTTPS;
- set `SECURE_COOKIES=true` behind a correct HTTPS reverse proxy;
- keep `data/app_secret` and `data/vapid.json` private;
- restrict filesystem permissions on `data/`;
- back up `data/chat.db`, `data/app_secret` and VAPID keys together;
- keep the Go toolchain and operating system patched;
- review `DEPENDENCIES.md` and `THIRD_PARTY_NOTICES.md` before redistribution;
- do not publish `.env`, certificates, private keys, database files or local
  binaries.

## Dependency Review

Before publishing a Community release:

```bash
GOCACHE=/tmp/webtchat-go-cache go test -count=1 -tags community ./...
GOCACHE=/tmp/webtchat-go-cache go vet -tags community ./...
npm ci
npm run check:js
```

Dependency license and scope are documented in:

- [DEPENDENCIES.md](DEPENDENCIES.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [COMMUNITY_VS_ENTERPRISE.md](COMMUNITY_VS_ENTERPRISE.md)
