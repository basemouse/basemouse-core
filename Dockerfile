FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Dependencies first (pg, stripe) so the layer caches across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
# migrations + scripts ship in the image so issue-key.mjs / migrate.mjs can
# run via `kubectl exec` in the pod (design decision 3A) without prod
# credentials ever living on a workstation.
COPY migrations ./migrations
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
