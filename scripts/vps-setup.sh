#!/bin/sh
# One-time hardening of a fresh Ubuntu LTS VPS for UlixOps (agent decision A21). Run as root:
#   AWS (default user "ubuntu"):  ssh ubuntu@<server-ip> 'sudo sh -s' < scripts/vps-setup.sh
#   Other providers (root login): ssh root@<server-ip> 'sh -s' < scripts/vps-setup.sh
# Creates the "ulixops" deploy user with the SSH keys of the account that ran it, turns off
# password and root SSH logins, enables the firewall (SSH only), automatic security updates and
# swap on small servers, and installs Docker.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "vps-setup: run as root (or with sudo)" >&2
  exit 1
fi
# Ubuntu cloud images put a "please log in as ubuntu" forced command in root's keys, so take the
# keys of the user who ran sudo.
key_user="${SUDO_USER:-root}"
key_file="$(getent passwd "$key_user" | cut -d: -f6)/.ssh/authorized_keys"
if [ ! -s "$key_file" ]; then
  echo "vps-setup: $key_user has no SSH key yet; add one first so this does not lock you out" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# Keep existing config files instead of stopping to ask (there is no terminal to answer).
keep_conf="-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
apt-get update
# shellcheck disable=SC2086
apt-get -y $keep_conf upgrade
# shellcheck disable=SC2086
apt-get install -y $keep_conf --no-install-recommends \
  docker.io docker-compose-v2 docker-buildx ufw unattended-upgrades fail2ban openssl

# Deploy user: SSH key only. Membership of the docker group is root-equivalent on this host,
# which is why the user has no password and SSH is key-only.
if ! id ulixops >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups docker ulixops
fi
install -d -m 0700 -o ulixops -g ulixops /home/ulixops/.ssh
install -m 0600 -o ulixops -g ulixops "$key_file" /home/ulixops/.ssh/authorized_keys

# Servers under ~3.5 GB RAM (e.g. AWS t4g.small) need swap to build the images.
mem_kb="$(awk '/^MemTotal/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 3500000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Sorts before cloud-init's 50-cloud-init.conf, and sshd keeps the first value it reads.
cat > /etc/ssh/sshd_config.d/10-ulixops.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowUsers ulixops
X11Forwarding no
EOF
sshd -t
systemctl try-reload-or-restart ssh

# Nothing but SSH comes in. The hub itself is reached only through the outbound Cloudflare Tunnel.
ufw default deny incoming
ufw default allow outgoing
ufw limit OpenSSH
ufw --force enable

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

systemctl enable --now docker fail2ban

echo "vps-setup: done. Root SSH login is now off; connect as: ssh ulixops@<server-ip>"
echo "vps-setup: for emergencies use the provider's console (on AWS: Systems Manager Session Manager)."
