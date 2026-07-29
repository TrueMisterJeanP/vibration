export function isIOSWebKit(navigatorLike = globalThis.navigator) {
  const userAgent = String(navigatorLike?.userAgent || "");
  const platform = String(navigatorLike?.platform || "");
  const touchPoints = Number(navigatorLike?.maxTouchPoints || 0);
  return /iP(?:hone|ad|od)/i.test(userAgent)
    || (platform === "MacIntel" && touchPoints > 1);
}

export function needsInlinePDFWorker(navigatorLike = globalThis.navigator) {
  if (!isIOSWebKit(navigatorLike)) return false;
  const match = String(navigatorLike?.userAgent || "").match(/\bCPU(?: iPhone)? OS (\d+)(?:[_.]\d+)?/i);
  // Le mode « site pour ordinateur » d'iPadOS masque parfois sa version.
  // Dans ce cas, le chemin de compatibilité est le choix le plus sûr.
  return !match || Number(match[1]) <= 17;
}

export function pdfDocumentCompatibilityOptions(navigatorLike = globalThis.navigator) {
  if (!needsInlinePDFWorker(navigatorLike)) return {};
  return {
    // PDF.js 3.11 est conservé uniquement comme moteur de repli iOS 17.
    // Désactiver l’évaluation dynamique neutralise son ancien compilateur de
    // glyphes et évite aussi les blocages liés à la CSP de WebKit.
    isEvalSupported: false,
    disableFontFace: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
  };
}
