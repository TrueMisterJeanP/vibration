const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/js/message-links.js"), "utf8");
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

(async () => {
  const { messageLinkTokens } = await import(moduleURL);

  assert.deepEqual(
    messageLinkTokens("Voir https://example.com/docs?q=1, écrire à alice@example.fr ou www.vibration.fr."),
    [
      { type: "text", text: "Voir " },
      { type: "url", text: "https://example.com/docs?q=1", href: "https://example.com/docs?q=1" },
      { type: "text", text: ", écrire à " },
      { type: "email", text: "alice@example.fr", href: "mailto:alice@example.fr" },
      { type: "text", text: " ou " },
      { type: "url", text: "www.vibration.fr", href: "https://www.vibration.fr/" },
      { type: "text", text: "." },
    ],
  );

  assert.deepEqual(
    messageLinkTokens("Appelez le +33 (0)6 12 34 56 78 ou le 06.12.34.56.78."),
    [
      { type: "text", text: "Appelez le " },
      { type: "phone", text: "+33 (0)6 12 34 56 78", href: "tel:+33612345678", smsHref: "sms:+33612345678" },
      { type: "text", text: " ou le " },
      { type: "phone", text: "06.12.34.56.78", href: "tel:0612345678", smsHref: "sms:0612345678" },
      { type: "text", text: "." },
    ],
  );

  assert.deepEqual(
    messageLinkTokens("Date 2026-08-13, IP 192.168.1.1, code 12345 et javascript:alert(1)."),
    [{ type: "text", text: "Date 2026-08-13, IP 192.168.1.1, code 12345 et javascript:alert(1)." }],
  );
  assert.equal(messageLinkTokens("(https://example.com/a_(b)).")[0].text, "(");
  assert.equal(messageLinkTokens("(https://example.com/a_(b)).")[1].text, "https://example.com/a_(b)");

  const ui = fs.readFileSync(path.join(root, "web/js/ui.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
  const worker = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");

  assert.match(ui, /appendMessageLinks\(body, clear\)/);
  assert.match(ui, /link\.target = "_blank"/);
  assert.match(ui, /link\.rel = "noopener noreferrer"/);
  assert.match(ui, /plugin:opener\|open_url/);
  assert.match(ui, /sms\.href = token\.smsHref/);
  assert.match(css, /\.message \.message-link:visited \{ color: #70e6c9/);
  assert.match(css, /\.message \.message-link:visited \{[^}]*text-decoration: none/);
  assert.match(css, /:root\[data-theme="light"\] \.message \.message-link:visited \{ color: #08786f/);
  const linkModuleVersion = ui.match(/message-links\.js\?v=([^"\s]+)/)?.[1];
  assert.ok(linkModuleVersion);
  assert.ok(worker.includes(`/js/message-links.js?v=${linkModuleVersion}`));

  const cargoPath = path.join(root, "src-tauri/Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    const rust = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
    const cargo = fs.readFileSync(cargoPath, "utf8");
    const capabilities = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/capabilities/default.json"), "utf8"));
    assert.match(cargo, /tauri-plugin-opener = "2"/);
    assert.match(rust, /tauri_plugin_opener::init\(\)/);
    assert.ok(capabilities.permissions.includes("opener:default"));
    assert.ok(capabilities.permissions.some((permission) =>
      permission.identifier === "opener:allow-open-url" && permission.allow?.some((scope) => scope.url === "sms:*")
    ));
  }

  console.log("Message links: URLs, emails, phone calls, SMS and optional Tauri system opening verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
