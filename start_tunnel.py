#!/usr/bin/env python3
"""
CodeArena Cloudflare Tunnel & Custom Domain Launcher

Usage:
  # 1. Quick Free Tunnel (trycloudflare.com):
  python3 start_tunnel.py

  # 2. Custom Domain with Cloudflare Zero Trust Tunnel Token:
  python3 start_tunnel.py --token <YOUR_TUNNEL_TOKEN> --domain arena.yourdomain.com

  # 3. Custom Domain with CNAME instructions:
  python3 start_tunnel.py --domain arena.yourdomain.com
"""

import sys
import os
import time
import re
import json
import argparse
import subprocess
import signal

PORT = 5517
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TUNNEL_JSON_PATH = os.path.join(BASE_DIR, "public", "tunnel_url.json")


def is_server_running():
    try:
        import urllib.request
        req = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=2)
        return req.getcode() == 200
    except Exception:
        return False


def ensure_server():
    if is_server_running():
        print(f"✅ Local server is already running on http://127.0.0.1:{PORT}")
        return None
    print(f"🚀 Starting CodeArena server on port {PORT}...")
    proc = subprocess.Popen([sys.executable, "serve.py"], cwd=BASE_DIR)
    time.sleep(1.8)
    if is_server_running():
        print(f"✅ Local server started successfully (PID: {proc.pid})")
        return proc
    print("❌ Failed to start local server. Please check serve.py logs.")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="CodeArena Cloudflare Tunnel & Domain Launcher")
    parser.add_argument("--token", default=os.environ.get("CLOUDFLARE_TUNNEL_TOKEN"),
                        help="Cloudflare Zero Trust Tunnel Token for your custom domain")
    parser.add_argument("--domain", default=os.environ.get("CONTEST_DOMAIN"),
                        help="Your custom domain name (e.g. arena.yourdomain.com)")
    parser.add_argument("--tunnel", default=None,
                        help="Named Cloudflare tunnel name (e.g. codearena)")
    args = parser.parse_args()

    print("=" * 68)
    print("⚡ CODE//ARENA — DOMAIN & CLOUDFLARE TUNNEL LAUNCHER")
    print("=" * 68)

    server_proc = ensure_server()

    # Mode 1: Cloudflare Tunnel Token (Best for Custom Domains in Cloudflare Dashboard)
    if args.token:
        print(f"\n🌐 Connecting via Cloudflare Zero Trust Tunnel Token...")
        cmd = ["cloudflared", "tunnel", "run", "--token", args.token]
        cloudflared_proc = subprocess.Popen(cmd)

        domain_url = f"https://{args.domain}" if args.domain else "https://your-custom-domain"
        print("\n" + "=" * 68)
        print(f"🎉 CLOUDFLARE CUSTOM DOMAIN TUNNEL IS ACTIVE!")
        print(f"🔗 Student Arena:   {domain_url}")
        print(f"🛡️  Admin Dashboard: {domain_url}/admin.html")
        print("=" * 68)

        def handle_exit(_sig, _frame):
            print("\nStopping Cloudflare Tunnel...")
            cloudflared_proc.terminate()
            if server_proc:
                server_proc.terminate()
            sys.exit(0)

        signal.signal(signal.SIGINT, handle_exit)
        signal.signal(signal.SIGTERM, handle_exit)
        cloudflared_proc.wait()
        return

    # Mode 2: Named Tunnel
    if args.tunnel:
        print(f"\n🌐 Connecting via Named Cloudflare Tunnel '{args.tunnel}'...")
        cmd = ["cloudflared", "tunnel", "run", "--url", f"http://localhost:{PORT}", args.tunnel]
        cloudflared_proc = subprocess.Popen(cmd)

        domain_url = f"https://{args.domain}" if args.domain else "https://your-custom-domain"
        print("\n" + "=" * 68)
        print(f"🎉 NAMED TUNNEL ACTIVE!")
        print(f"🔗 Student Arena:   {domain_url}")
        print(f"🛡️  Admin Dashboard: {domain_url}/admin.html")
        print("=" * 68)

        def handle_exit(_sig, _frame):
            print("\nStopping Cloudflare Tunnel...")
            cloudflared_proc.terminate()
            if server_proc:
                server_proc.terminate()
            sys.exit(0)

        signal.signal(signal.SIGINT, handle_exit)
        signal.signal(signal.SIGTERM, handle_exit)
        cloudflared_proc.wait()
        return

    # Mode 3: Quick Tunnel with trycloudflare.com
    print("\n🌐 Establishing Cloudflare Tunnel...")
    cloudflared_proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    tunnel_url = None
    url_pattern = re.compile(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com")

    for line in cloudflared_proc.stdout:
        match = url_pattern.search(line)
        if match:
            tunnel_url = match.group(0)
            break

    if not tunnel_url:
        print("❌ Could not obtain Cloudflare Tunnel URL.")
        cloudflared_proc.kill()
        sys.exit(1)

    try:
        with open(TUNNEL_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump({"tunnelUrl": tunnel_url, "customDomain": args.domain}, f, indent=2)
        print(f"💾 Saved tunnel URL to public/tunnel_url.json")
    except Exception as e:
        print(f"⚠️ Could not save tunnel URL: {e}")

    print("\n" + "=" * 68)
    print(f"🎉 CLOUDFLARE TUNNEL IS LIVE!")
    print(f"🔗 Public Arena:    {tunnel_url}")
    print(f"🛡️  Admin Dashboard: {tunnel_url}/admin.html")

    if args.domain:
        print("\n" + "-" * 68)
        print(f"📌 TO ROUTE YOUR CUSTOM DOMAIN '{args.domain}':")
        cname_host = tunnel_url.replace("https://", "")
        print(f"1. In your domain DNS manager, add a CNAME record:")
        print(f"   Type:  CNAME")
        print(f"   Name:  {args.domain.split('.')[0] if '.' in args.domain else '@'}")
        print(f"   Value: {cname_host}")
        print(f"   Proxy: Enabled (Cloudflare Orange Cloud)")
        print(f"2. Your students can then open: https://{args.domain}")
        print("-" * 68)
    else:
        print("-" * 68)
        print("💡 Want to use your own domain?")
        print("   Run: python3 start_tunnel.py --domain arena.yourdomain.com")
        print("-" * 68)

    print("=" * 68)
    print("\nPress Ctrl+C to stop the tunnel.\n")

    def handle_exit(_sig, _frame):
        print("\nStopping Cloudflare Tunnel...")
        cloudflared_proc.terminate()
        if server_proc:
            server_proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

    try:
        cloudflared_proc.wait()
    except KeyboardInterrupt:
        handle_exit(None, None)


if __name__ == "__main__":
    main()
