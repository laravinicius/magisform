#!/usr/bin/env python3
"""Cópia local e restauração de teste para a demonstração MagisForm."""

import gzip
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone


def docker(*args, capture=True):
    result = subprocess.run(['docker', *args], stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, check=False)
    if result.returncode:
        raise RuntimeError('Comando Docker de backup ou restauração falhou.')
    return result.stdout.decode('utf8').strip() if capture else ''


def database_shell(command):
    # A credencial permanece no container e fora dos argumentos do processo MariaDB.
    return ('umask 077; f=$(mktemp /tmp/magisform-demo-backup.XXXXXX); '
            'trap \'rm -f "$f"\' EXIT; '
            'printf "[client]\\nuser=root\\npassword=%s\\n" "$(cat /run/secrets/db_root_password)" > "$f"; '
            + command)


def database_version(container):
    sql = 'SELECT version FROM schema_version WHERE singleton=1'
    shell = database_shell(f'mariadb --defaults-extra-file="$f" --batch --skip-column-names magisform -e "{sql}"')
    value = docker('exec', container, 'sh', '-ec', shell)
    if not value.isdigit():
        raise RuntimeError('Não foi possível verificar a versão do banco da demonstração.')
    return value


def stream_dump(container, destination):
    command = ('mariadb-dump --defaults-extra-file="$f" --single-transaction --quick '
               '--routines --events --triggers --hex-blob magisform')
    proc = subprocess.Popen(['docker', 'exec', container, 'sh', '-ec', database_shell(command)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with open(destination, 'xb') as raw:
            os.fchmod(raw.fileno(), 0o600)
            with gzip.GzipFile(fileobj=raw, mode='wb') as compressed:
                shutil.copyfileobj(proc.stdout, compressed, length=1024 * 1024)
            raw.flush()
            os.fsync(raw.fileno())
        if proc.wait() != 0:
            raise RuntimeError('Não foi possível gerar o backup do banco de teste.')
    finally:
        if proc.stdout:
            proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def restore_dump(container, source):
    shell = ('export MYSQL_PWD="$(cat /run/secrets/qa_root_password)"; '
             'exec mariadb --user=root magisform')
    proc = subprocess.Popen(['docker', 'exec', '-i', container, 'sh', '-ec', shell],
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with gzip.open(source, 'rb') as compressed:
            shutil.copyfileobj(compressed, proc.stdin, length=1024 * 1024)
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError('Não foi possível restaurar o backup em QA.')
    finally:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def backup(directory, expected_project='magisform-demo'):
    root = Path(directory).resolve(strict=True)
    compose = ['compose', '--project-directory', str(root), '-f', str(root / 'compose.yaml')]
    config = json.loads(docker(*compose, 'config', '--format', 'json'))
    if config.get('name') != expected_project or not expected_project.startswith('magisform-'):
        raise RuntimeError('Este backup local é exclusivo do projeto de teste configurado.')
    db = docker(*compose, 'ps', '-q', 'db')
    if not db or '\n' in db:
        raise RuntimeError('Não foi encontrado exatamente um MariaDB em execução.')
    labels = json.loads(docker('inspect', db))[0]['Config'].get('Labels', {})
    if labels.get('com.docker.compose.project') != expected_project or labels.get('com.docker.compose.service') != 'db':
        raise RuntimeError('O MariaDB não corresponde ao projeto de teste.')
    schema_version = database_version(db)
    destination = root / '.auto-update' / 'backups'
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = f'backup-demo-{stamp}-{secrets.token_hex(4)}.sql.gz'
    final = destination / name
    qa_name = f'magisform-demo-restore-{secrets.token_hex(8)}'
    with tempfile.TemporaryDirectory(prefix='restore-qa-', dir=destination) as temp:
        work = Path(temp)
        dump = work / 'backup.sql.gz'
        stream_dump(db, dump)
        qa_password = work / 'qa-root.txt'
        qa_password.write_text(secrets.token_hex(24), encoding='utf8')
        qa_password.chmod(0o644)  # Senha descartável; o diretório pai é privado.
        created = False
        try:
            docker('run', '--detach', '--rm', '--network', 'none', '--name', qa_name,
                   '--mount', f'type=bind,source={qa_password},target=/run/secrets/qa_root_password,readonly',
                   '--env', 'MARIADB_ROOT_PASSWORD_FILE=/run/secrets/qa_root_password',
                   '--env', 'MARIADB_DATABASE=magisform', 'mariadb:11.4')
            created = True
            for _ in range(90):
                ready = subprocess.run(['docker', 'exec', qa_name, 'healthcheck.sh', '--connect', '--innodb_initialized'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('MariaDB descartável de restauração não ficou pronto.')
            restore_dump(qa_name, dump)
            query = ('export MYSQL_PWD="$(cat /run/secrets/qa_root_password)"; '
                     'exec mariadb --user=root --batch --skip-column-names magisform '
                     '-e "SELECT version FROM schema_version WHERE singleton=1"')
            restored = docker('exec', qa_name, 'sh', '-ec', query)
            if restored != schema_version:
                raise RuntimeError('A versão do schema restaurado não corresponde ao banco de teste.')
            os.replace(dump, final)
        finally:
            if created:
                subprocess.run(['docker', 'rm', '--force', '--volumes', qa_name],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    print(f'Backup local de teste restaurado em QA: {final}', flush=True)
    return final


if __name__ == '__main__':
    try:
        backup(Path.cwd())
    except Exception as error:
        print(f'Backup de teste interrompido: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
