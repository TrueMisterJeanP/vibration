const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/file-preview-image.js"), "utf8");
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

(async () => {
  const { nonWhiteImageBounds } = await import(moduleURL);
  const width = 10;
  const height = 8;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 3; y <= 5; y++) {
    for (let x = 2; x <= 7; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 20;
      pixels[offset + 1] = 80;
      pixels[offset + 2] = 140;
    }
  }
  assert.deepEqual(nonWhiteImageBounds(pixels, width, height, { padding: 0 }), {
    x: 2,
    y: 3,
    width: 6,
    height: 3,
  });

  const nearlyWhite = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let offset = 0; offset < nearlyWhite.length; offset += 4) {
    nearlyWhite[offset] = 250;
    nearlyWhite[offset + 1] = 249;
    nearlyWhite[offset + 2] = 251;
  }
  assert.equal(nonWhiteImageBounds(nearlyWhite, width, height), null);

  const noisyWidth = 20;
  const noisyHeight = 16;
  const noisy = new Uint8ClampedArray(noisyWidth * noisyHeight * 4).fill(255);
  for (const [x, y] of [[0, 0], [4, 2], [15, 7], [19, 15]]) {
    const offset = (y * noisyWidth + x) * 4;
    noisy[offset] = 210;
    noisy[offset + 1] = 215;
    noisy[offset + 2] = 220;
  }
  for (let y = 9; y <= 13; y++) {
    for (let x = 5; x <= 16; x++) {
      const offset = (y * noisyWidth + x) * 4;
      noisy[offset] = 30;
      noisy[offset + 1] = 90;
      noisy[offset + 2] = 150;
    }
  }
  assert.deepEqual(nonWhiteImageBounds(noisy, noisyWidth, noisyHeight, { padding: 0 }), {
    x: 5,
    y: 9,
    width: 12,
    height: 5,
  });
  console.log("PDF preview image: white margins detected without JPEG noise");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
