"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { uploadMediaAction, removeMediaAction } from "@/lib/actions/participant.ts";
import { Button, Notice, Panel, PanelHeader } from "./ui";
import { useFormAction } from "./form";

type Asset = { id: string; filename: string; bytes: number; mime: string };

export function MediaPanel({
  slug, projectId, thumbnail, gallery, readOnly,
}: {
  slug: string; projectId: string;
  thumbnail: Asset | null; gallery: Asset[]; readOnly: boolean;
}) {
  const [up, upload, uploading] = useFormAction(uploadMediaAction);
  const [rm, remove] = useFormAction(removeMediaAction);

  return (
    <Panel>
      <PanelHeader
        title="Media"
        sub="PNG, JPEG, GIF or WebP, up to 5 MB each. Stored on this server; nothing is sent anywhere."
      />
      <div className="space-y-6 px-5 py-5">
        {up.error ? <Notice tone="danger">{up.error}</Notice> : null}
        {rm.error ? <Notice tone="danger">{rm.error}</Notice> : null}

        <div>
          <h3 className="mb-2 text-[13px] font-medium text-foreground">Thumbnail</h3>
          <div className="flex flex-wrap items-start gap-4">
            {thumbnail ? (
              <figure className="w-40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${thumbnail.id}`}
                  alt={`Thumbnail for this project: ${thumbnail.filename}`}
                  className="h-24 w-40 rounded-[8px] border border-border object-cover"
                />
                <figcaption className="mt-1 truncate font-mono text-[11px] text-muted-soft">{thumbnail.filename}</figcaption>
              </figure>
            ) : (
              <div className="flex h-24 w-40 items-center justify-center rounded-[8px] border border-dashed border-border text-[12px] text-muted-soft">
                No thumbnail
              </div>
            )}

            {!readOnly ? (
              <form action={upload} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="slot" value="thumbnail" />
                <input
                  type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp"
                  aria-label="Choose a thumbnail image"
                  className="max-w-[230px] text-[12px] text-muted-foreground file:mr-3 file:min-h-[38px] file:rounded-[8px] file:border-0 file:bg-secondary file:px-3 file:text-[12px] file:text-foreground"
                />
                <Button type="submit" tone="secondary" disabled={uploading}>
                  <ImagePlus size={15} />{uploading ? "Uploading…" : "Upload"}
                </Button>
              </form>
            ) : null}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-[13px] font-medium text-foreground">Gallery <span className="text-muted-soft">({gallery.length} of 8)</span></h3>
          {gallery.length ? (
            <ul className="flex flex-wrap gap-3">
              {gallery.map((a) => (
                <li key={a.id} className="w-32">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${a.id}`}
                    alt={a.filename}
                    className="h-20 w-32 rounded-[8px] border border-border object-cover"
                  />
                  {!readOnly ? (
                    <form action={remove} className="mt-1">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="assetId" value={a.id} />
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 size={12} aria-hidden />Remove
                        <span className="sr-only"> {a.filename}</span>
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-soft">No gallery images yet.</p>
          )}

          {!readOnly && gallery.length < 8 ? (
            <form action={upload} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="slot" value="gallery" />
              <input
                type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp"
                aria-label="Add a gallery image"
                className="max-w-[230px] text-[12px] text-muted-foreground file:mr-3 file:min-h-[38px] file:rounded-[8px] file:border-0 file:bg-secondary file:px-3 file:text-[12px] file:text-foreground"
              />
              <Button type="submit" tone="secondary" disabled={uploading}>
                <ImagePlus size={15} />Add image
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
