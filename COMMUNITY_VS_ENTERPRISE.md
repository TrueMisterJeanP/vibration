# Community vs Enterprise

Vibration Community is the public GitHub edition. Its purpose is to let
visitors inspect, run and test the philosophy of Vibration: sovereign
self-hosting, browser-side encryption, and the main messaging workflows without
depending on a hosted Vibration service.

Vibration Enterprise keeps the same core codebase and adds operational features
for organizations that need production support, administration and managed
self-hosted deployment.

## Summary

| Area | Community | Enterprise |
| --- | --- | --- |
| License | GPL-3.0-or-later | GPL-3.0-or-later for delivered client code |
| Source availability | Public GitHub export | Delivered to customers for their version |
| Main goal | Audit and test the core philosophy and functions | Production deployment and operational control |
| Server | Go server | Go server with additional modules |
| Web client | Web/PWA | Web/PWA plus Enterprise interfaces |
| Desktop/mobile wrapper | Not published | Can include Tauri/Android packaging work |
| Database | SQLite only | SQLite plus external database deployment options |
| Registration | Open registration | Can include activation/admin workflows |
| Administration console | Not included | Included |
| Federation | Not included | Available where configured |
| TURN/Coturn | Public STUN fallback only | Private Coturn configuration support |
| Support | Community/self-service | Commercial support and deployment guidance |

## Included In Community

- user registration and login;
- contacts;
- direct and group conversations;
- browser-side encrypted message payloads;
- encrypted file workflows;
- audio/video calls using browser WebRTC APIs;
- screen sharing where supported by the browser;
- whiteboard;
- Web Push notifications without clear message content;
- PWA installation from the browser;
- SQLite persistence;
- reproducible public export script.

## Not Included In Community

- `src-tauri/` desktop/mobile wrapper;
- administration console;
- Enterprise route registration;
- federation modules;
- private Coturn configuration;
- activation-code workflow;
- external database deployment support as a public feature;
- managed production support.

The Community export excludes these files through `editions/community.exclude`.

## Why This Split Exists

Community should be small enough to audit and run locally. It demonstrates the
product principles without turning the public repository into the full
commercial operations package.

Enterprise is for organizations that need stronger production guarantees:
administration, deployment assistance, private relay infrastructure, federation
options, and database choices.

## Public Positioning

Community should be described as:

- auditable;
- self-hostable;
- sovereign by default;
- focused on the core user experience;
- intentionally limited compared with Enterprise.

It should not be described as the full production operations edition.

Enterprise offer: https://vibration-shop.appbox.fr
