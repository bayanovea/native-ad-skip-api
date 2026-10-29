#!/bin/bash

echo "DB_NAME=$DB_NAME" >> /app/.env
echo "DB_USER=$DB_USER" >> /app/.env
echo "DB_PASSWORD=$DB_PASSWORD" >> /app/.env
echo "DB_HOST=$DB_HOST" >> /app/.env
echo "NODE_APP_PORT=$NODE_APP_PORT" >> /app/.env
echo "AUTH_TOKEN=$AUTH_TOKEN" >> /app/.env
echo "HOST_IP=$HOST_IP" >> /app/.env
# The AI command's switches and key; cron jobs see only /app/.env.
env | grep -E '^(AI_[A-Z_]+|YTDLP_BIN|ANTHROPIC_API_KEY|PROVIDER_[A-Z_]+|LEGACY_PRV)=' >> /app/.env || true
