const SESSION_APPROVAL_PATH = "/link-device.html";
const SESSION_APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sessionApprovalTokenFromQR(value, instanceURL) {
  let scannedURL;
  let instance;
  try {
    scannedURL = new URL(String(value || "").trim());
    instance = new URL(String(instanceURL || "").trim());
  } catch {
    return "";
  }
  if (scannedURL.origin !== instance.origin
    || scannedURL.pathname !== SESSION_APPROVAL_PATH
    || scannedURL.username
    || scannedURL.password
    || scannedURL.search) return "";
  const token = new URLSearchParams(scannedURL.hash.slice(1)).get("token")?.trim() || "";
  return SESSION_APPROVAL_TOKEN_PATTERN.test(token) ? token : "";
}

export function decodeQRImageData(imageData) {
  if (typeof globalThis.jsQR !== "function" || !imageData?.data || !imageData.width || !imageData.height) return "";
  return globalThis.jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  })?.data?.trim() || "";
}
