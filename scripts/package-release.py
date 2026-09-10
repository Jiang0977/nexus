#!/usr/bin/env python3
"""Build a Linux x86_64 binary archive and matching corresponding-source archive.
Only tracked project files enter source archives; runtime files never enter binaries.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BINS = ['nexus-server', 'nexus-setup', 'nexus-pty-runtime', 'nexus-native-pty-supervisor',
        'nexus-native-session', 'nexus-window-launch-runtime', 'nexus-session-runtime', 'nexus-codex-home']


def run(*args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def archive_tree(tree, target):
    with tarfile.open(target, 'w:gz') as archive:
        def metadata(info):
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            return info
        archive.add(tree, arcname=tree.name, filter=metadata)


def notices(metadata):
    sections = ['Third-party licenses and notices for Nexus. See LICENSE.md and COPYING.\n']
    packages = []
    for package in metadata['packages']:
        if package['name'] == 'nexus-rust-runtime':
            continue
        packages.append((package['name'], package['version'], package.get('license'), Path(package['manifest_path']).parent))
    lock = json.loads((ROOT / 'frontend/package-lock.json').read_text())
    for path, package in lock['packages'].items():
        if path and not package.get('dev'):
            directory = ROOT / 'frontend' / path
            packages.append((path.removeprefix('node_modules/'), package['version'], package.get('license'), directory))
    # alloc-stdlib omits its license file from the crate archive; its sibling
    # alloc-no-stdlib ships the shared Dropbox BSD-3-Clause notice.
    shared_alloc_license = next(directory for name, _, _, directory in packages if name == 'alloc-no-stdlib')
    for name, version, license_id, directory in sorted(packages):
        sections.append(f'\n=== {name} {version} | {license_id or "see accompanying notice"} ===\n')
        found = False
        for file in sorted(directory.rglob('*')):
            if not file.is_file() or len(file.relative_to(directory).parts) > 3:
                continue
            if not re.search(r'(?i)(^|[-_.])(licen[cs]e|copying|notice)([-_.]|$)', file.name):
                continue
            if file.stat().st_size > 1_000_000:
                continue
            sections.append(f'\n--- {file.relative_to(directory)} ---\n' + file.read_text(errors='replace'))
            found = True
        if not found and name == 'html-parse-stringify':
            sections.append((ROOT / 'docs/licenses/html-parse-stringify-LICENSE').read_text())
            found = True
        if not found and name == 'alloc-stdlib':
            sections.append((shared_alloc_license / 'LICENSE').read_text())
            found = True
        if not found:
            raise SystemExit(f'Missing license text for {name} {version}; review before publishing')
    return '\n'.join(sections)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-dirty', action='store_true', help='local package rehearsal only; never publish this archive')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise SystemExit('This release recipe supports Linux x86_64 only')
    dirty = run('git', 'status', '--porcelain', capture_output=True, text=True).stdout.strip()
    if dirty and not args.allow_dirty:
        raise SystemExit('Commit the reviewed tree before packaging, or use --allow-dirty for a local rehearsal')
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise SystemExit('Expected a numeric release version')
    revision = run('git', 'rev-parse', 'HEAD', capture_output=True, text=True).stdout.strip()
    output = ROOT / 'release'
    output.mkdir(exist_ok=True)
    build_env = dict(os.environ)
    # Do not embed maintainer home/checkout paths in distributed binaries.
    remaps = f'--remap-path-prefix={ROOT}=/usr/src/nexus --remap-path-prefix={Path.home()}=/usr/src/user'
    build_env['RUSTFLAGS'] = f'{build_env.get("RUSTFLAGS", "")} {remaps}'.strip()
    run('cargo', 'build', '--locked', '--manifest-path', 'rust-runtime/Cargo.toml', '--release', '--bins', env=build_env)
    metadata = json.loads(run('cargo', 'metadata', '--offline', '--locked', '--filter-platform', 'x86_64-unknown-linux-gnu', '--manifest-path', 'rust-runtime/Cargo.toml', '--format-version', '1', capture_output=True, text=True).stdout)
    notice_text = notices(metadata)
    with tempfile.TemporaryDirectory(prefix='nexus-package-') as temporary:
        work = Path(temporary)
        binary = work / f'nexus-{version}-linux-x86_64'
        binary.mkdir()
        required = ['setup.sh', 'start.sh', 'nexus-run-claude.sh', 'nexus-run-codex.sh',
                    '.env.example', 'package.json', 'README.md', 'README_CN.md', 'LICENSE.md',
                    'COPYING', 'NOTICE.md', 'SECURITY.md', 'THIRD_PARTY.md', 'CHANGELOG.md']
        for relative in required:
            shutil.copy2(ROOT / relative, binary / relative)
        for relative in ['frontend/dist', 'public', 'docs']:
            shutil.copytree(ROOT / relative, binary / relative)
        (binary / 'scripts/runtime-bin').mkdir(parents=True)
        scripts = ['nexus-paths.sh', 'nexus-systemd.sh', 'restart-nexus-service.sh',
                   'nexus-tmux-service.sh', 'nexus-native-pty-service.sh', 'nexus-codex-resume-picker.py']
        for name in scripts:
            shutil.copy2(ROOT / 'scripts' / name, binary / 'scripts' / name)
        for file in (ROOT / 'scripts/runtime-bin').iterdir():
            if file.is_file():
                shutil.copy2(file, binary / 'scripts/runtime-bin' / file.name)
        target = binary / 'rust-runtime/target/release'
        target.mkdir(parents=True)
        for name in BINS:
            shutil.copy2(ROOT / 'rust-runtime/target/release' / name, target / name)
        (binary / 'VERSION').write_text(f'{version}\nsource {revision}{" (dirty rehearsal)" if dirty else ""}\n')
        (binary / 'THIRD_PARTY_NOTICES.txt').write_text(notice_text)
        # Include the original vendored terminal-engine copyright files verbatim.
        avt = binary / 'rust-runtime/vendor/avt'
        avt.mkdir(parents=True)
        for name in ['LICENSE', 'XTERM-LICENSE']:
            shutil.copy2(ROOT / 'rust-runtime/vendor/avt' / name, avt / name)
        for file in binary.rglob('*'):
            if file.is_file() and (str(ROOT).encode() in file.read_bytes() or str(Path.home()).encode() in file.read_bytes()):
                raise SystemExit(f'Personal build path leaked into {file.relative_to(binary)}')
        binary_archive = output / f'{binary.name}.tar.gz'
        archive_tree(binary, binary_archive)

        source = work / f'nexus-{version}-source'
        source.mkdir()
        tracked = run('git', 'ls-files', '-z', capture_output=True).stdout.decode().split('\0')
        if args.allow_dirty:
            tracked += run('git', 'ls-files', '--others', '--exclude-standard', '-z', capture_output=True).stdout.decode().split('\0')
        for relative in sorted(set(tracked)):
            if not relative or not (ROOT / relative).is_file():
                continue
            if relative == '.env' or relative.startswith(('.context/', 'data/', 'logs/', 'release/')):
                raise SystemExit(f'Refusing private source path: {relative}')
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        vendor = source / 'rust-runtime/vendor-deps'
        config = run('cargo', 'vendor', '--offline', '--locked', '--manifest-path', 'rust-runtime/Cargo.toml', str(vendor), capture_output=True, text=True).stdout
        (source / '.cargo').mkdir(exist_ok=True)
        (source / '.cargo/config.toml').write_text(config.replace(str(vendor), 'rust-runtime/vendor-deps'))
        # Include frontend package sources (including build tooling) so the bundle can
        # be rebuilt from the archive without fetching JS packages from a registry.
        shutil.copytree(ROOT / 'frontend/node_modules', source / 'frontend/node_modules', symlinks=True)
        (source / 'VERSION').write_text((binary / 'VERSION').read_text())
        (source / 'THIRD_PARTY_NOTICES.txt').write_text(notice_text)
        source_archive = output / f'{source.name}.tar.gz'
        archive_tree(source, source_archive)
    checksums = []
    for path in [binary_archive, source_archive]:
        checksums.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}')
    (output / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
    print('\n'.join(str(output / path) for path in [binary_archive.name, source_archive.name, 'SHA256SUMS']))


if __name__ == '__main__':
    main()
