import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // A benchmark pack cloned elsewhere and symlinked into packs/ must resolve its
  // relative imports of host modules (../../scripts/…) through the symlink path,
  // not through the clone's real path outside this repository.
  resolve: { preserveSymlinks: true },
  test: {
    environment: "jsdom",
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
      // Optional benchmark packs ship their own tests.
      "packs/*/**/*.test.{ts,tsx,mjs}"
    ],
    environmentOptions: {
      jsdom: {
        url: "http://127.0.0.1:4174"
      }
    },
    setupFiles: "./src/test/setup.ts"
  }
});
