const OFFICE_PREVIEW_BUILD = "ios17-pdf-v199";
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
  const availableWidth = Math.max(1, container.getBoundingClientRect().width || width);
  const scale = Math.min(1, availableWidth / width);
  frame.style.height = `${Math.max(1, Math.ceil(height * scale))}px`;
  frame.style.aspectRatio = `${width} / ${height}`;
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
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
  container.replaceChildren(image);
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
  await nextFrame();
  const page = pages[0] || bodyContainer.firstElementChild;
  if (!page) throw new Error("Le document Word est vide.");
  const bounds = page.getBoundingClientRect();
  const naturalWidth = Math.max(1, Math.ceil(bounds.width || page.scrollWidth || 816));
  const naturalHeight = Math.max(1, Math.ceil(bounds.height || page.scrollHeight || 1056));
  bodyContainer.style.width = `${naturalWidth}px`;
  bodyContainer.style.height = `${naturalHeight}px`;
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
    const presentation = await previewer.load(copiedArrayBuffer(file.data));
    if (!presentation?.slides?.length) throw new Error("La présentation PowerPoint est vide.");
    previewer.renderSingleSlide(0);
    sanitizeRenderedDocument(content);
    const preview = await tryRasterizeOfficeElement(content, 960, 540);
    if (!preview) {
      if (rasterOnly) return null;
      fitOfficeDOMPreview(frame, content, 960, 540, container);
    }
    if (!rasterOnly) {
      if (preview) {
        appendOfficeImagePreview(container, preview);
        if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
      } else if (!compact) {
        appendLimitNote(container, translate("Aperçu affiché dans le document Office."));
      }
    }
    return preview;
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
