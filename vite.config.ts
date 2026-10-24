import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type Plugin } from "vite";

// Audit F6: GitHub Pages cannot send response headers, so ship a <meta> CSP in
// PRODUCTION builds only (dev needs inline scripts/websockets for HMR). Note a
// meta CSP cannot enforce frame-ancestors / report-uri; put the site behind a
// header-capable host (Cloudflare, Netlify, Vercel) to get those.
const SUPABASE_ORIGIN = "https://ewukneoblhogtreeekqc.supabase.co";
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React/Leaflet/Radix set inline style attributes
  `img-src 'self' data: blob: https://tile.openstreetmap.org ${SUPABASE_ORIGIN}`,
  `media-src 'self' blob: ${SUPABASE_ORIGIN}`,
  `connect-src 'self' ${SUPABASE_ORIGIN} wss://ewukneoblhogtreeekqc.supabase.co`,
  "font-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "mg-csp-meta",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<head>",
        `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  <meta name="referrer" content="strict-origin-when-cross-origin" />`,
      ),
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // Repository-aware base path. On GitHub Pages project sites the app is served
  // from /<repo>/ — but ONLY for production builds: the dev/preview server
  // always serves from /, so a stray GITHUB_REPOSITORY in the sandbox can never
  // move the preview to a subpath (which renders a blank page).
  // Set PUBLIC_PATH to override either case.
  const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  const base =
    process.env.PUBLIC_PATH ??
    (command === "build" && repoName ? `/${repoName}/` : "/");

  return {
    plugins: [react(), tailwindcss(), cspPlugin()],
    base,
    // Short commit id of the deployed build, shown on error panels so a report
    // can say exactly which version of the app produced it.
    define: {
      __BUILD_ID__: JSON.stringify(
        (process.env.GITHUB_SHA ?? "dev").slice(0, 7),
      ),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      // Force a single copy of React across all packages.
      dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom", "react-router"],
            "supabase-vendor": ["@supabase/supabase-js"],
            "radix-ui": [
              "@radix-ui/react-accordion",
              "@radix-ui/react-alert-dialog",
              "@radix-ui/react-avatar",
              "@radix-ui/react-checkbox",
              "@radix-ui/react-collapsible",
              "@radix-ui/react-context-menu",
              "@radix-ui/react-dialog",
              "@radix-ui/react-dropdown-menu",
              "@radix-ui/react-hover-card",
              "@radix-ui/react-label",
              "@radix-ui/react-menubar",
              "@radix-ui/react-navigation-menu",
              "@radix-ui/react-popover",
              "@radix-ui/react-progress",
              "@radix-ui/react-radio-group",
              "@radix-ui/react-scroll-area",
              "@radix-ui/react-select",
              "@radix-ui/react-separator",
              "@radix-ui/react-slider",
              "@radix-ui/react-slot",
              "@radix-ui/react-switch",
              "@radix-ui/react-tabs",
              "@radix-ui/react-toggle",
              "@radix-ui/react-toggle-group",
              "@radix-ui/react-tooltip",
            ],
            charts: ["recharts"],
            forms: ["react-hook-form", "@hookform/resolvers", "zod"],
            maps: ["leaflet", "react-leaflet"],
          },
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash].[ext]",
        },
      },
      chunkSizeWarningLimit: 1000,
      target: "esnext",
      minify: "esbuild",
    },
    optimizeDeps: {
      entries: ["index.html"],
      include: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "react-router",
        "@supabase/supabase-js",
      ],
    },
    server: {
      host: true,
      port: 5173,
    },
  };
});
