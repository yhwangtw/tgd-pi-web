# Running pi-web so you can reach it from outside

> [!WARNING]
> **pi-web is a coding agent** — it can run bash commands and read/write files
> as the user it runs as. Anyone who can reach its URL effectively has a shell
> on that machine. Turn on the access password below **and** keep it off the
> open internet: use a private network (Tailscale) or an authenticated tunnel
> (Cloudflare Tunnel + Access). See the bottom of this file.

## 0. Turn on the access password (do this first)

pi-web ships one optional shared-password gate — set an env var and every route
requires a login:

```bash
# In the service environment (systemd: add an Environment= line; launchd: the
# EnvironmentVariables dict; shell: export before `npm run start`):
PIWEB_ACCESS_PASSWORD='pick-a-long-passphrase'
PIWEB_SESSION_SECRET='paste-a-random-value-from-openssl-rand-hex-32'
```

Generate the session secret once with `openssl rand -hex 32`, store it beside
the password in the service environment, and keep it stable across restarts.
Changing it intentionally signs out every browser. If the secret is omitted,
pi-web falls back to the password for compatibility, but an independent random
secret is strongly recommended for remote access.

Unauthenticated page loads redirect to `/login`; API calls return 401. Access
cookies are HMAC-signed and last 30 days; five failed logins from one client
trigger a 15-minute lockout. Browser mutations with an explicit cross-origin
Origin are rejected even when the password gate is disabled. Log out from the
Appearance panel. **With `PIWEB_ACCESS_PASSWORD` unset the gate is off** (fine
for localhost-only use). This is a front-door lock, not a substitute for the
network isolation below — run both.

The port is `30141` (set by the `start` script: `next start -p 30141`). Next
binds to `0.0.0.0` by default, so once it's running, any device on the **same
LAN** can already reach `http://<machine-lan-ip>:30141`. The steps below make
it (a) start on boot and (b) reachable from **outside** the LAN, safely.

---

## 1. Auto-start on boot

Build once first (and after every `git pull`):

```bash
cd /path/to/tGD-pi-web
npm ci
npm run build
```

### Linux (systemd)

```bash
# Edit deploy/pi-web.service: set User= and WorkingDirectory= (and the npm path
# if `command -v npm` isn't /usr/bin/npm), then:
sudo cp deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web.service

systemctl status pi-web.service      # check it's running
journalctl -u pi-web.service -f      # follow logs
```

Run it as a **normal user**, not root — the agent's shell/file access inherits
that user's permissions.

### macOS (launchd)

```bash
# Edit deploy/com.tgd.piweb.plist: set WorkingDirectory and the npm/PATH lines
# (Apple Silicon Homebrew = /opt/homebrew/bin, Intel = /usr/local/bin).
cp deploy/com.tgd.piweb.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.tgd.piweb.plist

launchctl list | grep piweb          # check it's loaded
tail -f /tmp/piweb.err.log           # logs
```

### Docker / container

No unit file needed — run with a restart policy:

```bash
docker run -d --name pi-web --restart unless-stopped \
  -p 30141:30141 -e HOSTNAME=0.0.0.0 \
  -v /path/to/your/projects:/path/to/your/projects \
  your-piweb-image
```

(You still need the auth layer below — a container is not a security boundary
against the network.)

---

## 2. Reach it from outside — pick ONE

### Tailscale (recommended: private network, nothing public)

```bash
# On the pi-web machine
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # installs its own auto-start service
```

Install Tailscale on your phone/laptop, log in to the **same account**, then
browse to `http://<machine-name>:30141` (the name shows in `tailscale status`).
No ports are exposed to the internet, traffic is end-to-end encrypted, and
scanners can't find it. This is the right default for a no-auth, high-privilege
service.

Optional niceties:
- `tailscale serve https / http://localhost:30141` gives it an HTTPS name
  inside your tailnet.
- Do **not** use `tailscale funnel` here — that publishes it to the internet,
  defeating the point.

### Cloudflare Tunnel + Access (when you need a real public URL)

```bash
# Quick throwaway URL (add Access before real use!):
cloudflared tunnel --url http://localhost:30141
```

For a stable `https://pi.yourdomain.com`, create a named tunnel and — this part
is **mandatory** — put a Cloudflare Access policy in front (free plan supports
Google/GitHub/email-OTP). A bare tunnel with no Access is the same as pasting a
shell onto the internet.

### SSH tunnel (temporary, zero install)

From wherever you are, if you can SSH to the machine:

```bash
ssh -L 30141:localhost:30141 you@your-machine
# then open http://localhost:30141 locally
```

Auth piggybacks on SSH; nothing new is exposed. Good for occasional access.

---

## Do NOT

- Forward port 30141 on your router / expose it via DDNS to the open internet.
- Run a Cloudflare/ngrok tunnel without an auth layer.
- Run the service as root.
