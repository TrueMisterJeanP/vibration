const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/js/office-preview.js"), "utf8");
assert.match(source, /async function rasterizeOfficeElement\(element, width, height\)/);
assert.match(source, /officeCanvasJPEG\(canvas\)/);
assert.match(source, /\{ type: "image\/png" \}/);
assert.match(source, /setTimeout\(\(\) => \{/);
assert.match(source, /async function tryRasterizeOfficeElement\(element, width, height\)/);
assert.match(source, /fitOfficeDOMPreview\(frame, bodyContainer/);
assert.match(source, /appendOfficeImagePreview\(container, preview\)/);
assert.match(source, /renderSingleSlide\(0\)/);
assert.match(source, /rasterOnly/);
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

(async () => {
  const {
    copiedArrayBuffer,
    modernOfficeKind,
    officeCellText,
    preloadModernOfficePreview,
  } = await import(moduleURL);

  assert.equal(modernOfficeKind({
    name: "contrat",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }), "word");
  assert.equal(modernOfficeKind({ name: "budget.XLSX", mime: "application/octet-stream" }), "excel");
  assert.equal(modernOfficeKind({ name: "présentation.pptx", mime: "application/zip" }), "powerpoint");
  assert.equal(modernOfficeKind({ name: "ancien.doc", mime: "application/msword" }), null);
  assert.equal(modernOfficeKind({ name: "ancien.xls", mime: "application/vnd.ms-excel" }), null);
  assert.equal(modernOfficeKind({ name: "ancien.ppt", mime: "application/vnd.ms-powerpoint" }), null);
  assert.equal(await preloadModernOfficePreview({ name: "ancien.doc", mime: "application/msword" }), null);

  const bytes = Uint8Array.from([10, 20, 30, 40]);
  const copied = new Uint8Array(copiedArrayBuffer(bytes.subarray(1, 3)));
  assert.deepEqual([...copied], [20, 30]);
  copied[0] = 99;
  assert.deepEqual([...bytes], [10, 20, 30, 40]);

  assert.equal(officeCellText({ result: 42 }), "42");
  assert.equal(officeCellText({ richText: [{ text: "Bon" }, { text: "jour" }] }), "Bonjour");
  assert.equal(officeCellText({ text: "Site", hyperlink: "https://example.invalid" }), "Site");
  assert.equal(officeCellText({ error: "#DIV/0!" }), "#DIV/0!");

  const vendorFiles = [
    "web/vendor/jszip/jszip.min.js",
    "web/vendor/docx-preview/docx-preview.min.js",
    "web/vendor/exceljs/exceljs.min.js",
    "web/vendor/pptx-preview/pptx-preview.umd.js",
  ];
  for (const filename of vendorFiles) {
    const absolute = path.join(root, filename);
    assert.equal(fs.existsSync(absolute), true, `${filename} must be bundled`);
    assert.ok(fs.statSync(absolute).size > 1_000, `${filename} must not be empty`);
  }

  console.log("Office preview: DOCX, XLSX and PPTX routing verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
