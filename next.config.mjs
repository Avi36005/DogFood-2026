/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite is a runtime builtin; it must never be bundled.
  serverExternalPackages: ["node:sqlite"],
  images: { unoptimized: true },
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/**": ["./lib/db/schema.sql"],
  },
  async headers() {
    return [
      {
        // Everything is frame-denied by default.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // The embeddable gallery is the one deliberate exception. It carries
        // only public gallery data, so framing it leaks nothing private.
        // frame-ancestors is narrowed with FORGEBOARD_EMBED_ANCESTORS.
        source: "/embed/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "" },
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${process.env.FORGEBOARD_EMBED_ANCESTORS ?? "*"}`,
          },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};
export default nextConfig;
