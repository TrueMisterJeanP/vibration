const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
assert.match(css, /\.calendar-toolbar\s*\{[^}]*position:\s*relative[^}]*grid-template-areas:\s*"previous spacer today next"[^}]*margin-top:\s*\.75rem/s);
assert.match(css, /\.calendar-toolbar strong\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*translateX\(-50%\)/s);
assert.match(css, /#calendar-previous\s*\{\s*grid-area:\s*previous/);
assert.match(css, /#calendar-today\s*\{\s*grid-area:\s*today/);
assert.match(css, /#calendar-next\s*\{\s*grid-area:\s*next/);
const mobileStart = css.indexOf("@media (max-width: 720px)");
const mobileEnd = css.indexOf("\n}", mobileStart);
const mobileStyles = css.slice(mobileStart, mobileEnd);

assert.match(mobileStyles, /\.calendar-dialog\s*\{[^}]*width:\s*calc\(100dvw - 1\.5rem\)/s);
assert.match(mobileStyles, /\.calendar-dialog\s*\{[^}]*max-height:\s*min\(86dvh, 44rem\)/s);
assert.match(mobileStyles, /\.carnet-dialog, \.global-files-dialog\s*\{[^}]*width:\s*calc\(100dvw - 1\.5rem\)[^}]*max-width:\s*calc\(100dvw - 1\.5rem\)/s);
assert.match(mobileStyles, /\.calendar-toolbar\s*\{[^}]*grid-template-columns:\s*2\.5rem minmax\(0, 1fr\) 2\.5rem[^}]*margin-top:\s*\.75rem[^}]*padding-right:\s*0/s);
assert.match(mobileStyles, /#calendar-month-label\s*\{[^}]*position:\s*static[^}]*justify-self:\s*center[^}]*transform:\s*none/s);
assert.match(mobileStyles, /\.calendar-scroll\s*\{[^}]*max-height:\s*min\(52dvh, 26rem\)/s);
assert.match(mobileStyles, /\.calendar-weekdays, \.calendar-grid\s*\{[^}]*repeat\(7, minmax\(0, 1fr\)\)[^}]*min-width:\s*0/s);
assert.doesNotMatch(mobileStyles, /\.calendar-weekdays, \.calendar-grid\s*\{[^}]*min-width:\s*728px/s);
assert.match(mobileStyles, /\.calendar-day-event-avatar, \.calendar-day-event-time\s*\{\s*display:\s*none/);

console.log("Mobile calendar: bounded dialog and seven-column grid fitted to the viewport");
