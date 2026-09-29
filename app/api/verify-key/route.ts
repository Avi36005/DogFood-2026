import { publicKeyPem, keyIdFor } from "../../../lib/domain/records.ts";

export const dynamic = "force-dynamic";

/** Public verification material. No authentication: that is the point. */
export async function GET() {
  const pem = publicKeyPem();
  return new Response(pem, {
    headers: {
      "Content-Type": "application/x-pem-file; charset=utf-8",
      "X-Forgeboard-Key-Id": keyIdFor(pem),
      "Cache-Control": "public, max-age=300",
    },
  });
}
