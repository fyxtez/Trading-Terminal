import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Tauri serves the production bundle from its own application protocol.
  // Relative asset URLs work there and also keep browser deployments portable
  // when the terminal is hosted below a non-root path.
  base: "./",
  clearScreen: false,
  server: {
    host: tauriDevHost || false,
    port: 5173,
    strictPort: true,
    hmr: tauriDevHost ? { protocol: "ws", host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    rolldownOptions: {
      output: {
        // The chart stays in the initial request path, but a dedicated chunk
        // lets the browser cache its stable third-party code independently
        // from frequently changing application logic. Remaining dependencies
        // are likewise separated from the app and from the chart runtime.
        codeSplitting: {
          groups: [
            {
              name: "chart-vendor",
              test: /node_modules[\\/]lightweight-charts[\\/]/,
              priority: 30,
            },
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
