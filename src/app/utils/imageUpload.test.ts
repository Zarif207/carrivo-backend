import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_IMAGE_BYTES, detectImageType, validateImageFile } from "./imageUpload.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");

const file = (mimetype: string, buffer: Buffer, size = buffer.length) => ({ mimetype, buffer, size });

describe("detectImageType (magic bytes)", () => {
  it("recognizes JPEG, PNG and WebP", () => {
    assert.equal(detectImageType(JPEG), "image/jpeg");
    assert.equal(detectImageType(PNG), "image/png");
    assert.equal(detectImageType(WEBP), "image/webp");
  });

  it("rejects other formats and truncated headers", () => {
    assert.equal(detectImageType(GIF), null);
    assert.equal(detectImageType(SVG), null);
    assert.equal(detectImageType(EXE), null);
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
    assert.equal(detectImageType(Buffer.from("RIFF\0\0\0\0WAVE")), null);
    assert.equal(detectImageType(Buffer.alloc(0)), null);
  });
});

describe("validateImageFile", () => {
  it("accepts a matching JPEG/PNG/WebP", () => {
    assert.deepEqual(validateImageFile(file("image/jpeg", JPEG)), { ok: true, mimetype: "image/jpeg" });
    assert.deepEqual(validateImageFile(file("image/png", PNG)), { ok: true, mimetype: "image/png" });
    assert.deepEqual(validateImageFile(file("image/webp", WEBP)), { ok: true, mimetype: "image/webp" });
  });

  it("requires a non-empty file", () => {
    assert.equal(validateImageFile(undefined).ok, false);
    const empty = validateImageFile(file("image/png", Buffer.alloc(0)));
    assert.deepEqual(empty.ok ? null : empty.status, 400);
  });

  it("rejects files over 4 MB with 413, and accepts exactly 4 MB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length + 1)]);
    const tooBig = validateImageFile(file("image/png", big));
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.ok ? 0 : tooBig.status, 413);
    const exact = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]);
    assert.equal(validateImageFile(file("image/png", exact)).ok, true);
  });

  it("rejects declared types other than jpeg/png/webp", () => {
    for (const mimetype of ["image/gif", "image/svg+xml", "application/pdf", "application/octet-stream"]) {
      const result = validateImageFile(file(mimetype, PNG));
      assert.equal(result.ok, false, mimetype);
    }
  });

  it("rejects content that is not an image even with an image mimetype", () => {
    const svg = validateImageFile(file("image/png", SVG));
    assert.equal(svg.ok, false);
    assert.match(svg.ok ? "" : svg.message, /not a JPEG, PNG or WebP/);
    assert.equal(validateImageFile(file("image/jpeg", EXE)).ok, false);
  });

  it("rejects a real image whose declared type does not match", () => {
    const result = validateImageFile(file("image/jpeg", PNG));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /does not match/);
  });
});
