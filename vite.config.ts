import { defineConfig } from "vite";

export default defineConfig({
  server: {
    watch: {
      // Only source code needs live reload. Watching saved projects, test files and images can
      // crash the dev server on Windows when a file is still locked while it's being written.
      ignored: ["**/test/**", "**/*.paintsim", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.gpl", "**/*.svg"],
    },
  },
});
