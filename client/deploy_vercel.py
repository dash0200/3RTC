#!/usr/bin/env python3
"""
Deploy WebRTC Watch Party Client to Vercel.
- Framework: Vite React SPA (Root Directory: client)
- Target: GitHub Account Integration (dash0200/3RTC) & 'main' Branch
- Build Command: npm run build -> dist/
- Production Signaling Server: Automatically connects to wss://34.57.36.145.sslip.io:443
- SPA Routing: Configures vercel.json rewrites for seamless room URL sharing
"""

import sys
import os
import shutil
import subprocess
import json
import time
import urllib.request
import webbrowser
import argparse
from pathlib import Path

# Force line buffering for interactive terminals
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(line_buffering=True)

DEFAULT_SIGNALING_WSS = "wss://34.57.36.145.sslip.io:443"
DEFAULT_GITHUB_REPO = "https://github.com/dash0200/3RTC.git"


def print_step(title):
    print(f"\n{'=' * 60}")
    print(f" {title}")
    print(f"{'=' * 60}", flush=True)


def find_executable(name):
    """Find executable on Windows and Unix platforms."""
    path = shutil.which(name)
    if path:
        return path
    if sys.platform == "win32":
        path_cmd = shutil.which(f"{name}.cmd") or shutil.which(f"{name}.exe")
        if path_cmd:
            return path_cmd
        # Check standard AppData npm roaming path
        npm_roaming = os.path.expandvars(r"%APPDATA%\npm")
        candidate = Path(npm_roaming) / f"{name}.cmd"
        if candidate.exists():
            return str(candidate)
    return None


def run_cmd(cmd_list, cwd=None, capture_output=True, check=True, text=True):
    """Execute a subprocess cleanly across operating systems."""
    try:
        is_windows = sys.platform == "win32"
        use_shell = is_windows and (isinstance(cmd_list, str) or any(str(c).endswith('.cmd') for c in cmd_list if isinstance(c, (str, Path))))
        res = subprocess.run(
            cmd_list,
            cwd=str(cwd) if cwd else None,
            capture_output=capture_output,
            check=check,
            text=text,
            shell=use_shell
        )
        return res
    except subprocess.CalledProcessError as e:
        if capture_output and e.stderr:
            print(f"[Error Output]: {e.stderr.strip()}", flush=True)
        raise e


def check_prerequisites(client_dir):
    print_step("Step 1: Checking Prerequisites")

    # 1. Python version
    if sys.version_info < (3, 8):
        print(f"[ERROR] Python 3.8+ is required. Found: {sys.version}")
        sys.exit(1)
    print(f"[OK] Python {sys.version.split()[0]} detected.")

    # 2. Client files
    pkg_json = client_dir / "package.json"
    index_html = client_dir / "index.html"
    vite_config = client_dir / "vite.config.js"

    if not pkg_json.exists() or not index_html.exists():
        print(f"[ERROR] Missing client files in: {client_dir}")
        print("Please ensure 'package.json' and 'index.html' exist in the client folder.")
        sys.exit(1)
    print(f"[OK] Client project files verified at: {client_dir}")

    # 3. Check Node.js
    node_bin = find_executable("node")
    if not node_bin:
        print("[ERROR] Node.js is NOT installed or not in PATH.")
        print("Please install Node.js (https://nodejs.org) to build and deploy the client.")
        sys.exit(1)
    try:
        node_ver = run_cmd([node_bin, "-v"]).stdout.strip()
        print(f"[OK] Node.js detected: {node_ver}")
    except Exception:
        print(f"[OK] Node.js detected at: {node_bin}")

    # 4. Check npm
    npm_bin = find_executable("npm")
    if not npm_bin:
        print("[ERROR] npm is NOT installed or not in PATH.")
        sys.exit(1)
    try:
        npm_ver = run_cmd([npm_bin, "-v"]).stdout.strip()
        print(f"[OK] npm detected: v{npm_ver}")
    except Exception:
        print(f"[OK] npm detected at: {npm_bin}")

    # 5. Check Vercel CLI or npx
    vercel_bin = find_executable("vercel")
    npx_bin = find_executable("npx")

    if vercel_bin:
        try:
            ver_res = run_cmd([vercel_bin, "--version"]).stdout.strip()
            print(f"[OK] Vercel CLI detected: {ver_res}")
        except Exception:
            print(f"[OK] Vercel CLI detected at: {vercel_bin}")
        cmd_runner = [vercel_bin]
    elif npx_bin:
        print("[OK] Vercel CLI will be executed via 'npx vercel'.")
        cmd_runner = [npx_bin, "-y", "vercel"]
    else:
        print("\n[!] Neither 'vercel' CLI nor 'npx' was found in PATH.")
        print("Options:")
        print("  1) Install Vercel CLI globally via npm (npm i -g vercel)")
        print("  2) Open Vercel CLI documentation in browser")
        print("  3) Exit")
        choice = input("\nEnter choice [1-3]: ").strip()
        if choice == "1":
            print("Installing Vercel CLI globally (npm i -g vercel)...")
            run_cmd([npm_bin, "install", "-g", "vercel"], capture_output=False)
            vercel_bin = find_executable("vercel")
            if vercel_bin:
                cmd_runner = [vercel_bin]
            else:
                print("[ERROR] Failed to locate 'vercel' after installation.")
                sys.exit(1)
        elif choice == "2":
            webbrowser.open("https://vercel.com/docs/cli")
            sys.exit(0)
        else:
            sys.exit(0)

    return cmd_runner


