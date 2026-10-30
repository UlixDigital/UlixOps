# syntax=docker/dockerfile:1
# Disposable WordPress test site for UlixOps dev and e2e tests: key-only SSH + WP-CLI,
# like a WP Engine environment. Never use for real sites or in production.
FROM wordpress:php8.3-apache

ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server less mariadb-client \
  && rm -rf /var/lib/apt/lists/*

# WP-CLI, pinned and checked against a checksum recorded in this file
RUN curl -fsSL -o /tmp/wp-cli.phar \
    "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" \
  && echo "${WP_CLI_SHA512}  /tmp/wp-cli.phar" | sha512sum -c - \
  && install -m 0755 /tmp/wp-cli.phar /usr/local/bin/wp \
  && rm /tmp/wp-cli.phar

# SSH user for the runner. Shares uid/gid 33 with www-data so files it writes match WordPress
# ownership, like a host's SSH user (agent decision A11). "*" = no password, but not locked.
RUN useradd --non-unique --uid 33 --gid www-data --create-home --home-dir /home/wpdev \
    --shell /bin/bash wpdev \
  && usermod --password '*' wpdev \
  && mkdir -p /run/sshd

COPY sshd_config /etc/ssh/sshd_config.d/ulixops.conf
COPY entrypoint.sh /usr/local/bin/ulixops-entrypoint
COPY install-wordpress.sh /usr/local/bin/ulixops-install-wordpress
# Inactive test plugins copied into the site by install-wordpress.sh (see fixtures/).
COPY fixtures /usr/src/ulixops-fixtures
RUN chmod 0755 /usr/local/bin/ulixops-entrypoint /usr/local/bin/ulixops-install-wordpress

EXPOSE 22 80
ENTRYPOINT ["ulixops-entrypoint"]
CMD ["apache2-foreground"]
