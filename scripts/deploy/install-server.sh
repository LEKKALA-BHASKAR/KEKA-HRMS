#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu/Debian server (run as root).
#
#   curl -fsSL https://raw.githubusercontent.com/LEKKALA-BHASKAR/KEKA-HRMS/main/scripts/deploy/install-server.sh | bash
#   # or, from a checkout:  bash scripts/deploy/install-server.sh
#
# Safe to re-run: it pulls the latest main, migrates, rebuilds and restarts.
# It never touches other nginx sites, databases or services, and it seeds the
# demo company only on the very first install.
#
# Settings (environment variables, all optional):
#   KEKA_DOMAIN   public host name. Default: <ip-with-dashes>.sslip.io, a free
#                 wildcard DNS name that resolves to this server, so HTTPS works
#                 without buying a domain. Point your own domain's A record here
#                 and pass it instead when you have one.
#   KEKA_BRANCH   git branch or commit to deploy (default main)
#   KEKA_EMAIL    email for Let's Encrypt expiry notices (default: none)
#   KEKA_PORT     local port the app listens on (default 3100)
#   KEKA_PLATFORM_EMAIL  email of the first platform admin (default admin@<domain>)
set -euo pipefail

REPO_URL="${KEKA_REPO:-https://github.com/LEKKALA-BHASKAR/KEKA-HRMS.git}"
BRANCH="${KEKA_BRANCH:-main}"
PORT="${KEKA_PORT:-3100}"
APP_DIR=/srv/keka
APP_USER=keka
DATA_DIR=/var/lib/keka
STATE_DIR=/etc/keka

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root."
command -v apt-get >/dev/null || die "This script supports Debian/Ubuntu (apt) only."

PUBLIC_IP="${KEKA_IP:-$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')}"
DOMAIN="${KEKA_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"

# ---------------------------------------------------------------------------
log "Checking what this server already runs"
# ---------------------------------------------------------------------------
if ss -ltnp 2>/dev/null | grep -q ":${PORT} " && ! systemctl is-active --quiet keka-web; then
  die "Port ${PORT} is already used by another program. Re-run with KEKA_PORT=<free port>."
fi
for p in 80 443; do
  owner="$(ss -ltnp "sport = :$p" 2>/dev/null | awk 'NR>1{print $NF}' | head -1)"
  if [ -n "$owner" ] && ! grep -q nginx <<<"$owner"; then
    die "Port $p is held by something other than nginx ($owner). Stopping so the existing site is not disturbed."
  fi
done

# ---------------------------------------------------------------------------
log "Installing system packages (Node 20, PostgreSQL, nginx, certbot)"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git openssl postgresql postgresql-contrib nginx certbot python3-certbot-nginx
node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${node_major:-0}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
systemctl enable --now postgresql nginx

# The production build needs ~4 GB; add swap on small servers so it is not killed.
mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 6000000 ] && [ "$(swapon --noheadings | wc -l)" = 0 ] && [ ! -f /swapfile-keka ]; then
  log "Adding a 4 GB swap file for the build"
  fallocate -l 4G /swapfile-keka && chmod 600 /swapfile-keka && mkswap /swapfile-keka && swapon /swapfile-keka
  echo '/swapfile-keka none swap sw 0 0' >> /etc/fstab
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR" "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/mail"
install -d -m 700 "$STATE_DIR"

# ---------------------------------------------------------------------------
log "Fetching the code ($BRANCH)"
# ---------------------------------------------------------------------------
[ -d "$APP_DIR/.git" ] || sudo -u "$APP_USER" git init -q "$APP_DIR"
sudo -u "$APP_USER" git -C "$APP_DIR" remote remove origin 2>/dev/null || true
sudo -u "$APP_USER" git -C "$APP_DIR" remote add origin "$REPO_URL"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" reset -q --hard FETCH_HEAD
sudo -u "$APP_USER" git -C "$APP_DIR" log -1 --format='Deploying %h %s' 

