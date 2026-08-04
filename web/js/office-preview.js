const OFFICE_PREVIEW_BUILD = "office-preview-v254";
const scriptLoads = new Map();
const previewCleanups = new Set();

const OFFICE_MIMES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "powerpoint",
};

const OFFICE_EXTENSIONS = {
  docx: "word",
  xlsx: "excel",
  pptx: "powerpoint",
};

export function modernOfficeKind(file) {
  const mime = String(file?.mime || "").split(";")[0].trim().toLowerCase();
  if (OFFICE_MIMES[mime]) return OFFICE_MIMES[mime];
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return OFFICE_EXTENSIONS[extension] || null;
}

export function officeCellText(value, locale = "fr-FR") {
  if (value == null) return "";
  if (value instanceof Date) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(value);
  }
  if (typeof value !== "object") return String(value);
  if (value.result != null) return officeCellText(value.result, locale);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
  if (value.text != null) return String(value.text);
  if (value.hyperlink != null) return String(value.hyperlink);
  if (value.error != null) return String(value.error);
  return "";
}

export function copiedArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  throw new TypeError("Les données du document sont invalides.");
}

export function clearOfficePreviewResources() {
  for (const cleanup of previewCleanups) cleanup();
  previewCleanups.clear();
}

const OFFICE_CAPTURE_STYLE_PROPERTIES = [
  "box-sizing", "display", "position", "top", "left", "right", "bottom", "width", "height",
  "min-width", "min-height", "max-width", "max-height", "margin", "margin-top", "margin-right",
  "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-indent", "text-transform", "white-space", "color",
  "background", "background-color", "background-image", "background-size", "background-position",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-width",
  "border-style", "border-color", "border-collapse", "border-spacing", "border-radius",
  "vertical-align", "list-style", "opacity", "overflow", "overflow-wrap", "word-break",
  "transform", "transform-origin", "flex", "flex-direction", "flex-wrap", "align-items",
  "align-content", "justify-content", "grid-template-columns", "grid-template-rows", "gap",
];

function copyComputedStyles(source, target) {
  const computed = getComputedStyle(source);
  for (const property of OFFICE_CAPTURE_STYLE_PROPERTIES) {
    target.style.setProperty(property, computed.getPropertyValue(property));
  }
  const sourceChildren = [...source.children];
  const targetChildren = [...target.children];
  for (let index = 0; index < sourceChildren.length; index += 1) {
    if (targetChildren[index]) copyComputedStyles(sourceChildren[index], targetChildren[index]);
  }
}

function officeCanvasJPEG(canvas, quality = 0.82) {
  return new Promise((resolve) => {
    const formats = [
      { type: "image/jpeg", quality },
      // Some Safari/WebView versions can render the canvas but refuse JPEG
      // encoding. PNG keeps the preview usable in that case.
      { type: "image/png" },
    ];
    let formatIndex = 0;

    const encodeNextFormat = () => {
      const format = formats[formatIndex++];
      if (!format) {
        resolve(null);
        return;
      }

      const fallback = () => {
        try {
          const dataURL = canvas.toDataURL(format.type, format.quality);
          const [header, payload] = dataURL.split(",");
          const binary = atob(payload);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          resolve(new Blob([bytes], { type: header.match(/data:([^;]+)/)?.[1] || format.type }));
        } catch {
          encodeNextFormat();
        }
      };

      if (typeof canvas.toBlob !== "function") {
        fallback();
        return;
      }

      let settled = false;
      const fallbackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fallback();
      }, 2000);
      try {
        canvas.toBlob((blob) => {
          if (settled) return;
          settled = true;
          clearTimeout(fallbackTimer);
          if (blob && blob.size > 0) {
            resolve(blob);
          } else {
            fallback();
          }
        }, format.type, format.quality);
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(fallbackTimer);
          fallback();
        }
      }
    };

    encodeNextFormat();
  });
}

