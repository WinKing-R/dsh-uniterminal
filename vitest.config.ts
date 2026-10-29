import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * 默认 node 环境：绝大多数用例是纯逻辑与源码断言，不需要 DOM。
     *
     * 需要真 DOM 的用例（渲染组件、模拟真实点击与键盘）在**文件头**单独声明：
     *   // @vitest-environment jsdom
     * 这样全局默认不变，node 环境的用例不会被 jsdom 拖慢，也不会因为
     * "全局开 jsdom"而让某些依赖 node 行为的断言失真。
     */
    environment: "node",
    // .test.tsx 是 DOM 用例（渲染 React 组件需要 JSX）。
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
