// The MP4 box walker every video reader shares: the three telemetry parsers
// (pdr.js, pdr25.js, gpmf.js) and the best-lap clip cutter (mp4cut.js). Each
// used to carry its own copy of these helpers; this is the one.
//
// Everything reads through Blob.slice, so a multi-gigabyte video is never read
// whole — only the index (`moov`) and whatever samples a caller asks for.

const td = new TextDecoder("latin1");

// `length` bytes at `offset`, as a DataView (shorter at the end of the blob).
export async function bufAt(blob, offset, length) {
  const ab = await blob.slice(offset, Math.min(offset + length, blob.size)).arrayBuffer();
  return new DataView(ab);
}

export const fourcc = (dv, off) => td.decode(new Uint8Array(dv.buffer, dv.byteOffset + off, 4));

// The boxes laid end to end in [start, end) of a view: { type, start, body,
// size }, `body` being where the box's payload begins (after a 64-bit size
// when there is one). Stops at the first thing that isn't a plausible box.
export function boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(dv, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    }
    if (size === 0) size = end - p;
    if (size < 8 || p + size > end || !/^[\x20-\x7e]{4}$/.test(type)) break;
    out.push({ type, start: p, body: p + hdr, size });
    p += size;
  }
  return out;
}

// A box's children, and the first child of a type.
export const children = (dv, box) => boxes(dv, box.body, box.start + box.size);
export const child = (dv, box, type) => children(dv, box).find((b) => b.type === type);

// Walks the file's top-level boxes and reads `moov` — the index — into
// memory. It is usually at the end of a camera's file, after gigabytes of
// `mdat`, which this skips by reading 16-byte headers. Answers { moov, pos,
// size }: the box's bytes as a DataView (the `moov` header at 0) and where it
// sits in the file.
export async function readMoov(blob) {
  let pos = 0;
  while (pos + 16 <= blob.size) {
    const hdr = await bufAt(blob, pos, 16);
    let size = hdr.getUint32(0);
    const type = fourcc(hdr, 4);
    if (size === 1) size = Number(hdr.getBigUint64(8));
    if (size === 0) size = blob.size - pos;
    if (size < 8) throw new Error("Not a valid MP4 file");
    if (type === "moov") return { moov: await bufAt(blob, pos, size), pos, size };
    pos += size;
  }
  throw new Error("No moov box found — is this an MP4?");
}
