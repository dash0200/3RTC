#!/usr/bin/env python3
"""
Convenience launcher to deploy WebRTC Watch Party client to Vercel.
Can be executed directly from the repository root:
    python deploy_client.py
"""

import sys
import subprocess
from pathlib import Path

def main():
    root_dir = Path(__file__).resolve().parent
    script_path = root_dir / "client" / "deploy_vercel.py"
    if not script_path.exists():
        print(f"[ERROR] Could not find {script_path}")
        sys.exit(1)
    
    cmd = [sys.executable, str(script_path)] + sys.argv[1:]
    sys.exit(subprocess.call(cmd))

if __name__ == "__main__":
    main()
