import { defineConfig } from "vitest/config.js";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    clearMocks: true,
  },
});
