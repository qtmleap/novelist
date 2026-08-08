#!/bin/zsh

sudo chown -R vscode:vscode node_modules 2>/dev/null || true
bun install --frozen-lockfile --ignore-scripts
bunx prisma generate