async function rasterizeOfficeElement(element, width, height) {
  const naturalWidth = Math.max(1, Math.ceil(width || element.scrollWidth || element.getBoundingClientRect().width));
  const naturalHeight = Math.max(1, Math.ceil(height || element.scrollHeight || element.getBoundingClientRect().height));
  const clone = element.cloneNode(true);
  copyComputedStyles(element, clone);
  clone.style.width = `${naturalWidth}px`;
  clone.style.height = `${naturalHeight}px`;
  clone.style.maxWidth = "none";
  clone.style.maxHeight = "none";
  clone.style.overflow = "visible";
  clone.style.transform = "none";
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${naturalWidth}" height="${naturalHeight}" viewBox="0 0 ${naturalWidth} ${naturalHeight}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${naturalWidth}px;height:${naturalHeight}px;overflow:hidden;background:#ffffff">${serialized}</div></foreignObject></svg>`;
  const sourceURL = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const source = new Image();
    const loadSource = (url) => new Promise((resolve, reject) => {
      source.onload = resolve;
      source.onerror = () => reject(new Error("Le rendu image du document Office est illisible."));
      source.src = url;
    });
    try {
      await loadSource(sourceURL);
    } catch {
      await loadSource(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Le contexte de rendu image est indisponible.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, naturalWidth, naturalHeight);
    context.drawImage(source, 0, 0, naturalWidth, naturalHeight);
    const blob = await officeCanvasJPEG(canvas);
    if (!blob) throw new Error("La conversion image du document Office est indisponible.");
    return { blob, width: naturalWidth, height: naturalHeight };
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
}

async function tryRasterizeOfficeElement(element, width, height) {
  try {
    return await rasterizeOfficeElement(element, width, height);
  } catch (error) {
    // Rendering the Office DOM remains useful even when a browser blocks
    // SVG/foreignObject rasterization or canvas export.
    console.warn("Conversion image du document Office impossible", error);
    return null;
  }
}

function fitOfficeDOMPreview(frame, content, width, height, container) {
  const frameWidth = frame.getBoundingClientRect().width;
  const containerWidth = container.getBoundingClientRect().width;
  const computedMaxWidth = cssPixelLength(getComputedStyle(frame).maxWidth);
  // The Office frame is capped at 460px while its parent can be wider. Safari
  // frequently uses this DOM fallback, so scaling against the parent would
  // create a surface wider than the frame and clip its right edge.
  const availableWidth = Math.max(1, frameWidth || Math.min(
    containerWidth || width,
    computedMaxWidth || containerWidth || width,
    width,
  ));
  const scale = Math.min(1, availableWidth / width);
  const scaledWidth = Math.max(1, Math.ceil(width * scale));
  frame.style.width = `${scaledWidth}px`;
  frame.style.height = `${Math.max(1, Math.ceil(height * scale))}px`;
  frame.style.aspectRatio = `${width} / ${height}`;
  frame.style.marginLeft = "auto";
  frame.style.marginRight = "auto";
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
  content.style.left = "0";
  content.style.transform = `scale(${scale})`;
}

function appendOfficeImagePreview(container, preview) {
  const url = URL.createObjectURL(preview.blob);
  previewCleanups.add(() => URL.revokeObjectURL(url));
  const image = document.createElement("img");
  image.className = "office-page-preview";
  image.src = url;
  image.alt = "Aperçu";
  image.decoding = "async";
  image.loading = "eager";
  image.draggable = false;
  image.style.aspectRatio = `${preview.width} / ${preview.height}`;
  image.style.marginLeft = "auto";
  image.style.marginRight = "auto";
  image.style.objectPosition = "center center";
  container.replaceChildren(image);
}

export function officeDataURLPreview(source, width, height) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(source || ""));
  if (!match) return null;
  try {
    const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return {
      blob: new Blob([bytes], { type: match[1] || "application/octet-stream" }),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  } catch {
    return null;
  }
}