# ---------------------------------------------------------------------------
log "Preparing the database and secrets"
# ---------------------------------------------------------------------------
# Secrets are generated once and kept in /etc/keka (root only). Hex keeps the
# auth secret clear of the start-up placeholder check.
[ -f "$STATE_DIR/db_password" ] || openssl rand -hex 24 > "$STATE_DIR/db_password"
[ -f "$STATE_DIR/auth_secret" ] || openssl rand -hex 48 > "$STATE_DIR/auth_secret"
chmod 600 "$STATE_DIR"/*
DB_PASS="$(cat "$STATE_DIR/db_password")"

sudo -u postgres psql -v ON_ERROR_STOP=1 -tc "SELECT 1 FROM pg_roles WHERE rolname='keka'" | grep -q 1 \
  || sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE keka LOGIN PASSWORD '${DB_PASS}'"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE keka WITH LOGIN PASSWORD '${DB_PASS}' CREATEDB"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='keka'" | grep -q 1 \
  || sudo -u postgres createdb -O keka keka

# NODE_ENV stays out of .env so `npm ci` still installs the build tooling;
# the service sets it.
cat > "$APP_DIR/.env" <<EOF
DATABASE_URL="postgresql://keka:${DB_PASS}@localhost:5432/keka?schema=public"
AUTH_SECRET="$(cat "$STATE_DIR/auth_secret")"
APP_URL="https://${DOMAIN}"
AUTH_URL="https://${DOMAIN}"
APP_BASE_DOMAIN="${DOMAIN}"
STORAGE_DIR="${DATA_DIR}/storage"
MAIL_DIR="${DATA_DIR}/mail"
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------------------------------------------------------------------------
log "Installing dependencies, migrating and building (takes a few minutes)"
# ---------------------------------------------------------------------------
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && set -a && . ./.env && set +a && $*"; }
as_app "npm ci --no-audit --no-fund"
as_app "npm run db:generate"
# Through the package script so prisma.config.ts supplies the migrations folder;
# `--schema <dir>` alone finds no migrations and applies nothing.
as_app "npm run deploy --workspace=@keka/db"
if [ ! -f "$STATE_DIR/seeded" ]; then
  log "First install: loading the demo company"
  as_app "npm run db:seed"
  touch "$STATE_DIR/seeded"
fi
as_app "NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace apps/web"

# ---------------------------------------------------------------------------
log "Running the app as a service"
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/keka-web.service <<EOF
[Unit]
Description=BooS-HR web app
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=/usr/bin/npm run start --workspace apps/web -- -H 127.0.0.1 -p ${PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable keka-web
systemctl restart keka-web

cat > /etc/cron.d/keka <<EOF
*/5 * * * * ${APP_USER} cd ${APP_DIR} && set -a && . ./.env && set +a && npm run jobs -- deliver-mail >> /var/log/keka-jobs.log 2>&1
30 1 * * *  ${APP_USER} cd ${APP_DIR} && set -a && . ./.env && set +a && npm run jobs -- nightly >> /var/log/keka-jobs.log 2>&1
15 * * * * ${APP_USER} cd ${APP_DIR} && set -a && . ./.env && set +a && npm run jobs -- automations >> /var/log/keka-jobs.log 2>&1
EOF
touch /var/log/keka-jobs.log && chown "$APP_USER" /var/log/keka-jobs.log

# ---------------------------------------------------------------------------
log "Putting nginx in front (${DOMAIN} and every company's <name>.${DOMAIN})"
# ---------------------------------------------------------------------------
# Each company signs in at its own address, <subdomain>.${DOMAIN}. sslip.io
# answers for any such name; with your own domain add a wildcard DNS record
# (*.yourdomain -> this server). Sign-in cookies are Secure in production, so
# everything is HTTPS: one certificate holds the main name plus every
# company's name, and keka-cert-sync adds new companies to it every few minutes.
CERT_NAME="$DOMAIN"
CERT_DIR="/etc/letsencrypt/live/${CERT_NAME}"
mkdir -p /var/www/certbot

