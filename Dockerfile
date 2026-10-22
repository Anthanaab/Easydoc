FROM node:20-slim

WORKDIR /app

# Dépendances serveur uniquement (le client charge ses libs via import-map CDN)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# Données auto-hébergées (dépôt local si pas de GitHub)
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]