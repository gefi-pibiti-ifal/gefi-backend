#!/bin/sh
# Entrypoint da API.
#
# As migrations rodam aqui, antes da aplicacao subir, e nao no CMD -- assim o
# container falha rapido e de forma visivel se o banco estiver inacessivel ou
# se uma migration quebrar, em vez de subir uma API apontando para um schema
# desatualizado.
#
# RUN_MIGRATIONS=false pula essa etapa. Use isso quando houver mais de uma
# replica da API (duas instancias aplicando migrations ao mesmo tempo disputam
# o lock do Prisma) ou quando as migrations forem aplicadas por um job proprio.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] aplicando migrations do Prisma..."
  ./node_modules/.bin/prisma migrate deploy
  echo "[entrypoint] migrations aplicadas."
else
  echo "[entrypoint] RUN_MIGRATIONS=false -- pulando migrations."
fi

# exec: a aplicacao vira o PID 1 do container e recebe SIGTERM diretamente,
# permitindo o shutdown gracioso do Nest.
exec "$@"
