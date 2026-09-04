#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 PATH_TO_DEB [DOCKER_IMAGE]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for the clean-package smoke test" >&2
  exit 1
fi

package_path="$(realpath "$1")"
image="${2:-ubuntu:22.04}"

if [[ ! -f "$package_path" || "$package_path" != *.deb ]]; then
  echo "Debian package not found: $package_path" >&2
  exit 1
fi

container_name="fyxtez-deb-smoke-$$-${RANDOM}"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Creating clean $image container for $(basename "$package_path")"
docker create \
  --platform linux/amd64 \
  --name "$container_name" \
  --mount "type=bind,src=$package_path,dst=/tmp/fyxtez-terminal.deb,readonly" \
  "$image" \
  sleep infinity >/dev/null
docker start "$container_name" >/dev/null

docker exec -i "$container_name" bash -s <<'CONTAINER_TEST'
set -Eeuo pipefail

package_file=/tmp/fyxtez-terminal.deb
package_name="$(dpkg-deb --field "$package_file" Package)"
package_version="$(dpkg-deb --field "$package_file" Version)"
package_arch="$(dpkg-deb --field "$package_file" Architecture)"

if [[ "$package_arch" != "$(dpkg --print-architecture)" ]]; then
  echo "package architecture $package_arch does not match the clean system" >&2
  exit 1
fi

assert_no_developer_tools() {
  local tool
  for tool in node npm cargo rustc; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "unexpected developer tool found in clean runtime: $tool" >&2
      exit 1
    fi
  done
}

apt_get() {
  DEBIAN_FRONTEND=noninteractive \
    apt-get --quiet=2 -o Dpkg::Use-Pty=0 "$@"
}

verify_installation() {
  local binary ldd_output
  local desktop_file="/usr/share/applications/Fyxtez Terminal.desktop"

  test "$(dpkg-query --show --showformat='${db:Status-Abbrev}' "$package_name")" = "ii "
  test "$(dpkg-query --show --showformat='${Version}' "$package_name")" = "$package_version"
  test -x /usr/bin/fyxtez-terminal-desktop
  test -x /usr/bin/fyxtez-backend
  test -f "$desktop_file"
  grep -Fxq 'Type=Application' "$desktop_file"
  grep -Fxq 'Exec=fyxtez-terminal-desktop' "$desktop_file"
  grep -Fxq 'Icon=fyxtez-terminal-desktop' "$desktop_file"
  find /usr/share/icons/hicolor -type f \
    -name 'fyxtez-terminal-desktop.png' -print -quit | grep -q .

  for binary in /usr/bin/fyxtez-terminal-desktop /usr/bin/fyxtez-backend; do
    ldd_output="$(ldd "$binary")"
    if grep -Fq 'not found' <<<"$ldd_output"; then
      echo "unresolved runtime library in $binary" >&2
      echo "$ldd_output" >&2
      exit 1
    fi
  done

  dpkg --verify "$package_name"
  assert_no_developer_tools
}

assert_no_developer_tools
apt_get update
apt_get install --yes --no-install-recommends "$package_file"
verify_installation

data_dir=/root/.local/share/com.fyxtez.terminal
marker="$data_dir/docker-smoke-marker"
mkdir -p "$data_dir"
printf '%s\n' 'preserve application data across package operations' >"$marker"
marker_checksum="$(sha256sum "$marker")"

apt_get install --yes --reinstall "$package_file"
verify_installation
test "$(sha256sum "$marker")" = "$marker_checksum"

apt_get purge --yes "$package_name"
test ! -e /usr/bin/fyxtez-terminal-desktop
test ! -e /usr/bin/fyxtez-backend
test "$(sha256sum "$marker")" = "$marker_checksum"

apt_get install --yes --no-install-recommends "$package_file"
verify_installation
test "$(sha256sum "$marker")" = "$marker_checksum"

echo "PASS: $package_name $package_version installs cleanly without Node or Cargo"
echo "PASS: runtime libraries, desktop metadata, remove/reinstall, and data retention verified"
CONTAINER_TEST
