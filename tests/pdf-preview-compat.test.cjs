const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/pdf-preview-compat.js"), "utf8");
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

(async () => {
  const {
    isIOSWebKit,
    needsInlinePDFWorker,
    pdfDocumentCompatibilityOptions,
  } = await import(moduleURL);

  const iPhone17 = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_11 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    platform: "iPhone",
    maxTouchPoints: 5,
  };
  assert.equal(isIOSWebKit(iPhone17), true);
  assert.equal(needsInlinePDFWorker(iPhone17), true);
  assert.deepEqual(pdfDocumentCompatibilityOptions(iPhone17), {
    isEvalSupported: false,
    disableFontFace: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
  });

  const iPhone18 = {
    ...iPhone17,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  };
  assert.equal(needsInlinePDFWorker(iPhone18), false);
  assert.deepEqual(pdfDocumentCompatibilityOptions(iPhone18), {});

  const desktopIPad = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
  };
  assert.equal(isIOSWebKit(desktopIPad), true);
  assert.equal(needsInlinePDFWorker(desktopIPad), true);

  const mac = { ...desktopIPad, maxTouchPoints: 0 };
  assert.equal(isIOSWebKit(mac), false);
  assert.equal(needsInlinePDFWorker(mac), false);

  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
  for (const filename of [
    "web/vendor/pdfjs-ios17/pdf.min.js",
    "web/vendor/pdfjs-ios17/pdf.worker.min.js",
  ]) {
    const absolute = path.join(root, filename);
    assert.equal(fs.existsSync(absolute), true, `${filename} must be bundled`);
    assert.ok(fs.statSync(absolute).size > 100_000, `${filename} must not be empty`);
  }
  assert.match(app, /if \(needsInlinePDFWorker\(\)\) return ios17PDFJS\(\)/);
  assert.match(app, /pdfjsLib\?\.version === "3\.11\.174"/);
  assert.match(app, /pdfOperationWithTimeout/);
  assert.doesNotMatch(app, /application\/pdf[\s\S]*createElement\("object"\)/);
  assert.doesNotMatch(styles, /pdf-native-preview|pdf-native-fallback/);

  console.log("PDF preview: compatibility routing and JPEG-only first-page rendering verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
