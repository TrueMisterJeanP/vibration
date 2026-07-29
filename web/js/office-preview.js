const OFFICE_PREVIEW_BUILD = "ios17-pdf-v184";
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

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function observeScale(frame, content, naturalWidth, naturalHeight) {
  const resize = () => {
    if (!frame.isConnected) return;
    const width = frame.getBoundingClientRect().width;
    if (width <= 0) return;
    const scale = width / naturalWidth;
    content.style.transform = `scale(${scale})`;
    frame.style.height = `${Math.ceil(naturalHeight * scale)}px`;
  };
  resize();
  if (!("ResizeObserver" in window)) {
    requestAnimationFrame(resize);
    return;
  }
  const observer = new ResizeObserver(resize);
  const cleanup = () => observer.disconnect();
  previewCleanups.add(cleanup);
  observer.observe(frame);
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

async function renderWordPreview(file, container, compact, translate) {
  const docx = await wordRenderer();
  const frame = document.createElement("div");
  frame.className = "office-document-preview office-word-preview";
  const shadow = frame.attachShadow({ mode: "open" });
  const isolation = document.createElement("style");
  isolation.textContent = `
    :host { position: relative; display: block; width: 100%; overflow: hidden; background: #fff; color: #172124; }
    .office-word-content { position: absolute; inset: 0 auto auto 0; transform-origin: top left; }
    .docx-wrapper { align-items: flex-start !important; padding: 0 !important; background: transparent !important; }
    .docx-wrapper > section.docx { margin: 0 !important; box-shadow: none !important; }
    a { color: inherit; text-decoration: none; pointer-events: none; }
  `;
  const styleContainer = document.createElement("div");
  const bodyContainer = document.createElement("div");
  bodyContainer.className = "office-word-content";
  shadow.append(isolation, styleContainer, bodyContainer);
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
  observeScale(frame, bodyContainer, naturalWidth, naturalHeight);
  if (!compact) appendLimitNote(container, translate("Aperçu limité à la première page."));
}

async function renderExcelPreview(file, container, compact, translate, locale) {
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
}

async function renderPowerPointPreview(file, container, compact, translate) {
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
  previewCleanups.add(() => previewer.destroy?.());
  const presentation = await previewer.load(copiedArrayBuffer(file.data));
  if (!presentation?.slides?.length) throw new Error("La présentation PowerPoint est vide.");
  previewer.renderSingleSlide(0);
  sanitizeRenderedDocument(content);
  observeScale(frame, content, 960, 540);
  if (!compact) appendLimitNote(container, translate("Aperçu limité à la première diapositive."));
}

export async function renderModernOfficePreview(file, container, options = {}) {
  const kind = modernOfficeKind(file);
  if (!kind) throw new Error("Ce document Office n’est pas pris en charge.");
  const compact = options.compact === true;
  const translate = options.translate || ((value) => value);
  const locale = options.locale || "fr-FR";
  const loading = document.createElement("span");
  loading.className = "file-preview-loading office-preview-loading";
  loading.textContent = translate("Chargement…");
  container.append(loading);
  container.classList.add("office-file-preview", `office-${kind}-file-preview`);
  try {
    if (kind === "word") {
      await renderWordPreview(file, container, compact, translate);
    } else if (kind === "excel") {
      await renderExcelPreview(file, container, compact, translate, locale);
    } else {
      await renderPowerPointPreview(file, container, compact, translate);
    }
  } finally {
    loading.remove();
  }
}
