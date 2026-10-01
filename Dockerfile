# Untested in the authoring environment (no Docker available) — build in CI first.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/rbac/package.json packages/rbac/
COPY packages/payroll/package.json packages/payroll/
COPY packages/time/package.json packages/time/
COPY packages/services/package.json packages/services/
COPY packages/documents/package.json packages/documents/
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate --schema packages/db/prisma/schema && npm run build --workspace apps/web

FROM node:20-bookworm-slim AS run
ENV NODE_ENV=production PORT=3100
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema && npm run start --workspace apps/web"]
