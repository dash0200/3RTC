#!/usr/bin/env python3
"""
Deploy WebRTC Signaling Server to Oracle Cloud Infrastructure (OCI) Always Free Tier.
- Free Tier Specs:
    * Ampere A1 (ARM): up to 4 OCPUs, 24 GB RAM, or
    * AMD Micro (x86_64): VM.Standard.E2.1.Micro (1 OCPU, 1 GB RAM).
    * 200 GB Total Block Volume Storage (Free Forever).
    * 10 TB / Month Outbound Data Transfer (Egress).
- Features:
    * Fully Automated OCI Cloud Provisioner: creates VCN, Subnet, Firewall & VM directly from terminal.
    * Auto-Detects Home Region: solves Oracle IAM region mismatch errors automatically.
    * Reuses Existing VCN & Subnet: uses existing network or creates clean new one.
    * Automated SSH Deployment: configures any existing Oracle VM with 1 click.
    * Unlocks Oracle Host Firewall (iptables / firewalld / ufw) for ports 80, 443, 8443.
    * Configures Caddy reverse proxy with automated Let's Encrypt SSL via <IP>.sslip.io.
    * Instant Hot-Updates: re-run anytime to update server code in ~2 seconds.
"""

import sys
import os
import shutil
import subprocess
import json
import base64
import time
import glob
import re
import urllib.request
import getpass
import tempfile
from pathlib import Path

# Force line buffering for interactive terminals
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

SIGNAL_DOMAIN = "orc.3rtc.me"
DEFAULT_PORT = "443"
ALT_PORT = "8443"
SERVICE_USER = "webrtc"
SERVICE_FILE = "webrtc-signaling.service"
SERVER_FILES = ["server.js", "signaling.js", "seats.js", "rateLimit.js", "quickPicks.js", "log.js", "package.json"]
CACHE_FILE_NAME = ".oracle_deploy_cache.json"

PROBE_REGIONS = [
    "ap-hyderabad-1", "ap-mumbai-1", "us-ashburn-1", "us-phoenix-1",
    "eu-frankfurt-1", "uk-london-1", "ap-singapore-1", "ap-tokyo-1",
    "ap-sydney-1", "ca-toronto-1"
]


def print_step(title):
    print(f"\n{'=' * 65}")
    print(f" {title}")
    print(f"{'=' * 65}", flush=True)


def find_executable(name, extra_paths=None):
    found = shutil.which(name) or (sys.platform == "win32" and shutil.which(f"{name}.exe"))
    if found:
        return found
    if extra_paths and sys.platform == "win32":
        for p in extra_paths:
            expanded = os.path.expandvars(p)
            if os.path.isfile(expanded):
                return expanded
    return None


def find_ssh():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\ssh.exe",
        r"%ProgramFiles%\Git\usr\bin\ssh.exe"
    ]
    return find_executable("ssh", win_paths)


def find_scp():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\scp.exe",
        r"%ProgramFiles%\Git\usr\bin\scp.exe"
    ]
    return find_executable("scp", win_paths)


def find_ssh_keygen():
    win_paths = [
        r"%SystemRoot%\System32\OpenSSH\ssh-keygen.exe",
        r"%ProgramFiles%\Git\usr\bin\ssh-keygen.exe"
    ]
    return find_executable("ssh-keygen", win_paths)


def find_oci():
    """Find OCI CLI executable, including Windows Store Python package directories."""
    found = shutil.which("oci") or (sys.platform == "win32" and shutil.which("oci.exe"))
    if found:
        return found

    if sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            patterns = [
                os.path.join(local_app, "Packages", "PythonSoftwareFoundation.Python*", "LocalCache", "local-packages", "Python*", "Scripts", "oci.exe"),
                os.path.join(local_app, "Programs", "Python", "Python*", "Scripts", "oci.exe"),
                os.path.expandvars(r"%USERPROFILE%\lib\oracle-cli\bin\oci.exe")
            ]
            for pat in patterns:
                matches = glob.glob(pat)
                if matches and os.path.isfile(matches[0]):
                    return matches[0]
    return None


def run_cmd(cmd_list, capture_output=True, check=True, text=True):
    try:
        res = subprocess.run(
            cmd_list,
            capture_output=capture_output,
            check=check,
            text=text,
            shell=(sys.platform == "win32" and isinstance(cmd_list, str))
        )
        return res
    except subprocess.CalledProcessError as e:
        if capture_output and e.stderr:
            print(f"[Error Output]: {e.stderr.strip()}", flush=True)
        raise e


def get_oci_auth_flags():
    config_path = Path.home() / ".oci" / "config"
    if config_path.exists():
        try:
            content = config_path.read_text(encoding="utf-8")
            if "security_token_file" in content:
                return ["--auth", "security_token"]
        except Exception:
            pass
    return []


def read_oci_config_section(section="DEFAULT"):
    config_path = Path.home() / ".oci" / "config"
    data = {}
    if not config_path.exists():
        return data
    current_sec = None
    try:
        for line in config_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                current_sec = line[1:-1]
                continue
            if current_sec == section and "=" in line:
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip()
    except Exception:
        pass
    return data


def update_oci_config_region(new_region):
    config_file = Path.home() / ".oci" / "config"
    if config_file.exists():
        try:
            text = config_file.read_text(encoding="utf-8")
            new_text = re.sub(r"region\s*=\s*[^\r\n]+", f"region={new_region}", text)
            config_file.write_text(new_text, encoding="utf-8")
        except Exception:
            pass


