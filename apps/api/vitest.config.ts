import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * 串行执行测试文件。
     *
     * 这些用例每个都起一整套 Fastify 实例、再开第二个 SQLite 连接直连同一个库文件。
     * 并行跑时会互相抢临时目录与文件锁，表现为偶发的 `UNIQUE constraint failed: users.email`
     * 与长耗时用例超时——单跑全过、并行偶发失败，是最难排查的那类不稳定。
     * 串行换来确定性，代价是整体慢一点。
     */
    fileParallelism: false,
    // 套图分页用例要遍历 1000+ 条内置套图，默认 5s 在慢机上不够。
    testTimeout: 30_000,
  },
});
