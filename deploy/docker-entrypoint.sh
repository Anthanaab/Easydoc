#!/bin/sh
# Point d'entrée de l'image Docker : Easydoc ne tourne jamais en root.
#  - lancé en root (cas normal) : les données qui n'appartiennent pas encore au compte « node »
#    (volume créé par une ancienne image) lui sont rendues, puis le serveur démarre sous ce compte ;
#  - lancé avec « user: » (docker compose) ou --user : rien à faire, le serveur démarre tel quel.
set -e
DATA="${DATA_DIR:-/app/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  if [ -n "$(find "$DATA" ! -user node -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$DATA"
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