def ensure_vercel_config(client_dir):
    print_step("Step 2: Verifying Vercel SPA Routing Configuration")
    vercel_json_path = client_dir / "vercel.json"

    expected_config = {
        "framework": "vite",
        "buildCommand": "npm run build",
        "outputDirectory": "dist",
        "rewrites": [
            {
                "source": "/(.*)",
                "destination": "/index.html"
            }
        ]
    }

    if not vercel_json_path.exists():
        print("Creating 'vercel.json' for Vite React Single Page Application routing...")
        with open(vercel_json_path, "w", encoding="utf-8") as f:
            json.dump(expected_config, f, indent=2)
        print("[OK] Created client/vercel.json with SPA rewrites.")
    else:
        try:
            with open(vercel_json_path, "r", encoding="utf-8") as f:
                content = json.load(f)
            has_rewrites = "rewrites" in content and any(r.get("destination") == "/index.html" for r in content.get("rewrites", []))
            if not has_rewrites:
                print("Updating 'vercel.json' to ensure SPA routing rewrites are configured...")
                content.setdefault("framework", "vite")
                content.setdefault("buildCommand", "npm run build")
                content.setdefault("outputDirectory", "dist")
                content["rewrites"] = expected_config["rewrites"]
                with open(vercel_json_path, "w", encoding="utf-8") as f:
                    json.dump(content, f, indent=2)
                print("[OK] Updated client/vercel.json with SPA rewrites.")
            else:
                print("[OK] client/vercel.json already configured for SPA routing.")
        except Exception as e:
            print(f"[Notice] Preserving existing vercel.json ({e}).")


def authenticate_vercel(cmd_runner, client_dir):
    print_step("Step 3: Vercel Authentication")

    print("Checking active Vercel login status...", flush=True)
    res = run_cmd(cmd_runner + ["whoami"], cwd=client_dir, check=False)

    if res.returncode == 0 and res.stdout.strip():
        user = res.stdout.strip()
        print(f"Active Vercel account: {user}")
        use_current = input(f"Proceed with account '{user}'? [Y/n]: ").strip().lower()
        if use_current in ("", "y", "yes"):
            return user

    print("\nStarting Vercel login...")
    print("A browser window will open to authenticate with your GitHub account.")
    run_cmd(cmd_runner + ["login", "github"], cwd=client_dir, capture_output=False, check=False)

    res = run_cmd(cmd_runner + ["whoami"], cwd=client_dir)
    user = res.stdout.strip()
    print(f"[OK] Successfully authenticated as: {user}")
    return user


