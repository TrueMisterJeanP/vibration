const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const office = fs.readFileSync(path.join(root, "web/js/office-preview.js"), "utf8");
const thumbnailSourceLate = app.slice(
  app.indexOf("async function renderEncryptedFileThumbnail("),
  app.indexOf("function loadPreviewImage(url)"),
);
const renderSourceLate = app.slice(
  app.indexOf("async function renderFilePreview(message, container, key)"),
  app.indexOf("async function renderReplyFilePreview("),
);

// Aucun voyant de chargement n'est posé dans la bulle : l'aperçu est préparé
// avant que le fil n'arrive jusqu'à lui, « aria-busy » suffit à l'accessibilité.
assert.doesNotMatch(office, /loading\.textContent = translate\("Chargement…"\)/);
assert.doesNotMatch(office, /container\.append\(loading\)/);
assert.match(office, /container\.setAttribute\("aria-busy", "true"\)/);
// Et les aperçus restants sont produits en fond, du plus proche au plus loin.
assert.match(app, /void renderRemainingFilePreviews\(conversationID\);/);
assert.match(app, /async function renderRemainingFilePreviews\(conversationID\)[\s\S]*nearestPendingFilePreviewID\(\)[\s\S]*await ensureRenderedMessageFilePreview\(id\)/);
assert.match(app, /function nearestPendingFilePreviewID\(\)[\s\S]*state\.pendingFilePreviews[\s\S]*Math\.abs\(pending\.container\.getBoundingClientRect\(\)\.top - viewportTop\)/);
// La vignette de réponse garde son référentiel de positionnement.
assert.match(css, /\.message-reply-file-thumb \{[^}]*position: relative/);
// Aucune containment de peinture sur l'aperçu : WebKit laissait des tuiles
// jamais repeintes quand un aperçu changeait de taille pendant le défilement.
assert.doesNotMatch(css, /\.file-preview \{[^}]*contain:/);

