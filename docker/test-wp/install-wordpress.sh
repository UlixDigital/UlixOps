#!/bin/sh
# Installs WordPress once the official entrypoint has written wp-config.php and the database
# answers. Does nothing if WordPress is already installed on this volume.
set -eu
cd /var/www/html

wp() { runuser -u wpdev -- env HOME=/home/wpdev /usr/local/bin/wp "$@"; }

tries=0
until [ -f wp-config.php ] && wp db query "SELECT 1" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 90 ]; then
    echo "test-wp: database not reachable; WordPress not installed" >&2
    exit 1
  fi
  sleep 2
done

# The image's wp-config.php reads the database settings from container env vars, which SSH
# sessions don't have. Write them in as plain values, like a normal host's wp-config.php.
for name in DB_NAME DB_USER DB_PASSWORD DB_HOST; do
  eval "value=\${WORDPRESS_$name:-}"
  if [ -n "$value" ]; then wp config set "$name" "$value" --quiet; fi
done

# Test fixtures, inactive until a test activates them (e.g. the deliberately broken plugin).
for fixture in /usr/src/ulixops-fixtures/*/; do
  name="$(basename "$fixture")"
  if [ ! -d "wp-content/plugins/$name" ]; then
    runuser -u wpdev -- cp -r "$fixture" "wp-content/plugins/$name"
  fi
done

# Browser uses localhost:8080; the runner reaches the same site as http://test-wp/. Prefer the
# request Host so WordPress does not 301 to a host:port the runner cannot open (A80).
if [ -f wp-config.php ] && ! grep -q 'ULIXOPS_REQUEST_HOST' wp-config.php; then
  printf '%s\n' \
    '/* ULIXOPS_REQUEST_HOST */' \
    'if (isset($_SERVER["HTTP_HOST"]) && !defined("WP_HOME")) {' \
    '  $ulixops_base = ((!empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off") ? "https://" : "http://") . $_SERVER["HTTP_HOST"];' \
    '  define("WP_HOME", $ulixops_base);' \
    '  define("WP_SITEURL", $ulixops_base);' \
    '}' \
    > /tmp/ulixops-request-host.php
  # Insert before the "stop editing" marker so constants apply.
  if grep -q "stop editing" wp-config.php; then
    sed -i '/stop editing/e cat /tmp/ulixops-request-host.php' wp-config.php
  else
    cat /tmp/ulixops-request-host.php >> wp-config.php
  fi
  rm -f /tmp/ulixops-request-host.php
fi

if wp core is-installed >/dev/null 2>&1; then exit 0; fi

# Random admin password, never printed or stored. For wp-admin access, set one over SSH:
#   wp user update ulixops-admin --prompt=user_pass
wp core install \
  --url="${TEST_WP_URL:-http://localhost:8080}" \
  --title="UlixOps test site" \
  --admin_user=ulixops-admin \
  --admin_email=admin@example.test \
  --admin_password="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')" \
  --skip-email
echo "test-wp: WordPress installed at ${TEST_WP_URL:-http://localhost:8080}"
