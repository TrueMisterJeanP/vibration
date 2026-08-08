const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../web/js/crypto.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");

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
  const remainingMember = await identity();
  const removedMember = await identity();
  const addedMember = await identity();
  const epoch1Key = await cryptoModule.generateGroupKey();
  const epoch2Key = await cryptoModule.generateGroupKey();

  const removedEpoch1Envelope = await cryptoModule.wrapGroupKey(
    epoch1Key,
    owner.privateKey,
    removedMember.publicKey,
    1,
  );
  const remainingEpoch2Envelope = await cryptoModule.wrapGroupKey(
    epoch2Key,
    owner.privateKey,
    remainingMember.publicKey,
    1,
  );
  const addedEpoch2Envelope = await cryptoModule.wrapGroupKey(
    epoch2Key,
    owner.privateKey,
    addedMember.publicKey,
    1,
  );
  const removedEpoch1Key = await cryptoModule.unwrapGroupKey(
    removedEpoch1Envelope,
    removedMember.privateKey,
    owner.publicKey,
  );
  const remainingEpoch2Key = await cryptoModule.unwrapGroupKey(
    remainingEpoch2Envelope,
    remainingMember.privateKey,
    owner.publicKey,
  );
  const addedEpoch2Key = await cryptoModule.unwrapGroupKey(addedEpoch2Envelope, addedMember.privateKey, owner.publicKey);

  const epoch1Raw = Buffer.from(await webcrypto.subtle.exportKey("raw", epoch1Key));
  const epoch2Raw = Buffer.from(await webcrypto.subtle.exportKey("raw", epoch2Key));
  assert.notDeepEqual(epoch2Raw, epoch1Raw, "a membership change must generate a new random group key");
  assert.deepEqual(Buffer.from(await webcrypto.subtle.exportKey("raw", removedEpoch1Key)), epoch1Raw);
  assert.deepEqual(Buffer.from(await webcrypto.subtle.exportKey("raw", remainingEpoch2Key)), epoch2Raw);
  assert.deepEqual(Buffer.from(await webcrypto.subtle.exportKey("raw", addedEpoch2Key)), epoch2Raw);

  const oldMessage = await cryptoModule.encryptText(epoch1Key, "ancien message");
  const newMessage = await cryptoModule.encryptText(epoch2Key, "nouveau message");
  assert.equal(await cryptoModule.decryptText(removedEpoch1Key, oldMessage.data, oldMessage.iv), "ancien message");
  await assert.rejects(cryptoModule.decryptText(removedEpoch1Key, newMessage.data, newMessage.iv));
  assert.equal(await cryptoModule.decryptText(addedEpoch2Key, newMessage.data, newMessage.iv), "nouveau message");

  assert.match(appSource, /\/rotate-keys/);
  assert.match(appSource, /message\?\.key_epoch/);
  assert.match(appSource, /\/keys`/);
  assert.match(appSource, /key_epoch: conversationKeyEpoch/);
  console.log("Group key epochs: fresh key rotation, historical decryption and removed-member isolation verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
