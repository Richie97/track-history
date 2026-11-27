// Season Wrapped's link-preview image (NS-36, #155). The owner's browser draws
// the 1200×630 poster and uploads it; this is the check on what arrives. It
// walks the JPEG's segment headers to the frame header and reads the size —
// enough to know the bytes are a JPEG of the one size a link preview wants,
// not a decode. What the pixels say is the owner's own share card and is not
// inspected.
//
// JPEG, not PNG: the poster's soft gradient makes a ~550 KB PNG and a ~70 KB
// JPEG, and every link scraper takes either.

export const WRAPPED_IMAGE_W = 1200;
export const WRAPPED_IMAGE_H = 630;
export const WRAPPED_IMAGE_MAX_BYTES = 400_000;

// The pixel size a JPEG's frame header declares, or null when the bytes
// aren't one (or end before saying).
export function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++; // a fill byte before the marker
      continue;
    }
    // Start of scan or end of image with no frame header before it.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    // SOF0–SOF15, less the three that share the range (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return { w: view.getUint16(at + 7), h: view.getUint16(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

// Null when the upload is acceptable, else the message for the 4xx.
export function wrappedImageError(bytes: Uint8Array): string | null {
  if (bytes.length > WRAPPED_IMAGE_MAX_BYTES) return "image is too large";
  const size = jpegSize(bytes);
  if (!size) return "image must be a JPEG";
  if (size.w !== WRAPPED_IMAGE_W || size.h !== WRAPPED_IMAGE_H)
    return `image must be ${WRAPPED_IMAGE_W}×${WRAPPED_IMAGE_H}`;
  return null;
}
