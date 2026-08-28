import assert from "node:assert/strict";
import test from "node:test";

async function loadUploadPreflight() {
  return import("../workbench/dist/assets/imvia-upload-preflight-v1.js").catch(() => ({}));
}

test("an oversized image is re-encoded below the Lovart upload target without changing its pixel dimensions", async () => {
  const { prepareLovartImageUpload } = await loadUploadPreflight();
  assert.equal(typeof prepareLovartImageUpload, "function", "upload preflight module must exist");

  const original = { size: 20_000_001, type: "image/png" };
  const attempts = [];
  const encoded = [
    { size: 18_500_000, type: "image/webp" },
    { size: 17_900_000, type: "image/webp" },
  ];
  let closed = false;

  const result = await prepareLovartImageUpload(original, {
    decodeImage: async () => ({ width: 3392, height: 5056, close: () => { closed = true; } }),
    encodeImage: async (_image, options) => {
      attempts.push(options);
      return encoded.shift();
    },
    qualities: [0.94, 0.9],
  });

  assert.equal(result.compressed, true);
  assert.equal(result.original_size_bytes, 20_000_001);
  assert.equal(result.upload_size_bytes, 17_900_000);
  assert.equal(result.upload_blob.type, "image/webp");
  assert.deepEqual(attempts, [
    { mime_type: "image/webp", quality: 0.94, width: 3392, height: 5056 },
    { mime_type: "image/webp", quality: 0.9, width: 3392, height: 5056 },
  ]);
  assert.equal(closed, true);
});

test("an image at the Lovart limit is uploaded unchanged", async () => {
  const { prepareLovartImageUpload } = await loadUploadPreflight();
  assert.equal(typeof prepareLovartImageUpload, "function", "upload preflight module must exist");

  const original = { size: 20_000_000, type: "image/jpeg" };
  let decoded = false;
  const result = await prepareLovartImageUpload(original, {
    decodeImage: async () => { decoded = true; throw new Error("must not decode"); },
  });

  assert.equal(result.compressed, false);
  assert.equal(result.upload_blob, original);
  assert.equal(decoded, false);
});

test("oversized images are identified as soon as they are added while other media is ignored", async () => {
  const { oversizedLovartImages } = await loadUploadPreflight();
  assert.equal(typeof oversizedLovartImages, "function", "image selection preflight must exist");

  const oversized = { name: "character.png", size: 20_000_001, type: "image/png" };
  const atLimit = { name: "poster.jpg", size: 20_000_000, type: "image/jpeg" };
  const video = { name: "clip.mp4", size: 30_000_000, type: "video/mp4" };

  assert.deepEqual(oversizedLovartImages([oversized, atLimit, video]), [oversized]);
});

test("reference upload sends the compressed bytes and reports the visible size change", async () => {
  const { uploadWorkbenchReference } = await loadUploadPreflight();
  assert.equal(typeof uploadWorkbenchReference, "function", "reference upload helper must exist");

  const sourceBlob = new Blob(["original-image"], { type: "image/png" });
  const uploadBlob = new Blob(["compressed"], { type: "image/webp" });
  const notifications = [];
  const uploads = [];

  const attachment = await uploadWorkbenchReference({
    source: "blob:reference-1",
    kind: "image",
    label: "图片1",
    fetchImpl: async () => new Response(sourceBlob, { status: 200, headers: { "content-type": "image/png" } }),
    prepareImage: async () => ({
      compressed: true,
      upload_blob: uploadBlob,
      original_size_bytes: 21_264_657,
      upload_size_bytes: uploadBlob.size,
      width: 3392,
      height: 5056,
    }),
    uploadJson: async (path, options) => {
      uploads.push({ path, options });
      return { attachment: "imvia-upload:compressed.webp" };
    },
    onCompressed: (event) => notifications.push(event),
  });

  assert.equal(attachment, "imvia-upload:compressed.webp");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, "/api/v1/workbench/assets");
  assert.equal(uploads[0].options.headers["content-type"], "image/webp");
  assert.equal(uploads[0].options.body.byteLength, uploadBlob.size);
  assert.deepEqual(notifications, [{
    label: "图片1",
    original_size_bytes: 21_264_657,
    upload_size_bytes: uploadBlob.size,
    width: 3392,
    height: 5056,
  }]);
});
