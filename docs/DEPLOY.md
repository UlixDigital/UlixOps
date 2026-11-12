# Deploying UlixOps to ulixops.ulixdigital.com

The hub runs on its own VPS with Docker. Nobody can reach it directly: the server accepts only SSH, and the website is reached only through a Cloudflare Tunnel, behind a Cloudflare Access (Zero Trust) login and IP allowlist.

```
browser ──▶ Cloudflare Access (login + allowed IPs) ──▶ Cloudflare Tunnel ──▶ VPS: cloudflared ──▶ web
```

**Live host:** AWS EC2 `ulixops@18.218.128.255`. All deploys (`scripts/deploy-direct.sh`, `scripts/deploy.sh`, CI `DEPLOY_HOST`) go there.

### Access cheatsheet (agents / Claude)

| What                  | Value                                             |
| --------------------- | ------------------------------------------------- |
| SSH user@host         | `ulixops@18.218.128.255`                          |
| Deploy key (laptop)   | `~/.ssh/ulixops_deploy_ed25519`                   |
| Public URL            | `https://ulixops.ulixdigital.com`                 |
| App dir on server     | `~/ulixops`                                       |
| Runtime env on server | `~/ulixops.env` (never commit or paste into chat) |

```sh
# Shell on live
ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255

# Deploy from laptop (committed code only)
DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy.sh

# Compose on live (after ssh)
cd ~/ulixops
set -a; . ~/ulixops.env; set +a
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Steps marked **(owner)** need your accounts or payment. Steps marked **(Claude)** can be run by Claude Code once you've done the step before.

## 1. Clear the DNS name for the hub (owner)

`ulixdigital.com` is already on Cloudflare, so no DNS move is needed.

1. Cloudflare dashboard → `ulixdigital.com` → **DNS → Records**.
2. **Delete** any existing record named `ulixops` (for example an `A` record pointing at the server's IP). The hub must not be reached by IP: the server's web ports are closed, and the tunnel creates its own `CNAME` record for `ulixops` in step 3.

## 2. Turn on Cloudflare Zero Trust and protect the hub (owner)

1. Cloudflare dashboard → **Zero Trust**. Choose a team name and the Free plan (up to 50 users).
2. **Access → Applications → Add an application → Self-hosted**:
   - Application domain: `ulixops.ulixdigital.com`
   - Policy "UlixOps team": **Action** Allow. **Include**: the email addresses of the people who may use the hub. **Require**: IP ranges, your office/VPN IP addresses.
   - Session duration: 12 hours (matches the spec's absolute session limit).
3. Save. From now on, nobody reaches the hub without passing this login.

## 3. Create the Cloudflare Tunnel (owner)

1. Zero Trust → **Networks → Tunnels → Create a tunnel** → type **Cloudflared**, name `ulixops`.
2. On the "install connector" screen, copy the **token**: the long string after `--token` in the commands shown. Don't install anything; the hub runs its own connector container.
3. Save the token on **your computer** in this file (git-ignored, never committed):
   `.dev/cloudflare-tunnel-token`. Don't paste it into chat.
4. **Public hostname**: subdomain `ulixops`, domain `ulixdigital.com`, service type `HTTP`, URL `web:3000`.

## 4. Rent the VPS (owner)

Size: **2 vCPU and 4 GB RAM** is comfortable. 2 GB works for now: the setup script adds swap so the image builds fit, but builds are slower. Operating system: **Ubuntu 24.04 LTS** (or newer LTS). All images run on both x86 and ARM.

### On AWS (EC2)

1. **Billing first:** Billing → Budgets → create a monthly budget of e.g. USD 10 with an email alert.
2. **Region:** the one closest to you.
3. **EC2 → Key pairs → Actions → Import key pair:** name `ulixops-deploy`, paste the public key Claude Code gives you (`~/.ssh/ulixops_deploy_ed25519.pub`).
4. **EC2 → Launch instance:**
   - Name `ulixops-hub`
   - AMI: **Ubuntu Server 26.04 LTS (or 24.04), 64-bit (Arm)**. The architecture must match the instance type: Arm for `t4g`, x86 for `t3`
   - Instance type: **`t4g.small`** to start on the free plan (2 GB), or **`t4g.medium`** (4 GB) for day-to-day use
   - Key pair: `ulixops-deploy`
   - Network settings → security group: **only SSH (port 22)**. Do **not** allow HTTP or HTTPS; the tunnel needs no inbound ports.
   - Storage: **30 GB gp3**, with **Encrypted** turned on
   - Advanced details: IAM instance profile with the **`AmazonSSMManagedInstanceCore`** policy (lets you open a shell from the AWS console in an emergency, even if SSH is locked down), and **termination protection** on. Leave metadata version at **IMDSv2 only** (the default).
5. Optional: **Elastic IP** so the address survives a stop/start.
6. Send Claude the instance's **public IPv4 address** (that's not a secret).

## 5. Harden the server (Claude)

```sh
# AWS (log in as "ubuntu" before hardening)
ssh -i ~/.ssh/ulixops_deploy_ed25519 ubuntu@<server-ip> 'sudo sh -s' < scripts/vps-setup.sh
```

This updates the system and installs Docker. It also creates the `ulixops` deploy user, allows only SSH key logins (no passwords, no root, and no more `ubuntu`), opens only the SSH port in the firewall, adds swap on 2 GB servers and turns on automatic security updates. For emergencies, use EC2 → Connect → Session Manager.

## 6. Deploy

### Direct (preferred)

```sh
DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh
```

Syncs the local working tree over SSH/rsync and rebuilds on AWS. No GitHub or `.git` needed (A124). There is no hosted CI; run lint, format check, type-check, tests and `pnpm audit:deps` locally first (A128).

### Legacy git deploy (laptop)

```sh
DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy.sh
```

On the first run this creates `~/ulixops.env` on the server, readable only by the deploy user. It generates the database and Redis passwords there, and copies in the tunnel token from `.dev/cloudflare-tunnel-token`. Every run sends only **committed** code, builds the images on the server, runs the database migration and restarts the stack.

## 7. Create the first Admin (Claude)

```sh
ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255 \
  'cd ~/ulixops && docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml \
   exec api node dist/cli.js create-admin --email you@ulixdigital.com --name "Your Name"'
