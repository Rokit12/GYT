// Client-side helpers for yacht photo uploads.
export type Photo = { id: number; url: string; caption: string; is_cover: boolean; sha256: string; bytes: number; created_at: string; status: string };

/** Downscale large images in the browser (max 2400 px, JPEG) so uploads are quick on any connection. */
export async function shrink(file: File, max = 2400): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(`${file.name}: use a JPEG, PNG or WebP image`);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(`${file.name}: this image could not be read`); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 2.5e6) { bmp.close(); return file; }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not compress image"))), "image/jpeg", 0.86));
}

/** POST raw bytes with upload progress (fetch has no upload progress). */
export function uploadPhoto(yachtId: string, blob: Blob, caption: string, onProgress: (p: number) => void): Promise<Photo> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/gyt/yachts/${yachtId}/photos?caption=${encodeURIComponent(caption)}`);
    x.setRequestHeader("Content-Type", blob.type || "image/jpeg");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let body: { detail?: string } & Photo;
      try { body = JSON.parse(x.responseText); } catch { body = {} as typeof body; }
      if (x.status >= 200 && x.status < 300) res(body); else rej(new Error(typeof body.detail === "string" ? body.detail : `Upload failed (${x.status})`));
    };
    x.onerror = () => rej(new Error("Network error. Check your connection and try again."));
    x.send(blob);
  });
}
export const photosChanged = (yachtId: string) => window.dispatchEvent(new CustomEvent("gyt:photos", { detail: yachtId }));
