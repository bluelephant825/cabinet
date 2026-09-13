/**
 * Cabinet host adapter replacing Electron's `nativeImage` for the vendored PDF
 * image pipeline. The vendored code uses exactly three calls:
 *   - createFromBuffer(png|jpeg bytes) -> { isEmpty, getSize, toBitmap }
 *     where toBitmap() returns PREMULTIPLIED BGRA (Electron semantics)
 *   - createFromBitmap(bgra, { width, height }) -> { toPNG }
 * Both are synchronous in upstream code, so the default implementation uses
 * pngjs/jpeg-js (pure JS). A host that wants a different codec (e.g. sharp)
 * can install one with setImageCodec before touching the engine.
 */
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

export interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  /** premultiplied BGRA, matching Electron nativeImage.toBitmap() */
  toBitmap(): Buffer
  toPNG(): Buffer
}

export interface ImageCodec {
  createFromBuffer(data: Buffer): NativeImageLike
  createFromBitmap(bgra: Buffer, opts: { width: number; height: number }): NativeImageLike
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

function rgbaToPremultipliedBgra(rgba: Buffer): Buffer {
  const out = Buffer.alloc(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    out[i] = Math.round((rgba[i + 2]! * a) / 255)
    out[i + 1] = Math.round((rgba[i + 1]! * a) / 255)
    out[i + 2] = Math.round((rgba[i]! * a) / 255)
    out[i + 3] = a
  }
  return out
}

function bgraToRgba(bgra: Buffer): Buffer {
  const out = Buffer.alloc(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]!
    out[i + 1] = bgra[i + 1]!
    out[i + 2] = bgra[i]!
    out[i + 3] = bgra[i + 3]!
  }
  return out
}

function decodeRgba(data: Buffer): { width: number; height: number; rgba: Buffer } | null {
  try {
    if (data.subarray(0, 4).equals(PNG_MAGIC)) {
      const png = PNG.sync.read(data)
      return { width: png.width, height: png.height, rgba: png.data }
    }
    if (data.subarray(0, 3).equals(JPEG_MAGIC)) {
      const j = jpeg.decode(data, { maxMemoryUsageInMB: 512 })
      if (!j) return null
      return { width: j.width, height: j.height, rgba: j.data }
    }
    return null
  } catch {
    return null
  }
}

class DecodedImage implements NativeImageLike {
  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly bgra: Buffer,
  ) {}
  isEmpty(): boolean {
    return this.w <= 0 || this.h <= 0
  }
  getSize(): { width: number; height: number } {
    return { width: this.w, height: this.h }
  }
  toBitmap(): Buffer {
    return this.bgra
  }
  toPNG(): Buffer {
    const png = new PNG({ width: this.w, height: this.h })
    bgraToRgba(this.bgra).copy(png.data)
    return PNG.sync.write(png)
  }
}

class EmptyImage implements NativeImageLike {
  isEmpty(): boolean {
    return true
  }
  getSize(): { width: number; height: number } {
    return { width: 0, height: 0 }
  }
  toBitmap(): Buffer {
    return Buffer.alloc(0)
  }
  toPNG(): Buffer {
    return Buffer.alloc(0)
  }
}

const defaultCodec: ImageCodec = {
  createFromBuffer(data: Buffer): NativeImageLike {
    const decoded = decodeRgba(data)
    if (!decoded) return new EmptyImage()
    return new DecodedImage(
      decoded.width,
      decoded.height,
      rgbaToPremultipliedBgra(decoded.rgba),
    )
  },
  createFromBitmap(bgra: Buffer, opts: { width: number; height: number }): NativeImageLike {
    if (bgra.length !== opts.width * opts.height * 4) return new EmptyImage()
    return new DecodedImage(opts.width, opts.height, Buffer.from(bgra))
  },
}

let active: ImageCodec = defaultCodec

/** Install a host-provided codec (e.g. an Electron shell can pass the real
    nativeImage; a worker may prefer sharp). Call before any engine use. */
export function setImageCodec(codec: ImageCodec): void {
  active = codec
}

export function getImageCodec(): ImageCodec {
  return active
}

/** Drop-in replacement for `import { nativeImage } from 'electron'` covering
    the subset of the API the vendored image pipeline uses. */
export const nativeImage: ImageCodec = {
  createFromBuffer: (data) => active.createFromBuffer(data),
  createFromBitmap: (bgra, opts) => active.createFromBitmap(bgra, opts),
}
