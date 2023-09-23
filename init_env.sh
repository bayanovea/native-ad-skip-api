#!/bin/bash

echo "DB_NAME=$DB_NAME" >> /app/.env
echo "DB_USER=$DB_USER" >> /app/.env
echo "DB_PASSWORD=$DB_PASSWORD" >> /app/.env
echo "DB_HOST=$DB_HOST" > /app/.env
echo "NODE_APP_PORT=$NODE_APP_PORT" > /app/.env
