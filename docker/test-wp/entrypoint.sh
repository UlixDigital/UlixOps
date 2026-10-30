#!/bin/sh
# Starts key-only sshd next to WordPress, then hands over to the official WordPress entrypoint.
set -eu

install -d -m 0700 -o wpdev -g www-data /home/wpdev/.ssh
if [ -s /run/ulixops/authorized_keys ]; then
  install -m 0600 -o wpdev -g www-data /run/ulixops/authorized_keys /home/wpdev/.ssh/authorized_keys
else
  echo "test-wp: no /run/ulixops/authorized_keys; run scripts/dev-ssh-key.sh (SSH logins will fail)" >&2
fi

ssh-keygen -A >/dev/null
/usr/sbin/sshd

ulixops-install-wordpress &

exec docker-entrypoint.sh "$@"
