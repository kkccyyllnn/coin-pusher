import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    // 本环境对批量删除有保护，Vite 清空 dist 会被拦下来导致构建失败。
    // 关掉自动清空，改为每次构建覆盖同名产物。
    emptyOutDir: false,
  },
});
