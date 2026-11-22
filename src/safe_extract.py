#!/usr/bin/env python3
"""Validated ZIP extraction used for portable simulator artifacts.

Rejects traversal, symlinks and decompression bombs before writing any file.
"""
import argparse
import pathlib
import re
import stat
import sys
import zipfile

MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_FILES = 50000


def extract_archive(archive, destination):
    root = pathlib.Path(destination).resolve()
    with zipfile.ZipFile(archive) as package:
        infos = package.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError("ZIP contains too many entries")
        total = 0
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = pathlib.PurePosixPath(name).parts
            if (not name or name.startswith("/") or
                    not parts or any(part in ("..", "") for part in parts) or
                    re.match(r"^[a-zA-Z]:", name)):
                raise ValueError("Unsafe ZIP path")
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError("ZIP symlinks are not allowed")
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError("ZIP entry exceeds size limit")
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("ZIP exceeds total size limit")
            target = (root / name).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                raise ValueError("ZIP entry escapes destination")
        root.mkdir(parents=True, exist_ok=True)
        package.extractall(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Safely extract QEMU simulator archive")
    parser.add_argument("archive")
    parser.add_argument("destination")
    args = parser.parse_args()
    try:
        extract_archive(args.archive, args.destination)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print("Simulator extraction failed: {}".format(error), file=sys.stderr)
        sys.exit(1)
