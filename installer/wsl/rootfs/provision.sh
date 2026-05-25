#!/usr/bin/env bash
# Provision the `phison-hybrid-openclaw` WSL distro on the customer machine.
# Runs as root inside the customer's freshly-imported Ubuntu 24.04 base
# rootfs, orchestrated by `installer/post-install.ps1` (Phase 2).
#
# Inputs (pre-staged into the customer's distro by post-install.ps1):
#   /tmp/openclaw-source.tar.gz  OpenClaw source tarball (from `git archive HEAD`)
#   /tmp/rootfs-config/          wsl.conf + openclaw-gateway.service
#
# Environment overrides:
#   NODE_VERSION (default: 22.17.0)
#   PNPM_VERSION (default: 9.12.0)
#
# Network: this script REQUIRES internet access (apt, nodejs.org,
# github.com for pnpm, npm registry). If install fails partway through,
# post-install.ps1 will `wsl --unregister phison-hybrid-openclaw` and the user can
# retry once network is restored.
set -euo pipefail

# Node.js LTS line. Pin >= 22.16.0 because some transitive deps now
# declare engines.node >= 22.16.0 and pnpm refuses to run lifecycle
# scripts (e.g. `pnpm build`) when engine-strict is enforced.
NODE_VERSION="${NODE_VERSION:-22.17.0}"
PNPM_VERSION="${PNPM_VERSION:-9.12.0}"

export DEBIAN_FRONTEND=noninteractive

log() { printf '[provision] %s\n' "$*"; }

# 1. Base packages. systemd is mandatory because wsl.conf will set
#    [boot] systemd=true, and the gateway runs as a systemd unit.
log "[1/8] Installing base packages..."
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git openssl python3 build-essential \
    dbus systemd systemd-sysv \
    sudo locales tzdata
