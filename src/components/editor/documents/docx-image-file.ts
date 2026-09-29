import {
  IMAGE_MAX_BYTES,
  fitImageSize,
  parseImageDataUrl,
} from "./docx-toolbar-commands";

export type ImageFileResult =
  | { ok: true; dataUrl: string; widthPx: number; heightPx: number; altText: string }
  | { ok: false; reason: "type" | "size" | "read" };

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const measure = (dataUrl: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });

/** Validate (png/jpeg/gif, size cap), read and measure a picked file, scaled to the column. */
export async function readImageFile(file: File): Promise<ImageFileResult> {
  if (!/^image\/(png|jpeg|gif)$/.test(file.type)) return { ok: false, reason: "type" };
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, reason: "size" };
  try {
    const dataUrl = await readAsDataUrl(file);
    if (!parseImageDataUrl(dataUrl)) return { ok: false, reason: "type" };
    const { width, height } = await measure(dataUrl);
    const size = fitImageSize(width, height);
    return { ok: true, dataUrl, ...size, altText: file.name.replace(/\.[^.]+$/, "") };
  } catch {
    return { ok: false, reason: "read" };
  }
}
