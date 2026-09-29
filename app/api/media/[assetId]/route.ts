import { readFile } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "../../../../lib/db/client.ts";
import * as media from "../../../../lib/domain/media.ts";

export const dynamic = "force-dynamic";

/**
 * Serves a stored image. The path comes from the database, never from the URL,
 * and the recorded mime is echoed back with nosniff so a stored file cannot be
 * coaxed into executing as something else.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  const asset = media.byId(assetId);
  if (!asset) return new Response("Not found", { status: 404 });

  const full = path.join(UPLOAD_DIR, asset.storage_path);
  if (!path.resolve(full).startsWith(path.resolve(UPLOAD_DIR))) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const bytes = await readFile(full);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.mime,
        "Content-Length": String(asset.bytes),
        "Content-Disposition": `inline; filename="${asset.id}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
