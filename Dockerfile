# Single-stage on purpose: runs via tsx (TS directly, no compile step)
# rather than tsc-to-JS. That's the right trade-off for a demo-scale
# service — a real production deploy would add a build stage. `pnpm
# build` (vite) exists as a CI-style bundling check (see README) but
# isn't what this container runs.
FROM node:24-slim

WORKDIR /app

# Containers never have a TTY. Without this, pnpm's automatic
# deps-status check (run before any `pnpm <script>`) can try to
# interactively confirm a node_modules purge and abort instead —
# harmless here since install already ran with a verified lockfile,
# but there's no reason to leave a container hostage to a prompt that
# can never be answered.
ENV CI=true

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["pnpm", "start"]
