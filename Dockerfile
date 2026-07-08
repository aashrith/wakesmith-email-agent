# Single-stage on purpose: this runs via tsx (TS directly, no compile
# step) rather than tsc-to-JS. That's the right trade-off for a
# demo-scale service — a real production deploy would add a build stage,
# but that's complexity this project doesn't need yet (see README).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
