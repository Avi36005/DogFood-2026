import type { Metadata } from "next";
import { currentActor } from "./auth/session.ts";
import { capabilityFor } from "./authz.ts";
import * as events from "./domain/events.ts";

/**
 * The event's name for a page title, or null when this viewer may not know it.
 *
 * Metadata is rendered even when the page itself answers 404, so a draft
 * event's name must not reach the <title> of someone the page would refuse.
 */
export async function visibleEventName(slug: string): Promise<string | null> {
  const event = events.bySlug(slug);
  if (!event) return null;
  if (event.status !== "draft") return event.name;
  const actor = await currentActor();
  return actor && capabilityFor(actor, event.id).isOrganizer ? event.name : null;
}

/** `generateMetadata` for an event page: "<label> · <event>" (the root template adds the brand). */
export function eventPageTitle(label: string) {
  return async ({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> => {
    const name = await visibleEventName((await params).slug);
    return { title: name ? `${label} · ${name}` : label };
  };
}
