FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# better-sqlite3 在 Linux 构建阶段需要 node-gyp 的 Python 和 C/C++ 工具链。
# apt 源沿用基础镜像默认配置；重试用于应对临时网络抖动。
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
# 构建完成后重建一棵只含生产依赖的依赖树。
# 直接 `pnpm install --prod` 不够：pnpm 只解链顶层条目，虚拟 store（.pnpm）里的
# 开发依赖仍留在磁盘上（实测 vitest/jsdom/@testing-library 仍在镜像内）。
# 先删除 node_modules 再装，才能得到干净的生产树。
RUN rm -rf node_modules && pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 只复制运行时需要的东西：产物、生产依赖、清单文件。
#
# 用 --chown 而不是复制后再 `chown -R`：后者会重写每个文件的元数据，
# BuildKit 因此生成一个包含全部文件副本的新层（实测多出 807MB）。
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages

# 数据目录必须属于运行用户，否则挂载命名卷后无法写入。
RUN mkdir -p /app/data && chown node:node /app/data
# 以非 root 运行：容器内任意文件写入类漏洞不再能落到宿主可写的路径上。
USER node

EXPOSE 8787
# 编排器据此判断"进程活着且能响应"，而不是只看容器是否在跑。
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
