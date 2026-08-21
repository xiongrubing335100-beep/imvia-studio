import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";

const URL_FIELDS = ["url", "download_url", "image_url", "video_url", "audio_url", "artifact_url", "content"];

function managedPath(dataDirectory, localPath) {
  if (typeof localPath !== "string" || !path.isAbsolute(localPath)) {
    throw new DomainError("PATH_NOT_ALLOWED", "Artifact path must be an absolute managed path.");
  }
  const root = path.resolve(dataDirectory);
  const resolved = path.resolve(localPath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new DomainError("PATH_NOT_ALLOWED", "Artifact path is outside the IMVIA managed data directory.");
  return resolved;
}

function kindFor(value, field = "") {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw.includes("video") || field.includes("video")) return "video";
  if (raw.includes("audio") || field.includes("audio")) return "audio";
  if (raw.includes("image") || field.includes("image")) return "image";
  return "image";
}

function collectArtifactUrls(value, found = [], inheritedKind = "image", inheritedId = null, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactUrls(item, found, inheritedKind, inheritedId, seen);
    return found;
  }
  const ownKind = kindFor(value.kind ?? value.type ?? inheritedKind);
  const ownId = typeof value.artifact_id === "string" && value.artifact_id ? value.artifact_id : inheritedId;
  for (const field of URL_FIELDS) {
    if (typeof value[field] === "string" && value[field]) {
      found.push({ url: value[field], kind: kindFor(value.kind ?? ownKind, field), source_artifact_id: ownId });
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!URL_FIELDS.includes(key)) collectArtifactUrls(nested, found, kindFor(value.kind ?? ownKind, key), ownId, seen);
  }
  return found;
}

function extensionFor(url, kind, contentType) {
  const mime = typeof contentType === "string" ? contentType.split(";", 1)[0].trim().toLowerCase() : "";
  const fromMime = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav" }[mime];
  if (fromMime) return fromMime;
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/u.test(ext)) return ext;
  } catch {
    // URL validation happens before this function.
  }
  return kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".png";
}

export function createArtifactTransfer({ dataDirectory, fetchImpl = globalThis.fetch } = {}) {
  if (!dataDirectory) throw new TypeError("dataDirectory is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");

  async function prepareUpload({ local_path: localPath }) {
    const resolved = managedPath(dataDirectory, localPath);
    let info;
    try {
      info = await lstat(resolved);
    } catch {
      throw new DomainError("PATH_NOT_ALLOWED", "The managed artifact file is unavailable.");
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new DomainError("PATH_NOT_ALLOWED", "Artifact path must identify a regular managed file.");
    return { file_path: resolved };
  }

  async function downloadResults({ job_id: jobId, result }) {
    if (typeof jobId !== "string" || !/^[a-z0-9._-]+$/iu.test(jobId)) throw new DomainError("VALIDATION_FAILED", "job_id is invalid.", { field: "job_id" });
    const urls = collectArtifactUrls(result);
    const resultsRoot = path.join(path.resolve(dataDirectory), "results");
    const temporaryDirectory = path.join(resultsRoot, `.job-${jobId}-${randomUUID()}.tmp`);
    const finalDirectory = path.join(resultsRoot, jobId);
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const artifacts = [];
    try {
      for (let index = 0; index < urls.length; index += 1) {
        const item = urls[index];
        let url;
        try {
          url = new URL(item.url);
        } catch {
          throw new DomainError("ARTIFACT_URL_NOT_ALLOWED", "Result artifact URL is invalid.");
        }
        if (url.protocol !== "https:" || url.username || url.password || url.hash) {
          throw new DomainError("ARTIFACT_URL_NOT_ALLOWED", "Result artifact URL must be HTTPS without credentials or fragments.");
        }
        let response;
        try {
          response = await fetchImpl(String(url), { method: "GET", redirect: "error" });
        } catch {
          throw new DomainError("ARTIFACT_DOWNLOAD_FAILED", "Result artifact could not be downloaded.");
        }
        if (!response?.ok || typeof response.arrayBuffer !== "function") throw new DomainError("ARTIFACT_DOWNLOAD_FAILED", "Result artifact could not be downloaded.");
        const bytes = Buffer.from(await response.arrayBuffer());
        const contentType = typeof response.headers?.get === "function" ? response.headers.get("content-type") : null;
        const filename = `artifact-${String(index + 1).padStart(3, "0")}${extensionFor(String(url), item.kind, contentType)}`;
        const localPath = path.join(temporaryDirectory, filename);
        await writeFile(localPath, bytes, { mode: 0o600 });
        artifacts.push({ kind: item.kind, local_path: path.join(finalDirectory, filename), source_url: String(url), source_artifact_id: item.source_artifact_id ?? null, mime_type: contentType });
      }
      await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
      await rm(finalDirectory, { recursive: true, force: true });
      await rename(temporaryDirectory, finalDirectory);
      return { artifacts };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  return Object.freeze({ prepareUpload, downloadResults });
}
