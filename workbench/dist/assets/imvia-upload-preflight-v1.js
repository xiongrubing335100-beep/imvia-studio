export const LOVART_IMAGE_MAX_BYTES = 20_000_000;
export const LOVART_IMAGE_TARGET_BYTES = 18_000_000;

const DEFAULT_QUALITIES = Object.freeze([0.94, 0.9, 0.86, 0.82, 0.76, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3, 0.22]);

export function oversizedLovartImages(files, maximumBytes = LOVART_IMAGE_MAX_BYTES) {
  return Array.from(files || []).filter((file) => String(file?.type || "").toLowerCase().startsWith("image/") && Number(file?.size) > maximumBytes);
}

async function decodeBrowserImage(blob) {
  if (typeof globalThis.createImageBitmap !== "function") {
    const error = new Error("当前工作台无法自动压缩这张图片，请先手动压缩到 20MB 以下。");
    error.code = "IMAGE_COMPRESSION_UNAVAILABLE";
    throw error;
  }
  return globalThis.createImageBitmap(blob);
}

function createBrowserEncoder(image) {
  if (!globalThis.document?.createElement) {
    const error = new Error("当前工作台无法自动压缩这张图片，请先手动压缩到 20MB 以下。");
    error.code = "IMAGE_COMPRESSION_UNAVAILABLE";
    throw error;
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    const error = new Error("当前工作台无法自动压缩这张图片，请先手动压缩到 20MB 以下。");
    error.code = "IMAGE_COMPRESSION_UNAVAILABLE";
    throw error;
  }
  context.drawImage(image, 0, 0, image.width, image.height);
  return {
    encode: ({ mime_type: mimeType, quality }) => new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("图片压缩失败，请更换图片后重试。"));
      }, mimeType, quality);
    }),
    close: () => { canvas.width = 0; canvas.height = 0; },
  };
}

export async function prepareLovartImageUpload(blob, {
  maximumBytes = LOVART_IMAGE_MAX_BYTES,
  targetBytes = LOVART_IMAGE_TARGET_BYTES,
  qualities = DEFAULT_QUALITIES,
  decodeImage = decodeBrowserImage,
  encodeImage = null,
} = {}) {
  if (!blob || !Number.isFinite(blob.size) || blob.size < 0) throw new TypeError("image blob is required");
  if (blob.size <= maximumBytes) {
    return { compressed: false, upload_blob: blob, original_size_bytes: blob.size, upload_size_bytes: blob.size };
  }

  const image = await decodeImage(blob);
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    image?.close?.();
    throw new Error("无法读取图片尺寸，请更换图片后重试。");
  }

  const mimeType = String(blob.type || "").toLowerCase() === "image/jpeg" ? "image/jpeg" : "image/webp";
  let browserEncoder = null;
  try {
    if (typeof encodeImage !== "function") browserEncoder = createBrowserEncoder(image);
    const encode = typeof encodeImage === "function" ? encodeImage : (_image, options) => browserEncoder.encode(options);
    for (const quality of qualities) {
      const candidate = await encode(image, { mime_type: mimeType, quality, width, height });
      if (candidate && Number.isFinite(candidate.size) && candidate.size <= targetBytes) {
        return {
          compressed: true,
          upload_blob: candidate,
          original_size_bytes: blob.size,
          upload_size_bytes: candidate.size,
          width,
          height,
        };
      }
    }
  } finally {
    browserEncoder?.close?.();
    image?.close?.();
  }

  const error = new Error("图片保持原像素尺寸后仍超过 18MB，请手动压缩或更换图片。" );
  error.code = "IMAGE_COMPRESSION_TARGET_UNREACHABLE";
  throw error;
}

export async function uploadWorkbenchReference({
  source,
  kind,
  label,
  fetchImpl = globalThis.fetch,
  uploadJson,
  prepareImage = prepareLovartImageUpload,
  onCompressed = () => undefined,
}) {
  if (typeof fetchImpl !== "function" || typeof uploadJson !== "function") throw new TypeError("reference upload dependencies are required");
  const mediaResponse = await fetchImpl(source);
  if (!mediaResponse?.ok || typeof mediaResponse.blob !== "function") throw new Error("参考素材读取失败，请重新添加后重试。");
  const sourceBlob = await mediaResponse.blob();
  const prepared = kind === "image"
    ? await prepareImage(sourceBlob)
    : { compressed: false, upload_blob: sourceBlob, original_size_bytes: sourceBlob.size, upload_size_bytes: sourceBlob.size };
  const uploadBlob = prepared.upload_blob;
  const bytes = await uploadBlob.arrayBuffer();
  const fallbackType = kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png";
  const contentType = uploadBlob.type || mediaResponse.headers?.get?.("content-type") || fallbackType;
  if (prepared.compressed) {
    onCompressed({
      label,
      original_size_bytes: prepared.original_size_bytes,
      upload_size_bytes: prepared.upload_size_bytes,
      width: prepared.width,
      height: prepared.height,
    });
  }
  const uploaded = await uploadJson("/api/v1/workbench/assets", {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  });
  return uploaded.attachment;
}
