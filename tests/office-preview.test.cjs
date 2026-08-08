const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/js/office-preview.js"), "utf8");
assert.match(source, /async function rasterizeOfficeElement\(element, width, height\)/);
assert.match(source, /async function rasterizeOfficeElementWithHTMLCanvas\(element, width, height\)/);
assert.match(source, /vendor\/html2canvas\/html2canvas\.min\.js/);
assert.match(source, /return await rasterizeOfficeElementWithHTMLCanvas\(element, width, height\)/);
assert.match(source, /const OFFICE_RASTER_MAX_WIDTH = 640/);
assert.match(source, /const OFFICE_RASTER_MAX_HEIGHT = 800/);
assert.match(source, /export async function officeFallbackPreviewBlob\(file\)/);
assert.match(source, /async function wordContentPreview\(data\)/);
assert.match(source, /async function excelWorksheetContentPreview\(worksheet, locale\)/);
assert.match(source, /async function powerpointContentPreview\(data, width = 640, height = 360\)/);
assert.match(source, /word: \{ label: "DOCX"/);
assert.match(source, /excel: \{ label: "XLSX"/);
assert.match(source, /powerpoint: \{ label: "PPTX"/);
assert.match(source, /Math\.min\(1, OFFICE_RASTER_MAX_WIDTH \/ naturalWidth, OFFICE_RASTER_MAX_HEIGHT \/ naturalHeight\)/);
assert.match(source, /officeCanvasJPEG\(canvas\)/);
assert.match(source, /\{ type: "image\/png" \}/);
assert.match(source, /setTimeout\(\(\) => \{/);
assert.match(source, /async function tryRasterizeOfficeElement\(element, width, height\)/);
assert.match(source, /fitOfficeDOMPreview\(frame, bodyContainer/);
assert.match(source, /const frameWidth = frame\.getBoundingClientRect\(\)\.width/);
assert.match(source, /frame\.style\.width = `\$\{scaledWidth\}px`/);
assert.match(source, /frame\.style\.marginLeft = "auto"/);
assert.match(source, /appendOfficeImagePreview\(container, preview\)/);
assert.match(source, /image\.style\.objectPosition = "center center"/);
assert.match(source, /const declaredHeight = cssPixelLength\(computed\.minHeight\)/);
assert.match(source, /isolateFirstWordPage\(page, bodyContainer, naturalWidth, naturalHeight\)/);
assert.match(source, /page\.style\.maxHeight = `\$\{height\}px`/);
assert.match(source, /if \(!rasterOnly\) \{[\s\S]*fitOfficeDOMPreview\(frame, bodyContainer, naturalWidth, naturalHeight, container\)/);
assert.match(source, /function createOfficePreviewStage\(container, kind\)/);
assert.match(source, /commitOfficePreviewStage\(renderContainer, container\)/);
assert.match(source, /renderSingleSlide\(0\)/);
assert.match(source, /slideCount = Number\(previewer\.slideCount\)/);
assert.match(source, /officeDataURLPreview\(presentation\?\.thumbnail, 960, slideHeight\)/);
assert.match(source, /firstSlidePowerPointArchive\(file\.data\)/);
assert.match(source, /renderExtractedPowerPointSlide\(/);
assert.match(source, /const renderedSlide = preparedPowerPointSlide\(content, 960, slideHeight\)/);
assert.match(source, /tryRasterizeOfficeElement\([\s\S]*renderedSlide\.element,[\s\S]*renderedSlide\.width,[\s\S]*renderedSlide\.height/);
assert.match(source, /slide\.style\.inset = "0 auto auto 0"/);
assert.doesNotMatch(source, /La présentation PowerPoint est vide/);
assert.match(source, /rasterOnly/);
assert.match(source, /container\.inert = true/);
assert.match(source, /container\.style\.pointerEvents = "none"/);
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

(async () => {
  const {
    copiedArrayBuffer,
    extractedWordParagraphs,
    firstSlidePowerPointArchive,
    modernOfficeKind,
    officeDataURLPreview,
    officeCellText,
    preloadModernOfficePreview,
    wordPageViewport,
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

  const thumbnail = officeDataURLPreview("data:image/jpeg;base64,AQIDBA==", 960, 540);
  assert.equal(thumbnail.blob.type, "image/jpeg");
  assert.equal(thumbnail.blob.size, 4);
  assert.equal(thumbnail.width, 960);
  assert.equal(thumbnail.height, 540);
  assert.equal(officeDataURLPreview("not-a-data-url", 960, 540), null);

  assert.deepEqual(extractedWordParagraphs(`<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Rapport annuel</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chiffre</w:t></w:r><w:tab/><w:r><w:t>d’affaires</w:t></w:r></w:p>
  </w:body></w:document>`), [
    { text: "Rapport annuel", style: "Title", bold: false },
    { text: "Chiffre d’affaires", style: "", bold: false },
  ]);

  globalThis.getComputedStyle = () => ({ width: "816px", minHeight: "1056px" });
  const wordViewport = wordPageViewport({
    getBoundingClientRect: () => ({ width: 816, height: 4000 }),
    scrollWidth: 816,
    style: { height: "" },
  });
  assert.deepEqual(wordViewport, { width: 816, height: 1056 });

  const JSZip = require(path.join(root, "web/vendor/jszip/jszip.min.js"));
  globalThis.JSZip = JSZip;
  const sourceArchive = new JSZip();
  sourceArchive.file("[Content_Types].xml", `<?xml version="1.0"?><Types>
    <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
    <Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
    <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
    <Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
    <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
    <Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  </Types>`);
  sourceArchive.file("ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`);
  sourceArchive.file("ppt/_rels/presentation.xml.rels", `<Relationships>
    <Relationship Type="slide" Target="slides/slide1.xml" Id="rId1"/>
    <Relationship Type="slide" Target="slides/slide2.xml" Id="rId2"/>
  </Relationships>`);
  sourceArchive.file("ppt/slides/slide1.xml", "<p:sld/>");
  sourceArchive.file("ppt/slides/slide2.xml", "<p:sld/>");
  sourceArchive.file("ppt/slides/_rels/slide2.xml.rels", `<Relationships><Relationship Id="layout" Type="slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>`);
  sourceArchive.file("ppt/slideLayouts/slideLayout1.xml", "<p:sldLayout/>");
  sourceArchive.file("ppt/slideLayouts/slideLayout2.xml", "<p:sldLayout/>");
  sourceArchive.file("ppt/slideLayouts/_rels/slideLayout2.xml.rels", `<Relationships><Relationship Type="slideMaster" Target="../slideMasters/slideMaster2.xml" Id="master"/></Relationships>`);
  sourceArchive.file("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster/>");
  sourceArchive.file("ppt/slideMasters/slideMaster2.xml", "<p:sldMaster/>");
  sourceArchive.file("ppt/slideMasters/_rels/slideMaster2.xml.rels", `<Relationships><Relationship Target="../theme/theme2.xml" Id="theme" Type="theme"/></Relationships>`);
  sourceArchive.file("ppt/theme/theme1.xml", "<a:theme/>");
  sourceArchive.file("ppt/theme/theme2.xml", "<a:theme/>");
  const firstSlideArchive = await firstSlidePowerPointArchive(await sourceArchive.generateAsync({ type: "arraybuffer" }));
  assert.equal(firstSlideArchive.originalSlideCount, 2);
  assert.equal(firstSlideArchive.slidePath, "ppt/slides/slide2.xml");
  const recoveredArchive = await JSZip.loadAsync(firstSlideArchive.data);
  const recoveredTypes = await recoveredArchive.file("[Content_Types].xml").async("text");
  assert.match(recoveredTypes, /PartName="\/ppt\/slides\/slide2\.xml"/);
  assert.match(recoveredTypes, /PartName="\/ppt\/slideLayouts\/slideLayout2\.xml"/);
  assert.match(recoveredTypes, /PartName="\/ppt\/slideMasters\/slideMaster2\.xml"/);
  assert.match(recoveredTypes, /PartName="\/ppt\/theme\/theme2\.xml"/);
  assert.doesNotMatch(recoveredTypes, /PartName="\/ppt\/slides\/slide1\.xml"/);
  assert.doesNotMatch(recoveredTypes, /PartName="\/ppt\/slideLayouts\/slideLayout1\.xml"/);

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