locale-gen en_US.UTF-8
rm -rf /var/lib/apt/lists/*

# 1.5 Phison corporate SSL inspection CA.
#
# Phison intranet HTTPS is re-signed by an internal root CA (phison-new).
# Windows trusts it via Group Policy, but WSL does not inherit that store
# and Node.js ignores Linux ca-certificates unless NODE_EXTRA_CA_CERTS is
# set. post-install.ps1 exports the Windows-trusted cert when available;
# otherwise probe api.search.brave.com and install only if the chain shows
# phison-new (so home/off-network installs stay untouched).
PHISON_CA="/usr/local/share/ca-certificates/phison-new.crt"
install_phison_ssl_inspection_ca() {
    if [ -f "${PHISON_CA}" ]; then
        log "[1.5/8] Phison SSL inspection CA already installed"
        return 0
    fi
    if [ -f /tmp/rootfs-config/phison-new.crt ]; then
        install -m 0644 /tmp/rootfs-config/phison-new.crt "${PHISON_CA}"
        update-ca-certificates
        log "[1.5/8] Installed Phison SSL inspection CA from Windows trust store export"
        return 0
    fi
    local extracted
    extracted="$(mktemp)"
    if echo | openssl s_client -connect api.search.brave.com:443 \
        -servername api.search.brave.com -showcerts 2>/dev/null \
        | awk '/-----BEGIN CERTIFICATE-----/{n++} n==2{p=1} p{print} /-----END CERTIFICATE-----/ && n==2{exit}' \
        > "${extracted}" \
        && [ -s "${extracted}" ] \
        && openssl x509 -in "${extracted}" -noout -issuer 2>/dev/null \
            | grep -qi 'phison-new'; then
        install -m 0644 "${extracted}" "${PHISON_CA}"
        update-ca-certificates
        rm -f "${extracted}"
        log "[1.5/8] Installed Phison SSL inspection CA from HTTPS probe"
        return 0
    fi
    rm -f "${extracted}"
    log "[1.5/8] Phison SSL inspection CA not installed (not on Phison intranet)"
    return 1
}
install_phison_ssl_inspection_ca || true

# 2. Node.js 22 LTS. Use the official binary tarball rather than NodeSource
#    so we don't pull in another apt repo + GPG key.
log "[2/8] Installing Node.js ${NODE_VERSION}..."
mkdir -p /opt/node
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ --strip-components=1 -C /opt/node
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm  /usr/local/bin/npm
ln -sf /opt/node/bin/npx  /usr/local/bin/npx

# 3. pnpm via standalone binary. Avoids `npm i -g` and pins the version.
log "[3/8] Installing pnpm ${PNPM_VERSION}..."
mkdir -p /opt/pnpm
curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-x64" \
    -o /opt/pnpm/pnpm
chmod +x /opt/pnpm/pnpm
ln -sf /opt/pnpm/pnpm /usr/local/bin/pnpm

# 4. Non-root runtime user. uid 1000 is conventional for the first user.
#    /bin/bash + no sudo group + no password => normal unprivileged user.
#
#    NOTE: the shell intentionally is /bin/bash, NOT /usr/sbin/nologin.
#
#    The earlier (systemd-driven) iteration of this design used nologin
#    as a defense-in-depth ("even if the gateway is compromised, the
#    attacker still cannot interactive-login as openclaw"). That stopped
#    working when we switched to the foreground launch model: wsl.exe
#    -u openclaw enters via PAM, PAM spawns the user's login shell, and
#    nologin promptly prints "This account is currently not available."
#    and exits 1, so the launcher's run-gateway.sh never gets a chance
#    to run.
#
#    Restoring nologin would only buy us back a defense-in-depth that
#    doesn't apply in this distro anyway: there is no sshd, no getty,
#    no external login surface, and the node gateway itself can already
#    spawn /bin/bash via child_process.spawn -- the user's *login*
#    shell setting does not gate that. Real isolation is provided by:
#      * no sudo / no password / not in any privileged group
#      * wsl.conf controls [automount] / [interop]; the windowsbridge
#        installer task decides whether the gateway sees /mnt/c and
#        cmd.exe (post-install.ps1 reports the active mode and head -1
#        /etc/wsl.conf shows it on a running distro). The other
#        defenses on this list still hold in either mode.
#      * /opt/openclaw and /opt/node are root-owned read-only (locked
#        in step 6 below)
#      * gateway binds 127.0.0.1 only
#    All of which are unaffected by the shell choice.
#
#    Ubuntu 24.04 cloud rootfs (what `ubuntu-base.tar.gz` ships) comes
#    with a pre-baked `ubuntu` user occupying UID 1000. We do not need
#    that account, and leaving it would force openclaw to a higher UID.
#    Removing it keeps openclaw at the conventional first-non-system
#    UID and trims one extra account from the rootfs.
log "[4/8] Creating openclaw user..."
if id -u ubuntu >/dev/null 2>&1; then
    log "[4/8] Removing default 'ubuntu' user to free UID 1000..."
    # `pkill -u ubuntu` would be unsafe here; userdel -f handles a stale
    # session if any. We tolerate non-zero exit (e.g. user already gone
    # in a re-run scenario) so the script stays idempotent.
    userdel --remove --force ubuntu 2>/dev/null || true
fi
if ! id -u openclaw >/dev/null 2>&1; then
    useradd --create-home --uid 1000 --shell /bin/bash openclaw
fi
# Lock the password explicitly. useradd without -p leaves the password
# field empty in /etc/shadow which on most distros means "any password
# accepted" or "locked" depending on PAM config; `passwd -l` makes it
# unambiguously locked across all configurations.
passwd -l openclaw >/dev/null 2>&1 || true

# 5. Build OpenClaw. Source arrives as a tarball produced by `git archive`
#    on the build machine and shipped inside the .exe; only commit-tracked
#    files are present (no node_modules / .git noise).
#    We build as root for simplicity and chown to openclaw at the end.
log "[5/8] Building OpenClaw..."
SRC_TARBALL="/tmp/openclaw-source.tar.gz"
SRC_DIR="/tmp/openclaw-src"
test -f "${SRC_TARBALL}" || {
    echo "ERROR: ${SRC_TARBALL} missing -- orchestrator must stage source first" >&2
    exit 1
}
mkdir -p "${SRC_DIR}"
tar -xzf "${SRC_TARBALL}" -C "${SRC_DIR}"
cd "${SRC_DIR}"
pnpm install --ignore-scripts
# Native modules used by OpenClaw -- explicit rebuild keeps the install
# step lean (--ignore-scripts above) while still producing working binaries.
pnpm rebuild esbuild sharp koffi protobufjs
# Use `pnpm build` (NOT `build:docker`). The `build:docker` variant skips
# `canvas:a2ui:bundle` because the official Docker build excludes
# `vendor/` and `apps/` via .dockerignore -- there is no a2ui source to
# compile inside that image. Our installer ships the source via
# `git archive HEAD` which DOES include vendor/ and apps/, so the
# bundle step can and must run; otherwise `src/canvas-host/a2ui/
# a2ui.bundle.js` will be missing at runtime and any A2UI canvas
# rendering in the UI will fail to load.
pnpm build
pnpm ui:build

mkdir -p /opt/openclaw
cp -a "${SRC_DIR}"/. /opt/openclaw/
chown -R openclaw:openclaw /opt/openclaw
rm -rf "${SRC_DIR}" "${SRC_TARBALL}"

# 6. Install WSL boot config + foreground launcher wrapper.
#
# We deliberately do NOT enable openclaw-gateway.service. The customer
# launch model is now "click desktop icon -> Windows Terminal opens ->
# wsl.exe runs run-gateway.sh in the foreground -> Ctrl-C stops it,
# closing the window". This matches the native dev experience (`pnpm
# dev` / `node openclaw.mjs gateway run`) and lets the user see logs,
# stop the process, and restart it without learning systemctl.
#
# We still SHIP the unit file (disabled) so power users who want
# always-on daemon behaviour can `sudo systemctl enable --now
# openclaw-gateway.service` after first launch. See the design doc
# (Q5/Q7 re-evaluation in 2026-04-23-wsl-sandbox-design.md).
log "[6/8] Installing wsl.conf, run-gateway.sh, and systemd unit (disabled)..."
install -m 0644 /tmp/rootfs-config/wsl.conf /etc/wsl.conf
install -m 0644 /tmp/rootfs-config/openclaw-gateway.service \
    /etc/systemd/system/openclaw-gateway.service
# Explicitly disable the unit just in case the rootfs cache somehow
# shipped it pre-enabled. `disable` on an already-disabled unit is a
# no-op, so this is idempotent.
systemctl disable openclaw-gateway.service 2>/dev/null || true

# Node.js TLS env helper. Sourced by run-gateway.sh and the openclaw CLI
# wrapper so every node invocation trusts the Phison SSL inspection CA when
# it was installed in step 1.5 above.
cat > /opt/openclaw/node-ca-env.sh <<'NODE_CA_EOF'
#!/usr/bin/env bash
# Node.js ships its own Mozilla CA bundle and does not read Linux
# /etc/ssl/certs unless NODE_EXTRA_CA_CERTS is set.
PHISON_CA="/usr/local/share/ca-certificates/phison-new.crt"
if [ -f "${PHISON_CA}" ]; then
  export NODE_EXTRA_CA_CERTS="${PHISON_CA}"
fi
NODE_CA_EOF
chmod 0644 /opt/openclaw/node-ca-env.sh

if [ -f "${PHISON_CA}" ] && ! grep -q 'NODE_EXTRA_CA_CERTS' /etc/systemd/system/openclaw-gateway.service; then
    sed -i '/^\[Service\]/a Environment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/phison-new.crt' \
        /etc/systemd/system/openclaw-gateway.service
fi

# Foreground launcher wrapper. The Windows-side openclaw-launcher.cmd
# spawns this via `wsl.exe -d phison-hybrid-openclaw -u openclaw -- /opt/openclaw/
# run-gateway.sh` inside a Windows Terminal tab, so the user sees stdout
# / stderr in real time and can Ctrl-C to stop the gateway exactly as
# they would when running `node openclaw.mjs gateway run` natively.
#
# We `exec` node so PID 1 of the wsl session IS the node process: that
# means SIGINT from Windows Terminal's Ctrl-C reaches node directly
# without any bash wrapper swallowing it.
cat > /opt/openclaw/run-gateway.sh <<'GATEWAY_EOF'
#!/usr/bin/env bash
# Foreground gateway launcher for the WSL sandbox build.
# Invoked from Windows: wsl.exe -d phison-hybrid-openclaw -u openclaw -- /opt/openclaw/run-gateway.sh
set -e
echo "[Phison Hybrid OpenClaw] Starting OpenClaw gateway on http://localhost:18789/"
echo "[Phison Hybrid OpenClaw] Press Ctrl-C in this window to stop."
# Echo the active sandbox mode so users see at every launch whether the
# Windows bridge is open. The first line of /etc/wsl.conf was prepended
# by post-install.ps1 with `# MODE: STRICT SANDBOX (...)` or
# `# MODE: PERMISSIVE (...)`. We grep that out and print it as a
# one-line banner; if the marker is missing (e.g. distro provisioned
# by an older installer), we just stay silent rather than guess.
mode_line=$(head -1 /etc/wsl.conf 2>/dev/null || true)
case "${mode_line}" in
    "# MODE: "*) echo "[Phison Hybrid OpenClaw] ${mode_line#'# '}" ;;
esac
echo ""
cd "${HOME}"
# shellcheck source=/dev/null
. /opt/openclaw/node-ca-env.sh
# `--force` makes the gateway take over port 18789 if a stale listener
# still holds it (e.g. previous wsl session was killed without graceful
# shutdown). `--bind loopback` binds 127.0.0.1 + ::1 only, never the
# distro's external interface.
exec /opt/node/bin/node /opt/openclaw/openclaw.mjs gateway run \
    --bind loopback --port 18789 --force
GATEWAY_EOF
chmod 0755 /opt/openclaw/run-gateway.sh

# Install a thin `openclaw` CLI wrapper into /usr/local/bin so users can
# run `openclaw <command>` (e.g. `openclaw status`, `openclaw dashboard`,
# `openclaw plugins ...`) directly inside the distro -- mirrors the
# native installer's `pnpm link --global` behavior without dragging in
# a writable global pnpm store. The wrapper just execs the bundled
# node against /opt/openclaw/openclaw.mjs and forwards all args.
#
# We deliberately do NOT use `pnpm link --global` here:
#   * /opt/openclaw is mode a-w in step 6 below, which would break
#     pnpm's expectation of a writable project root.
#   * pnpm link writes into ~/.local/share/pnpm and depends on the
#     openclaw user's per-home pnpm state -- a single root-owned
#     wrapper in /usr/local/bin is simpler and survives `pnpm store
#     prune`.
#
# /usr/local/bin is on the default PATH for both interactive and
# non-interactive shells (login, ssh -c, wsl.exe -- ... invocations),
# so this works the same way as the native CLI on a built-from-source
# install.
log "[6/8] Installing /usr/local/bin/openclaw CLI wrapper..."
install -m 0755 /dev/stdin /usr/local/bin/openclaw <<'CLI_EOF'
#!/usr/bin/env bash
# OpenClaw CLI wrapper for the WSL sandbox build. Provided so users
# can run `openclaw <command>` inside the distro without typing the
# full `/opt/node/bin/node /opt/openclaw/openclaw.mjs ...` path.
# Mirrors the global `openclaw` shim that `pnpm link --global` would
# install on a native build.
# shellcheck source=/dev/null
. /opt/openclaw/node-ca-env.sh
exec /opt/node/bin/node /opt/openclaw/openclaw.mjs "$@"
CLI_EOF

# Lock down the install dir as a substitute for the (now-disabled)
# systemd unit's ProtectSystem=strict + ProtectHome=read-only +
# ReadWritePaths= filesystem isolation.
#
# Concretely we want: openclaw user can read & execute everything
# under /opt/openclaw but cannot modify it. Step 5 set the tree to
# openclaw:openclaw to make the build work, which means openclaw
# could `chmod u+w` and write again -- ownership has to change to
# root:root before chmod, otherwise the chmod is purely advisory.
#
# `chmod -R a-w,a+rX`:
#   * a-w   -- remove write bit from owner / group / other
#   * a+rX  -- add read for everyone; capital X adds execute only on
#              directories and files that already had ANY execute bit,
#              so we don't accidentally turn .json / .md / .js into
#              executables.
#
# Effect: /opt/openclaw becomes a read-only, executable code tree.
# An LLM-driven gateway that turns hostile cannot backdoor its own
# binaries to run on next launch. It can still write /home/openclaw/
# workspace and /home/openclaw/.openclaw, where it legitimately
# stores user files and runtime state.
#
# /opt/node is already root-owned (step 2 created it as root and
# extracted the official tarball with root ownership), so the
# openclaw user has never been able to write to it. We re-chmod it
# anyway as defense-in-depth in case a future change accidentally
# chowns it.
log "[6/8] Locking /opt/openclaw and /opt/node read-only..."
chown -R root:root /opt/openclaw /opt/node
chmod -R a-w,a+rX /opt/openclaw /opt/node

# Mask Ubuntu Pro's WSL-side bridge. It is preinstalled on the Ubuntu
# 24.04 cloud rootfs and tries to talk to a Windows-side companion via
# cmd.exe. Two cases:
#   - STRICT SANDBOX mode (windowsbridge unchecked): wsl.conf disables
#     automount, so the bridge cannot find cmd.exe and fails on every
#     start, spamming the journal at ~2-second intervals (restart
#     counter climbs into the hundreds within minutes) which buries
#     our own logs.
#   - PERMISSIVE mode (windowsbridge checked): the bridge could find
#     cmd.exe, but it expects a paid Ubuntu Pro subscription on the
#     Windows side; without one it still fails (just for a different
#     reason) and still spams the journal.
# Either way the bridge is irrelevant to OpenClaw, so masking it is a
# clean no-op for functionality and a big win for log hygiene
# regardless of which sandbox mode is active.
systemctl mask wsl-pro.service || true

# 7. Pre-create writable allowlist directories. Even though the
#    foreground launcher does not have systemd's ReadWritePaths=
#    enforcement, run-gateway.sh expects these to exist (the gateway
#    writes session/log/canvas state under ~/.openclaw and treats
#    workspace/ as the project root).
log "[7/8] Creating runtime directories..."
install -d -m 0755 -o openclaw -g openclaw \
    /home/openclaw/workspace \
    /home/openclaw/.openclaw \
    /home/openclaw/readonly

# 7.5 Install wsl-binfmt-fix.service.
#
# Problem: this distro uses an Ubuntu 24.04 *cloud* rootfs (ubuntu-base),
# NOT the Microsoft Store WSL distro.  The Store variant ships a small
# helper that reliably re-registers the WSLInterop binfmt handler on
# every boot; the cloud rootfs does not.  The net effect is that after
# certain session-lifecycle sequences (e.g. wsl.exe single-command
# invocation followed by an interactive login) the WSLInterop entry in
# /proc/sys/fs/binfmt_misc disappears.  Any attempt to exec a Windows
# .exe (cmd.exe, powershell.exe, schtasks.exe …) then fails with
# "Exec format error" because the kernel falls back to /bin/sh, which
# tries to interpret the PE MZ header as a shell script.
#
# The systemd drop-in at
#   /usr/lib/systemd/system/systemd-binfmt.service.d/wsl.conf
# intentionally adds ConditionVirtualization=!wsl to prevent
# systemd-binfmt from running (it would overwrite WSLInterop with a
# version lacking the F flag).  So we cannot rely on systemd-binfmt to
# fix this for us.
#
# Fix: install a lightweight oneshot unit that runs After=local-fs.target
# and registers WSLInterop only when it is absent.  The
# ConditionPathExists=!/proc/sys/fs/binfmt_misc/WSLInterop guard makes
# the unit a no-op whenever /init already registered the handler, so
# there is no conflict with the normal boot path.
log "[7/8] Installing wsl-binfmt-fix.service..."
cat > /etc/systemd/system/wsl-binfmt-fix.service <<'BINFMT_EOF'
[Unit]
Description=Ensure WSLInterop binfmt handler is registered
# binfmt_misc pseudo-fs is mounted by local-fs.target; we must run after it.
After=local-fs.target
# Only needed when running under WSL2 (the kernel command line carries
# WSL_ROOT_INIT=1 and the WSL2 hypervisor is present).
ConditionVirtualization=microsoft
# /init is the WSL2 bootstrap binary that owns the binfmt interpreter path.
# If it is absent something is deeply wrong -- skip rather than fail.
ConditionPathExists=/init
# Skip if /init already registered the handler during early boot.
ConditionPathExists=!/proc/sys/fs/binfmt_misc/WSLInterop

[Service]
Type=oneshot
# Register WSLInterop with flags P (preserve argv[0]) and F (fix binary --
# open the interpreter fd before execve so the handler works even when the
# filesystem is mounted with noexec or when the calling process has
# reduced capabilities).  This matches the flags used by /init itself.
ExecStart=/bin/sh -c \
    'echo ":WSLInterop:M::MZ::/init:PF" \
        > /proc/sys/fs/binfmt_misc/register'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
BINFMT_EOF

systemctl daemon-reload
systemctl enable wsl-binfmt-fix.service

# 8. Shrink the distro. apt caches and build tooling are not needed at
#    runtime and add ~150MB. We keep the customer's distro small even
#    though it is no longer "shipped" (the build happens on their box).
log "[8/8] Cleaning up..."
apt-get purge -y build-essential || true
apt-get autoremove -y
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt /tmp/* /var/tmp/* /root/.cache /root/.npm

log "Done. Distro provisioned."
