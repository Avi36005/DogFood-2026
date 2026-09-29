import { createHash } from "node:crypto";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { all, get, run, nowIso, UPLOAD_DIR } from "../db/client.ts";
import { newId } from "../ids.ts";
import { AccessDenied, isProjectOwner, type Capability } from "../authz.ts";
import type { Actor } from "../auth/session.ts";
import * as audit from "./audit.ts";

export const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB
export const MAX_GALLERY = 8;

export type AssetRow = {
  id: string; filename: string; mime: string; bytes: number;
  sha256: string; storage_path: string; uploaded_by: string; created_at: string;
};

/**
 * Content sniffing. The browser-supplied Content-Type and the filename are
 * both attacker-controlled, so the decision is made from the leading bytes.
 * Only still raster formats are accepted; SVG is deliberately excluded because
 * it can carry script.
 */
function sniff(buf: Uint8Array): { mime: string; ext: string } | null {
  const b = buf;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { mime: "image/gif", ext: "gif" };
  const ascii = String.fromCharCode(...b.slice(0, 12));
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export function byId(id: string): AssetRow | undefined {
  return get<AssetRow>(`SELECT * FROM media_assets WHERE id = ?`, id);
}

/**
 * Stores an upload. The filename on disk is generated from the asset id, so a
 * crafted name such as "../../etc/passwd" or "x.png\0.sh" cannot influence the
 * path. The original name is kept only as a display label.
 */
export async function store(actor: Actor, file: File): Promise<AssetRow> {
  if (file.size > MAX_BYTES) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 5 MB.`);
  }
  if (file.size === 0) throw new Error("That file is empty.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    throw new Error("Only PNG, JPEG, GIF or WebP images are accepted. (SVG is not, because it can carry script.)");
  }

  const id = newId("ast");
  const storagePath = `${id}.${kind.ext}`;          // generated, never user input
  const full = path.join(UPLOAD_DIR, storagePath);
  if (!path.resolve(full).startsWith(path.resolve(UPLOAD_DIR))) {
    throw new Error("Refusing to write outside the upload directory.");
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(full, bytes);

  const displayName = (file.name || "image").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  run(
    `INSERT INTO media_assets (id, filename, mime, bytes, sha256, storage_path, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, displayName, kind.mime, bytes.byteLength,
    createHash("sha256").update(bytes).digest("hex"), storagePath, actor.id, nowIso(),
  );
  return byId(id)!;
}

export async function attachThumbnail(cap: Capability, actor: Actor, projectId: string, file: File) {
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  const asset = await store(actor, file);
  run(`UPDATE projects SET thumbnail_asset_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    asset.id, nowIso(), projectId);
  audit.record({ actor, eventId: cap.eventId, action: "media.thumbnail", subjectType: "project", subjectId: projectId, detail: { assetId: asset.id, bytes: asset.bytes } });
  return asset;
}

export async function attachGallery(cap: Capability, actor: Actor, projectId: string, file: File) {
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  const count = get<{ n: number }>(`SELECT COUNT(*) AS n FROM project_media WHERE project_id = ?`, projectId)!.n;
  if (count >= MAX_GALLERY) throw new Error(`A project can hold ${MAX_GALLERY} gallery images.`);
  const asset = await store(actor, file);
  run(`INSERT INTO project_media (id, project_id, asset_id, sort_order) VALUES (?,?,?,?)`,
    newId("pmd"), projectId, asset.id, count);
  audit.record({ actor, eventId: cap.eventId, action: "media.gallery", subjectType: "project", subjectId: projectId, detail: { assetId: asset.id } });
  return asset;
}

export async function removeAsset(cap: Capability, actor: Actor, projectId: string, assetId: string) {
  if (!cap.isOrganizer && !isProjectOwner(actor, projectId)) throw new AccessDenied("not your team's project");
  run(`DELETE FROM project_media WHERE project_id = ? AND asset_id = ?`, projectId, assetId);
  run(`UPDATE projects SET thumbnail_asset_id = NULL WHERE id = ? AND thumbnail_asset_id = ?`, projectId, assetId);
  const asset = byId(assetId);
  const stillUsed = get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM project_media WHERE asset_id = ?)
          + (SELECT COUNT(*) FROM projects WHERE thumbnail_asset_id = ?) AS n`, assetId, assetId)!.n;
  if (asset && stillUsed === 0) {
    run(`DELETE FROM media_assets WHERE id = ?`, assetId);
    try { await unlink(path.join(UPLOAD_DIR, asset.storage_path)); } catch { /* already gone */ }
  }
  audit.record({ actor, eventId: cap.eventId, action: "media.remove", subjectType: "project", subjectId: projectId, detail: { assetId } });
}

export function galleryFor(projectId: string): AssetRow[] {
  return all<AssetRow>(
    `SELECT a.* FROM project_media pm JOIN media_assets a ON a.id = pm.asset_id
      WHERE pm.project_id = ? ORDER BY pm.sort_order`, projectId);
}
