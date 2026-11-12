# syntax=docker/dockerfile:1
# Malware scanner sidecar (Phase 2 step 3, A140): ClamAV plus YARA webshell / PHP backdoor rules
# from Neo23x0/signature-base (Detection Rule License 1.1). It never connects to sites, the
# database, Redis or the vault. The runner drops a copy of a site's code into the shared
# scan-work volume; scan-loop.sh scans each request and writes the result next to it.
# Same uid (1000) as the runner's "node" user, so both share scan-work with private file modes.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-freshclam yara ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 scanner \
  && mkdir -p /work /opt/rules && chown scanner:scanner /work

# signature-base rules pinned to one commit and checked against hashes recorded here.
ARG SIGBASE_COMMIT=c0599df8793d68ecdacabdc8fbb6acaa4b043775
RUN set -eu; cd /opt/rules; \
  base="https://raw.githubusercontent.com/Neo23x0/signature-base/${SIGBASE_COMMIT}"; \
  for f in gen_webshells.yar thor-webshells.yar gen_cn_webshells.yar cn_pentestset_webshells.yar \
           apt_laudanum_webshells.yar vul_php_zlib_backdoor.yar; do \
    curl -fsSL -o "$f" "$base/yara/$f"; \
  done; \
  curl -fsSL -o LICENSE-signature-base "$base/LICENSE"; \
  printf '%s\n' \
    "6876bdb29fe9cedc198d64b7e73d2d040c10918f47d40090b5d2ce1bf8c429d2  gen_webshells.yar" \
    "a297a3cda25740f700ce5ac71b3924660c306d54138a277d0e6e87832961b192  thor-webshells.yar" \
    "4775d01a68755e57dd63d934d5277dd290d8bb11a6c88094913370140a4c5ea0  gen_cn_webshells.yar" \
    "a7bf6e7b31636833a8388fe7ad65a2a895ab7b16148ce33866c31f48e3dd1e88  cn_pentestset_webshells.yar" \
    "ab895af093afec02cb46582fc06fab320427759dbc43aeefea60499ed28d62cc  apt_laudanum_webshells.yar" \
    "b3da6044dddb604c6eb1b6d516ed7c292606039f8c88f3e456aa23fa777cfe8c  vul_php_zlib_backdoor.yar" \
    "8a959b2413d0c83ca1b3ce9153076c649abf2e4bbfebbb493fb24c2074a1eb8a  LICENSE-signature-base" \
    | sha256sum -c -; \
  yarac /opt/rules/*.yar /opt/rules/webshells.yarc; \
  apt-get purge -y curl >/dev/null; apt-get autoremove -y >/dev/null

COPY docker/scanner/freshclam.conf /etc/ulixops/freshclam.conf
COPY docker/scanner/scan-loop.sh /usr/local/bin/scan-loop.sh
RUN chmod 0644 /etc/ulixops/freshclam.conf && chmod 0755 /usr/local/bin/scan-loop.sh

USER scanner
# ClamAV signatures live in the scanner-cache volume mounted here (the root filesystem is read-only).
ENV HOME=/home/scanner
CMD ["/usr/local/bin/scan-loop.sh"]
