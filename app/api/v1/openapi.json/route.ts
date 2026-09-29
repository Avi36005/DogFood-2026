import { TOPICS } from "../../../../lib/domain/webhooks.ts";

export const dynamic = "force-dynamic";

/**
 * OpenAPI 3.1 for the operations this server actually implements.
 *
 * Deliberately not aspirational: every path below is backed by a handler in
 * app/api/v1/[[...path]]/route.ts. Operations the UI supports but the API does
 * not are listed in README.md under the T4 coverage note rather than described
 * here as though they exist.
 */
const spec = {
  openapi: "3.1.0",
  info: {
    title: "Forgeboard API",
    version: "1.0.0",
    description:
      "Read and write access to events, projects, judging and results. " +
      "Authorization is identical to the web interface: a key grants exactly what its owner can do.",
    license: { name: "MIT" },
  },
  servers: [{ url: "/api/v1" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http", scheme: "bearer",
        description: "An event API key (`fbk_…`), issued from the organizer console. A session cookie also works.",
      },
    },
    parameters: {
      limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      offset: { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      slug: { name: "slug", in: "path", required: true, schema: { type: "string" } },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              status: { type: "integer" },
              title: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
      Pagination: {
        type: "object",
        properties: {
          total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" },
        },
      },
      Event: {
        type: "object",
        properties: {
          id: { type: "string" }, slug: { type: "string" }, name: { type: "string" },
          tagline: { type: "string" },
          status: { type: "string", enum: ["draft", "open", "submissions_closed", "judging", "results_published", "archived"] },
          timezone: { type: "string" },
          submissions_open_at: { type: ["string", "null"], format: "date-time" },
          submissions_close_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" }, tagline: { type: "string" },
          track: { type: ["string", "null"] }, team: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          submitted_at: { type: ["string", "null"], format: "date-time" },
          links: {
            type: "object",
            properties: {
              repository: { type: ["string", "null"] },
              live: { type: ["string", "null"] },
              demo_video: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    responses: {
      Forbidden: { description: "The caller may not do this.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      NotFound: { description: "No such resource, or the caller may not know it exists.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Validation: { description: "The request was understood but rejected.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  },
  paths: {
    "/": {
      get: {
        summary: "Service description and the identity behind the current credentials",
        security: [{}, { bearerAuth: [] }],
        responses: { "200": { description: "Service metadata" } },
      },
    },
    "/events": {
      get: {
        summary: "List events visible to the caller",
        description: "Anonymous callers see published events. A signed-in caller also sees drafts they organize.",
        security: [{}, { bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/offset" }],
        responses: {
          "200": {
            description: "A page of events",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Event" } },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Create an event; the caller becomes its organizer",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object", required: ["name"],
                properties: { name: { type: "string", minLength: 2 }, tagline: { type: "string" }, description: { type: "string" } },
              },
              example: { name: "Spring Build 2027", tagline: "Two days, one product." },
            },
          },
        },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } } },
          "422": { $ref: "#/components/responses/Validation" },
        },
      },
    },
    "/events/{slug}": {
      get: {
        summary: "One event with its tracks and prizes",
        security: [{}, { bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "The event" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/events/{slug}/projects": {
      get: {
        summary: "Public gallery: submitted projects only",
        description: "Drafts, withdrawn entries and private answers are never returned, whoever asks.",
        security: [{}, { bearerAuth: [] }],
        parameters: [
          { $ref: "#/components/parameters/slug" },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "track", in: "query", schema: { type: "string" } },
          { name: "tag", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/offset" },
        ],
        responses: {
          "200": {
            description: "A page of projects",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Project" } },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/events/{slug}/judges": {
      get: {
        summary: "Judge progress (organizer only)",
        description: "Counts and last activity. Never another judge's scores.",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "Progress rows" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/events/{slug}/assignments": {
      get: {
        summary: "Coverage per project (organizer only)",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "Coverage rows" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
      post: {
        summary: "Generate assignments (organizer only)",
        description: "Additive and idempotent-ish: existing assignments are counted and kept.",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { reviews_per_project: { type: "integer", minimum: 1, maximum: 20 } } } } },
        },
        responses: { "201": { description: "Plan applied, with any uncovered slots listed" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/events/{slug}/reviews": {
      get: {
        summary: "Submitted reviews (organizer only)",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "Reviews with weighted scores" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/events/{slug}/results": {
      get: {
        summary: "Results",
        description: "Anonymous and non-organizer callers get the published snapshot only, and 404 if none is published.",
        security: [{}, { bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "Snapshot and rows" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
      post: {
        summary: "Compute a new snapshot (organizer only). Does not publish it.",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "201": { description: "Snapshot computed" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/events/{slug}/publish": {
      post: {
        summary: "Publish the latest snapshot (organizer only)",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "Published" }, "409": { description: "No snapshot to publish" } },
      },
    },
    "/events/{slug}/status": {
      post: {
        summary: "Move the event to another phase (organizer only)",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } } } },
        },
        responses: { "200": { description: "Updated" }, "422": { $ref: "#/components/responses/Validation" } },
      },
    },
    "/events/{slug}/tracks": {
      post: {
        summary: "Add a track (organizer only)",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } },
        responses: { "201": { description: "Created" } },
      },
    },
    "/events/{slug}/export": {
      get: {
        summary: "Whole-event bundle (organizer only)",
        description: "Excludes password hashes, sessions and raw invitation tokens.",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        responses: { "200": { description: "A portable bundle" }, "403": { $ref: "#/components/responses/Forbidden" } },
      },
    },
    "/events/{slug}/import": {
      post: {
        summary: "Import a bundle as a new event (organizer only)",
        description: "All-or-nothing. Send `dry_run: true` first for a validation report that writes nothing.",
        parameters: [{ $ref: "#/components/parameters/slug" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["bundle"], properties: { bundle: { type: "object" }, dry_run: { type: "boolean" } } } } },
        },
        responses: { "200": { description: "Report" }, "422": { $ref: "#/components/responses/Validation" } },
      },
    },
  },
  "x-webhooks": {
    topics: TOPICS,
    delivery:
      "At-least-once. Each payload carries a stable `id`; consumers must deduplicate on it. " +
      "Signature: HMAC-SHA256 over `deliveryId.timestamp.body`, sent as X-Forgeboard-Signature. " +
      "Up to 4 attempts with exponential backoff. Callback URLs resolving to private or reserved addresses are refused.",
  },
};

export async function GET() {
  return Response.json(spec, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}
