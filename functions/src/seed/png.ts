// ============================================================================
// Tiny dependency-free PNG generator for seed media.
//
// The seed needs REAL image bytes (the app's galleries, floor-plan viewer and
// flag feature must have something to render), but pulling in an image library
// for a handful of placeholder graphics would be a heavy dependency for no real
// gain. Node's built-in `zlib` is all a valid PNG actually needs, so we encode
// the few images we want by hand: a flat-colour canvas, an optional border, a
// simple grid (for floor plans) and a handful of severity "pins" (for flag
// composites). The output is a fully valid, openable PNG.
//
// This is intentionally minimal: 8-bit RGBA, no interlacing, a single IDAT
// chunk. It is not a general image toolkit, it is exactly enough for the seed.
// ============================================================================

import { deflateSync } from 'zlib';

/** A colour as red/green/blue/alpha, each 0..255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse a `#rrggbb` (or `#rgb`) hex colour into an opaque RGBA value. */
function hex(colour: string): Rgba {
  const clean = colour.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 255,
  };
}

// The three RAG severities as fixed colours. These mirror the report's risk
// meter; they are a SAFETY semantic and are never brand-themed (brief 9.1).
const SEVERITY_COLOURS = {
  H: hex('#d92d20'), // red
  M: hex('#f79009'), // amber
  L: hex('#12b76a'), // green
} as const;

/** A pixel canvas we draw onto, then encode. */
class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly data: Uint8Array; // RGBA, row-major

  constructor(width: number, height: number, fill: Rgba) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = fill.r;
      this.data[i * 4 + 1] = fill.g;
      this.data[i * 4 + 2] = fill.b;
      this.data[i * 4 + 3] = fill.a;
    }
  }

  /** Set one pixel, ignoring out-of-bounds writes so callers can draw freely. */
  set(x: number, y: number, c: Rgba): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const i = (py * this.width + px) * 4;
    this.data[i] = c.r;
    this.data[i + 1] = c.g;
    this.data[i + 2] = c.b;
    this.data[i + 3] = c.a;
  }

  /** Fill an axis-aligned rectangle. */
  rect(x: number, y: number, w: number, h: number, c: Rgba): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        this.set(xx, yy, c);
      }
    }
  }

  /** Stroke a rectangle outline of a given thickness. */
  border(thickness: number, c: Rgba): void {
    this.rect(0, 0, this.width, thickness, c);
    this.rect(0, this.height - thickness, this.width, thickness, c);
    this.rect(0, 0, thickness, this.height, c);
    this.rect(this.width - thickness, 0, thickness, this.height, c);
  }

  /** Draw a filled circle (used for flag pins). */
  circle(cx: number, cy: number, radius: number, c: Rgba): void {
    for (let yy = -radius; yy <= radius; yy++) {
      for (let xx = -radius; xx <= radius; xx++) {
        if (xx * xx + yy * yy <= radius * radius) {
          this.set(cx + xx, cy + yy, c);
        }
      }
    }
  }

  /** Draw a light grid - enough to read as a floor plan at a glance. */
  grid(step: number, c: Rgba): void {
    for (let x = step; x < this.width; x += step) {
      this.rect(x, 0, 1, this.height, c);
    }
    for (let y = step; y < this.height; y += step) {
      this.rect(0, y, this.width, 1, c);
    }
  }

  /** Encode the canvas to PNG bytes. */
  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

// --- PNG container encoding --------------------------------------------------

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

// Standard PNG/zlib CRC-32, table built once on first use.
let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  // IHDR: 8-bit, colour type 6 (truecolour with alpha), no interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Each scanline is prefixed with a filter-type byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const idat = deflateSync(raw);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- High-level image factories the seed actually calls ----------------------

/** A solid brand-coloured tile with a subtle border - org logo / building photo
 *  / empty-state placeholder. `accent` paints a corner band so the few images
 *  are visually distinguishable from one another in galleries. */
export function solidTile(
  width: number,
  height: number,
  fill: string,
  accent?: string,
): Buffer {
  const canvas = new Canvas(width, height, hex(fill));
  if (accent) {
    canvas.rect(0, 0, width, Math.max(8, Math.round(height * 0.18)), hex(accent));
  }
  canvas.border(4, { r: 255, g: 255, b: 255, a: 60 });
  return canvas.toPng();
}

/** A floor-plan-style image: pale background, grid lines, a darker perimeter
 *  wall. Realistic enough to anchor flag pins against. */
export function floorPlan(width: number, height: number): Buffer {
  const canvas = new Canvas(width, height, hex('#f4f6f8'));
  canvas.grid(40, hex('#d7dde3'));
  canvas.border(6, hex('#344054'));
  // A couple of internal "rooms" so it does not read as a blank grid.
  canvas.rect(40, 40, 4, height - 80, hex('#98a2b3'));
  canvas.rect(40, Math.round(height / 2), Math.round(width / 2), 4, hex('#98a2b3'));
  return canvas.toPng();
}

/** A flag composite: a floor plan flattened with R/A/G severity pins at the
 *  given normalised (0..1) coordinates - exactly what the app produces on save
 *  (brief 8) and what the action plan embeds. */
export function flagComposite(
  width: number,
  height: number,
  pins: Array<{ x: number; y: number; severity: 'H' | 'M' | 'L' }>,
): Buffer {
  const canvas = new Canvas(width, height, hex('#f4f6f8'));
  canvas.grid(40, hex('#d7dde3'));
  canvas.border(6, hex('#344054'));
  canvas.rect(40, 40, 4, height - 80, hex('#98a2b3'));
  for (const pin of pins) {
    const cx = Math.round(pin.x * width);
    const cy = Math.round(pin.y * height);
    // White halo then the severity-coloured pin, so it reads on any background.
    canvas.circle(cx, cy, 16, { r: 255, g: 255, b: 255, a: 255 });
    canvas.circle(cx, cy, 12, SEVERITY_COLOURS[pin.severity]);
  }
  return canvas.toPng();
}
