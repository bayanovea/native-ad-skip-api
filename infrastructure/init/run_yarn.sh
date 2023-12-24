#!/bin/sh

if [ "$ENV" = "dev" ]; then
  exec yarn dev
else
  exec yarn start
fi
