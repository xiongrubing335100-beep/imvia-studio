const TERMINAL_STATUSES = new Set(["succeeded", "partially_succeeded", "failed", "cancelled", "declined"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function artifactOrder(artifact, index) {
  const created = Date.parse(artifact?.created_at ?? "");
  return Number.isFinite(created) ? created : index;
}

/**
 * Build the read-only result workspace model used by the workbench.
 * An empty artifact set intentionally remains the existing empty panel even
 * while a job is loading, waiting for cost, or has failed.
 */
export function presentLovartResultWorkspace({ job = null, artifacts = [] } = {}) {
  const inputArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const unique = new Map();
  inputArtifacts.forEach((artifact, index) => {
    if (!artifact || typeof artifact !== "object") return;
    const key = artifact.id || `${artifact.job_id ?? "unknown"}:${artifact.source_artifact_id ?? "index-${index}"}`;
    if (!unique.has(key)) unique.set(key, { artifact: clone(artifact), index });
  });
  const ordered = [...unique.values()]
    .sort((a, b) => artifactOrder(a.artifact, a.index) - artifactOrder(b.artifact, b.index) || a.index - b.index)
    .map(({ artifact }) => artifact);
  if (!ordered.length) {
    return {
      state: "empty",
      job: job ? clone(job) : null,
      groups: [],
      artifacts: [],
    };
  }
  const groups = [];
  for (const artifact of ordered) {
    let group = groups.find((item) => item.job_id === artifact.job_id);
    if (!group) {
      group = { job_id: artifact.job_id ?? null, artifacts: [] };
      groups.push(group);
    }
    group.artifacts.push(artifact);
  }
  const state = job && TERMINAL_STATUSES.has(job.status) ? "populated" : "preparing";
  return { state, job: job ? clone(job) : null, groups, artifacts: ordered };
}

export function resultArtifactPreview(artifact) {
  if (!artifact || typeof artifact !== "object") return { kind: "unknown", label: "结果", canPreview: false };
  const kind = ["image", "video", "audio"].includes(artifact.kind) ? artifact.kind : "unknown";
  return {
    kind,
    label: kind === "image" ? "图片结果" : kind === "video" ? "视频结果" : kind === "audio" ? "音频结果" : "结果",
    canPreview: Boolean(artifact.id),
  };
}
