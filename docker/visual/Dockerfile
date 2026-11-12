# Playwright sidecar for before/after visual checks (A163). Chromium only; no vault, DB,
# Redis or SSH. The runner drops request.json under /work; this loop writes PNGs to the
# shared visual-store and result.json + done back under /work.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /opt/ulixops-visual

COPY docker/visual/package.json ./
# Browsers already live in the base image; skip download. pixelmatch + pngjs only.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund \
  && chown -R pwuser:pwuser /opt/ulixops-visual

COPY docker/visual/capture-loop.mjs ./

ENV VISUAL_WORK_DIR=/work \
    NODE_ENV=production

USER pwuser
CMD ["node", "capture-loop.mjs"]
