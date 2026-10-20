#!/usr/bin/env bash
# Fullfilio root-domain proxy (deploy/root-proxy): install or update it on an Ubuntu server.
#   curl -fsSL https://fullfilio.com/downloads/root-proxy/install.sh | sudo bash -s -- you@example.com
# Safe to run again: it keeps the PROXY_SECRET it made the first time and only adds what is missing.
set -euo pipefail

# Everything runs from main, called on the last line: a download cut off half-way runs nothing.
main() {
EMAIL="${1:-}"
DIR="${FFP_DIR:-/opt/fullfilio-root-proxy}"
OLD_DIR="/home/${SUDO_USER:-ubuntu}/root-proxy"   # an earlier copy-paste install
[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo."; exit 1; }

echo "== 1/5 Opening ports 80 and 443 on this server"
open_port() {
  iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p "$1" --dport "$2" -j ACCEPT
}
if command -v iptables >/dev/null 2>&1; then
  open_port tcp 80
  open_port tcp 443
  open_port udp 443
fi
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
fi

echo "== 2/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "== 3/5 Proxy files in $DIR"
mkdir -p "$DIR"
secret_in() { [ -f "$1" ] && grep -E '^PROXY_SECRET=.{32,}$' "$1" | head -n1 | cut -d= -f2- || true; }
email_in() { [ -f "$1" ] && grep -E '^ACME_EMAIL=.+@.+$' "$1" | head -n1 | cut -d= -f2- || true; }
SECRET="$(secret_in "$DIR/.env")"
[ -n "$SECRET" ] || SECRET="$(secret_in "$OLD_DIR/.env")"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 32)"
[ -n "$EMAIL" ] || EMAIL="$(email_in "$DIR/.env")"
[ -n "$EMAIL" ] || EMAIL="$(email_in "$OLD_DIR/.env")"
case "$EMAIL" in
  *@*.*) ;;
  *) echo "Give your email after --, for example: ... | sudo bash -s -- you@example.com"; exit 1 ;;
esac

cat > "$DIR/Caddyfile" <<'EOF'
# Root-domain proxy for Fullfilio stores (see deploy/root-proxy/README.md).
{
    email {$ACME_EMAIL}
    on_demand_tls {
        ask {$FULLFILIO_SITE}/functions/v1/domains
    }
    servers {
        timeouts {
            read_header 10s
            idle 2m
        }
    }
}

http:// {
    redir https://{host}{uri} 308
}

https:// {
    tls {
        on_demand
    }
    encode zstd gzip
    reverse_proxy https://{$UPSTREAM_HOST} {
        header_up Host {$UPSTREAM_HOST}
        transport http {
            tls_server_name {$UPSTREAM_HOST}
            dial_timeout 10s
            response_header_timeout 60s
        }
        header_up X-Fullfilio-Host {http.request.tls.server_name}
        header_up X-Fullfilio-Client-IP {remote_host}
        header_up X-Fullfilio-Proxy {$PROXY_SECRET}
        header_up -X-Forwarded-For
        header_down -Server
    }
}
EOF

cat > "$DIR/docker-compose.yml" <<'EOF'
name: fullfilio-root-proxy
services:
  caddy:
    image: caddy:2.8
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    env_file: .env
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF

umask 077
cat > "$DIR/.env" <<EOF
ACME_EMAIL=$EMAIL
FULLFILIO_SITE=https://fullfilio.com
UPSTREAM_HOST=stores.fullfilio.com
PROXY_SECRET=$SECRET
EOF
chmod 600 "$DIR/.env"

echo "== 4/5 Starting the proxy"
# An earlier copy-paste install would hold ports 80/443: stop it (its secret was kept above).
if [ -f "$OLD_DIR/docker-compose.yml" ]; then docker compose -f "$OLD_DIR/docker-compose.yml" down >/dev/null 2>&1 || true; fi
docker compose -f "$DIR/docker-compose.yml" pull -q
docker compose -f "$DIR/docker-compose.yml" up -d
# Already running: load a changed Caddyfile too (up -d does not restart it for that).
docker compose -f "$DIR/docker-compose.yml" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || docker compose -f "$DIR/docker-compose.yml" restart caddy >/dev/null 2>&1 || true

echo "== 5/5 Watchdog (restarts the proxy if it ever stops answering)"
# A crashed container restarts by itself (restart: unless-stopped); a stuck one does not. Every
# minute this asks the proxy on port 80 for its redirect; after two misses in a row it restarts it.
if ! command -v cron >/dev/null 2>&1; then
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron) >/dev/null 2>&1 || true
fi
{
  echo '#!/bin/sh'
  echo "# Written by the Fullfilio root-proxy install script."
  echo "DIR='$DIR'"
  cat <<'WATCHDOG'
STATE=/run/fullfilio-proxy-watchdog
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: check.invalid' http://127.0.0.1/ || true)"
if [ "$code" = "308" ]; then rm -f "$STATE"; exit 0; fi
misses=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$misses" > "$STATE"
if [ "$misses" -ge 2 ]; then
  logger -t fullfilio-proxy "proxy not answering (HTTP $code), restarting it"
  docker compose -f "$DIR/docker-compose.yml" restart caddy >/dev/null 2>&1 || docker compose -f "$DIR/docker-compose.yml" up -d >/dev/null 2>&1 || true
  rm -f "$STATE"
fi
WATCHDOG
} > /usr/local/bin/fullfilio-proxy-watchdog
chmod 755 /usr/local/bin/fullfilio-proxy-watchdog
cat > /etc/cron.d/fullfilio-root-proxy <<'CRON'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root /usr/local/bin/fullfilio-proxy-watchdog
CRON
chmod 644 /etc/cron.d/fullfilio-root-proxy
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now cron >/dev/null 2>&1 || true; fi

ok=""
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: check.invalid' http://127.0.0.1/ || true)"
  if [ "$code" = "308" ]; then ok=1; break; fi
  sleep 2
done
echo
if [ -n "$ok" ]; then
  echo "Proxy is running."
else
  echo "The proxy did not answer yet. Show the log with:"
  echo "  sudo docker compose -f $DIR/docker-compose.yml logs --tail 50"
fi
echo
echo "Put this in Cloudflare -> Workers & Pages -> fullfilio -> Settings -> Variables and Secrets"
echo "as a Secret named ROOT_PROXY_SECRET (keep it private):"
echo
echo "  $SECRET"
echo
}

main "$@"
