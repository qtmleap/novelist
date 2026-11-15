#!/bin/zsh
set -e

# Keep oh-my-zsh's completion cache from being group/other-writable.
# Processes started via `docker exec` can run with umask 0000, so the
# cache/completions directory oh-my-zsh creates on first run ends up 777 and
# compinit refuses to load completions ("Insecure completion-dependent
# directories"). Creating it first with sane permissions lets oh-my-zsh's own
# `mkdir -p` reuse it as-is.
if [ -d "$HOME/.oh-my-zsh" ]; then
  mkdir -p "$HOME/.oh-my-zsh/cache/completions"
  chmod -R go-w "$HOME/.oh-my-zsh/cache"
fi

sudo chown -R $(whoami):$(whoami) node_modules 2>/dev/null || true

# Silence direnv output.
# In direnv 2.36+, DIRENV_LOG_FORMAT env var is ignored unless direnv.toml exists.
# See: https://github.com/direnv/direnv/issues/1418
mkdir -p ~/.config/direnv
cat > ~/.config/direnv/direnv.toml <<'EOF'
[global]
log_format = ""
hide_env_diff = true
EOF

# Install deps if package.json exists.
if [ -f package.json ]; then
  if [ -f bun.lock ]; then
    bun install --frozen-lockfile --ignore-scripts
  else
    bun install --ignore-scripts
  fi
fi

# Playwright MCP drives a real Chromium, and neither the browser nor its system
# libraries ship in the image, so the first `browser_navigate` fails with
# `Browser "chromium" is not installed` until both are installed here. The MCP
# server bundles its own Playwright build and expects a different Chromium
# revision than the `playwright` devDependency, so the browser has to come from
# the MCP CLI rather than `playwright install`.
if [ -f playwright-mcp.config.json ]; then
  bunx @playwright/mcp install-browser --with-deps chromium
fi
