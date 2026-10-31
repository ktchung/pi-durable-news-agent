#!/usr/bin/env python3
"""Prepare only this stack's local directories and a new private env file."""
import argparse
import os
from pathlib import Path
import secrets
import stat


def prepare(root):
    root = Path(root).resolve()
    for name in ("auth", "data", "logs", "logs/api", "logs/hub", "logs/ticker", "gluetun"):
        path = root / name
        if path.is_symlink():
            raise ValueError("Refusing a symlinked state/log directory")
        path.mkdir(mode=0o700, exist_ok=True)
        if not path.is_dir() or path.stat().st_uid != os.getuid():
            raise ValueError("State/log directories must belong to the deployment user")
        if name == "auth" and path.stat().st_mode & 0o077:
            raise ValueError("Existing auth directory must be private (chmod 700)")
    env = root / ".env"
    if env.is_symlink():
        raise ValueError("Refusing a symlinked env file")
    if env.exists():
        if not stat.S_ISREG(env.stat().st_mode) or env.stat().st_mode & 0o077:
            raise ValueError("Existing .env must be a private regular file (chmod 600)")
        print("Existing .env preserved; no credentials or settings were replaced.")
        return
    template = (root / ".env.example").read_text()
    for old, new in (("PUID=1000", f"PUID={os.getuid()}"),
                     ("PGID=1000", f"PGID={os.getgid()}"),
                     ("DNA_CLIENT_TOKEN=", "DNA_CLIENT_TOKEN=" + secrets.token_urlsafe(32)),
                     ("DNA_CRON_TOKEN=", "DNA_CRON_TOKEN=" + secrets.token_urlsafe(32))):
        if template.count(old + "\n") != 1:
            raise ValueError("Unexpected env template")
        template = template.replace(old + "\n", new + "\n", 1)
    fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(template)
    print("Created private .env with distinct local API tokens and current UID/GID.")
    print("VPN and provider credentials remain blank. Fill them locally before deployment.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        prepare(args.directory)
    except (OSError, ValueError) as error:
        # Only fixed categories; never print credentials or private path exceptions.
        print(f"Preparation failed ({type(error).__name__}); check directory ownership and template.")
        raise SystemExit(1)
