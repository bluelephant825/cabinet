import type { NextConfig } from "next";
import path from "path";

// Next.js 15 blocks cross-origin dev requests (HMR, /_next/*) from any Host
// not listed here. Loopback works for local desktop use, but Cabinet is also
// run on a LAN box / home server / VPS and accessed from another machine,
// in which case the operator sets CABINET_APP_ORIGIN. Auto-allow its host.
function resolveAllowedDevOrigins(): string[] {
  const origins = new Set<string>(["127.0.0.1", "localhost"]);
  // CABINET_APP_ORIGIN may carry one URL or a comma-separated list (the
  // daemon already supports the list form for its browser-origin allowlist;
  // mirror that here so a single env var configures both surfaces).
  const raw = process.env.CABINET_APP_ORIGIN?.trim();
  if (raw) {
    for (const candidate of raw.split(",").map((v) => v.trim()).filter(Boolean)) {
      try {
        const { hostname } = new URL(candidate);
        if (hostname) origins.add(hostname);
      } catch {
        // Malformed entry — skip it but keep parsing the rest.
      }
    }
  }
  return Array.from(origins);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: resolveAllowedDevOrigins(),
  experimental: {
    // Next 16's proxy layer (src/proxy.ts) caps request bodies at 10MB by
    // default, making req.formData() fail with "Failed to parse body as
    // FormData" for larger uploads before the route handler runs. Raise it
    // above the 300MB video upload limit (+ multipart framing overhead)
    // enforced in /api/upload.
    proxyClientMaxBodySize: "350mb",
  },
  compiler: {
    removeConsole: {
      exclude: ["error", "warn"],
    },
  },
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  // Audit #219 / #220: the floating Next.js dev indicator sat on top of the
  // sidebar "New Page" button and was visible in the product chrome even in
  // dev. Disable it entirely — actual Next.js compile errors still surface
  // via the terminal and the error overlay.
  devIndicators: false,
  serverExternalPackages: [
    "node-pty",
    "simple-git",
    "better-sqlite3",
    "node-cron",
    // Vendored GenOffice engines are server/daemon-only: keep their runtime
    // deps external so Next never bundles them (or their wasm assets) into
    // client or server chunks.
    "@embedpdf/pdfium",
    "pdf-lib",
    "fast-xml-parser",
    "bidi-js",
    "harfbuzzjs",
    "utif2",
    "pngjs",
    "jpeg-js",
    // PDFCN/Takumi renderer — wasm-based, worker-only (server/documents).
    "takumi-pdf",
    "@takumi-rs/helpers",
  ],
  outputFileTracingIncludes: {
    "/*": [
      // Turbopack prod runtimes are loaded via externalRequire() at runtime,
      // so static tracing misses them — the packaged standalone died on boot
      // with "Cannot find module 'next/dist/compiled/next-server/app-route-
      // turbo.runtime.prod.js'". Force-include the whole directory.
      "node_modules/next/dist/compiled/next-server/*.js",
    ],
  },
  outputFileTracingExcludes: {
    "/*": [
      ".next/dev/**/*",
      ".next/cache/**/*",
      "dist/**/*",
      "data-backup-*/**",
      ".git/**/*",
      ".github/**/*",
      ".claude/**/*",
      ".agents/**/*",
      "coverage/**/*",
      "out/**/*",
      "test/**/*",
      "**/.DS_Store",
    ],
  },
  async rewrites() {
    return [
      {
        source: "/room/:path*\\.:ext(html|pdf|csv|ipynb|tex|latex|typ)",
        destination: "/room/:path*",
      },
    ];
  },
};

export default nextConfig;