// Le style public restauré ne rajoute aucun effet visuel à l'injection.
assert.doesNotMatch(css, /@keyframes file-preview-appear/);
assert.doesNotMatch(css, /\.file-preview-appearing/);
// Toute injection reste atomique et restaure son repère de lecture.
assert.match(app, /function commitReservedFilePreview\(container, commit\) \{[\s\S]*revealCommittedFilePreview\(container\);\s*restoreReservedFilePreviewCommit\(anchor\);/);

// Rien ne doit bouger tant que la discussion défile : l'aperçu attend la pause
// au lieu de s'injecter sous les doigts, faute de quoi son décalage ne pourrait
// être rattrapé par aucun recadrage (Safari écarte les écritures de défilement
// faites pendant un geste).
assert.match(app, /function waitForMessageScrollIdle\(\) \{\s*if \(!userIsScrollingMessages\(\)\) return Promise\.resolve\(\);/);
// Le téléchargement, le déchiffrement et la rastérisation ne touchent pas à
// l'affichage : ils tournent pendant le geste, sinon l'aperçu ne commencerait à
// charger qu'à l'arrêt. Le rendu n'attend donc pas.
const trackedStart = app.indexOf("function trackedFilePreviewRender(message, container, key)");
const trackedEnd = app.indexOf("async function ensureRenderedMessageFilePreview", trackedStart);
const trackedSource = app.slice(trackedStart, trackedEnd);
assert.ok(trackedStart >= 0 && trackedEnd > trackedStart);
assert.doesNotMatch(trackedSource, /waitForMessageScrollIdle/);
// Mais chaque insertion dans une bulle, elle, attend la pause.
assert.match(thumbnailSourceLate, /await waitForMessageScrollIdle\(\);\s*if \(!container\.isConnected\) return false;/);
assert.match(renderSourceLate, /await waitForMessageScrollIdle\(\);\s*if \(!container\.isConnected\) return;\s*if \(!modernOfficeKind\(file\)\)/);
// Vider la surface réservée, poser une image, poser un SVG : trois insertions.
assert.equal(renderSourceLate.match(/await waitForMessageScrollIdle\(\);/g)?.length, 3);
// Le rendu PDF peint son canevas hors écran ; seule l'insertion attend.
const pdfSource = app.slice(
  app.indexOf("async function renderPDFPreview(file, container)"),
  app.indexOf("function recordedVoiceNeedsStableContainer(file)"),
);
assert.match(pdfSource, /await waitForMessageScrollIdle\(\);\s*if \(!container\.isConnected\) return;\s*container\.append\(image\);/);
assert.match(app, /awaitCommitWindow: waitForMessageScrollIdle,/);
assert.match(office, /if \(options\.awaitCommitWindow\) await options\.awaitCommitWindow\(\);\s*if \(!container\.isConnected\) return preview\?\.blob \|\| null;/);

// Le repère de lecture se pose au moment exact de l'injection, jamais depuis un
// ResizeObserver : sous WebKit, déplacer le défilement depuis ce rappel laisse
// des zones jamais repeintes dans la discussion.
assert.doesNotMatch(app, /new ResizeObserver\([\s\S]{0,400}scrollTop \+=/);
assert.doesNotMatch(app, /new ResizeObserver\([\s\S]{0,400}restoreMessageScrollAnchor/);

// Toute injection d'aperçu est ancrée, pas seulement la première : la miniature
// provisoire cède ensuite la place au rendu fidèle, de hauteur différente.
const prepareStart = app.indexOf("function prepareReservedFilePreviewCommit(container)");
const prepareEnd = app.indexOf("function restoreReservedFilePreviewCommit(anchor)", prepareStart);
const prepareSource = app.slice(prepareStart, prepareEnd);
assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
assert.doesNotMatch(prepareSource, /return null;/);
assert.match(prepareSource, /const anchor = elements\.messages\.hasChildNodes\(\)\s*\? captureMessageScrollAnchor\(reservedFilePreviewAnchorRow\(container\)\)\s*: null;/);

// Une image injectée avant son décodage prendrait sa hauteur après coup, hors
// du repère : l'aperçu chiffré et les images entières attendent le décodage.
const thumbnailStart = app.indexOf("async function renderEncryptedFileThumbnail(");
const thumbnailEnd = app.indexOf("function loadPreviewImage(url)", thumbnailStart);
const thumbnailSource = app.slice(thumbnailStart, thumbnailEnd);
assert.ok(thumbnailStart >= 0 && thumbnailEnd > thumbnailStart);
assert.match(thumbnailSource, /await waitForPreviewImage\(image\);\s*if \(!container\.isConnected\) return false;/);
assert.ok(
  thumbnailSource.indexOf("await waitForPreviewImage(image)")
    < thumbnailSource.indexOf("commitReservedFilePreview"),
  "le décodage doit précéder l'injection",
);
// Le calage au ratio appartient à l'injection ancrée.
assert.match(
  thumbnailSource,
  /commitReservedFilePreview\(container, \(\) => \{\s*container\.replaceChildren\(image\);\s*if \(previewMIME\.startsWith\("image\/"\)\) fitImagePreviewToAspect\(container, image\);\s*\}\);/,
);

const renderStart = app.indexOf("async function renderFilePreview(message, container, key)");
const renderEnd = app.indexOf("async function renderReplyFilePreview(", renderStart);
const renderSource = app.slice(renderStart, renderEnd);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
// Vider la surface réservée déplace déjà la discussion : cela s'ancre aussi.
assert.match(
  renderSource,
  /if \(!modernOfficeKind\(file\)\) commitReservedFilePreview\(container, \(\) => container\.replaceChildren\(\)\);/,
);
// Images entières, SVG et aperçu texte : une seule injection ancrée par aperçu.
assert.equal(renderSource.match(/await waitForPreviewImage\(image\);/g)?.length, 2);
assert.equal(renderSource.match(/commitReservedFilePreview\(/g)?.length, 5);
assert.doesNotMatch(renderSource, /container\.append\(image\)/);
assert.doesNotMatch(renderSource, /container\.append\(pre\)/);

// Une bulle plus haute que la vue est parfois la seule candidate au repère :
// son propre haut ne bougeant pas quand elle grandit, le repère serait neutre
// alors que ce qu'on lit descend. On retient donc la bulle qui la suit.
assert.match(app, /function captureMessageScrollAnchor\(preferredRow = null\)/);
assert.match(
  app,
  /function prepareReservedFilePreviewCommit\(container\) \{[\s\S]*captureMessageScrollAnchor\(reservedFilePreviewAnchorRow\(container\)\)/,
);
assert.match(
  app,
  /function reservedFilePreviewAnchorRow\(container\) \{[\s\S]*container\?\.closest\?\.\("\.message-row"\);[\s\S]*row\?\.previousElementSibling;/,
);

// Le repère lui-même : une bulle au-dessus de la vue qui change de hauteur ne
// doit pas déplacer le message lu.
const anchorStart = app.indexOf("function captureMessageScrollAnchor(");
const anchorEnd = app.indexOf("async function scrollMessagesToLatest", anchorStart);
const anchorSource = app.slice(anchorStart, anchorEnd);
assert.ok(anchorStart >= 0 && anchorEnd > anchorStart);

function harness({ rows, viewportBottom, atBottom }) {
  const context = {
    elements: {
      messageScroller: { scrollTop: 0, getBoundingClientRect: () => ({ bottom: viewportBottom }) },
      messages: {
        hasChildNodes: () => rows.length > 0,
        querySelectorAll: () => rows,
      },
    },
    messagesAreScrolledToBottom: () => atBottom,
    renderedMessageRow: (id) => rows.find((row) => row.dataset.id === id) || null,
    scrollToBottom() { context.scrolledToLatest = true; },
    scrolledToLatest: false,
    frames: [],
    requestAnimationFrame(callback) { context.frames.push(callback); },
  };
  vm.createContext(context);
  vm.runInContext(
    `${anchorSource}
globalThis.anchorApi = {
  commitReservedFilePreview,
  noteMessageScrollOrigin,
  userIsScrollingMessages,
};`,
    context,
  );
  return context;
}

// Un cadre déjà libéré — la miniature provisoire remplacée par le rendu
// définitif — garde malgré tout la lecture en place.
let top = 600;
const row = { dataset: { id: "7" }, getBoundingClientRect: () => ({ top }) };
const second = harness({ rows: [row], viewportBottom: 900, atBottom: false });
const container = { dataset: {}, removeAttribute() {} };
second.anchorApi.commitReservedFilePreview(container, () => { top = 430; });
assert.equal(second.elements.messageScroller.scrollTop, -170);

// Ce qui se pose une image plus tard — cadre de chargement retiré, image qui
// finit de s'installer — est rattrapé à la frame suivante : sans cela la bulle
// monte avant de redescendre.
let lateTop = 500;
const lateRow = { dataset: { id: "8" }, getBoundingClientRect: () => ({ top: lateTop }) };
const late = harness({ rows: [lateRow], viewportBottom: 900, atBottom: false });
late.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => {});
assert.equal(late.frames.length, 1);
lateTop = 560;
late.frames[0]();
assert.equal(late.elements.messageScroller.scrollTop, 60);

// Mais un défilement de l'utilisateur entre-temps prime sur le repère.
let scrolledTop = 500;
const scrolledRow = { dataset: { id: "9" }, getBoundingClientRect: () => ({ top: scrolledTop }) };
const scrolled = harness({ rows: [scrolledRow], viewportBottom: 900, atBottom: false });
scrolled.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => {});
scrolled.elements.messageScroller.scrollTop = 320;
scrolledTop = 560;
scrolled.frames[0]();
assert.equal(scrolled.elements.messageScroller.scrollTop, 320);

// Une liste reconstruite entre-temps n'a plus le message repère : ne rien faire
// plutôt que de retomber sur le bas de la discussion.
const goneRows = [{ dataset: { id: "3" }, getBoundingClientRect: () => ({ top: 500 }) }];
const gone = harness({ rows: goneRows, viewportBottom: 900, atBottom: false });
gone.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => {});
goneRows.length = 0;
gone.frames[0]();
assert.equal(gone.scrolledToLatest, false);

// Une bulle plus haute que la vue : le repère doit suivre la bulle d'en dessous,
// qui se déplace de la hauteur gagnée, et non la géante dont le haut est fixe.
let belowTop = 700;
const giantRow = { dataset: { id: "20" }, getBoundingClientRect: () => ({ top: -200 }) };
const belowRow = {
  dataset: { id: "21" },
  classList: { contains: (name) => name === "message-row" },
  getBoundingClientRect: () => ({ top: belowTop }),
};
giantRow.previousElementSibling = belowRow;
const giant = harness({ rows: [giantRow, belowRow], viewportBottom: 900, atBottom: false });
const giantContainer = { dataset: {}, removeAttribute() {}, closest: () => giantRow };
belowRow.previousElementSibling = null;
giant.anchorApi.commitReservedFilePreview(giantContainer, () => { belowTop = 980; });
assert.equal(giant.elements.messageScroller.scrollTop, 280);

// Pendant un geste de défilement, aucune écriture de scrollTop : Safari
// applique la nôtre une seule image — reculée et mal peinte — avant de reprendre
// l'offset de son compositeur. Le geste absorbe lui-même le décalage.
let gestureTop = 500;
const gestureRow = { dataset: { id: "5" }, getBoundingClientRect: () => ({ top: gestureTop }) };
const gesture = harness({ rows: [gestureRow], viewportBottom: 900, atBottom: false });
gesture.anchorApi.noteMessageScrollOrigin();
assert.equal(gesture.anchorApi.userIsScrollingMessages(), true);
gesture.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => { gestureTop = 560; });
assert.equal(gesture.elements.messageScroller.scrollTop, 0);
assert.equal(gesture.frames.length, 0);

// Nos propres écritures déclenchent aussi l'évènement « scroll » : les prendre
// pour un geste ferait taire le repère sur toute la suite du rendu.
const ours = harness({ rows: [{ dataset: { id: "6" }, getBoundingClientRect: () => ({ top: 500 }) }], viewportBottom: 900, atBottom: false });
ours.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => {});
ours.anchorApi.noteMessageScrollOrigin();
assert.equal(ours.anchorApi.userIsScrollingMessages(), false);

// Collé en bas, la discussion reste collée en bas.
const pinned = harness({ rows: [{ dataset: { id: "1" }, getBoundingClientRect: () => ({ top: 100 }) }], viewportBottom: 900, atBottom: true });
pinned.anchorApi.commitReservedFilePreview({ dataset: {}, removeAttribute() {} }, () => {});
assert.equal(pinned.scrolledToLatest, true);

console.log("Message previews: every preview commit keeps the reading position, no scroll moved from a ResizeObserver");
