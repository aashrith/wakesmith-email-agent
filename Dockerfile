# Single-stage on purpose: runs via tsx (TS directly, no compile step)
# rather than tsc-to-JS. That's the right trade-off for a demo-scale
# service — a real production deploy would add a build stage. `pnpm
# build` (vite) exists as a CI-style bundling check (see README) but
# isn't what this container runs.
FROM node:24-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["pnpm", "start"]