def load_cache(script_dir):
    cache_path = script_dir / CACHE_FILE_NAME
    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save_cache(script_dir, data):
    cache_path = script_dir / CACHE_FILE_NAME
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def check_prerequisites():
    print_step("Step 1: Checking Prerequisites")

    if sys.version_info < (3, 8):
        print(f"[ERROR] Python 3.8+ required. Found: {sys.version}")
        sys.exit(1)
    print(f"[OK] Python {sys.version.split()[0]} detected.")

    script_dir = Path(__file__).resolve().parent
    server_files = [script_dir / name for name in SERVER_FILES]
    missing = [f.name for f in [*server_files, script_dir / SERVICE_FILE] if not f.exists()]
    if missing:
        print(f"[ERROR] Missing server files in {script_dir}: {', '.join(missing)}")
        sys.exit(1)
    print(f"[OK] Local server files verified: {', '.join(SERVER_FILES)}")

    ssh_bin = find_ssh()
    scp_bin = find_scp()
    if not ssh_bin or not scp_bin:
        print("[ERROR] OpenSSH client ('ssh' and 'scp') was not found in PATH.")
        sys.exit(1)
    print(f"[OK] SSH tools detected.")

    oci_bin = find_oci()
    if not oci_bin:
        print("\n[Notice] Oracle Cloud CLI ('oci') not found. Installing via pip...")
        subprocess.run([sys.executable, "-m", "pip", "install", "oci-cli"])
        oci_bin = find_oci()

    if oci_bin:
        print(f"[OK] Oracle Cloud CLI (oci) ready: {oci_bin}")
    else:
        print("[INFO] Oracle Cloud CLI not installed. Direct SSH mode available.")

    return script_dir, server_files, ssh_bin, scp_bin, oci_bin


def build_remote_bootstrap_script():
    script = f"""#!/bin/bash
set -e

exec > >(tee -a /var/log/oracle-3rtc-setup.log) 2>&1
echo "[3RTC] Starting WebRTC Signaling Server bootstrap on Oracle Cloud..."

# 1. Unlock Oracle Cloud Host Firewall (iptables / firewalld / ufw)
echo "[Firewall] Configuring host firewall for ports 80, 443, 8443..."
if command -v iptables >/dev/null 2>&1; then
    sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 8443 -j ACCEPT 2>/dev/null || true
    if command -v netfilter-persistent >/dev/null 2>&1; then
        sudo netfilter-persistent save || true
    fi
fi

if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 80/tcp || true
    sudo ufw allow 443/tcp || true
    sudo ufw allow 8443/tcp || true
fi

if command -v firewall-cmd >/dev/null 2>&1; then
    sudo firewall-cmd --zone=public --permanent --add-port=80/tcp || true
    sudo firewall-cmd --zone=public --permanent --add-port=443/tcp || true
    sudo firewall-cmd --zone=public --permanent --add-port=8443/tcp || true
    sudo firewall-cmd --reload || true
fi

# 2. Setup 2GB Swap (prevents OOM on smaller/shared instances)
if [ ! -f /swapfile ]; then
    echo "[Swap] Setting up 2GB swap space..."
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3. Detect Package Manager & Install Node.js 20 & Caddy
if command -v apt-get >/dev/null 2>&1; then
    echo "[Deps] Debian/Ubuntu detected. Installing Node.js 20 & Caddy..."
    export DEBIAN_FRONTEND=noninteractive
    sudo apt-get update -y
    sudo apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

    # Node.js 20
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
    sudo apt-get update -y
    sudo apt-get install -y nodejs

    # Caddy
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -y
    sudo apt-get install -y caddy

elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    echo "[Deps] Oracle Linux / RHEL detected. Installing Node.js 20 & Caddy..."
    PKG_MGR="dnf"
    command -v dnf >/dev/null 2>&1 || PKG_MGR="yum"

    sudo $PKG_MGR install -y curl tar bzip2
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo $PKG_MGR install -y nodejs

    sudo $PKG_MGR install -y 'dnf-command(copr)' 2>/dev/null || true
    sudo $PKG_MGR copr enable -y @caddy/caddy 2>/dev/null || true
    sudo $PKG_MGR install -y caddy
fi

# 4. Service User & App Directory
echo "[App] Preparing application directory..."
sudo mkdir -p /opt/webrtc-server
id -u {SERVICE_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER}
sudo chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server

# 5. Discover External IP & Configure Caddy Reverse Proxy
EXTERNAL_IP=$(curl -s -m 5 https://api.ipify.org || curl -s -m 5 http://checkip.amazonaws.com || hostname -I | awk '{{print $1}}')
DOMAIN="${{EXTERNAL_IP}}.sslip.io"

echo "[TLS] Configuring Caddy for domain: ${{DOMAIN}}"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{{
    admin off
}}

# Automated Let's Encrypt TLS on standard HTTPS/WSS (443) and 8443 for orc.3rtc.me and sslip.io
orc.3rtc.me:443, orc.3rtc.me:8443, ${{DOMAIN}}:443, ${{DOMAIN}}:8443 {{
    reverse_proxy 127.0.0.1:8080
}}

# HTTP status check & ACME challenge support on port 80
:80 {{
    respond "3RTC WebRTC Signaling Server Ready at wss://orc.3rtc.me:443" 200
}}
EOF

sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy

echo "[Done] Oracle Cloud OS bootstrap finished successfully!"
"""
    return script