```

This prints a one-time setup link to `https://ulixops.ulixdigital.com/setup?token=…`, valid for 24 hours. Open it yourself (it's a credential, so don't forward it), set a password and scan the 2FA QR code.

## 8. Check it (owner)

Open `https://ulixops.ulixdigital.com`. You should see the Cloudflare Access login first, then the UlixOps sign-in page. After signing in, the home page shows **API: Healthy**.

## 9. Clean up (owner)

- Delete (or change the password of) the Hostinger FTP account for `app.wphelpertools.com`. Its password was shared in a chat.
- Store the server IP, the deploy key's location and the Cloudflare account owner in the break-glass kit (docs/BREAK-GLASS.md).

## Notes

- The hub's own runtime secrets (database and Redis passwords, session and TOTP keys, the vault's keys, the tunnel token) exist only in `~/ulixops.env` on the server. Site SSH keys live in the vault. To rotate a hub secret, edit that file and run the deploy again (never change `INFISICAL_ENCRYPTION_KEY`: the vault's data is encrypted with it).
- **Vault (Infisical).** The first deploy needs the vault admin's email: `VAULT_ADMIN_EMAIL=you@ulixdigital.com DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy.sh`. It claims the fresh vault, writes the vault admin password to `~/infisical-admin.txt` on the server (mode 600), and gives the runner its own login. Move that password into the password manager and the break-glass kit, then delete the file. To open the vault UI, tunnel to it: `ssh -L 8081:127.0.0.1:8081 -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255`, then browse to `http://localhost:8081`. Normally you won't need it: create SSH keys in UlixOps under Settings → Credentials.
- **Malware scans (ClamAV + YARA, A138/A140).** Nothing to set up: no licence or account. On the first start the scanner downloads ClamAV signatures (~110 MB) into the `scanner-cache` volume and refreshes them every 12 h; until then scans run with the YARA webshell rules only and say so. A scan needs up to ~1.5 GB of RAM in the scanner (capped at 2 GB) and up to ~1.5 GB of free disk for the temporary site copy. By default production sites are scanned weekly, one at a time; change the schedule (frequency, UTC time window, staging) and run, queue or stop scans under **Security → Malware scans**.
- **Google Drive backups (A145, A146).** One-time (owner), on **Settings → Google Drive**, which lists the steps: (1) Google Cloud Console as ulixdevs@gmail.com: project with the _Google Drive API_ enabled; Google Auth Platform audience _External_ and **Publish app** (In production; the drive.file scope needs no Google review, and a "Testing" app's sign-in expires after 7 days); OAuth client of type **Web application** with the authorized redirect URI shown on the page (`https://ulixops.ulixdigital.com/oauth/google/callback`); paste its client ID and secret on that page. (2) `openssl rand -hex 32`: save it in the password manager **and** the break-glass kit, then paste it as the backup encryption key. (3) Click **Sign in with Google**, choose ulixdevs@gmail.com, Allow. Default schedule: Fridays from 18:00 UTC.
- **Super Admin (A134 / A172).** First grant is usually on the server (person must already be an Admin with 2FA): `ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255 'cd ~/ulixops && set -a && . ~/ulixops.env && set +a && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api node dist/cli.js grant-super-admin --email you@ulixdigital.com'`. Afterwards, a Super Admin can promote other Admins (with 2FA) under Settings → Users, or use `revoke-super-admin` / demote in the UI. Their risky actions are then self-approved; every other Admin is alerted.
- **Vulnerability feed (Wordfence Intelligence, A132/A133).** One-time (owner): create a free API key at wordfence.com → Account → Integrations. In UlixOps, **Settings → Credentials → Wordfence Intelligence API key → Request to set key**; a second Admin approves on **Approvals**; the requester then pastes the key there within 24 hours. It is sealed to the runner and stored only in the vault (folder `/ssh-keys`, name `WORDFENCE_API_KEY`), and the first feed sync starts straight away; after that it syncs daily. Adding it directly in the vault UI (tunnel above) also works.
- The test WordPress site never runs on the server.
- Docker can bypass the `ufw` firewall for published ports, so the production stack publishes **none** (`docker-compose.prod.yml` removes the web port). Never add `ports:` to production services.
