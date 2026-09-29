import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { currentActor } from "@/lib/auth/session.ts";

/**
 * Header and footer for every page are the reference's own Navigation and
 * FooterSection. The navigation is fixed and 80px tall, so a spacer keeps page
 * content from sliding under it.
 */
export async function SiteHeader() {
  const actor = await currentActor();
  return (
    <>
      <Navigation signedIn={!!actor} displayName={actor?.displayName} solid />
      <div className="h-16" aria-hidden />
    </>
  );
}

export function SiteFooter() {
  return <FooterSection />;
}
