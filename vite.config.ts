import { defineConfig } from "vite";

export default defineConfig({
  base: "/watchy/",
  build: {
    target: "chrome56",
    outDir: "build",
  },
});
