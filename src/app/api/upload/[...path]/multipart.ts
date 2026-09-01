export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024; // 1MB envelope allowance

export class MultipartUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415
  ) {
    super(message);
    this.name = "MultipartUploadError";
  }
}

export async function parseBoundedMultipartFile(req: Request): Promise<File> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new MultipartUploadError("Expected multipart form data", 415);
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new MultipartUploadError("Invalid Content-Length", 400);
    }
    if (declared > MAX_MULTIPART_BYTES) {
      throw new MultipartUploadError(
        `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB size limit`,
        413
      );
    }
  }
  if (!req.body) {
    throw new MultipartUploadError("No file provided", 400);
  }

  const chunks: Uint8Array[] = [];
  const reader = req.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MULTIPART_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MultipartUploadError(
        `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB size limit`,
        413
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let formData: FormData;
  try {
    formData = await new Response(body.buffer, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new MultipartUploadError("Invalid multipart form data", 400);
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new MultipartUploadError("No file provided", 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new MultipartUploadError(
      `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB size limit`,
      413
    );
  }
  return file;
}
