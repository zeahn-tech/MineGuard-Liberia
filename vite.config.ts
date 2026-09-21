import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// Repository-aware base path: on GitHub Pages project sites the app is served
// from /<repo>/, locally and on custom hosts from /. Set PUBLIC_PATH to
// override (e.g. PUBLIC_PATH=/mineguard-liberia/ bun run build).
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.PUBLIC_PATH ?? (repoName ? `/${repoName}/` : "/");

// https://vite.dev/config/
export default defineConfig({
  // vlyPlugin is optional in non-Freebuff environments (e.g. GitHub CI);
  // it is only loaded when installed.
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.DISABLE_VLY_PLUGIN === "1"
      ? []
      : [vlyPlugin()]),
  ],
  base,
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
          "firebase-vendor": ["firebase/app", "firebase/auth", "firebase/firestore", "firebase/storage"],
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
          "framer-motion": ["framer-motion"],
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
      "firebase/app",
      "firebase/auth",
      "firebase/firestore",
      "framer-motion",
    ],
  },
  server: {
    host: true,
    port: 5173,
    hmr: {
      overlay: false,
    },
  },
});
