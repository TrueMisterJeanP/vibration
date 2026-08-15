const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const server = fs.readFileSync(path.join(root, "cmd/server/main.go"), "utf8");
const users = fs.readFileSync(path.join(root, "internal/users/handlers.go"), "utf8");
const contacts = fs.readFileSync(path.join(root, "internal/contacts/handlers.go"), "utf8");
const conversations = fs.readFileSync(path.join(root, "internal/conversations/handlers.go"), "utf8");
const discovery = fs.readFileSync(path.join(root, "internal/userdiscovery/discovery.go"), "utf8");
const migrations = fs.readFileSync(path.join(root, "internal/db/migrations.go"), "utf8");
const federationPath = path.join(root, "internal/federation/handlers.go");
const federation = fs.existsSync(federationPath) ? fs.readFileSync(federationPath, "utf8") : "";

assert.match(html, /id="profile-invisible" type="checkbox"/);
assert.match(html, /id="profile-discovery-generate"[\s\S]*id="profile-discovery-code"[\s\S]*id="profile-discovery-copy"/);
assert.ok(
  html.indexOf('class="profile-password-section"') < html.indexOf('class="profile-discovery"'),
  "la confidentialité du profil doit suivre la modification du mot de passe",
);
assert.match(html, /class="profile-password-section"[\s\S]*id="profile-password-title">Modifier le mot de passe<[\s\S]*fieldset class="profile-password" aria-labelledby="profile-password-title"/);
assert.match(css, /\.profile-password-section h4\s*\{[^}]*color: var\(--muted\);[^}]*font-size: \.9rem;[^}]*font-weight: 400;/);
assert.match(html, /id="contact-search"[\s\S]*Nom d’utilisateur, nom affiché, rôle ou code privé|Nom d’utilisateur, nom affiché, rôle ou code privé[\s\S]*id="contact-search"/);
assert.doesNotMatch(html.match(/<input id="contact-search"[^>]*>/)?.[0] || "", /placeholder=/);
assert.doesNotMatch(html.match(/<input id="group-user-search"[^>]*>/)?.[0] || "", /placeholder=/);
assert.doesNotMatch(html.match(/<input id="group-edit-user-search"[^>]*>/)?.[0] || "", /placeholder=/);
assert.match(css, /\.profile-visibility-toggle input\[type="checkbox"\]/);
assert.match(css, /\.profile-discovery-code\[hidden\]\s*\{\s*display:\s*none/);

assert.match(app, /function normalizedPrivateDiscoveryCode\(value\)/);
assert.match(app, /\[A-Z2-7\]\{15\}/);
assert.match(app, /VIB\[A-Z2-7\]\{32\}/);
assert.match(app, /function searchInstanceUsers\(query, role = ""\)[\s\S]*api\("\/api\/users\/search",\s*\{[\s\S]*method:\s*"POST"[\s\S]*body:\s*role \? \{ query, role \} : \{ query \}/);
assert.match(app, /body:\s*\{[\s\S]*user_id:\s*user\.id,[\s\S]*discovery_code:\s*isPrivateDiscoveryCode\(query\)/);
assert.match(app, /discovery_codes:\s*discoveryCodes/);
assert.match(app, /is_discoverable:\s*isDiscoverable/);
assert.match(app, /api\("\/api\/me\/discovery-code",\s*\{[\s\S]*method:\s*"POST"/);
assert.match(app, /il ne sera plus affiché après la fermeture du profil/);
const discoveryGeneration = app.slice(
  app.indexOf("async function generateProfileDiscoveryCode"),
  app.indexOf("async function copyProfileDiscoveryCode"),
);
assert.doesNotMatch(discoveryGeneration, /prompt|password/i);

assert.match(server, /POST \/api\/me\/discovery-code/);
assert.match(server, /POST \/api\/users\/search/);
assert.match(users, /u\.is_discoverable=1[\s\S]*EXISTS\(SELECT 1 FROM contacts/);
assert.match(users, /discovery_code_hash=\?,discovery_code_created_at=\?/);
assert.match(contacts, /userdiscovery\.CanInitiate\(h\.DB, ownerID, input\.UserID, input\.DiscoveryCode\)/);
assert.match(conversations, /DiscoveryCodes\s+map\[string\]string/);
assert.match(conversations, /userdiscovery\.CanInitiate\((?:h\.DB|tx), ownerID/);
assert.match(discovery, /raw := make\(\[\]byte, 10\)/);
assert.match(discovery, /generatedCodeCharacters\s*= 15/);
assert.match(discovery, /sha256\.Sum256\(\[\]byte\(normalized\)\)/);
assert.doesNotMatch(migrations, /discovery_code\s+TEXT/);
assert.match(migrations, /discovery_code_hash TEXT/);
if (federation) {
  assert.match(federation, /is_banned=0 AND is_discoverable=1/);
}

console.log("Private discovery: invisible profiles, one-time secure codes and server-side authorization verified");
