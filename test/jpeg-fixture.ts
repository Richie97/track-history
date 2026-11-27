// The start of a JPEG, for the Wrapped preview-image tests (#155): the upload
// check walks the segment headers to the frame header and reads nothing after.

// SOI, a JFIF APP0 segment, then a baseline frame header (SOF0) of w × h.
export function jpegHeader(w: number, h: number, total = 64): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const sof = 2 + 2 + 16;
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03], sof);
  return bytes;
}
