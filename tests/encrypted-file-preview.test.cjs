const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const crypto = fs.readFileSync(path.join(__dirname, "../web/js/crypto.js"), "utf8");
const ui = fs.readFileSync(path.join(__dirname, "../web/js/ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../cmd/server/main.go"), "utf8");

assert.match(app, /const FILE_PREVIEW_MAX_BYTES = 512 \* 1024/);
assert.match(app, /const FILE_PREVIEW_SOURCE_MAX_BYTES = 64 \* 1024 \* 1024/);
assert.match(app, /async function encryptedFilePreview\(file, data, key\)/);
assert.match(app, /mime === "application\/pdf"[\s\S]*pdfFilePreview\(data\)/);
assert.match(app, /async function videoFilePreview\(file, data\)[\s\S]*video\.currentTime[\s\S]*return canvasJPEG\(canvas, 0\.78\)/);
assert.match(app, /mime\.startsWith\("video\/"\)[\s\S]*videoFilePreview\(file, data\)/);
assert.match(app, /modernOfficeKind\(\{ name: file\.name, mime \}\)[\s\S]*officeFilePreview\(file, data\)/);
assert.match(app, /rasterOnly: true/);
assert.match(app, /officeFallbackPreviewBlob\(officeFile\)/);
assert.match(app, /preview\?\.size > 0 && preview\.size <= FILE_PREVIEW_MAX_BYTES/);
assert.match(app, /message\.file\.has_preview !== true[\s\S]*renderTemporaryOfficeThumbnail\(container\)/);
assert.match(app, /encrypted_preview_data: preview\?\.data \|\| ""/);
assert.match(app, /preview_iv: preview\?\.iv \|\| ""/);
assert.match(app, /from "\.\/crypto\.js\?v=file-share-history-v323"/);
assert.match(app, /async function encryptFileBytes\(key, bytes\)/);
assert.match(app, /encryptFileBytes\(key, data\)/);

const cryptoImportBlock = [...app.matchAll(/import\s*\{([\s\S]*?)\}\s*from "([^"]+)"/g)]
  .find((match) => match[2].startsWith("./crypto.js?"));
const cryptoImports = cryptoImportBlock?.[1]
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean) || [];
const cryptoExports = new Set(
  [...crypto.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]),
);
for (const imported of cryptoImports) {
  assert.ok(cryptoExports.has(imported), `crypto.js doit exporter ${imported}`);
}
assert.match(app, /upload\.append\("metadata", JSON\.stringify\(body\)\)/);
assert.match(app, /upload\.append\("encrypted_data", new Blob\(\[encrypted\.data\]/);
assert.match(app, /api\("\/api\/files", \{[\s\S]*body: upload/);
assert.match(app, /function safeFullFilePreviewSource\(message, container\)[\s\S]*supportsFullFilePreview\(file\)[\s\S]*size <= FILE_PREVIEW_SOURCE_MAX_BYTES/);
assert.match(app, /async function renderFilePreview[\s\S]*safeFullFilePreviewSource\(message, container\)[\s\S]*loadDecryptedFile\(message, key\)/);
assert.match(app, /api\(`\/api\/files\/\$\{message\.file\.id\}\/preview`\)/);
assert.match(ui, /preview\.dataset\.fileMime = clear\?\.mime \|\| ""/);
assert.match(app, /previewMIME === "application\/pdf"[\s\S]*preparedPDFThumbnail\(thumbnail\)[\s\S]*fitPDFPreviewToAspect\(container, display\.width \|\| image\.naturalWidth, display\.height \|\| image\.naturalHeight\)/);
assert.match(app, /video-file-play-button/);
assert.match(app, /loadDecryptedFile\(message, key\)[\s\S]*renderVideoPlayer\(file, container, \{ poster: thumbnail\.url, autoplay: true \}\)/);
assert.match(app, /function renderVideoPlayer\(file, container/);
assert.match(app, /async function pdfFilePreview[\s\S]*canvasJPEG\(croppedPDFPreviewCanvas\(canvas, base\.width \/ base\.height\)\)/);
assert.match(app, /async function preparedPDFThumbnail[\s\S]*croppedPDFPreviewCanvas\(canvas, source\.naturalWidth \/ source\.naturalHeight\)/);
assert.match(app, /const displayedCanvas = croppedPDFPreviewCanvas\(canvas, baseViewport\.width \/ baseViewport\.height\)[\s\S]*const previewBlob = await canvasJPEG\(displayedCanvas, 0\.82\)/);
assert.match(app, /const previewURL = URL\.createObjectURL\(previewBlob\);[\s\S]*const image = document\.createElement\("img"\);[\s\S]*image\.className = "pdf-page-preview"/);
assert.match(app, /fitPDFPreviewToAspect\(container, displayedCanvas\.width, displayedCanvas\.height\)/);
assert.match(styles, /\.fitted-pdf-message \.file-attachment\s*\{[^}]*width:\s*var\(--pdf-preview-width\)/);
assert.match(styles, /\.file-preview\.fitted-pdf-preview > img\s*\{[^}]*max-height:\s*none;/);
assert.match(styles, /\.video-file-thumbnail\s*\{/);
assert.match(styles, /\.video-file-play-button\s*\{/);

for (const functionName of ["renderFilePreview", "renderReplyFilePreview"]) {
  const start = app.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1);
  const body = app.slice(start, app.indexOf("\n}", start) + 2);
  assert.ok(
    body.indexOf("renderEncryptedFileThumbnail") < body.indexOf("loadDecryptedFile(message, key)"),
    `${functionName} doit essayer l’aperçu séparé avant le fichier original`,
  );
}

assert.match(server, /GET \/api\/files\/\{id\}\/preview/);

console.log("Encrypted file preview: generation, upload and lightweight loading wired");