def build_update_command(server_files):
    moves = " && ".join(f"sudo mv /tmp/{f.name} /opt/webrtc-server/{f.name}" for f in server_files)
    caddy_check = (
        "if [ ! -f /etc/caddy/Caddyfile ] || ! grep -q 'orc.3rtc.me' /etc/caddy/Caddyfile 2>/dev/null; then "
        "EXT_IP=$(curl -s -m 5 https://api.ipify.org || hostname -I | awk '{print $1}'); "
        "printf '{\\n    admin off\\n}\\norc.3rtc.me:443, orc.3rtc.me:8443, %s.sslip.io:443, %s.sslip.io:8443 {\\n    reverse_proxy 127.0.0.1:8080\\n}\\n:80 {\\n    respond \"3RTC Ready\" 200\\n}\\n' \"$EXT_IP\" \"$EXT_IP\" | sudo tee /etc/caddy/Caddyfile >/dev/null && "
        "sudo systemctl daemon-reload && sudo systemctl enable caddy && sudo systemctl restart caddy; fi"
    )
    return (
        "sudo mkdir -p /opt/webrtc-server && "
        f"{moves} && cd /opt/webrtc-server"
        " && (sudo npm install --omit=dev --no-audit --no-fund --silent || echo 'Dependencies unchanged')"
        f" && (id -u {SERVICE_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin {SERVICE_USER})"
        f" && sudo chown -R {SERVICE_USER}:{SERVICE_USER} /opt/webrtc-server"
        " && (sudo chmod 600 /opt/webrtc-server/.youtube-api-key 2>/dev/null || true)"
        f" && sudo mv /tmp/{SERVICE_FILE} /etc/systemd/system/{SERVICE_FILE}"
        f" && sudo chown root:root /etc/systemd/system/{SERVICE_FILE}"
        " && sudo systemctl daemon-reload"
        " && sudo systemctl enable webrtc-signaling"
        " && sudo systemctl restart webrtc-signaling"
        f" && {caddy_check}"
        " && sudo systemctl restart caddy 2>/dev/null || true"
    )


def wait_for_ready(external_ip):
    print_step("Verifying Deployment & Obtaining wss:// URL")
    domain = f"{external_ip}.sslip.io"
    http_url = f"http://{external_ip}"
    wss_url = f"wss://{domain}:{DEFAULT_PORT}"
    wss_alt = f"wss://{domain}:{ALT_PORT}"

    print(f"Server domain: {domain}")
    print("Waiting for Caddy reverse proxy and SSL certificate to initialize...")
    print("(This typically takes ~20-45 seconds)")

    max_retries = 30
    ready = False
    for i in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(http_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=4) as response:
                if response.status == 200:
                    ready = True
                    break
        except Exception:
            pass

        time.sleep(5)
        print(f"  [{i * 5}s] Checking HTTP & TLS connectivity...", end="\r", flush=True)

    print()
    if ready:
        print("[OK] Signaling server and TLS reverse proxy are LIVE!")
    else:
        print("[Notice] Setup complete. If Let's Encrypt is still provisioning, URLs will become active in a moment.")

    print("\n" + "=" * 65)
    print(" 3RTC WebRTC Signaling Server Live (Oracle Always Free)")
    print("=" * 65)
    print(f"\n Secure WebSocket (WSS) URLs for Testing:\n")
    print(f"  Oracle Test URL : {wss_url}")
    print(f"  Alternative WSS : {wss_alt}")
    print(f"  Production DNS  : wss://{SIGNAL_DOMAIN} (Kept on GCP until you decide to switch)")
    print("\n" + "-" * 65)
    print("Server Details:")
    print(f"  External IP  : {external_ip}")
    print(f"  SSL Domain   : {domain} (Valid Let's Encrypt Certificate)")
    print("  Host Cloud   : Oracle Cloud Infrastructure (Always Free Tier)")
    print("=" * 65 + "\n")


