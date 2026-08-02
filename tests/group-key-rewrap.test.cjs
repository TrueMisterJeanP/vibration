const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../web/js/crypto.js"), "utf8");

async function loadCryptoModule() {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleURL);
}

async function identity() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: JSON.stringify(await webcrypto.subtle.exportKey("jwk", pair.publicKey)),
  };
}

(async () => {
  const cryptoModule = await loadCryptoModule();
  const owner = await identity();
  const creator = await identity();
  const readdedMember = await identity();
  const originalGroupKey = await cryptoModule.generateGroupKey();

  const ownerEnvelope = await cryptoModule.wrapGroupKey(
    originalGroupKey,
    creator.privateKey,
    owner.publicKey,
    1,
  );
  const reopenedGroupKey = await cryptoModule.unwrapGroupKey(
    ownerEnvelope,
    owner.privateKey,
    creator.publicKey,
  );
  assert.equal(reopenedGroupKey.extractable, true);

  const readdedMemberEnvelope = await cryptoModule.wrapGroupKey(
    reopenedGroupKey,
    owner.privateKey,
    readdedMember.publicKey,
    2,
  );
  const readdedMemberKey = await cryptoModule.unwrapGroupKey(
    readdedMemberEnvelope,
    readdedMember.privateKey,
    owner.publicKey,
  );

  const originalRaw = Buffer.from(await webcrypto.subtle.exportKey("raw", originalGroupKey));
  const readdedRaw = Buffer.from(await webcrypto.subtle.exportKey("raw", readdedMemberKey));
  assert.deepEqual(readdedRaw, originalRaw);
  console.log("Group key rewrap: reopened group key can be shared with a re-added member");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