write_nginx() {
  local proxy='
        proxy_pass http://127.0.0.1:'"${PORT}"';
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;'
  if [ -f "${CERT_DIR}/fullchain.pem" ]; then
    cat > /etc/nginx/sites-available/keka <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} .${DOMAIN} ${PUBLIC_IP};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / {
        if (\$host = ${PUBLIC_IP}) { return 301 https://${DOMAIN}\$request_uri; }
        return 301 https://\$host\$request_uri;
    }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${DOMAIN} .${DOMAIN};
    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    client_max_body_size 25m;
    location / {${proxy}
    }
}
EOF
  else
    cat > /etc/nginx/sites-available/keka <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} .${DOMAIN} ${PUBLIC_IP};
    client_max_body_size 25m;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / {${proxy}
    }
}
EOF
  fi
  ln -sf /etc/nginx/sites-available/keka /etc/nginx/sites-enabled/keka
  # Older nginx (before 1.25.1) has no "http2 on;" directive.
  if ! nginx -t 2>/dev/null; then sed -i '/http2 on;/d; s/listen 443 ssl;/listen 443 ssl http2;/; s/listen \[::\]:443 ssl;/listen [::]:443 ssl http2;/' /etc/nginx/sites-available/keka; fi
  nginx -t
  systemctl reload nginx
}
write_nginx

# The certificate sync: adds every active company's address to the certificate.
cat > "$STATE_DIR/cert.env" <<EOF
DOMAIN="${DOMAIN}"
CERT_NAME="${CERT_NAME}"
KEKA_EMAIL="${KEKA_EMAIL:-}"
EOF
cat > /usr/local/sbin/keka-cert-sync <<'EOF'
#!/usr/bin/env bash
# Keeps the HTTPS certificate covering the main address and every active
# company's <subdomain> address. Run by cron; safe to run by hand.
set -euo pipefail
. /etc/keka/cert.env
names=("$DOMAIN")
while read -r sub; do
  [ -n "$sub" ] && names+=("${sub}.${DOMAIN}")
done < <(sudo -u postgres psql -d keka -Atc "SELECT subdomain FROM tenants WHERE \"isActive\" ORDER BY \"createdAt\" LIMIT 99")
have="$(openssl x509 -in "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem" -noout -ext subjectAltName 2>/dev/null || true)"
missing=0
for n in "${names[@]}"; do grep -q "DNS:${n}\(,\|$\)" <<<"$have" || missing=1; done
[ "$missing" = 1 ] || exit 0
if [ -n "${KEKA_EMAIL:-}" ]; then email_args=(--email "$KEKA_EMAIL"); else email_args=(--register-unsafely-without-email); fi
args=(); for n in "${names[@]}"; do args+=(-d "$n"); done
certbot certonly --webroot -w /var/www/certbot --cert-name "$CERT_NAME" --expand --non-interactive --agree-tos "${email_args[@]}" "${args[@]}" \
  --deploy-hook "systemctl reload nginx"
EOF
chmod 755 /usr/local/sbin/keka-cert-sync
echo "*/5 * * * * root /usr/local/sbin/keka-cert-sync >> /var/log/keka-cert-sync.log 2>&1" > /etc/cron.d/keka-certs

if /usr/local/sbin/keka-cert-sync; then
  write_nginx
else
  echo "!! HTTPS certificate failed. Check that ports 80 and 443 are open in the server firewall, then re-run."
fi
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 'Nginx Full' || true; fi

# ---------------------------------------------------------------------------
log "Platform admin panel"
# ---------------------------------------------------------------------------
# The first platform admin is created once; after that they add teammates
# from the panel. The temporary password is printed here and never stored.
PLATFORM_LOGIN=""
if [ "$(sudo -u postgres psql -d keka -Atc 'SELECT count(*) FROM platform_admins')" = 0 ]; then
  PLATFORM_LOGIN="$(as_app "npm run --silent platform:admin -- '${KEKA_PLATFORM_EMAIL:-admin@${DOMAIN}}' 'Platform Admin'")"
fi

# ---------------------------------------------------------------------------
log "Checking it answers"
# ---------------------------------------------------------------------------
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo
echo
echo "Live at: https://${DOMAIN}"
echo "Platform admin panel (onboard companies): https://${DOMAIN}/platform"
if [ -n "$PLATFORM_LOGIN" ]; then echo "$PLATFORM_LOGIN"; else echo "  Lost the platform login? Reset it: cd ${APP_DIR} && sudo -u ${APP_USER} npm run platform:admin -- <email>"; fi
echo "Demo company: https://acme.${DOMAIN}   Admin: vikram.menon@acme.test   Password: see the seed (Keka@2026) - change it after first sign-in"
echo "Logs: journalctl -u keka-web -f"