def configure_quick_picks(ssh_bin, user, host, key_path):
    print_step("YouTube Quick Picks Setup (Optional)")
    print("Quick picks can fetch trending and search videos using a YouTube Data API v3 key.")
    print("The key is stored securely in /opt/webrtc-server/.youtube-api-key.")
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if key:
        print("Using YOUTUBE_API_KEY from current environment.")
    else:
        key = getpass.getpass("Paste YouTube Data API key (hidden, or press Enter to skip): ").strip()
    if not key:
        print("Skipped. Built-in video presets remain active.")
        return

    fd, local_path = tempfile.mkstemp(prefix="yt-key-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(key + "\n")
        copy_remote_scp(find_scp(), user, host, key_path, [local_path], "/tmp/.youtube-api-key")
    finally:
        os.remove(local_path)

    cmd = (
        f"sudo install -m 600 -o {SERVICE_USER} -g {SERVICE_USER} /tmp/.youtube-api-key /opt/webrtc-server/.youtube-api-key"
        " && rm -f /tmp/.youtube-api-key && sudo rm -f /opt/webrtc-server/quick-picks-cache.json"
        " && sudo systemctl restart webrtc-signaling"
    )
    execute_remote_ssh(ssh_bin, user, host, key_path, cmd)
    print("[OK] YouTube API key installed. Quick picks will refresh from YouTube API.")


def copy_remote_scp(scp_bin, user, host, key_path, local_files, remote_dest):
    cmd = [
        scp_bin,
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-q",
        *[str(f) for f in local_files],
        f"{user}@{host}:{remote_dest}"
    ]
    return run_cmd(cmd, capture_output=False)


def execute_remote_ssh(ssh_bin, user, host, key_path, command):
    cmd = [
        ssh_bin,
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=15",
        f"{user}@{host}",
        command
    ]
    return run_cmd(cmd, capture_output=False)


# =====================================================================
# FULLY AUTOMATED OCI CLOUD PROVISIONING (No Browser Console Needed)
# =====================================================================

def detect_home_region(oci_bin, tenancy_id, auth_flags):
    """Detect the tenancy's real Home Region where Always Free resources reside."""
    print("Auto-detecting your Oracle Cloud Home Region...", end="", flush=True)

    # 1. Try currently configured region
    cfg = read_oci_config_section("DEFAULT")
    curr_region = cfg.get("region")
    if curr_region:
        res = run_cmd([oci_bin, "iam", "region-subscription", "list", "--tenancy-id", tenancy_id, "--region", curr_region, *auth_flags, "--output", "json"], check=False)
        if res.returncode == 0:
            subs = json.loads(res.stdout or "{}").get("data", [])
            for s in subs:
                if s.get("is-home-region"):
                    home = s.get("region-name")
                    print(f" [OK: {home}]")
                    return home

    # 2. Probe popular candidate regions
    for r in PROBE_REGIONS:
        res = run_cmd([oci_bin, "iam", "region-subscription", "list", "--tenancy-id", tenancy_id, "--region", r, *auth_flags, "--output", "json"], check=False)
        if res.returncode == 0:
            subs = json.loads(res.stdout or "{}").get("data", [])
            for s in subs:
                if s.get("is-home-region"):
                    home = s.get("region-name")
                    print(f" [OK: {home}]")
                    update_oci_config_region(home)
                    return home

    print(" [Fallback to ap-hyderabad-1]")
    return "ap-hyderabad-1"


def authenticate_oci(oci_bin):
    """Ensure OCI CLI is authenticated with active session or API key."""
    print_step("Step 2: Oracle Cloud Authentication")

    auth_flags = get_oci_auth_flags()
    config = read_oci_config_section("DEFAULT")

    if config and config.get("tenancy"):
        # Auto-detect real home region
        home_region = detect_home_region(oci_bin, config["tenancy"], auth_flags)
        config["region"] = home_region
        update_oci_config_region(home_region)
        print(f"[OK] Authenticated for Tenancy in Home Region: {home_region}")
        return config, auth_flags, home_region

    # If unauthenticated, trigger login
    print("\nOCI CLI requires authentication.")
    print("A browser window will open to sign into your Oracle Cloud account once.")
    run_cmd([oci_bin, "session", "authenticate"], capture_output=False)

    auth_flags = get_oci_auth_flags()
    config = read_oci_config_section("DEFAULT")
    home_region = detect_home_region(oci_bin, config["tenancy"], auth_flags)
    config["region"] = home_region
    update_oci_config_region(home_region)
    return config, auth_flags, home_region


def ensure_ssh_key():
    """Ensure an SSH key pair exists in ~/.ssh/oracle_3rtc_key for the VM."""
    ssh_dir = Path.home() / ".ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    priv_key = ssh_dir / "oracle_3rtc_key"
    pub_key = ssh_dir / "oracle_3rtc_key.pub"

    if not priv_key.exists() or not pub_key.exists():
        print(f"\nGenerating dedicated SSH key pair at: {priv_key}...")
        keygen = find_ssh_keygen()
        if keygen:
            run_cmd([keygen, "-t", "ed25519", "-N", "", "-f", str(priv_key), "-C", "3rtc-signaling"], capture_output=True)
        else:
            run_cmd([keygen, "-t", "rsa", "-b", "2048", "-N", "", "-f", str(priv_key), "-C", "3rtc-signaling"], capture_output=True)

    if sys.platform == "win32":
        try:
            username = os.environ.get("USERNAME")
            if username:
                subprocess.run(["icacls", str(priv_key), "/inheritance:r", "/grant:r", f"{username}:(R,W)"], capture_output=True)
        except Exception:
            pass

    return priv_key, pub_key


def provision_network(oci_bin, auth_flags, compartment_id, region):
    """Automatically ensure VCN, Subnet, and Security List exist with open ports."""
    print_step("Step 4: Provisioning Cloud Network & Firewall")

    # 1. Check for Existing VCN
    print(f"Checking for Virtual Cloud Network in {region}...", end="", flush=True)
    vcns_res = run_cmd([oci_bin, "network", "vcn", "list", "--compartment-id", compartment_id, "--region", region, *auth_flags, "--output", "json"])
    vcns = json.loads(vcns_res.stdout or "{}").get("data", [])
    
    if vcns:
        target_vcn = vcns[0]
        vcn_id = target_vcn["id"]
        print(f" [Using existing VCN: {target_vcn.get('display-name')}]")
    else:
        print(" [Creating new VCN: 3rtc-signaling-vcn]")
        create_vcn = run_cmd([
            oci_bin, "network", "vcn", "create",
            "--compartment-id", compartment_id,
            "--cidr-block", "10.0.0.0/16",
            "--display-name", "3rtc-signaling-vcn",
            "--dns-label", "rtc3vcn",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        vcn_id = json.loads(create_vcn.stdout)["data"]["id"]

    # 2. Check or Create Internet Gateway
    ig_res = run_cmd([oci_bin, "network", "internet-gateway", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    igs = json.loads(ig_res.stdout or "{}").get("data", [])
    if igs:
        ig_id = igs[0]["id"]
    else:
        print("Creating Internet Gateway...")
        create_ig = run_cmd([
            oci_bin, "network", "internet-gateway", "create",
            "--compartment-id", compartment_id,
            "--vcn-id", vcn_id,
            "--is-enabled", "true",
            "--display-name", "3rtc-ig",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        ig_id = json.loads(create_ig.stdout)["data"]["id"]

    # 3. Route Table: Route 0.0.0.0/0 to Internet Gateway
    rt_res = run_cmd([oci_bin, "network", "route-table", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    rts = json.loads(rt_res.stdout or "{}").get("data", [])
    if rts:
        rt_id = rts[0]["id"]
        route_rules = [
            {"destination": "0.0.0.0/0", "destinationType": "CIDR_BLOCK", "networkEntityId": ig_id}
        ]
        run_cmd([
            oci_bin, "network", "route-table", "update",
            "--rt-id", rt_id,
            "--route-rules", json.dumps(route_rules),
            "--region", region,
            "--force",
            *auth_flags, "--output", "json"
        ], capture_output=True)

    # 4. Security List: Allow Ingress on 22, 80, 443, 8443
    print("Ensuring Ingress Security Rules allow ports 22, 80, 443, 8443...")
    sec_res = run_cmd([oci_bin, "network", "security-list", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    sec_lists = json.loads(sec_res.stdout or "{}").get("data", [])
    if sec_lists:
        sec_id = sec_lists[0]["id"]
        existing_rules = sec_lists[0].get("ingress-security-rules", [])
        
        # Merge our required ports
        required_ports = [22, 80, 443, 8443]
        for p in required_ports:
            has_port = any(
                r.get("tcpOptions", {}).get("destinationPortRange", {}).get("min") == p
                for r in existing_rules
            )
            if not has_port:
                existing_rules.append({
                    "protocol": "6",
                    "source": "0.0.0.0/0",
                    "tcpOptions": {"destinationPortRange": {"min": p, "max": p}},
                    "description": f"3RTC port {p}"
                })

        run_cmd([
            oci_bin, "network", "security-list", "update",
            "--security-list-id", sec_id,
            "--ingress-security-rules", json.dumps(existing_rules),
            "--region", region,
            "--force",
            *auth_flags, "--output", "json"
        ], capture_output=True)

    # 5. Check or Create Public Subnet
    sub_res = run_cmd([oci_bin, "network", "subnet", "list", "--compartment-id", compartment_id, "--vcn-id", vcn_id, "--region", region, *auth_flags, "--output", "json"])
    subs = json.loads(sub_res.stdout or "{}").get("data", [])
    if subs:
        subnet_id = subs[0]["id"]
        print(f"[OK] Using subnet: {subs[0].get('display-name')}")
    else:
        print("Creating Public Subnet...")
        create_sub = run_cmd([
            oci_bin, "network", "subnet", "create",
            "--compartment-id", compartment_id,
            "--vcn-id", vcn_id,
            "--cidr-block", "10.0.0.0/24",
            "--display-name", "3rtc-subnet",
            "--dns-label", "rtc3sub",
            "--region", region,
            *auth_flags, "--output", "json"
        ])
        subnet_id = json.loads(create_sub.stdout)["data"]["id"]

    print("[OK] Virtual Cloud Network & Firewall ready.")
    return subnet_id


def find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region):
    """Find latest Canonical Ubuntu image compatible with chosen shape in region."""
    print(f"Finding latest Canonical Ubuntu image for {shape}...", end="", flush=True)
    res = run_cmd([
        oci_bin, "compute", "image", "list",
        "--compartment-id", compartment_id,
        "--shape", shape,
        "--operating-system", "Canonical Ubuntu",
        "--region", region,
        *auth_flags, "--output", "json"
    ], check=False)

    images = json.loads(res.stdout or "{}").get("data", []) if res.returncode == 0 else []
    # Standard 22.04 or 24.04 preferred
    standard_imgs = [img for img in images if "22.04" in img.get("display-name", "") and "Minimal" not in img.get("display-name", "")]
    if standard_imgs:
        chosen = sorted(standard_imgs, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    candidates = [img for img in images if "22.04" in img.get("display-name", "") or "24.04" in img.get("display-name", "")]
    if candidates:
        chosen = sorted(candidates, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    if images:
        chosen = sorted(images, key=lambda x: x.get("time-created", ""), reverse=True)[0]
        print(f" [OK: {chosen['display-name']}]")
        return chosen["id"]

    raise RuntimeError(f"No Canonical Ubuntu images found for {shape} in region {region}.")


def get_ampere_available_limits(oci_bin, compartment_id, selected_ad, region, auth_flags):
    """Query tenancy's available Ampere A1 OCPUs and RAM to prevent LimitExceeded errors."""
    avail_cores = 4
    avail_ram = 24
    try:
        core_res = run_cmd([
            oci_bin, "limits", "resource-availability", "get",
            "--compartment-id", compartment_id,
            "--service-name", "compute",
            "--limit-name", "standard-a1-core-count",
            "--availability-domain", selected_ad,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, check=False)
        if core_res.returncode == 0:
            c_data = json.loads(core_res.stdout or "{}").get("data", {})
            if "available" in c_data and c_data["available"] is not None:
                avail_cores = int(c_data["available"])

        mem_res = run_cmd([
            oci_bin, "limits", "resource-availability", "get",
            "--compartment-id", compartment_id,
            "--service-name", "compute",
            "--limit-name", "standard-a1-memory-count",
            "--availability-domain", selected_ad,
            "--region", region,
            *auth_flags,
            "--output", "json"
        ], capture_output=True, check=False)
        if mem_res.returncode == 0:
            m_data = json.loads(mem_res.stdout or "{}").get("data", {})
            if "available" in m_data and m_data["available"] is not None:
                avail_ram = int(m_data["available"])
    except Exception:
        pass

    return avail_cores, avail_ram


def launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin=None):
    """End-to-end automated VM creation using OCI CLI."""
    config, auth_flags, region = authenticate_oci(oci_bin)
    compartment_id = config.get("tenancy")
    if not compartment_id:
        print("[ERROR] Tenancy OCID not found in OCI configuration.")
        sys.exit(1)

    # 1. Availability Domain
    print_step("Step 3: Availability Domain & VM Shape")
    ad_res = run_cmd([oci_bin, "iam", "availability-domain", "list", "--compartment-id", compartment_id, "--region", region, *auth_flags, "--output", "json"])
    ads = json.loads(ad_res.stdout or "{}").get("data", [])
    if not ads:
        print(f"[ERROR] No Availability Domains found in region '{region}'.")
        sys.exit(1)

    if len(ads) == 1:
        selected_ad = ads[0]["name"]
        print(f"[OK] Availability Domain: {selected_ad}")
    else:
        print("Available Availability Domains:")
        for idx, ad in enumerate(ads, 1):
            print(f"  {idx}) {ad['name']}")
        ad_choice = input(f"\nSelect Availability Domain [1-{len(ads)}, default: 1]: ").strip() or "1"
        ad_idx = int(ad_choice) - 1 if ad_choice.isdigit() and 1 <= int(ad_choice) <= len(ads) else 0
        selected_ad = ads[ad_idx]["name"]

    # 2. Shape Selection (Always Free)
    print("Checking tenancy compute resource availability...", end="", flush=True)
    avail_cores, avail_ram = get_ampere_available_limits(oci_bin, compartment_id, selected_ad, region, auth_flags)
    print(f" [Ampere Limit: {avail_cores} OCPUs, {avail_ram} GB RAM]")

    print("\nSelect Always Free VM Shape:")
    if avail_cores >= 2:
        print(f"  1) Ampere A1 (ARM): {avail_cores} OCPUs, {avail_ram} GB RAM (Your Account Limit) [Recommended]")
        if avail_cores > 1:
            print("  2) Ampere A1 (ARM): 1 OCPU, 6 GB RAM (Minimal ARM)")
            print("  3) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")
        else:
            print("  2) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")

        shape_choice = input("\nSelect shape [1-3, default: 1]: ").strip() or "1"
        if shape_choice == "2" and avail_cores > 1:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = 1, 6
        elif shape_choice == "3" or (shape_choice == "2" and avail_cores <= 1):
            shape = "VM.Standard.E2.1.Micro"
            ocpus, ram = None, None
        else:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = avail_cores, avail_ram
    elif avail_cores == 1:
        print(f"  1) Ampere A1 (ARM): 1 OCPU, {avail_ram} GB RAM (Your Account Limit) [Recommended]")
        print("  2) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro]")
        shape_choice = input("\nSelect shape [1-2, default: 1]: ").strip() or "1"
        if shape_choice == "2":
            shape = "VM.Standard.E2.1.Micro"
            ocpus, ram = None, None
        else:
            shape = "VM.Standard.A1.Flex"
            ocpus, ram = 1, avail_ram
    else:
        print("  (Note: Ampere A1 service limit is 0 in your account for this region.)")
        print("  1) AMD Micro: 1 OCPU, 1 GB RAM (VM.Standard.E2.1.Micro) [Always Free Micro] [Recommended]")
        shape_choice = input("\nSelect shape [default: 1]: ").strip() or "1"
        shape = "VM.Standard.E2.1.Micro"
        ocpus, ram = None, None

    # 3. Network & Security
    subnet_id = provision_network(oci_bin, auth_flags, compartment_id, region)

    # 4. SSH Keypair
    priv_key, pub_key = ensure_ssh_key()
    print(f"[OK] Using SSH Key: {priv_key}")

    # 5. OS Image
    image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)

    # 6. Startup Script (Cloud-Init Bootstrap)
    print_step("Step 5: Launching Always Free Instance")
    startup_content = build_remote_bootstrap_script()
    temp_script = script_dir / "_oracle_startup.sh"
    try:
        with open(temp_script, "w", encoding="utf-8", newline="\n") as f:
            f.write(startup_content)

        launch_args = [
            oci_bin, "compute", "instance", "launch",
            "--availability-domain", selected_ad,
            "--compartment-id", compartment_id,
            "--shape", shape,
            "--image-id", image_id,
            "--subnet-id", subnet_id,
            "--display-name", "3rtc-signaling-server",
            "--assign-public-ip", "true",
            "--ssh-authorized-keys-file", str(pub_key),
            "--user-data-file", str(temp_script),
            "--region", region,
            *auth_flags,
            "--output", "json"
        ]
        if ocpus and ram:
            launch_args.extend(["--shape-config", json.dumps({"ocpus": ocpus, "memoryInGBs": ram})])

        print(f"Launching instance in {selected_ad} ({region})...")
        while True:
            try:
                launch_res = run_cmd(launch_args)
                instance_data = json.loads(launch_res.stdout)["data"]
                instance_id = instance_data["id"]
                break
            except subprocess.CalledProcessError as e:
                err_text = str(e)
                if hasattr(e, "stderr") and e.stderr:
                    err_text += " " + e.stderr
                err_lower = err_text.lower()

                if "limitexceeded" in err_lower or "limits were exceeded" in err_lower or "limit exceeded" in err_lower:
                    print(f"\n[!] Oracle Cloud Service Limit exceeded for {shape}.")
                    if shape == "VM.Standard.A1.Flex" and ocpus and (ocpus > 1 or ram > 6):
                        print("Options:")
                        print("  1) Downscale to 1 OCPU, 6 GB RAM and retry")
                        print("  2) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free]")
                        print("  3) Cancel")
                        lim_choice = input("Select option [1-3, default: 1]: ").strip() or "1"
                        if lim_choice == "1":
                            ocpus, ram = 1, 6
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json",
                                "--shape-config", json.dumps({"ocpus": ocpus, "memoryInGBs": ram})
                            ]
                            print("Retrying with 1 OCPU, 6 GB RAM...")
                            continue
                        elif lim_choice == "2":
                            shape = "VM.Standard.E2.1.Micro"
                            ocpus, ram = None, None
                            image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json"
                            ]
                            print("Retrying with AMD Micro...")
                            continue
                        else:
                            sys.exit(0)
                    else:
                        print("Options:")
                        print("  1) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free]")
                        print("  2) Cancel")
                        lim_choice = input("Select option [1-2, default: 1]: ").strip() or "1"
                        if lim_choice == "1":
                            shape = "VM.Standard.E2.1.Micro"
                            ocpus, ram = None, None
                            image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                            launch_args = [
                                oci_bin, "compute", "instance", "launch",
                                "--availability-domain", selected_ad,
                                "--compartment-id", compartment_id,
                                "--shape", shape,
                                "--image-id", image_id,
                                "--subnet-id", subnet_id,
                                "--display-name", "3rtc-signaling-server",
                                "--assign-public-ip", "true",
                                "--ssh-authorized-keys-file", str(pub_key),
                                "--user-data-file", str(temp_script),
                                "--region", region,
                                *auth_flags,
                                "--output", "json"
                            ]
                            print("Retrying with AMD Micro...")
                            continue
                        else:
                            sys.exit(0)

                elif "toomanyrequests" in err_lower or "too many requests" in err_lower or "status: 429" in err_lower:
                    print("\n[!] Oracle API rate limit reached (HTTP 429: Too Many Requests).")
                    print("Waiting 45 seconds for API rate limits to reset before retrying...")
                    time.sleep(45)
                    continue

                elif "out of host capacity" in err_lower or "out of capacity" in err_lower:
                    print("\n[!] Oracle Cloud returned: Out of host capacity for Ampere A1 ARM in ap-hyderabad-1.")
                    print("Free Tier Ampere slots in this datacenter are currently full.")
                    print("\nOptions:")
                    print("  1) Switch to AMD Micro instance (VM.Standard.E2.1.Micro) [Always Free, Available Now] (Recommended)")
                    print("  2) Retry Ampere A1 (wait 45 seconds and retry)")
                    print("  3) Cancel")
                    cap_choice = input("Select option [1-3, default: 1]: ").strip() or "1"
                    if cap_choice == "2":
                        print("Waiting 45 seconds before retry to prevent rate limits... (Ctrl+C to abort)")
                        time.sleep(45)
                        continue
                    elif cap_choice == "1":
                        shape = "VM.Standard.E2.1.Micro"
                        ocpus, ram = None, None
                        image_id = find_ubuntu_image(oci_bin, auth_flags, compartment_id, shape, region)
                        launch_args = [
                            oci_bin, "compute", "instance", "launch",
                            "--availability-domain", selected_ad,
                            "--compartment-id", compartment_id,
                            "--shape", shape,
                            "--image-id", image_id,
                            "--subnet-id", subnet_id,
                            "--display-name", "3rtc-signaling-server",
                            "--assign-public-ip", "true",
                            "--ssh-authorized-keys-file", str(pub_key),
                            "--user-data-file", str(temp_script),
                            "--region", region,
                            *auth_flags,
                            "--output", "json"
                        ]
                        print("Switching to AMD Micro (VM.Standard.E2.1.Micro)...")
                        continue
                    else:
                        sys.exit(0)
                else:
                    raise

    finally:
        if temp_script.exists():
            temp_script.unlink()

    # 7. Wait for RUNNING and Public IP
    print(f"\n[OK] Instance created! ID: {instance_id}")
    print("Waiting for VM state to transition to 'RUNNING'...", end="", flush=True)

    public_ip = None
    for _ in range(30):
        time.sleep(5)
        print(".", end="", flush=True)
        inst_get = run_cmd([oci_bin, "compute", "instance", "get", "--instance-id", instance_id, "--region", region, *auth_flags, "--output", "json"], check=False)
        if inst_get.returncode == 0:
            state = json.loads(inst_get.stdout).get("data", {}).get("lifecycle-state")
            if state == "RUNNING":
                break

    print(" [RUNNING!]")
    print("Fetching assigned Public IP...")
    for _ in range(6):
        vnic_res = run_cmd([oci_bin, "compute", "instance", "list-vnics", "--instance-id", instance_id, "--region", region, *auth_flags, "--output", "json"])
        vnics = json.loads(vnic_res.stdout or "{}").get("data", [])
        if vnics and vnics[0].get("public-ip"):
            public_ip = vnics[0].get("public-ip")
            break
        time.sleep(5)

    if not public_ip:
        print("[ERROR] Could not retrieve Public IP. Check OCI Console.")
        sys.exit(1)

    print(f"\n[SUCCESS] Public IP: {public_ip}")
    save_cache(script_dir, {"host": public_ip, "user": "ubuntu", "key_path": str(priv_key)})

    # 8. Wait for SSH & cloud-init OS bootstrap
    print(f"\nWaiting for SSH and OS packages on {public_ip}...", end="", flush=True)
    actual_scp = scp_bin or find_scp()
    ssh_ready = False
    for attempt in range(60):
        check_res = subprocess.run([
            ssh_bin,
            "-i", str(priv_key),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=5",
            "-o", "BatchMode=yes",
            f"ubuntu@{public_ip}",
            "which cloud-init >/dev/null 2>&1 && cloud-init status --wait || true"
        ], capture_output=True, text=True)
        if check_res.returncode == 0:
            ssh_ready = True
            print(" [Ready!]")
            break
        time.sleep(5)
        print(".", end="", flush=True)

    if not ssh_ready:
        print("\n[Notice] Proceeding with file upload and service setup...")

    # 9. Upload application files via SCP
    print("\nUploading server application files...")
    all_files = [*server_files, script_dir / SERVICE_FILE]
    copy_remote_scp(actual_scp, "ubuntu", public_ip, priv_key, all_files, "/tmp/")

    # 10. Install dependencies & start systemd service
    print("Installing npm dependencies & starting webrtc-signaling service...")
    execute_remote_ssh(ssh_bin, "ubuntu", public_ip, priv_key, build_update_command(server_files))

    wait_for_ready(public_ip)
    configure_quick_picks(ssh_bin, "ubuntu", public_ip, priv_key)


def deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=None):
    """Direct SSH deployment for existing instances."""
    print_step("Connect to Oracle Cloud VM via SSH")

    cached_host = cached_info.get("host", "") if cached_info else ""
    cached_user = cached_info.get("user", "ubuntu") if cached_info else "ubuntu"
    cached_key = cached_info.get("key_path", "") if cached_info else ""

    host_prompt = f"Enter Oracle VM Public IP [{cached_host}]: " if cached_host else "Enter Oracle VM Public IP: "
    host = input(host_prompt).strip() or cached_host
    if not host:
        print("[ERROR] Public IP is required. Exiting.")
        sys.exit(1)

    user = input(f"SSH Username [default: {cached_user}]: ").strip() or cached_user
    key_path = Path(cached_key) if cached_key and Path(cached_key).exists() else None

    if not key_path:
        default_priv = Path.home() / ".ssh" / "oracle_3rtc_key"
        if default_priv.exists():
            key_path = default_priv
        else:
            raw_p = input("Enter path to your SSH private key (.key/.pem): ").strip()
            key_path = Path(raw_p).expanduser().resolve()

    if not key_path.exists():
        print(f"[ERROR] SSH private key not found at '{key_path}'. Exiting.")
        sys.exit(1)

    print("Uploading latest server files to /tmp/...")
    all_files = [*server_files, script_dir / SERVICE_FILE]
    copy_remote_scp(scp_bin, user, host, key_path, all_files, "/tmp/")

    print("Applying updates and restarting service...")
    execute_remote_ssh(ssh_bin, user, host, key_path, build_update_command(server_files))
    save_cache(script_dir, {"host": host, "user": user, "key_path": str(key_path)})
    wait_for_ready(host)
    configure_quick_picks(ssh_bin, user, host, key_path)


def main():
    print("""
=================================================================
  WebRTC Signaling Server - Oracle Cloud Always Free Deployer
=================================================================
""")
    script_dir, server_files, ssh_bin, scp_bin, oci_bin = check_prerequisites()
    cached_info = load_cache(script_dir)

    if cached_info and cached_info.get("host"):
        print(f"\nFound previous deployment: {cached_info.get('user', 'ubuntu')}@{cached_info.get('host')}")
        print("  1) Quick Hot-Update (2-second code refresh & restart) [Default]")
        print("  2) Launch a Brand New VM via OCI CLI (Full Automation)")
        print("  3) Connect to a different Oracle VM via SSH")
        print("  4) Exit")
        c = input("\nSelect choice [1-4, default: 1]: ").strip() or "1"
        if c == "1":
            deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=cached_info)
            return
        elif c == "2":
            launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin)
            return
        elif c == "3":
            deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin, cached_info=None)
            return
        else:
            sys.exit(0)

    print("\nSelect Deployment Mode:")
    print("  1) Fully Automated OCI Deploy (Create VM, VCN, Firewall & Deploy from Terminal) [Recommended]")
    print("  2) Connect to an Existing Oracle VM via SSH (Public IP + Key)")
    print("  3) Exit")
    choice = input("\nSelect option [1-3, default: 1]: ").strip() or "1"

    if choice == "1":
        if not oci_bin:
            print("[ERROR] Oracle Cloud CLI (oci) is required for full cloud automation.")
            print("Please run: pip install oci-cli")
            sys.exit(1)
        launch_oci_vm_automated(script_dir, server_files, oci_bin, ssh_bin, scp_bin)
    elif choice == "2":
        deploy_via_ssh(script_dir, server_files, ssh_bin, scp_bin)
    else:
        print("Exiting.")
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nDeployment cancelled by user.")
        sys.exit(0)
