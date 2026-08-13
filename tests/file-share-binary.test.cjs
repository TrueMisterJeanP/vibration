const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const share = fs.readFileSync(path.join(root, "web/js/share.js"), "utf8");
const shareHTML = fs.readFileSync(path.join(root, "web/share.html"), "utf8");
const worker = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");
const server = fs.readFileSync(path.join(root, "internal/files/shares.go"), "utf8");

assert.match(app, /async function createFileShare[\s\S]*encryptFileBytes\(shareKey, file\.data\)/);
assert.match(app, /upload\.append\("metadata", JSON\.stringify\(metadata\)\)/);
assert.match(app, /upload\.append\("encrypted_data", new Blob\(\[encrypted\.data\]/);
assert.match(app, /const recovered = await api\(`\/api\/file-shares\/\$\{shareToken\}`\)/);
assert.match(app, /const encryptedLink = await encryptEnvelope\(conversationKey, publicURL\.toString\(\)\)/);
assert.match(app, /encrypted_link: encryptedLink/);
assert.match(app, /async function loadExistingFileShares[\s\S]*decryptEnvelope\(conversationKey, share\.encrypted_link\)[\s\S]*copyTextToClipboard\(link\)/);
assert.match(server, /func \(h \*Handler\) CreateShare[\s\S]*extendFileTransferDeadlines\(w, r, r\.ContentLength\)/);
assert.match(server, /INSERT INTO file_shares\(file_id,created_by,token_hash,encrypted_link/);
assert.match(server, /SELECT id,encrypted_link,expires_at/);
assert.match(server, /decodeMultipartEncryptedBody\(w, r, input, maxFileSize, "invalid encrypted file share"\)/);
assert.match(server, /application\/octet-stream[\s\S]*w\.Write\(share\.EncryptedData\)/);
assert.match(share, /Accept: "application\/octet-stream"/);
assert.match(share, /crypto\.subtle\.decrypt\([\s\S]*base64ToBytes\(fileIV\)/);
assert.match(shareHTML, /\/js\/share\.js\?v=conversation-search-v326/);
assert.match(worker, /\/js\/share\.js\?v=conversation-search-v326/);

console.log("File sharing: binary transfer, response recovery and copyable encrypted history wired");
