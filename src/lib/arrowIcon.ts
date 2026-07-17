/**
 * Jednoduchá směrová šipka (nahoru = sever) pro MapLibre SDF.
 */
export function createArrowImageData(): ImageData | null {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.08);
  ctx.lineTo(size * 0.86, size * 0.78);
  ctx.lineTo(size * 0.5, size * 0.58);
  ctx.lineTo(size * 0.14, size * 0.78);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}
