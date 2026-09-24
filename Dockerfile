FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

# 余料库存快照目录（docker-compose 以命名数据卷挂载到此处持久化）
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV OFFCUTS_SNAPSHOT=/app/data/offcuts-snapshot.json
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
