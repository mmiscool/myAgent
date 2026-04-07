#!/usr/bin/env bash
set -Eeuo pipefail

rand_alnum() {
  local len="$1"
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | dd bs=1 count="$len" status=none 2>/dev/null || true
}

CT_NAME="${CT_NAME:-gpu-desktop}"
IMAGE="${IMAGE:-ubuntu:24.04}"
DESKTOP_USER="${DESKTOP_USER:-desktop}"
DESKTOP_PASSWORD="${DESKTOP_PASSWORD:-$(rand_alnum 16)}"
VNC_PASSWORD="${VNC_PASSWORD:-$(rand_alnum 8)}"
RESOLUTION="${RESOLUTION:-1920x1080}"
HOST_VNC_PORT="${HOST_VNC_PORT:-5901}"
HOST_NOVNC_PORT="${HOST_NOVNC_PORT:-6080}"
HOST_SSH_PORT="${HOST_SSH_PORT:-2222}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
RECREATE="${RECREATE:-0}"
NOVNC_TAG="${NOVNC_TAG:-v1.6.0}"
WEBSOCKIFY_TAG="${WEBSOCKIFY_TAG:-v0.13.0}"
PROVISION_MARKER="/root/.desktop_stack_provisioned"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

warn() {
  printf '\n[%s] WARNING: %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

fail() {
  printf '\n[%s] ERROR: %s\n' "$(date '+%H:%M:%S')" "$*" >&2
  exit 1
}

trap 'fail "Script failed on line $LINENO."' ERR

if [[ -z "${DESKTOP_PASSWORD}" ]]; then
  fail "Failed to generate DESKTOP_PASSWORD."
fi

if [[ -z "${VNC_PASSWORD}" ]]; then
  fail "Failed to generate VNC_PASSWORD."
fi

if [[ "$EUID" -ne 0 ]]; then
  fail "Run this script as root."
fi

if [[ ${#VNC_PASSWORD} -lt 6 || ${#VNC_PASSWORD} -gt 8 ]]; then
  fail "VNC_PASSWORD must be between 6 and 8 characters."
fi

for cmd in apt-get systemctl ss awk grep sed dd; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing required host command: $cmd"
done

have_port() {
  local port="$1"
  ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)$port$"
}

instance_exists() {
  lxc info "$CT_NAME" >/dev/null 2>&1
}

instance_running() {
  [[ "$(lxc list "$CT_NAME" -c s --format csv 2>/dev/null | head -n1)" == "RUNNING" ]]
}

instance_stopped() {
  [[ "$(lxc list "$CT_NAME" -c s --format csv 2>/dev/null | head -n1)" == "STOPPED" ]]
}

get_access_host() {
  if [[ "$BIND_ADDR" == "127.0.0.1" ]]; then
    echo "127.0.0.1"
  else
    hostname -I | awk '{print $1}'
  fi
}

show_connection_info() {
  local access_host
  access_host="$(get_access_host)"

  echo
  echo "Container:        $CT_NAME"
  echo "Desktop user:     $DESKTOP_USER"
  echo "Desktop password: $DESKTOP_PASSWORD"
  echo "VNC password:     $VNC_PASSWORD"
  echo
  echo "Browser URL:      http://${access_host}:${HOST_NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"
  echo "Raw VNC:          ${access_host}:${HOST_VNC_PORT}"
  echo "SSH:              ssh ${DESKTOP_USER}@${access_host} -p ${HOST_SSH_PORT}"
  echo
}

ensure_host_deps() {
  log "Checking host dependencies"

  export DEBIAN_FRONTEND=noninteractive

  if ! command -v snap >/dev/null 2>&1; then
    log "Installing snapd"
    apt-get update
    apt-get install -y snapd
  else
    log "snapd already installed"
  fi

  systemctl enable --now snapd.service snapd.socket >/dev/null 2>&1 || true
  export PATH="/snap/bin:$PATH"

  if ! snap list lxd >/dev/null 2>&1; then
    log "Installing LXD"
    snap install lxd
  else
    log "LXD already installed"
  fi

  log "Waiting for LXD commands to become available"
  for _ in $(seq 1 60); do
    if command -v lxd >/dev/null 2>&1 && command -v lxc >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  lxd waitready
  log "Host dependency check complete"
}

init_lxd_if_needed() {
  log "Checking LXD initialization"
  if ! lxc info >/dev/null 2>&1; then
    log "Initializing LXD with automatic network setup"
    lxd init --auto
  else
    log "LXD already initialized"
  fi
}

ensure_default_networking() {
  log "Checking default LXD networking"

  if ! lxc network show lxdbr0 >/dev/null 2>&1; then
    fail "LXD default bridge 'lxdbr0' is missing after 'lxd init --auto'. Fix LXD networking on the host and rerun."
  fi

  if ! lxc profile device show default | grep -q '^root:'; then
    fail "LXD default profile is missing the root disk device. Fix LXD initialization on the host and rerun."
  fi

  if ! lxc profile device show default | grep -q '^eth0:'; then
    fail "LXD default profile is missing the 'eth0' NIC on 'lxdbr0'. Fix LXD networking on the host and rerun."
  fi

  log "Default networking ready"
}

ensure_ufw_allows_lxd_bridge() {
  if ! command -v ufw >/dev/null 2>&1; then
    return 0
  fi

  if ufw status 2>/dev/null | grep -qi '^Status: inactive'; then
    log "UFW is inactive"
    return 0
  fi

  log "Ensuring UFW allows traffic on lxdbr0"
  ufw --force allow in on lxdbr0 >/dev/null 2>&1 || warn "Failed to add UFW input rule for lxdbr0"
  ufw --force route allow in on lxdbr0 >/dev/null 2>&1 || warn "Failed to add UFW route-in rule for lxdbr0"
  ufw --force route allow out on lxdbr0 >/dev/null 2>&1 || warn "Failed to add UFW route-out rule for lxdbr0"
}

check_ports_for_new_instance() {
  log "Checking required host ports"

  if have_port "$HOST_NOVNC_PORT"; then
    fail "Host port already in use: $HOST_NOVNC_PORT"
  fi

  if have_port "$HOST_VNC_PORT"; then
    fail "Host port already in use: $HOST_VNC_PORT"
  fi

  if have_port "$HOST_SSH_PORT"; then
    fail "Host port already in use: $HOST_SSH_PORT"
  fi

  log "Required host ports are free"
}

ensure_clean_instance() {
  if instance_exists; then
    if [[ "$RECREATE" == "1" ]]; then
      log "Deleting existing container: $CT_NAME"
      lxc delete -f "$CT_NAME"
    else
      fail "LXD instance '$CT_NAME' already exists."
    fi
  fi
}

ensure_proxy_device() {
  local dev_name="$1"
  local listen_port="$2"
  local connect_port="$3"

  if ! lxc config device show "$CT_NAME" | grep -q "^${dev_name}:"; then
    log "Adding proxy device ${dev_name} on host port ${listen_port}"
    lxc config device add "$CT_NAME" "$dev_name" proxy \
      listen="tcp:${BIND_ADDR}:${listen_port}" \
      connect="tcp:127.0.0.1:${connect_port}" \
      bind=host
  else
    log "Proxy device ${dev_name} already present"
  fi
}

wait_for_container_boot() {
  for _ in $(seq 1 120); do
    if lxc exec "$CT_NAME" -- true >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

wait_for_container_ipv4_route() {
  for _ in $(seq 1 60); do
    if lxc exec "$CT_NAME" -- bash -lc 'ip -4 route show default >/dev/null 2>&1'; then
      return 0
    fi
    sleep 1
  done

  return 1
}

refresh_container_network_stack() {
  lxc exec "$CT_NAME" -- bash -lc 'systemctl restart systemd-networkd systemd-resolved >/dev/null 2>&1 || true' || true
}

wait_for_container_network() {
  log "Waiting for container boot"

  if ! wait_for_container_boot; then
    fail "Container '${CT_NAME}' did not finish booting within 120 seconds."
  fi

  log "Waiting for cloud-init if present"
  lxc exec "$CT_NAME" -- bash -lc 'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait; fi' || true

  log "Refreshing container network services"
  refresh_container_network_stack

  log "Waiting for container default route"
  if wait_for_container_ipv4_route; then
    log "Container network is ready"
    return 0
  fi

  warn "Container did not get an IPv4 default route after network service restart. Restarting the container once."
  lxc restart "$CT_NAME" --force

  if ! wait_for_container_boot; then
    fail "Container '${CT_NAME}' did not come back after a restart."
  fi

  log "Waiting for cloud-init after restart"
  lxc exec "$CT_NAME" -- bash -lc 'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait; fi' || true

  log "Refreshing container network services after restart"
  refresh_container_network_stack

  if ! wait_for_container_ipv4_route; then
    fail "Container '${CT_NAME}' did not get an IPv4 default route. LXD default networking is still not functional on this host."
  fi

  log "Container network is ready"
}

launch_container() {
  log "Initializing container ${CT_NAME} from image ${IMAGE}"
  lxc init "$IMAGE" "$CT_NAME"

  log "Setting container options"
  lxc config set "$CT_NAME" boot.autostart true
  lxc config set "$CT_NAME" security.nesting true

  if ! lxc config device add "$CT_NAME" gpu gpu gputype=physical uid=1000 gid=1000 mode=0660 >/dev/null 2>&1; then
    warn "GPU passthrough could not be enabled. Continuing without a GPU device."
  else
    log "GPU passthrough device added"
  fi

  ensure_proxy_device novncproxy "$HOST_NOVNC_PORT" 6080
  ensure_proxy_device rawvncproxy "$HOST_VNC_PORT" 5901
  ensure_proxy_device sshproxy "$HOST_SSH_PORT" 22

  log "Starting container ${CT_NAME}"
  lxc start "$CT_NAME"

  wait_for_container_network
}

provision_container() {
  log "Provisioning desktop environment inside container"
  log "This can take several minutes on first run"

  lxc exec "$CT_NAME" -- env \
    DESKTOP_USER="$DESKTOP_USER" \
    DESKTOP_PASSWORD="$DESKTOP_PASSWORD" \
    VNC_PASSWORD="$VNC_PASSWORD" \
    RESOLUTION="$RESOLUTION" \
    NOVNC_TAG="$NOVNC_TAG" \
    WEBSOCKIFY_TAG="$WEBSOCKIFY_TAG" \
    PROVISION_MARKER="$PROVISION_MARKER" \
    bash -s <<'INNER'
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

if [[ -f "$PROVISION_MARKER" ]]; then
  echo "[container] already provisioned"
  exit 0
fi

apt_update_with_retries() {
  local attempt

  for attempt in 1 2 3 4; do
    if apt-get update; then
      return 0
    fi

    echo "[container] apt-get update failed on attempt ${attempt}; restarting network services and retrying"
    systemctl restart systemd-networkd systemd-resolved >/dev/null 2>&1 || true
    sleep 5
  done

  return 1
}

echo "[container] updating apt metadata"
apt_update_with_retries

echo "[container] installing desktop, VNC, SSH, and helper packages"
apt-get install -y \
  xfce4 xfce4-goodies \
  tigervnc-standalone-server tigervnc-tools \
  dbus-x11 xauth x11-xserver-utils \
  git ca-certificates sudo python3 \
  mesa-utils pciutils \
  openssh-server

echo "[container] configuring sshd"
mkdir -p /var/run/sshd
sed -ri 's/^#?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -ri 's/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
if grep -q '^#\?UsePAM ' /etc/ssh/sshd_config; then
  sed -ri 's/^#?UsePAM .*/UsePAM yes/' /etc/ssh/sshd_config
else
  echo 'UsePAM yes' >> /etc/ssh/sshd_config
fi

getent group render >/dev/null 2>&1 || groupadd --system render
getent group video >/dev/null 2>&1 || groupadd --system video

if ! id -u "$DESKTOP_USER" >/dev/null 2>&1; then
  echo "[container] creating desktop user"
  useradd -m -s /bin/bash "$DESKTOP_USER"
fi

echo "[container] setting user password and group membership"
echo "$DESKTOP_USER:$DESKTOP_PASSWORD" | chpasswd
usermod -aG sudo,video,render "$DESKTOP_USER"

echo "[container] creating VNC directories"
install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "/home/$DESKTOP_USER/.vnc"
install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "/home/$DESKTOP_USER/.config/tigervnc"

echo "[container] setting VNC password"
printf '%s\n' "$VNC_PASSWORD" | runuser -u "$DESKTOP_USER" -- bash -lc 'vncpasswd -f > "$HOME/.vnc/passwd"'
chown "$DESKTOP_USER:$DESKTOP_USER" "/home/$DESKTOP_USER/.vnc/passwd"
chmod 0600 "/home/$DESKTOP_USER/.vnc/passwd"

cat > "/home/$DESKTOP_USER/.vnc/xstartup" <<'XSTARTUP'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
xrdb "$HOME/.Xresources" 2>/dev/null || true
exec dbus-launch --exit-with-session startxfce4
XSTARTUP
chown "$DESKTOP_USER:$DESKTOP_USER" "/home/$DESKTOP_USER/.vnc/xstartup"
chmod 0755 "/home/$DESKTOP_USER/.vnc/xstartup"

echo "[container] cloning noVNC and websockify"
rm -rf /opt/novnc
mkdir -p /opt
git clone --depth 1 --branch "$NOVNC_TAG" https://github.com/novnc/noVNC.git /opt/novnc
git clone --depth 1 --branch "$WEBSOCKIFY_TAG" https://github.com/novnc/websockify.git /opt/novnc/utils/websockify
ln -sf /opt/novnc/vnc.html /opt/novnc/index.html

echo "[container] writing systemd units"
cat > /etc/systemd/system/vncserver.service <<SERVICE
[Unit]
Description=TigerVNC server for ${DESKTOP_USER}
After=network.target

[Service]
Type=forking
User=${DESKTOP_USER}
Group=${DESKTOP_USER}
WorkingDirectory=/home/${DESKTOP_USER}
PIDFile=/home/${DESKTOP_USER}/.vnc/%H:1.pid
ExecStartPre=-/usr/bin/tigervncserver -kill :1
ExecStart=/usr/bin/tigervncserver :1 -geometry ${RESOLUTION} -depth 24 -localhost no -rfbauth /home/${DESKTOP_USER}/.vnc/passwd
ExecStop=-/usr/bin/tigervncserver -kill :1
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/novnc.service <<SERVICE
[Unit]
Description=noVNC web client bridge
After=network.target vncserver.service
Requires=vncserver.service

[Service]
Type=simple
User=${DESKTOP_USER}
Group=${DESKTOP_USER}
WorkingDirectory=/opt/novnc
ExecStart=/opt/novnc/utils/novnc_proxy --vnc 127.0.0.1:5901 --listen 0.0.0.0:6080
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

echo "[container] enabling services"
systemctl daemon-reload
systemctl enable --now ssh vncserver.service novnc.service

touch "$PROVISION_MARKER"
echo "[container] provisioning complete"
INNER

  log "Container provisioning complete"
}

ensure_container_started_and_ready() {
  if instance_stopped; then
    log "Existing container is stopped. Starting it now"
    lxc start "$CT_NAME"
  else
    log "Existing container is already running"
  fi

  lxc config set "$CT_NAME" boot.autostart true
  lxc config set "$CT_NAME" security.nesting true || true

  ensure_proxy_device novncproxy "$HOST_NOVNC_PORT" 6080
  ensure_proxy_device rawvncproxy "$HOST_VNC_PORT" 5901
  ensure_proxy_device sshproxy "$HOST_SSH_PORT" 22

  wait_for_container_network

  if ! lxc exec "$CT_NAME" -- test -f "$PROVISION_MARKER" >/dev/null 2>&1; then
    log "Provision marker missing. Provisioning container"
    provision_container
  else
    log "Container already provisioned. Ensuring services are started"
    lxc exec "$CT_NAME" -- bash -lc 'systemctl enable --now ssh vncserver.service novnc.service' || true
  fi
}

open_browser() {
  local url
  url="http://$(get_access_host):${HOST_NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"

  log "Launching browser for noVNC"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
    echo "Opened browser: $url"
  else
    echo "Open this in your browser:"
    echo "$url"
  fi
}

ssh_into_container() {
  local host
  host="$(get_access_host)"
  log "Opening SSH session to container"
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$HOST_SSH_PORT" "${DESKTOP_USER}@${host}"
}

stop_current_container() {
  if instance_running; then
    log "Stopping container: $CT_NAME"
    lxc stop "$CT_NAME"
    echo "Stopped container: $CT_NAME"
  else
    echo "Container is not running: $CT_NAME"
  fi
}

list_all_containers() {
  log "Listing containers"
  echo
  lxc list
  echo
}

select_and_start_container() {
  mapfile -t stopped_containers < <(lxc list -c ns --format csv | awk -F, '$2=="STOPPED"{print $1}')

  if [[ "${#stopped_containers[@]}" -eq 0 ]]; then
    echo "No stopped containers found."
    return
  fi

  echo
  echo "Stopped containers:"
  local i=1
  for name in "${stopped_containers[@]}"; do
    echo "  $i) $name"
    ((i++))
  done
  echo "  q) Cancel"
  echo

  while true; do
    read -rp "Choose a container to start: " choice
    if [[ "$choice" == "q" || "$choice" == "Q" ]]; then
      return
    fi
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#stopped_containers[@]} )); then
      local selected
      selected="${stopped_containers[$((choice - 1))]}"
      log "Starting container: $selected"
      lxc start "$selected"
      echo "Started container: $selected"
      return
    fi
    echo "Invalid selection."
  done
}

menu_loop() {
  while true; do
    echo
    echo "Select an option:"
    echo "  1) Launch desktop VNC to browser"
    echo "  2) SSH to enter interactive terminal sessions in container"
    echo "  3) Stop container"
    echo "  4) List containers"
    echo "  5) Start container"
    echo "  6) Quit"
    echo

    read -rp "Enter choice [1-6]: " choice

    case "$choice" in
      1)
        open_browser
        ;;
      2)
        ssh_into_container
        ;;
      3)
        stop_current_container
        ;;
      4)
        list_all_containers
        ;;
      5)
        select_and_start_container
        ;;
      6)
        log "Exiting"
        exit 0
        ;;
      *)
        echo "Invalid choice."
        ;;
    esac
  done
}

main() {
  log "Starting container desktop setup"

  ensure_host_deps
  init_lxd_if_needed
  ensure_default_networking
  ensure_ufw_allows_lxd_bridge

  if instance_exists; then
    if [[ "$RECREATE" == "1" ]]; then
      log "RECREATE=1 set. Rebuilding existing container"
      ensure_clean_instance
      check_ports_for_new_instance
      launch_container
      provision_container
      show_connection_info
      menu_loop
      return
    fi

    log "Container '$CT_NAME' already exists. Skipping creation"
    ensure_container_started_and_ready
    show_connection_info
    menu_loop
    return
  fi

  check_ports_for_new_instance
  launch_container
  provision_container
  show_connection_info
  menu_loop
}

main "$@"
