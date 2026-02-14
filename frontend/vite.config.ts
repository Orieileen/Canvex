import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const api = env.VITE_API_URL
  const conditions = [mode === 'production' ? 'production' : 'development', 'browser', 'module', 'import']
  const canvexCss = path.resolve(
    __dirname,
    "node_modules/@excalidraw/excalidraw/dist",
    mode === 'production' ? "prod/index.css" : "dev/index.css"
  )

  return {
    plugins: [react(), tailwindcss()],
    define: {
      global: "globalThis",
      "process.env": {},
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@excalidraw/excalidraw/index.css": canvexCss,
      },
      conditions,
    },
    // 构建配置：调高大包体积的告警阈值（单位 KB），避免 Vite 在构建时因大体积第三方依赖频繁告警
    // 说明：仅调整“告警阈值”，不影响实际打包结果；如需真正减小体积，建议按需拆分动态 import 或启用更细 manualChunks
    build: {
      chunkSizeWarningLimit: 2000, // 将告警阈值从默认 500KB 提升到 2000KB（2MB）
    },
    server: {
      proxy: {
        // Proxy media to backend with ngrok header so <img src="/media/..."> works without custom headers
        '/media': {
          target: api || 'http://localhost:8000',
          changeOrigin: true,
          headers: { 'ngrok-skip-browser-warning': 'true' },
        },
      },
    },
  }
})
