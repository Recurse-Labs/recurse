#!/usr/bin/env sh
# Recurse installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Recurse-Labs/recurse/master/scripts/install.sh | sh
#
# Downloads the latest GitHub Release bundle for your platform and installs
# it the native way (dpkg/rpm on Linux, .app in /Applications on macOS).
# Once installed, Recurse checks for and installs updates itself — see
# docs/updating.md. This script is only needed for the very first install.
set -eu

REPO="Recurse-Labs/recurse"
API="https://api.github.com/repos/${REPO}/releases/latest"

log() { printf '==> %s\n' "$1"; }
die() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need curl

os="$(uname -s)"
arch="$(uname -m)"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

release_json="$tmpdir/release.json"
log "Fetching latest release metadata for ${REPO}..."
curl -fsSL "$API" -o "$release_json" ||
	die "could not reach GitHub API — check your connection, or grab a build manually from https://github.com/${REPO}/releases"

# Extracts every "browser_download_url" value without requiring jq.
list_assets() {
	grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' "$release_json" |
		sed -E 's/.*"([^"]+)"$/\1/'
}

# find_asset PATTERN — first asset URL whose filename matches an ERE pattern.
find_asset() {
	list_assets | grep -Ei "$1" | head -n1
}

download() {
	url="$1"
	out="$tmpdir/$(basename "$url")"
	log "Downloading $(basename "$url")..."
	curl -fsSL "$url" -o "$out" || die "download failed: $url"
	printf '%s' "$out"
}

install_linux() {
	case "$arch" in
	x86_64 | amd64) deb_arch="amd64" rpm_arch="x86_64" appimage_arch="amd64|x86_64" ;;
	aarch64 | arm64) deb_arch="arm64" rpm_arch="aarch64" appimage_arch="arm64|aarch64" ;;
	*) die "unsupported architecture: $arch" ;;
	esac

	if command -v dpkg >/dev/null 2>&1; then
		asset="$(find_asset "\.deb$" | grep -Ei "${deb_arch}" || find_asset "\.deb$")"
		if [ -n "$asset" ]; then
			pkg="$(download "$asset")"
			log "Installing via dpkg (sudo password may be requested)..."
			sudo dpkg -i "$pkg" || sudo apt-get install -f -y
			log "Installed. Launch with: recurse"
			return
		fi
	fi

	if command -v rpm >/dev/null 2>&1; then
		asset="$(find_asset "\.rpm$" | grep -Ei "${rpm_arch}" || find_asset "\.rpm$")"
		if [ -n "$asset" ]; then
			pkg="$(download "$asset")"
			log "Installing via rpm (sudo password may be requested)..."
			if command -v dnf >/dev/null 2>&1; then
				sudo dnf install -y "$pkg"
			elif command -v zypper >/dev/null 2>&1; then
				sudo zypper install -y "$pkg"
			else
				sudo rpm -i "$pkg"
			fi
			log "Installed. Launch with: recurse"
			return
		fi
	fi

	# Universal fallback: AppImage, no root required.
	asset="$(find_asset "\.AppImage$" | grep -Ei "${appimage_arch}" || find_asset "\.AppImage$")"
	[ -n "$asset" ] || die "no Linux build found in the latest release — see https://github.com/${REPO}/releases"
	img="$(download "$asset")"
	bindir="${HOME}/.local/bin"
	mkdir -p "$bindir"
	dest="${bindir}/recurse"
	cp "$img" "$dest"
	chmod +x "$dest"
	log "Installed AppImage to ${dest}"
	case ":$PATH:" in
	*":${bindir}:"*) ;;
	*) log "Add ${bindir} to your PATH, e.g.: export PATH=\"${bindir}:\$PATH\"" ;;
	esac
	log "Launch with: recurse"
}

install_macos() {
	case "$arch" in
	arm64) mac_pat="aarch64|arm64" ;;
	x86_64) mac_pat="x86_64|x64" ;;
	*) die "unsupported architecture: $arch" ;;
	esac

	asset="$(find_asset "\.dmg$" | grep -Ei "${mac_pat}" || find_asset "\.dmg$")"
	[ -n "$asset" ] || die "no macOS build found in the latest release — see https://github.com/${REPO}/releases"
	dmg="$(download "$asset")"

	log "Mounting disk image..."
	mount_point="$tmpdir/mnt"
	mkdir -p "$mount_point"
	hdiutil attach "$dmg" -mountpoint "$mount_point" -nobrowse -quiet

	app="$(find "$mount_point" -maxdepth 1 -name '*.app' | head -n1)"
	[ -n "$app" ] || {
		hdiutil detach "$mount_point" -quiet || true
		die "no .app bundle found inside the downloaded image"
	}

	log "Installing to /Applications (sudo password may be requested)..."
	sudo rm -rf "/Applications/$(basename "$app")"
	sudo cp -R "$app" /Applications/
	hdiutil detach "$mount_point" -quiet || true

	log "Installed. Launch from Applications, or: open -a Recurse"
}

case "$os" in
Linux) install_linux ;;
Darwin) install_macos ;;
*) die "unsupported OS: $os — on Windows use scripts/install.ps1 instead" ;;
esac
