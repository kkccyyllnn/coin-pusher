import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One worker: parallel headless WebGL contexts contend for the GPU, and the
  // frame-time collapse makes game time drift from wall time, flaking timed
  // gameplay phases and screenshot baselines.
  workers: 1,
  timeout: 30_000,
  // 不要每轮清空 test-results：这台环境对「同一轮批量删除 >50 个文件」有保护，
  // 产物累积后会直接拒绝删除、把整轮测试打断。产物按失败用例留存即可。
  preserveOutput: 'always',
  // 产物目录可以用 `PW_OUTPUT_DIR` 覆盖——这是上面那条保护的**出口**：
  // 产物累积到 50 个以上之后，Playwright 开跑时清空 `test-results` 会被拒绝、
  // 整轮测试直接中断（报 SAFE_DELETE_BULK_CONFIRM_REQUIRED），
  // 此时换一个空目录就能继续跑：
  //   PW_OUTPUT_DIR="/tmp/pw-$(date +%s)" npx playwright test
  outputDir: process.env.PW_OUTPUT_DIR ?? './test-results',
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5188',
    // 物理试玩会产生大量运行时间，trace 会把产物撑到上百 MB 并拖慢收尾；
    // 调试时用 PW_TRACE=on 临时打开。
    trace: process.env.PW_TRACE === 'on' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5188',
    // 本地开发时通常已经开着 dev server，复用它；CI 上始终起干净的实例。
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        // devices['Desktop Chrome'] sets no channel, so Playwright launches the
        // bundled headless shell, which has no GPU backend and falls back to
        // SwiftShader (CPU) — roughly 4x slower raster and meaningless FPS.
        // The full Chromium build renders headless on the real GPU.
        channel: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],
});