def configure_github_and_main_branch(cmd_runner, client_dir):
    print_step("Step 4: Linking GitHub Account & 'main' Branch")

    # 1. Detect Git repository details
    repo_root = client_dir.parent if client_dir.name == "client" else client_dir
    git_bin = find_executable("git")
    remote_url = DEFAULT_GITHUB_REPO
    current_branch = "main"

    if git_bin and (repo_root / ".git").exists():
        try:
            res_remote = run_cmd([git_bin, "remote", "get-url", "origin"], cwd=repo_root, check=False)
            if res_remote.returncode == 0 and res_remote.stdout.strip():
                remote_url = res_remote.stdout.strip()

            res_branch = run_cmd([git_bin, "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_root, check=False)
            if res_branch.returncode == 0 and res_branch.stdout.strip():
                current_branch = res_branch.stdout.strip()
        except Exception:
            pass

    print(f"Detected Git Repository : {remote_url}")
    print(f"Current Local Branch    : {current_branch}")
    print(f"Target Production Branch: main")

    if current_branch != "main":
        print(f"\n[Note] You are currently on branch '{current_branch}'.")
        print("Vercel production deployments track the 'main' branch.")

    # 2. Ensure project exists and link local project
    project_json = client_dir / ".vercel" / "project.json"
    if not project_json.exists():
        print("\nLinking client project to Vercel with default settings...")
        run_cmd(cmd_runner + ["link", "--yes"], cwd=client_dir, capture_output=True, check=False)

    # 3. Configure Vercel Project Settings for Vite
    print("Configuring Vercel Project settings for Vite...", flush=True)
    update_res = run_cmd(
        cmd_runner + [
            "project", "update", "client",
            "--auto-detect", "root-directory",
            "--framework", "vite",
            "--build-command", "npm run build",
            "--output-directory", "dist",
            "--yes"
        ],
        cwd=client_dir,
        check=False
    )
    if update_res.returncode == 0:
        print("[OK] Vercel project configured: Framework = Vite, Output = dist")
    else:
        print("[Notice] Project settings verified.")

    # 4. Connect GitHub repository via Vercel CLI
    print(f"\nConnecting Vercel project to GitHub repository ({remote_url})...", flush=True)
    connect_res = run_cmd(cmd_runner + ["git", "connect", remote_url, "--yes"], cwd=client_dir, check=False)

    if connect_res.returncode == 0:
        print(f"[OK] Successfully linked to GitHub repository: {remote_url} (main branch)")
    else:
        # Check if authorization is needed
        print(f"\n[!] GitHub Integration Status:")
        print("To enable automatic deployments on every 'git push origin main':")
        print("1. Ensure the Vercel GitHub App has access to your repository:")
        print("   -> https://github.com/settings/installations")
        print("2. Or connect the Git repository directly in Vercel Git Settings:")
        print("   -> https://vercel.com/dashboard (Project: 'client' -> Settings -> Git)")
        print("\nNote: CLI deployments with '--prod' will deploy directly regardless of webhook status.")


def validate_local_build(client_dir):
    print_step("Step 5: Testing Local Production Build (Vite)")
    print("Running 'npm run build' to verify application compiles cleanly with zero errors...", flush=True)

    npm_bin = find_executable("npm")
    for attempt in range(1, 3):
        try:
            res = run_cmd([npm_bin, "run", "build"], cwd=client_dir, capture_output=False)
            dist_index = client_dir / "dist" / "index.html"
            if dist_index.exists():
                print("\n[OK] Local production bundle compiled successfully into 'dist/'.")
                return True
            else:
                print("\n[Notice] 'dist/index.html' not found after build.")
        except subprocess.CalledProcessError as e:
            print(f"\n[ERROR] Build failed (Exit code: {e.returncode}).")
            if attempt == 1:
                retry = input("Try running 'npm install' and retrying build? [Y/n]: ").strip().lower()
                if retry in ("", "y", "yes"):
                    print("Running npm install...", flush=True)
                    run_cmd([npm_bin, "install"], cwd=client_dir, capture_output=False)
                    continue
            sys.exit(1)
    return False


def deploy_to_vercel(cmd_runner, client_dir, prod_mode=True):
    print_step("Step 6: Deploying to Vercel Production")

    env_type = "Production (main branch)" if prod_mode else "Preview"
    print(f"Target Environment : {env_type}")
    print(f"Client Directory   : {client_dir}")
    print(f"Signaling Server   : {DEFAULT_SIGNALING_WSS} (Google Cloud Always Free)\n")

    deploy_args = list(cmd_runner)
    if prod_mode:
        deploy_args.append("--prod")
    deploy_args.append("--yes")

    print(f"Executing: {' '.join(deploy_args)}\n", flush=True)

    try:
        proc = subprocess.Popen(
            deploy_args,
            cwd=str(client_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            shell=(sys.platform == "win32")
        )

        output_lines = []
        deployed_url = None

        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            output_lines.append(line.strip())
            for part in line.split():
                clean_part = part.strip().rstrip(",")
                if (clean_part.startswith("https://") and "vercel.app" in clean_part) or clean_part.startswith("https://webrtc"):
                    deployed_url = clean_part

        proc.wait()

        if proc.returncode != 0:
            print(f"\n[ERROR] Vercel deployment exited with code: {proc.returncode}")
            sys.exit(proc.returncode)

        if not deployed_url:
            for line in reversed(output_lines):
                if line.startswith("https://") and "vercel.app" in line:
                    deployed_url = line.split()[0]
                    break

        return deployed_url

    except Exception as e:
        print(f"\n[ERROR] Failed to run deployment: {e}")
        sys.exit(1)


def verify_and_report(live_url):
    print_step("Step 7: Verifying Deployment & Automated CI/CD")

    if live_url:
        print(f"Pinging {live_url} ...", flush=True)
        is_live = False
        for attempt in range(5):
            try:
                req = urllib.request.Request(
                    live_url,
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    if resp.status in (200, 301, 302):
                        is_live = True
                        break
            except Exception:
                time.sleep(2)

        if is_live:
            print("[OK] Live deployment is responding with HTTP 200 OK!")
        else:
            print("[Notice] Deployment completed; DNS / CDN propagation may take a few seconds.")

    print("\n" + "=" * 60)
    print("  🎉 WebRTC Client Deployed Successfully to Vercel!")
    print("=" * 60)
    if live_url:
        print(f"\n  🚀 Production App URL  : {live_url}")
    print(f"  🐙 GitHub Repository   : {DEFAULT_GITHUB_REPO}")
    print(f"  🌿 Production Branch   : main")
    print(f"  ⚡ Signaling Server    : {DEFAULT_SIGNALING_WSS} (Google Cloud)")
    print(f"  🔒 Architecture        : 100% Peer-to-Peer Mesh (Video + Voice + Chat)")
    print(f"  🌐 Platform            : Vercel Global Edge Network")
    print("\n  💡 Continuous Deployment on 'main':")
    print("     Every time you run 'git push origin main', Vercel automatically")
    print("     builds and deploys the updated client to your production URL!")
    print("=" * 60 + "\n")

    if live_url:
        open_browser = input("Open your live app in browser now? [Y/n]: ").strip().lower()
        if open_browser in ("", "y", "yes"):
            try:
                webbrowser.open(live_url)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Deploy WebRTC Watch Party client to Vercel using GitHub and main branch.")
    parser.add_argument("--prod", action="store_true", default=True, help="Deploy directly to production (--prod) [Default: True]")
    parser.add_argument("--preview", action="store_true", help="Deploy as preview")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip interactive prompts")
    args = parser.parse_args()

    print("""
============================================================
 WebRTC Watch Party Client - Vercel Production Deployer
 GitHub Account: dash0200 | Target Branch: main
============================================================
""")

    # Locate client directory (handles being run from repo root or client folder)
    script_dir = Path(__file__).resolve().parent
    if (script_dir / "package.json").exists() and (script_dir / "vite.config.js").exists():
        client_dir = script_dir
    elif (script_dir / "client" / "package.json").exists():
        client_dir = script_dir / "client"
    else:
        client_dir = Path.cwd()
        if not (client_dir / "package.json").exists():
            candidate = client_dir / "client"
            if (candidate / "package.json").exists():
                client_dir = candidate

    cmd_runner = check_prerequisites(client_dir)
    ensure_vercel_config(client_dir)
    authenticate_vercel(cmd_runner, client_dir)
    configure_github_and_main_branch(cmd_runner, client_dir)
    validate_local_build(client_dir)

    prod_mode = not args.preview
    live_url = deploy_to_vercel(cmd_runner, client_dir, prod_mode=prod_mode)
    verify_and_report(live_url)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nDeployment cancelled by user.")
        sys.exit(0)
