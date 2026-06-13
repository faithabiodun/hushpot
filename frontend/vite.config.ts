import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Zama relayer SDK ships a WASM module and expects browser globals. We expose `global` and
// keep the SDK out of dependency pre-bundling so its WASM loads correctly.
export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    exclude: ["@zama-fhe/relayer-sdk"],
  },
  build: {
    target: "es2020",
  },
});
