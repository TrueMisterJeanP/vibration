const LINK_CANDIDATE_PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s<>"']*)?|(?:\+|00)?\d(?:[\d().\u00a0\u202f -]{5,}\d)/giu;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/u;
const PHONE_DATE_PATTERN = /^(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])$/u;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function trimURLCandidate(value) {
  let result = value.replace(TRAILING_URL_PUNCTUATION, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (result.endsWith(closing) && result.split(closing).length > result.split(opening).length) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

function hasLinkBoundaries(source, start, length) {
  const before = source[start - 1] || "";
  const after = source[start + length] || "";
  return !/[\p{L}\p{N}_@]/u.test(before) && !/[\p{L}\p{N}_@]/u.test(after);
}

function normalizePhone(value) {
  const withoutInternationalTrunk = value.replace(/^(\+\d{1,3}|00\d{1,3})[\s.-]*\(0\)/u, "$1");
  return withoutInternationalTrunk.replace(/(?!^)\+|[^\d+]/gu, "");
}

function phoneToken(value) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 7 || digits.length > 15 || PHONE_DATE_PATTERN.test(value) || IPV4_PATTERN.test(value)) return null;
  const phone = normalizePhone(value);
  return { type: "phone", text: value, href: `tel:${phone}`, smsHref: `sms:${phone}` };
}

function linkToken(value) {
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@/iu.test(value)) {
    return { type: "email", text: value, href: `mailto:${value}` };
  }
  if (/^(?:https?:\/\/|www\.)/iu.test(value) || /[a-z0-9-]\.[a-z]{2,63}/iu.test(value)) {
    const href = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(href);
      if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return null;
      return { type: "url", text: value, href: url.toString() };
    } catch {
      return null;
    }
  }
  return phoneToken(value);
}

export function messageLinkTokens(value) {
  const source = String(value ?? "");
  const tokens = [];
  let textStart = 0;
  LINK_CANDIDATE_PATTERN.lastIndex = 0;
  for (let match = LINK_CANDIDATE_PATTERN.exec(source); match; match = LINK_CANDIDATE_PATTERN.exec(source)) {
    const raw = match[0];
    const candidate = /^(?:https?:\/\/|www\.)/iu.test(raw) ? trimURLCandidate(raw) : raw;
    if (!candidate || !hasLinkBoundaries(source, match.index, candidate.length)) continue;
    const token = linkToken(candidate);
    if (!token) continue;
    if (match.index > textStart) tokens.push({ type: "text", text: source.slice(textStart, match.index) });
    tokens.push(token);
    textStart = match.index + candidate.length;
    LINK_CANDIDATE_PATTERN.lastIndex = textStart;
  }
  if (textStart < source.length) tokens.push({ type: "text", text: source.slice(textStart) });
  return tokens;
}