function loadScript(source, available) {
  if (available()) return Promise.resolve();
  if (scriptLoads.has(source)) return scriptLoads.get(source);
  const load = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.onload = () => {
      if (available()) {
        resolve();
      } else {
        reject(new Error(`Le moteur ${source} n’est pas disponible.`));
      }
    };
    script.onerror = () => reject(new Error(`Impossible de charger le moteur ${source}.`));
    document.head.append(script);
  }).catch((error) => {
    scriptLoads.delete(source);
    throw error;
  });
  scriptLoads.set(source, load);
  return load;
}

async function wordRenderer() {
  await loadScript(
    `/vendor/jszip/jszip.min.js?v=${OFFICE_PREVIEW_BUILD}`,
    () => typeof globalThis.JSZip === "function",
  );
  await loadScript(
    `/vendor/docx-preview/docx-preview.min.js?v=${OFFICE_PREVIEW_BUILD}`,
    () => typeof globalThis.docx?.renderAsync === "function",
  );
  return globalThis.docx;
}

async function excelRenderer() {
  await loadScript(
    `/vendor/exceljs/exceljs.min.js?v=${OFFICE_PREVIEW_BUILD}`,
    () => typeof globalThis.ExcelJS?.Workbook === "function",
  );
  return globalThis.ExcelJS;
}

async function powerpointRenderer() {
  await loadScript(
    `/vendor/jszip/jszip.min.js?v=${OFFICE_PREVIEW_BUILD}`,
    () => typeof globalThis.JSZip === "function",
  );
  await loadScript(
    `/vendor/pptx-preview/pptx-preview.umd.js?v=${OFFICE_PREVIEW_BUILD}`,
    () => typeof globalThis.pptxPreview?.init === "function",
  );
  return globalThis.pptxPreview;
}

