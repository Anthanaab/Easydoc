FROM node:22-slim

# git : le dépôt local de documents (mode par défaut) est un dépôt git
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js cli.js ./
COPY src ./src
COPY public ./public
COPY deploy/docker-entrypoint.sh /usr/local/bin/easydoc-entrypoint
RUN chmod 755 /usr/local/bin/easydoc-entrypoint && mkdir -p /app/data && chown node:node /app/data

ENV PORT=3000 NODE_ENV=production DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Easydoc tourne sous le compte « node » (jamais root) : le point d'entrée rend d'abord les données
# au compte node (volumes créés par une ancienne image qui tournait en root), puis change de compte.
# arrêt propre : les documents ouverts sont enregistrés à la réception de SIGTERM
STOPSIGNAL SIGTERM
ENTRYPOINT ["easydoc-entrypoint"]
CMD ["node", "server.js"]
