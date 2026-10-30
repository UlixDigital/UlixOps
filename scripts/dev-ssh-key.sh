#!/bin/sh
# Creates the dev-only SSH key pair for the test WordPress container. Both files stay in the
# git-ignored .dev/ folder; only the public key is mounted into the container.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
key="$root/.dev/ssh/test_wp_ed25519"

mkdir -p "$root/.dev/ssh" "$root/.dev/test-wp"
chmod 700 "$root/.dev/ssh"
if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "ulixops-test-wp" -f "$key"
fi
cp "$key.pub" "$root/.dev/test-wp/authorized_keys"

echo "Test site key ready: .dev/ssh/test_wp_ed25519 (public key in .dev/test-wp/authorized_keys)"
echo "Try it: ssh -i .dev/ssh/test_wp_ed25519 -p 2222 wpdev@127.0.0.1 wp --path=/var/www/html core version"