export async function preloadModernOfficePreview(file) {
  const kind = modernOfficeKind(file);
  if (kind === "word") return wordRenderer();
  if (kind === "excel") return excelRenderer();
  if (kind === "powerpoint") return powerpointRenderer();
  return null;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sanitizeRenderedDocument(root) {
  root.querySelectorAll("script, style, iframe, frame, object, embed, form, input, button, select, textarea, audio, video").forEach((element) => element.remove());
  root.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name);
      } else if (["href", "xlink:href", "src", "poster"].includes(name) && !/^(?:data:|blob:|#)/i.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === "style" && /(?:javascript:|expression\s*\(|url\s*\(\s*(['"]?)(?!data:|blob:|#))/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

function appendLimitNote(container, text) {
  const note = document.createElement("small");
  note.className = "office-preview-note";
  note.textContent = text;
  container.append(note);
}

function cssPixelLength(value) {
  const length = Number.parseFloat(value);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function xmlAttribute(source, name) {
  const match = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=\\s*(["'])(.*?)\\1`, "i")
    .exec(source);
  if (!match) return "";
  return match[2]
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function relationshipPartPath(partPath) {
  const separator = partPath.lastIndexOf("/");
  const directory = separator >= 0 ? partPath.slice(0, separator + 1) : "";
  const filename = partPath.slice(separator + 1);
  return `${directory}_rels/${filename}.rels`;
}

function resolvedOfficePartPath(sourcePart, target) {
  const cleanTarget = String(target || "").replace(/\\/g, "/");
  const sourceDirectory = sourcePart.slice(0, Math.max(0, sourcePart.lastIndexOf("/") + 1));
  const segments = (cleanTarget.startsWith("/") ? cleanTarget.slice(1) : sourceDirectory + cleanTarget).split("/");
  const resolved = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join("/");
}

function parsedRelationships(xml, sourcePart) {
  return [...String(xml || "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gi)].map((match) => ({
    id: xmlAttribute(match[0], "Id"),
    type: xmlAttribute(match[0], "Type"),
    target: resolvedOfficePartPath(sourcePart, xmlAttribute(match[0], "Target")),
  }));
}

function naturalOfficePartOrder(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function relatedOfficePart(archive, sourcePart, typeSuffix) {
  const relationshipFile = archive.file(relationshipPartPath(sourcePart));
  if (!relationshipFile) return "";
  const relationships = parsedRelationships(await relationshipFile.async("text"), sourcePart);
  const normalizedSuffix = typeSuffix.toLowerCase();
  return relationships.find((relationship) => {
    const type = relationship.type.toLowerCase();
    return type === normalizedSuffix || type.endsWith(`/${normalizedSuffix}`);
  })?.target || "";
}

async function firstPresentationSlidePath(archive, slidePaths) {
  const presentationFile = archive.file("ppt/presentation.xml");
  const relationshipsFile = archive.file("ppt/_rels/presentation.xml.rels");
  if (!presentationFile || !relationshipsFile) return slidePaths[0] || "";
  const presentationXML = await presentationFile.async("text");
  const firstSlideTag = /<(?:[A-Za-z_][\w.-]*:)?sldId\b[^>]*>/i.exec(presentationXML)?.[0] || "";
  const relationshipID = xmlAttribute(firstSlideTag, "r:id") || xmlAttribute(firstSlideTag, "id");
  if (!relationshipID) return slidePaths[0] || "";
  const relationships = parsedRelationships(await relationshipsFile.async("text"), "ppt/presentation.xml");
  return relationships.find((relationship) => relationship.id === relationshipID)?.target || slidePaths[0] || "";
}

function escapedXMLAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function firstSlidePowerPointArchive(data) {
  const JSZip = globalThis.JSZip;
  if (typeof JSZip !== "function") return null;
  const archive = await JSZip.loadAsync(copiedArrayBuffer(data));
  const paths = Object.keys(archive.files);
  const slidePaths = paths.filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort(naturalOfficePartOrder);
  if (!slidePaths.length) return null;

  const slidePath = await firstPresentationSlidePath(archive, slidePaths);
  const layoutPaths = paths.filter((path) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(path)).sort(naturalOfficePartOrder);
  const masterPaths = paths.filter((path) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(path)).sort(naturalOfficePartOrder);
  const themePaths = paths.filter((path) => /^ppt\/theme\/theme\d+\.xml$/i.test(path)).sort(naturalOfficePartOrder);
  const layoutPath = await relatedOfficePart(archive, slidePath, "slideLayout") || layoutPaths[0] || "";
  const masterPath = layoutPath ? await relatedOfficePart(archive, layoutPath, "slideMaster") || masterPaths[0] || "" : masterPaths[0] || "";
  const themePath = masterPath ? await relatedOfficePart(archive, masterPath, "theme") || themePaths[0] || "" : themePaths[0] || "";

  const contentTypesFile = archive.file("[Content_Types].xml");
  if (!contentTypesFile) return null;
  let contentTypes = await contentTypesFile.async("text");
  const renderPartPattern = /^ppt\/(?:slides\/slide\d+|slideLayouts\/slideLayout\d+|slideMasters\/slideMaster\d+|theme\/theme\d+)\.xml$/i;
  contentTypes = contentTypes.replace(/<Override\b[^>]*\/?\s*>/gi, (override) => {
    const partName = xmlAttribute(override, "PartName").replace(/^\//, "");
    return renderPartPattern.test(partName) ? "" : override;
  });
  const overrides = [
    [slidePath, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],
    [layoutPath, "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
    [masterPath, "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
    [themePath, "application/vnd.openxmlformats-officedocument.theme+xml"],
  ].filter(([path]) => path && archive.file(path));
  const overrideXML = overrides.map(([path, contentType]) => (
    `<Override PartName="/${escapedXMLAttribute(path)}" ContentType="${contentType}"/>`
  )).join("");
  if (!/<\/Types\s*>/i.test(contentTypes)) return null;
  contentTypes = contentTypes.replace(/<\/Types\s*>/i, `${overrideXML}</Types>`);
  archive.file("[Content_Types].xml", contentTypes);
  return {
    data: await archive.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    }),
    originalSlideCount: slidePaths.length,
    slidePath,
  };
}

function decodedXMLText(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function powerpointImageMIME(path) {
  const extension = path.split(".").pop()?.toLowerCase();
  return {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  }[extension] || "";
}

async function rasterizedPowerPointImage(blob, width, height) {
  const sourceURL = URL.createObjectURL(blob);
  try {
    const source = new Image();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("L’image de la première diapositive a expiré.")), 5000);
      source.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      source.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("L’image de la première diapositive est illisible."));
      };
      source.src = sourceURL;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / source.naturalWidth, height / source.naturalHeight);
    const renderedWidth = source.naturalWidth * scale;
    const renderedHeight = source.naturalHeight * scale;
    context.drawImage(source, (width - renderedWidth) / 2, (height - renderedHeight) / 2, renderedWidth, renderedHeight);
    const rendered = await officeCanvasJPEG(canvas);
    return rendered ? { blob: rendered, width, height } : null;
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
}

async function extractedFirstPowerPointSlide(data, width, height) {
  const JSZip = globalThis.JSZip;
  if (typeof JSZip !== "function") return null;
  const archive = await JSZip.loadAsync(copiedArrayBuffer(data));
  const slidePaths = Object.keys(archive.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort(naturalOfficePartOrder);
  if (!slidePaths.length) return null;
  const slidePath = await firstPresentationSlidePath(archive, slidePaths);
  const slideFile = archive.file(slidePath);
  if (!slideFile) return null;
  const slideXML = await slideFile.async("text");
  const text = [...slideXML.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>/gi)]
    .map((match) => decodedXMLText(match[1]).trim())
    .filter(Boolean);

  const relationshipFile = archive.file(relationshipPartPath(slidePath));
  let image = null;
  if (relationshipFile) {
    const relationships = parsedRelationships(await relationshipFile.async("text"), slidePath)
      .filter((relationship) => relationship.type.toLowerCase().endsWith("/image"));
    const candidates = [];
    for (const relationship of relationships) {
      const mime = powerpointImageMIME(relationship.target);
      const imageFile = mime ? archive.file(relationship.target) : null;
      if (!imageFile) continue;
      const bytes = await imageFile.async("uint8array");
      candidates.push({ blob: new Blob([bytes], { type: mime }), size: bytes.byteLength });
    }
    candidates.sort((left, right) => right.size - left.size);
    if (candidates[0]) {
      image = await rasterizedPowerPointImage(candidates[0].blob, width, height).catch(() => null);
      if (!image) image = { blob: candidates[0].blob, width, height };
    }
  }
  return { image, text };
}

async function renderExtractedPowerPointSlide(file, container, frame, content, slideHeight, compact, translate, rasterOnly) {
  const extracted = await extractedFirstPowerPointSlide(file.data, 960, slideHeight);
  if (!extracted) throw new Error("Impossible de lire la première diapositive PowerPoint.");
  if (extracted.image) {
    if (!rasterOnly) {
      appendOfficeImagePreview(container, extracted.image);
      if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
    }
    return extracted.image;
  }

  content.replaceChildren();
  content.classList.add("office-powerpoint-extracted-content");
  content.style.boxSizing = "border-box";
  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.style.justifyContent = "center";
  content.style.gap = "24px";
  content.style.padding = "72px";
  content.style.overflow = "hidden";
  content.style.background = "#ffffff";
  content.style.color = "#172124";
  const title = document.createElement("strong");
  title.style.font = "700 42px/1.15 system-ui, sans-serif";
  title.textContent = extracted.text[0] || "";
  const body = document.createElement("div");
  body.style.font = "28px/1.35 system-ui, sans-serif";
  body.style.whiteSpace = "pre-wrap";
  body.textContent = extracted.text.slice(1).join("\n") || (extracted.text[0] ? "" : " ");
  content.append(title, body);
  await nextFrame();
  const preview = await tryRasterizeOfficeElement(content, 960, slideHeight);
  if (rasterOnly) return preview;
  if (preview) {
    appendOfficeImagePreview(container, preview);
  } else {
    fitOfficeDOMPreview(frame, content, 960, slideHeight, container);
  }
  if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
  return preview;
}

function preparedPowerPointSlide(content, fallbackWidth, fallbackHeight) {
  const slide = content.querySelector(".pptx-preview-slide-wrapper");
  if (!slide) return { element: content, width: fallbackWidth, height: fallbackHeight };
  const bounds = slide.getBoundingClientRect();
  const computed = getComputedStyle(slide);
  const width = Math.max(1, Math.ceil(
    cssPixelLength(computed.width) || bounds.width || slide.offsetWidth || fallbackWidth,
  ));
  const height = Math.max(1, Math.ceil(
    cssPixelLength(computed.height) || bounds.height || slide.offsetHeight || fallbackHeight,
  ));
  // The renderer positions the slide absolutely with left:auto and auto
  // margins. Those static-position rules can shift the serialized capture and
  // clip its right edge. Anchor the slide at the capture origin instead.
  slide.style.position = "relative";
  slide.style.inset = "0 auto auto 0";
  slide.style.margin = "0";
  slide.style.width = `${width}px`;
  slide.style.height = `${height}px`;
  const wrapper = slide.parentElement;
  if (wrapper) {
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.overflow = "hidden";
  }
  return { element: slide, width, height };
}

export function wordPageViewport(page) {
  const computed = getComputedStyle(page);
  const bounds = page.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(
    cssPixelLength(computed.width) || bounds.width || page.scrollWidth || 816,
  ));
  // docx-preview uses min-height for the physical sheet. The section's actual
  // height can include the entire flowing document when Word did not persist
  // automatic page breaks, so it must not be used as the preview height.
  const declaredHeight = cssPixelLength(computed.minHeight) || cssPixelLength(page.style.height);
  const height = Math.max(1, Math.ceil(declaredHeight || width * (1056 / 816)));
  return { width, height };
}

function cropWordDOMToFirstPage(page, bodyContainer, width, height) {
  page.style.width = `${width}px`;
  page.style.height = `${height}px`;
  page.style.minHeight = `${height}px`;
  page.style.maxHeight = `${height}px`;
  page.style.overflow = "hidden";
  const wrapper = page.parentElement;
  if (wrapper) {
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.maxHeight = `${height}px`;
    wrapper.style.overflow = "hidden";
  }
  bodyContainer.style.width = `${width}px`;
  bodyContainer.style.height = `${height}px`;
  bodyContainer.style.maxHeight = `${height}px`;
  bodyContainer.style.overflow = "hidden";
}

async function renderWordPreview(file, container, compact, translate, rasterOnly) {
  const docx = await wordRenderer();
  const frame = document.createElement("div");
  frame.className = "office-document-preview office-word-preview";
  const isolation = document.createElement("style");
  isolation.textContent = `
    .office-word-preview { position: relative; display: block; width: 100%; overflow: hidden; background: #fff; color: #172124; }
    .office-word-content { position: absolute; inset: 0 auto auto 0; transform-origin: top left; }
    .docx-wrapper { align-items: flex-start !important; padding: 0 !important; background: transparent !important; }
    .docx-wrapper > section.docx { margin: 0 !important; box-shadow: none !important; }
    a { color: inherit; text-decoration: none; pointer-events: none; }
  `;
  const styleContainer = document.createElement("div");
  const bodyContainer = document.createElement("div");
  bodyContainer.className = "office-word-content";
  frame.append(isolation, styleContainer, bodyContainer);
  container.append(frame);

  await docx.renderAsync(copiedArrayBuffer(file.data), bodyContainer, styleContainer, {
    breakPages: true,
    className: "docx",
    experimental: false,
    ignoreFonts: true,
    ignoreLastRenderedPageBreak: false,
    inWrapper: true,
    renderAltChunks: false,
    renderChanges: false,
    renderComments: false,
    useBase64URL: true,
  });
  sanitizeRenderedDocument(bodyContainer);
  const pages = [...bodyContainer.querySelectorAll("section.docx")];
  pages.slice(1).forEach((page) => page.remove());
  const page = pages[0] || bodyContainer.firstElementChild;
  if (!page) throw new Error("Le document Word est vide.");
  const { width: naturalWidth, height: naturalHeight } = wordPageViewport(page);
  cropWordDOMToFirstPage(page, bodyContainer, naturalWidth, naturalHeight);
  await nextFrame();
  const preview = await tryRasterizeOfficeElement(page, naturalWidth, naturalHeight);
  if (!preview) {
    if (rasterOnly) return null;
    fitOfficeDOMPreview(frame, bodyContainer, naturalWidth, naturalHeight, container);
  }
  if (!rasterOnly) {
    if (preview) {
      appendOfficeImagePreview(container, preview);
      if (!compact) appendLimitNote(container, translate("Aperçu limité à la première page."));
    } else if (!compact) {
      appendLimitNote(container, translate("Aperçu affiché dans le document Office."));
    }
  }
  return preview;
}

async function renderExcelPreview(file, container, compact, translate, locale, rasterOnly) {
  const ExcelJS = await excelRenderer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(copiedArrayBuffer(file.data));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Le classeur Excel est vide.");

  const shell = document.createElement("div");
  shell.className = "office-document-preview office-sheet-preview";
  const scroll = document.createElement("div");
  scroll.className = "office-sheet-scroll";
  const table = document.createElement("table");
  table.className = "office-sheet-table";
  const maxRows = compact ? 6 : 32;
  const maxColumns = compact ? 5 : 14;
  const rowCount = Math.min(Math.max(worksheet.actualRowCount, worksheet.rowCount), maxRows);
  const columnCount = Math.min(Math.max(worksheet.actualColumnCount, worksheet.columnCount), maxColumns);

  for (let rowNumber = 1; rowNumber <= Math.max(1, rowCount); rowNumber++) {
    const rowElement = document.createElement("tr");
    const row = worksheet.getRow(rowNumber);
    for (let columnNumber = 1; columnNumber <= Math.max(1, columnCount); columnNumber++) {
      const cell = document.createElement(rowNumber === 1 ? "th" : "td");
      const text = officeCellText(row.getCell(columnNumber).value, locale);
      cell.textContent = text.length > 160 ? `${text.slice(0, 157)}…` : text;
      rowElement.append(cell);
    }
    table.append(rowElement);
  }
  scroll.append(table);
  shell.append(scroll);
  container.append(shell);
  if (!compact) {
    const sheetName = document.createElement("strong");
    sheetName.className = "office-sheet-name";
    sheetName.textContent = worksheet.name;
    shell.prepend(sheetName);
    appendLimitNote(container, translate("Aperçu limité à la première feuille."));
  }
  await nextFrame();
  const preview = await tryRasterizeOfficeElement(
    table,
    Math.max(1, table.scrollWidth || table.getBoundingClientRect().width),
    Math.max(1, table.scrollHeight || table.getBoundingClientRect().height),
  );
  if (rasterOnly && !preview) return null;
  if (!rasterOnly && preview) appendOfficeImagePreview(container, preview);
  return preview;
}

async function renderPowerPointPreview(file, container, compact, translate, rasterOnly) {
  const pptx = await powerpointRenderer();
  const frame = document.createElement("div");
  frame.className = "office-document-preview office-powerpoint-preview";
  const content = document.createElement("div");
  content.className = "office-powerpoint-content";
  content.style.width = "960px";
  content.style.height = "540px";
  frame.append(content);
  container.append(frame);

  const previewer = pptx.init(content, { width: 960, height: 540, mode: "slide" });
  try {
    let presentation = null;
    let slideCount = 0;
    try {
      presentation = await previewer.load(copiedArrayBuffer(file.data));
      slideCount = Number(previewer.slideCount) || presentation?.slides?.length || 0;
    } catch (error) {
      console.warn("Lecture directe de la présentation PowerPoint impossible", error);
    }
    if (!slideCount) {
      try {
        const firstSlideArchive = await firstSlidePowerPointArchive(file.data);
        if (firstSlideArchive) {
          presentation = await previewer.load(firstSlideArchive.data);
          slideCount = Number(previewer.slideCount) || presentation?.slides?.length || 0;
        }
      } catch (error) {
        console.warn("Récupération de la première diapositive PowerPoint impossible", error);
      }
    }
    const presentationWidth = Number(presentation?.width) || 960;
    const presentationHeight = Number(presentation?.height) || 540;
    const slideHeight = Math.max(1, Math.round(960 * (presentationHeight / presentationWidth)));
    frame.style.aspectRatio = `960 / ${slideHeight}`;
    content.style.height = `${slideHeight}px`;
    previewer.wrapper.style.height = `${slideHeight}px`;
    if (previewer.htmlRender?.options?.viewPort) {
      previewer.htmlRender.options.viewPort.height = slideHeight;
    }
    const thumbnail = officeDataURLPreview(presentation?.thumbnail, 960, slideHeight);
    if (!slideCount) {
      // pptx-preview silently turns some valid OOXML parsing failures into an
      // empty slides array. PowerPoint's embedded thumbnail is still the first
      // slide and provides a useful, faithful fallback in that case.
      if (thumbnail) {
        if (!rasterOnly) {
          appendOfficeImagePreview(container, thumbnail);
          if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
        }
        return thumbnail;
      }
      return renderExtractedPowerPointSlide(
        file,
        container,
        frame,
        content,
        slideHeight,
        compact,
        translate,
        rasterOnly,
      );
    }
    try {
      previewer.renderSingleSlide(0);
    } catch (error) {
      if (!thumbnail) throw error;
      if (!rasterOnly) {
        appendOfficeImagePreview(container, thumbnail);
        if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
      }
      return thumbnail;
    }
    await nextFrame();
    sanitizeRenderedDocument(content);
    const renderedSlide = preparedPowerPointSlide(content, 960, slideHeight);
    frame.style.aspectRatio = `${renderedSlide.width} / ${renderedSlide.height}`;
    const preview = await tryRasterizeOfficeElement(
      renderedSlide.element,
      renderedSlide.width,
      renderedSlide.height,
    );
    if (!preview) {
      if (rasterOnly) return thumbnail;
      if (!thumbnail) {
        fitOfficeDOMPreview(frame, content, renderedSlide.width, renderedSlide.height, container);
      }
    }
    if (!rasterOnly) {
      if (preview || thumbnail) {
        appendOfficeImagePreview(container, preview || thumbnail);
        if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
      } else if (!compact) {
        appendLimitNote(container, translate("Aperçu affiché dans le document Office."));
      }
    }
    return preview || thumbnail;
  } finally {
    previewer.destroy?.();
  }
}

export async function renderModernOfficePreview(file, container, options = {}) {
  const kind = modernOfficeKind(file);
  if (!kind) throw new Error("Ce document Office n’est pas pris en charge.");
  const compact = options.compact === true;
  const rasterOnly = options.rasterOnly === true;
  const translate = options.translate || ((value) => value);
  const locale = options.locale || "fr-FR";
  const loading = document.createElement("span");
  loading.className = "file-preview-loading office-preview-loading";
  loading.textContent = translate("Chargement…");
  container.append(loading);
  container.classList.add("office-file-preview", `office-${kind}-file-preview`);
  // Les aperçus Office sont uniquement visuels. Dans Safari, le contenu DOCX/PPTX
  // de secours est une grande couche DOM mise à l’échelle avec transform. WebKit
  // peut conserver sa zone de hit-test d’origine au-delà du cadre visible et bloquer
  // des commandes voisines, notamment le lien Administration de la barre latérale.
  container.inert = true;
  container.style.pointerEvents = "none";
  try {
    if (kind === "word") {
      return (await renderWordPreview(file, container, compact, translate, rasterOnly))?.blob || null;
    } else if (kind === "excel") {
      return (await renderExcelPreview(file, container, compact, translate, locale, rasterOnly))?.blob || null;
    } else {
      return (await renderPowerPointPreview(file, container, compact, translate, rasterOnly))?.blob || null;
    }
  } finally {
    loading.remove();
  }
}
