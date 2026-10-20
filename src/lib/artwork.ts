const cache = new Map<string, Promise<string>>();
/**
 * Lock screens (notably iOS) ignore SVG artwork, so figures are drawn onto a square PNG.
 * Results are cached per image for the page's lifetime; a failed image falls back to the original URL.
 */
export function artworkFor(src: string, size = 512): Promise<string> {
  let result = cache.get(src);
  if (!result) {
    result = new Promise<string>(resolve => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const context = canvas.getContext('2d'); if (!context) { resolve(src); return; }
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
        const padding = size * 0.06, scale = Math.min((size - padding * 2) / (image.naturalWidth || size), (size - padding * 2) / (image.naturalHeight || size));
        const width = (image.naturalWidth || size) * scale, height = (image.naturalHeight || size) * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        canvas.toBlob(blob => resolve(blob ? URL.createObjectURL(blob) : src), 'image/png');
      };
      image.onerror = () => resolve(src);
      image.src = src;
    });
    cache.set(src, result);
  }
  return result;
}
