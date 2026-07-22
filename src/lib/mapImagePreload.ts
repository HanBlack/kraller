const decodedByUrl = new Map<string, HTMLImageElement>();
const inflight = new Map<string, Promise<HTMLImageElement>>();

/** Dekóduje PNG jednou — MapLibre pak swapne okamžitě. */
export function preloadMapImage(url: string): Promise<HTMLImageElement> {
  const cached = decodedByUrl.get(url);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(url);
  if (pending) return pending;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      decodedByUrl.set(url, img);
      inflight.delete(url);
      resolve(img);
    };
    img.onerror = () => {
      inflight.delete(url);
      reject(new Error("map image preload failed"));
    };
    img.src = url;
  });
  inflight.set(url, promise);
  return promise;
}

export function peekMapImage(url: string): HTMLImageElement | undefined {
  return decodedByUrl.get(url);
}

export function preloadMapImages(urls: string[]): void {
  for (const url of urls) {
    if (!url || decodedByUrl.has(url)) continue;
    void preloadMapImage(url).catch(() => {});
  }
}
