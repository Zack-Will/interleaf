import crypto from "node:crypto";
import Settings from "@overleaf/settings";
import { fetchJson } from "@overleaf/fetch-utils";
import ProjectEntityHandler from "../../../../app/src/Features/Project/ProjectEntityHandler.mjs";
import DocumentUpdaterHandler from "../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs";
import HistoryManager from "../../../../app/src/Features/History/HistoryManager.mjs";
import FileTypeManager from "../../../../app/src/Features/Uploads/FileTypeManager.mjs";
import isUtf8 from "utf-8-validate";
import { NotATextFileError } from "./Errors.mjs";

const clean = (p) => String(p || "").replace(/^\/+/, "");
async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), tooLarge: false };
}
async function resolveHash(projectId, path, hash) {
  const response = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    hash,
  );
  const loaded = await streamBuffer(response.stream);
  if (loaded.buffer.length > Settings.max_doc_length * 3)
    return {
      path,
      kind: "file",
      hash,
      size: loaded.buffer.length,
      getBuffer: () => loaded.buffer,
      buffer: loaded.buffer,
    };
  const text = loaded.buffer.toString("utf8");
  const invalidUtf8 = !isUtf8(loaded.buffer);
  if (!invalidUtf8 && FileTypeManager.isEditable(text, { filename: path })) {
    return { path, kind: "doc", content: text, size: loaded.buffer.length };
  }
  return {
    path,
    kind: "file",
    hash,
    size: loaded.buffer.length,
    getBuffer: () => loaded.buffer,
    buffer: loaded.buffer,
  };
}
async function getSnapshot(projectId, version, options = {}) {
  const body = await fetchJson(
    `${Settings.apis.project_history.url}/project/${projectId}/version/${version}`,
  );
  const files = [];
  const pending = [];
  for (const [pathname, entry] of Object.entries(body.files || {})) {
    const path = clean(pathname);
    const data = entry?.data || {};
    if (!entry || !entry.data) continue;
    if (data.content != null)
      files.push({
        path,
        kind: "doc",
        content: data.content,
        size: Buffer.byteLength(data.content),
      });
    else if (
      data.hash &&
      (options.includeBinary ||
        FileTypeManager.isEditable("", { filename: path }))
    )
      pending.push({ path, hash: data.hash });
  }
  for (let index = 0; index < pending.length; index += 4) {
    const batch = pending.slice(index, index + 4);
    files.push(
      ...(await Promise.all(
        batch.map((item) => resolveHash(projectId, item.path, item.hash)),
      )),
    );
  }
  return { version: body.version ?? version, files };
}
async function getFileTree(projectId) {
  const entities =
    await ProjectEntityHandler.promises.getAllEntities(projectId);
  return [
    ...(entities.docs || []).map((d) => ({ path: clean(d.path), kind: "doc" })),
    ...(entities.files || []).map((f) => ({
      path: clean(f.path),
      kind: "file",
    })),
  ];
}
async function readDoc(projectId, path, { startLine, endLine } = {}) {
  const target = clean(path);
  const entities =
    await ProjectEntityHandler.promises.getAllEntities(projectId);
  if ((entities.files || []).some((f) => clean(f.path) === target))
    throw new NotATextFileError();
  const docs =
    await ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
      projectId,
    );
  const found = Object.entries(docs).find(([, p]) => clean(p) === target);
  if (!found) throw new Error("document not found");
  const [docId] = found;
  const doc = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    docId,
    -1,
  );
  const lines = Array.isArray(doc.lines)
    ? doc.lines
    : String(doc.lines || "").split(/\r\n|\n|\r/);
  const content = lines.join("\n");
  const from = startLine == null ? 0 : Math.max(0, startLine - 1);
  const to = endLine == null ? lines.length : Math.min(lines.length, endLine);
  return {
    path: target,
    lines: lines.slice(from, to),
    totalLines: lines.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    docVersion: doc.version,
  };
}
export default {
  getSnapshot,
  getFileTree,
  readDoc,
  promises: { getSnapshot, getFileTree, readDoc },
};
