export function nonWhiteImageBounds(data, width, height, options = {}) {
  if (!data || width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 236;
  const minimumDensity = Number.isFinite(options.minimumDensity) ? options.minimumDensity : 0.01;
  const rowCounts = new Uint32Array(height);
  const columnCounts = new Uint32Array(width);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (data[offset + 3] <= 16) continue;
      if (data[offset] >= threshold && data[offset + 1] >= threshold && data[offset + 2] >= threshold) continue;
      rowCounts[y]++;
      columnCounts[x]++;
    }
  }
  const minimumRowPixels = Math.max(2, Math.ceil(width * minimumDensity));
  const minimumColumnPixels = Math.max(2, Math.ceil(height * minimumDensity));
  const top = rowCounts.findIndex((count) => count >= minimumRowPixels);
  const left = columnCounts.findIndex((count) => count >= minimumColumnPixels);
  if (top < 0 || left < 0) return null;
  let bottom = height - 1;
  let right = width - 1;
  while (bottom >= top && rowCounts[bottom] < minimumRowPixels) bottom--;
  while (right >= left && columnCounts[right] < minimumColumnPixels) right--;

  const padding = Math.max(0, Math.round(Number.isFinite(options.padding) ? options.padding : Math.min(width, height) * 0.012));
  const paddedLeft = Math.max(0, left - padding);
  const paddedTop = Math.max(0, top - padding);
  const paddedRight = Math.min(width - 1, right + padding);
  const paddedBottom = Math.min(height - 1, bottom + padding);
  return {
    x: paddedLeft,
    y: paddedTop,
    width: paddedRight - paddedLeft + 1,
    height: paddedBottom - paddedTop + 1,
  };
}
