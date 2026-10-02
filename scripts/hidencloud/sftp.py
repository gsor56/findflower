"""Pinned-host SFTP deployment. Never uploads .env, Git, dependencies or state."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.hidencloud-local'
sys.path.insert(0, str(LOCAL / 'python'))
import paramiko

HOST, PORT = 'pat.hidencloud.com', 2022
USER = 'uyhrjkcdmj-177471.9753ee4c'
STATE = '.hidencloud'


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or not name:
        raise RuntimeError('Unsafe remote relative path')
    return name


def read(sftp, name):
    try:
        info = sftp.lstat(name)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError(f'Refusing non-regular remote file: {name}')
        with sftp.open(name, 'rb') as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def mkdirs(sftp, directory):
    partial = ''
    for part in PurePosixPath(directory).parts:
        partial = f'{partial}/{part}'.lstrip('/')
        try:
            info = sftp.lstat(partial)
            if not stat.S_ISDIR(info.st_mode):
                raise RuntimeError(f'Refusing non-directory path: {partial}')
        except FileNotFoundError:
            sftp.mkdir(partial)


def atomic_write(sftp, name, data):
    mkdirs(sftp, str(PurePosixPath(name).parent))
    temporary = name + '.ff-upload'
    with sftp.open(temporary, 'wb') as handle:
        handle.write(data)
    if digest(read(sftp, temporary)) != digest(data):
        raise RuntimeError(f'Upload checksum mismatch: {name}')
    try:
        sftp.posix_rename(temporary, name)
    except OSError:
        # This HidenCloud SFTP service does not overwrite on rename. Retain
        # the original while installing the new name, and restore on failure.
        original = name + '.ff-previous'
        if read(sftp, original) is not None:
            raise RuntimeError(f'Previous replacement needs recovery: {name}')
        existed = read(sftp, name) is not None
        if existed:
            sftp.rename(name, original)
        try:
            sftp.rename(temporary, name)
        except Exception:
            if existed:
                sftp.rename(original, name)
            raise
        if existed:
            sftp.remove(original)


def password():
    value = os.environ.get('SFTP_PASSWORD')
    if not value:
        envfile = ROOT / '.env'
        if envfile.exists():
            for line in envfile.read_text(encoding='utf-8-sig').splitlines():
                if line.strip().startswith('SFTP_PASSWORD='):
                    value = line.split('=', 1)[1].strip().strip('\"\'')
    if not value and sys.stdin.isatty():
        from getpass import getpass
        value = getpass('SFTP password: ')
    if not value:
        raise RuntimeError('Set SFTP_PASSWORD in the process environment or GitHub Actions secrets, or use an interactive terminal')
    return value


def connect(args):
    transport = paramiko.Transport((HOST, PORT))
    transport.banner_timeout = 20
    transport.start_client(timeout=20)
    key = transport.get_remote_server_key()
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
    pinned = os.environ.get('SFTP_HOST_KEY', '').strip()
    keyfile = LOCAL / 'host-key.txt'
    if not pinned and keyfile.exists():
        pinned = keyfile.read_text().strip()
    if args.command == 'host-key':
        print(f'{HOST}:{PORT} {key.get_name()} {fingerprint}')
        if args.accept_new_host_key:
            if pinned and pinned != fingerprint:
                raise RuntimeError('Host key changed; verify with HidenCloud before updating the pin')
            LOCAL.mkdir(exist_ok=True)
            keyfile.write_text(fingerprint + '\n')
            print('Saved first-connection host key locally. Set repository variable SFTP_HOST_KEY to this fingerprint.')
        transport.close()
        return None, None
    if not pinned or pinned != fingerprint:
        transport.close()
        raise RuntimeError('Missing/mismatched SFTP_HOST_KEY. Verify the host key before deploying')
    transport.auth_password(USER, password())
    sftp = paramiko.SFTPClient.from_transport(transport)
    sftp.get_channel().settimeout(60)
    sftp.chdir(args.remote_root)
    return transport, sftp


def upload(sftp, args):
    bundle = Path(args.bundle)
    desired = json.loads((bundle / 'deployment.json').read_text())
    if args.command == 'narrow':
        # An explicit allowlist, so a narrow push can never widen into the
        # files whose live copies differ from this checkout.
        wanted_names = {safe_path(name) for name in (args.only or '').split(',') if name}
        if not wanted_names:
            raise RuntimeError('narrow requires --only with at least one destination')
        desired['files'] = [entry for entry in desired['files'] if entry['destination'] in wanted_names]
        found = {entry['destination'] for entry in desired['files']}
        if found != wanted_names:
            raise RuntimeError('Not in the manifest: ' + ', '.join(sorted(wanted_names - found)))
    if args.command == 'showcase':
        desired['files'] = [entry for entry in desired['files'] if entry['destination'] in {
            'how.html', 'scripts/showcase-videos.js', 'manifest.json', 'sw.js',
        } or entry['destination'].startswith('assets/') and entry['destination'].endswith(('.mp4', '.webp'))]
        if sum(e['destination'].endswith('.mp4') for e in desired['files']) != 5:
            raise RuntimeError('Expected exactly five showcase clips')
    for entry in desired['files']:
        safe_path(entry['destination'])
        data = (bundle / entry['destination']).read_bytes()
        if digest(data) != entry['sha256']:
            raise RuntimeError(f'Bundle checksum mismatch: {entry["destination"]}')
    mkdirs(sftp, STATE)
    lock = f'{STATE}/lock'
    try:
        sftp.mkdir(lock)
    except OSError as error:
        raise RuntimeError('Deploy/sync lock exists. Inspect the previous operation before retrying') from error
    try:
        if read(sftp, f'{STATE}/incomplete.json') is not None:
            raise RuntimeError('An interrupted upload needs recovery; inspect .hidencloud/incomplete.json')
        old_bytes = read(sftp, f'{STATE}/deployment.json')
        baseline = json.loads(old_bytes) if old_bytes else None
        if args.command == 'deploy' and not baseline:
            if not args.baseline:
                raise RuntimeError('First full deployment requires --baseline from the known deployed Git revision')
            baseline = json.loads(Path(args.baseline).read_text())
        if baseline and args.command == 'deploy':
            # Refuse an older queued workflow after a reverse-sync push.
            import subprocess
            required = baseline.get('serverSyncRevision') or baseline['revision']
            subprocess.run(['git', 'merge-base', '--is-ancestor', required, desired['revision']], cwd=ROOT, check=True, capture_output=True)
        old = {e['destination']: e for e in (baseline or {}).get('files', [])}
        wanted = {e['destination']: e for e in desired['files']}
        names = sorted(set(wanted) | (set(old) if args.command == 'deploy' else set()))
        current = {name: read(sftp, safe_path(name)) for name in names}
        conflicts = []
        changes = []
        for name in names:
            actual = digest(current[name])
            target = wanted.get(name, {}).get('sha256')
            previous = old.get(name, {}).get('sha256')
            if actual == target:
                continue
            if args.command == 'deploy' and actual != previous:
                conflicts.append(name)
            changes.append(name)
        if conflicts:
            raise RuntimeError('Server edits need reverse sync/review before deploy: ' + ', '.join(conflicts))
        print(f'{len(changes)} files to change; root={sftp.getcwd()}; revision={desired["revision"]}')
        if args.dry_run:
            for name in changes:
                print(name)
            return
        stamp = str(time.time_ns())
        backup = f'{STATE}/backups/{stamp}'
        # Record both missing files and copies, so partial uploads are recoverable.
        journal = {'backup': backup, 'files': {name: digest(current[name]) for name in changes}}
        for name in changes:
            if current[name] is not None:
                atomic_write(sftp, f'{backup}/{name}', current[name])
        if old_bytes:
            atomic_write(sftp, f'{backup}/deployment.json', old_bytes)
        atomic_write(sftp, f'{STATE}/incomplete.json', json.dumps(journal).encode())
        for name in changes:
            # Recheck just before replacement: an editor does not take our lock.
            if digest(read(sftp, name)) != digest(current[name]):
                raise RuntimeError(f'File changed during upload: {name}. Backup/journal retained')
            if name in wanted:
                atomic_write(sftp, name, (bundle / name).read_bytes())
            else:
                sftp.remove(name)
        receipt = 'showcase.json' if args.command == 'showcase' else 'deployment.json'
        atomic_write(sftp, f'{STATE}/{receipt}', json.dumps(desired, indent=2).encode())
        sftp.remove(f'{STATE}/incomplete.json')
        print(f'Uploaded and SHA-256 verified {len(changes)} files. Backup: {backup}')
        if args.command == 'deploy':
            print('Backend code is on disk. Run npm ci --omit=dev and restart via the panel startup command before deploying the Worker.')
    finally:
        sftp.rmdir(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['host-key', 'inspect', 'showcase', 'narrow', 'deploy'])
    parser.add_argument('--only', help='narrow: comma-separated remote destinations to push')
    parser.add_argument('--remote-root', default=os.environ.get('SFTP_REMOTE_ROOT', '.'))
    parser.add_argument('--accept-new-host-key', action='store_true')
    parser.add_argument('--bundle', default=str(LOCAL / 'bundle'))
    parser.add_argument('--baseline')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    transport, sftp = connect(args)
    if sftp is None:
        return
    try:
        if args.command == 'inspect':
            print('SFTP root:', sftp.getcwd())
            for item in sftp.listdir_attr('.'):
                print(('dir ' if stat.S_ISDIR(item.st_mode) else 'file'), item.filename, item.st_size)
            package = read(sftp, 'package.json')
            if package:
                parsed = json.loads(package)
                print('Package:', json.dumps({k: parsed.get(k) for k in ['name', 'type', 'main', 'scripts']}))
            try:
                channel = transport.open_session(timeout=10)
                channel.exec_command('git --version')
                channel.settimeout(10)
                print('Git command:', channel.recv(1024).decode(errors='replace').strip())
                channel.close()
            except Exception:
                print('SSH command execution unavailable: use the HidenCloud console to check Git and schedule sync.')
        else:
            upload(sftp, args)
    finally:
        sftp.close()
        transport.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never dump a credential-bearing environment or exception traceback.
        print(f'SFTP stopped: {error}', file=sys.stderr)
        sys.exit(1)
