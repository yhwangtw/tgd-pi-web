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

`npm start` and `npm run dev` use the shared launcher and bind only to
`127.0.0.1:30141` by default. Set `PORT` and `PIWEB_HOST` explicitly to change
this; an unrelated `HOSTNAME` variable does not change the bind address.
For private remote access, keep the loopback bind and forward through an
authenticated local proxy/tunnel. Direct LAN/private-interface binding is an
explicit operator choice requiring the password gate and network restrictions.
`npm run preview` uses localhost on `30142` with separate isolated agent data;
changing a production port alone does not isolate sessions, models or schedules.

---

## 1. Auto-start on boot

For a new or stopped checkout, build before enabling its service. Stop that
checkout's existing service before any source update, dependency installation,
or build; never run `git pull`/build in its live working directory. `setup.sh`
checks Node/npm first, then verifies actual process PID/cwd before any mutation.
It refuses a running or unverifiable checkout. For managed updates use the
staging contract below instead of building in place while the service runs.

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

Pi Web's Safety Guard is an application-level authorization layer: it confirms
high-impact operations and can remember only an exact action in the same
workspace for five minutes. It is **not** an OS sandbox. For stronger tool
isolation, run the service under a dedicated account and put the entire service
inside a container or VM with only the required workspace and credentials
mounted. Extensions inherit the same boundary as the server process.

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
  -p 127.0.0.1:30141:30141 -e PIWEB_HOST=0.0.0.0 \
  -e PIWEB_ACCESS_PASSWORD -e PIWEB_SESSION_SECRET \
  -v /path/to/your/projects:/path/to/your/projects \
  your-piweb-image
```

Set the two credential variables in the launching environment first; the example
forwards them without putting their values in argv. The application binds inside
the container, while the published host port stays on loopback for the private
proxy/tunnel. A container does not replace authentication or network isolation.

### Managed Update Center actions

The Web Update Center can always compare releases, run preflight checks, and
create private source backups. Update, restart, and rollback buttons remain
disabled until the service operator provides explicit helper commands and
verifiable health/staging configuration:

```bash
PIWEB_RELEASE_REPOSITORY='yhwangtw/tgd-pi-web'
PIWEB_UPDATE_BACKUP_DIR='/var/lib/pi-web/update-backups'
PIWEB_UPDATE_OPERATION_DIR='/var/lib/pi-web/update-operations'
PIWEB_UPDATE_PROTOCOL='staged-v1'
PIWEB_UPDATE_HEALTH_URL='http://127.0.0.1:30141/api/runtime/identity'
PIWEB_UPDATE_COMMAND_JSON='["/usr/local/libexec/pi-web-update"]'
PIWEB_RESTART_COMMAND_JSON='["/usr/local/libexec/pi-web-restart"]'
PIWEB_ROLLBACK_COMMAND_JSON='["/usr/local/libexec/pi-web-rollback"]'
```

Each command must be a JSON array whose first item is an absolute executable
path. A detached supervisor launches it with no shell interpolation and records
the operation outside the source checkout.
The helper receives `PIWEB_UPDATE_ACTION`, `PIWEB_UPDATE_TARGET_TAG`,
`PIWEB_UPDATE_BACKUP_ID`, `PIWEB_UPDATE_BACKUP_PATH`,
`PIWEB_UPDATE_OPERATION_ROOT`, and `PIWEB_UPDATE_OPERATION_ID` in its environment.
Keep helper files owned by the service operator and not writable through a
trusted workspace.

The helper must build a clean, exact-SHA candidate in a separate directory,
start it with isolated fixture agent data, verify its identity, and stop it
before stopping and switching the live service. Failed cutover must restore and
verify the previous running build. New PID, start time, approved version/SHA,
canonical cwd and original agent-data/environment must match the contract;
helper exit zero or an updated file is not success. Persistent operation locks
prevent concurrent actions and survive a lost browser response.

No launchd/systemd adapter is installed automatically. The current contract is
fixed-canonical-cwd; dirty/dev/archive builds without clean source provenance
and release-symlink cwd changes fail closed. Interrupted operations or mutexes
require operator recovery, not blind retries. See [the complete staged-v1,
health, rollback and recovery contract](../docs/MANAGED-UPDATES.md). Without
configured adapters, stop the service and use the manual CLI fallback.

---

## 2. Reach it from outside — pick ONE

### Tailscale (recommended: private network, nothing public)

```bash
# On the pi-web machine
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # installs its own auto-start service
```

Install Tailscale on your phone/laptop and log in to the same tailnet. Configure
Tailscale Serve on the pi-web host to forward its private HTTPS address to
`http://127.0.0.1:30141`, then open that assigned address from an authorized
device. Keep the application's password gate enabled. The default loopback
bind does not accept direct connections to `<machine-name>:30141`.

Do **not** use `tailscale funnel` here — that publishes the service to the
internet, defeating the private-network boundary.

### Cloudflare Tunnel + Access (when you need a real public URL)

For a stable `https://pi.yourdomain.com`, create a named tunnel and — this part
is **mandatory** — configure its Cloudflare Access policy before enabling the
public hostname. Keep the local upstream at `http://127.0.0.1:30141` and the
application password gate enabled. Do not expose a throwaway public tunnel
before authentication is in place. A bare tunnel is a public route to a coding
agent, not a safe preview.

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
