const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const scannerSource = fs.readFileSync(path.join(root, "web/js/qr-scanner.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const worker = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");
const i18nSource = fs.readFileSync(path.join(root, "web/js/i18n.js"), "utf8");

async function importSource(source, suffix) {
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${suffix}`).toString("base64")}`);
}

(async () => {
  const scanner = await importSource(scannerSource, "qr-scanner");
  const token = "A".repeat(43);
  const instance = "https://vibration.example";
  assert.equal(scanner.sessionApprovalTokenFromQR(`${instance}/link-device.html#token=${token}`, instance), token);
  assert.equal(scanner.sessionApprovalTokenFromQR(`https://evil.example/link-device.html#token=${token}`, instance), "");
  assert.equal(scanner.sessionApprovalTokenFromQR(`${instance}/other.html#token=${token}`, instance), "");
  assert.equal(scanner.sessionApprovalTokenFromQR(`${instance}/link-device.html?next=evil#token=${token}`, instance), "");
  assert.equal(scanner.sessionApprovalTokenFromQR(`${instance}/link-device.html#token=short`, instance), "");

  globalThis.jsQR = (_data, width, height, options) => ({ data: `${width}x${height}:${options.inversionAttempts}` });
  assert.equal(scanner.decodeQRImageData({ data: new Uint8ClampedArray(16), width: 2, height: 2 }), "2x2:attemptBoth");
  delete globalThis.jsQR;

  for (const id of [
    "profile-session-scan-qr",
    "session-qr-scanner-dialog",
    "session-qr-scanner-video",
    "session-qr-scanner-canvas",
    "session-qr-scanner-file",
    "session-qr-scanner-status",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /\/vendor\/jsqr\/jsQR\.js\?v=qr-scanner-v296/);
  assert.match(app, /getUserMedia\([\s\S]*facingMode: \{ ideal: "environment" \}/);
  assert.match(app, /sessionApprovalTokenFromQR\(value, getInstanceURL\(\)\)/);
  assert.match(app, /sessions\/preview[\s\S]*body: \{ token \}[\s\S]*sessions\/approve[\s\S]*body: \{ token \}/);
  assert.match(app, /sessionQRScannerStream\?\.getTracks\?\.\(\)[\s\S]*track\.stop\(\)/);
  assert.match(worker, /chat-pwa-go-v380/);
  assert.match(worker, /\/js\/qr-scanner\.js\?v=qr-scanner-v296/);
  assert.match(worker, /\/vendor\/jsqr\/jsQR\.js\?v=qr-scanner-v296/);
  assert.equal(fs.existsSync(path.join(root, "web/vendor/jsqr/LICENSE")), true);

  const scannerLabels = {
    en: "Scan a QR code",
    fr: "Scanner un QR code",
    es: "Escanear un código QR",
    it: "Scansiona un codice QR",
    pt: "Digitalizar um código QR",
    de: "QR-Code scannen",
  };
  for (const [language, expected] of Object.entries(scannerLabels)) {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language, languages: [language] } });
    const i18n = await importSource(i18nSource, `qr-${language}`);
    assert.equal(i18n.t("Scanner un QR code"), expected);
    assert.notEqual(i18n.t("La caméra n’est pas disponible. Choisissez une image du QR code."), "");
  }

  console.log("QR scanner: same-instance validation, camera/photo flow, offline assets and 6 languages verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
