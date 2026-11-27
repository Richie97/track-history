import { describe, expect, it } from "vitest";
import { jpegHeader } from "../jpeg-fixture";
import { WRAPPED_IMAGE_MAX_BYTES, jpegSize, wrappedImageError } from "../../src/lib/wrappedImage";

describe("jpegSize", () => {
  it("reads the size a JPEG's frame header declares", () => {
    expect(jpegSize(jpegHeader(1200, 630))).toEqual({ w: 1200, h: 630 });
    expect(jpegSize(jpegHeader(1080, 1920))).toEqual({ w: 1080, h: 1920 });
  });

  it("reads a progressive frame, and past fill bytes and other segments", () => {
    const progressive = jpegHeader(1200, 630);
    progressive[21] = 0xc2;
    expect(jpegSize(progressive)).toEqual({ w: 1200, h: 630 });
    // SOI, a fill byte, a quantisation table (DQT) segment, then the frame.
    const bytes = new Uint8Array(64);
    bytes.set([0xff, 0xd8, 0xff, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x04, 0xb0]);
    expect(jpegSize(bytes)).toEqual({ w: 1200, h: 630 });
  });

  it("is null for anything that isn't a JPEG with a frame header", () => {
    expect(jpegSize(new Uint8Array(0))).toBeNull();
    expect(jpegSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(jpegSize(png)).toBeNull();
    // A huffman table (DHT) sits in the SOF range and is not a frame.
    const dht = jpegHeader(1200, 630);
    dht[21] = 0xc4;
    expect(jpegSize(dht)).toBeNull();
    // Cut off before the frame header's size, and a scan with no frame at all.
    expect(jpegSize(jpegHeader(1200, 630).subarray(0, 26))).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]))).toBeNull();
    // A segment that claims a length shorter than its own length field.
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0]))).toBeNull();
  });

  it("reads a view into a larger buffer at its own offset", () => {
    const padded = new Uint8Array(100);
    padded.set(jpegHeader(1200, 630), 36);
    expect(jpegSize(padded.subarray(36))).toEqual({ w: 1200, h: 630 });
  });
});

describe("wrappedImageError", () => {
  it("accepts a 1200×630 JPEG and nothing else", () => {
    expect(wrappedImageError(jpegHeader(1200, 630))).toBeNull();
    expect(wrappedImageError(jpegHeader(1080, 1920))).toBe("image must be 1200×630");
    expect(wrappedImageError(new Uint8Array(64))).toBe("image must be a JPEG");
    expect(wrappedImageError(jpegHeader(1200, 630, WRAPPED_IMAGE_MAX_BYTES + 1))).toBe("image is too large");
  });
});
