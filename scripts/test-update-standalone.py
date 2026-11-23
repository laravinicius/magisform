#!/usr/bin/env python3
"""Exercita a troca de imagem em um Compose descartável, com dados sintéticos."""

import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('update_standalone', ROOT / 'deploy/ops/update-standalone.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def checked(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    source_image = os.environ.get('MAGISFORM_QA_IMAGE', 'magisform:ci')
    suffix = secrets.token_hex(5)
    project = f'magisform-update-qa-{suffix}'
    next_image = f'magisform:update-qa-{suffix}'
    checked('docker', 'image', 'inspect', source_image, stdout=subprocess.DEVNULL)
    checked('docker', 'tag', source_image, next_image)
    try:
        with tempfile.TemporaryDirectory(prefix=project + '-') as temp:
            directory = Path(temp)
            for name in ('db_password', 'db_root_password'):
                secret = directory / (name + '.txt')
                secret.write_text(secrets.token_hex(24), encoding='utf8')
                secret.chmod(0o644)  # Segredos exclusivamente sintéticos em diretório privado.
            compose = f'''name: {project}
services:
  db:
    image: mariadb:11.4
    environment:
      MARIADB_DATABASE: magisform
      MARIADB_USER: magisform_app
      MARIADB_PASSWORD_FILE: /run/secrets/db_password
      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password
    secrets: [db_password, db_root_password]
    networks: [data]
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 2s
      timeout: 3s
      retries: 45
  app:
    image: {source_image}
    pull_policy: never
    environment:
      NODE_ENV: production
      MAGISFORM_SERVER_HOST: 0.0.0.0
      MAGISFORM_SERVER_PORT: 3001
      MAGISFORM_SERVER_ORIGIN: https://qa.magisform.test
      MAGISFORM_SERVER_TRUST_PROXY: 172.16.0.0/12
      MAGISFORM_SERVER_DB_HOST: db
      MAGISFORM_SERVER_DB_PORT: 3306
      MAGISFORM_SERVER_DB_NAME: magisform
      MAGISFORM_SERVER_DB_USER: magisform_app
      MAGISFORM_SERVER_DB_PASSWORD_FILE: /run/secrets/db_password
      MAGISFORM_DB_HOST: db
      MAGISFORM_DB_PORT: 3306
      MAGISFORM_DB_NAME: magisform
      MAGISFORM_DB_USER: magisform_app
      MAGISFORM_DB_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    networks: [data, proxy]
  ingress:
    image: nginx:alpine
    networks: [proxy]
secrets:
  db_password:
    file: ./db_password.txt
  db_root_password:
    file: ./db_root_password.txt
networks:
  data:
    internal: true
  proxy: {{}}
'''
            (directory / 'compose.yaml').write_text(compose, encoding='utf8')
            hook = directory / 'qa-backup'
            backup_module = ROOT / 'deploy/ops/backup-demo.py'
            hook.write_text(
                f'#!{sys.executable}\nimport importlib.util\nfrom pathlib import Path\n'
                f's=importlib.util.spec_from_file_location("qa_backup", {str(backup_module)!r})\n'
                f'm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\n'
                f'm.backup(Path.cwd(), expected_project={project!r})\n', encoding='utf8')
            hook.chmod(0o700)
            updater = module.Updater(directory, hook)
            image_file = directory / 'imagem.tar'
            try:
                updater.compose('up', '-d', 'db', 'ingress')
                db = updater.service_container('db')
                updater.wait_healthy(db)
                updater.compose('run', '--rm', '--no-deps', '-T', 'app', 'node', 'scripts/database-schema.mjs', 'bootstrap')
                updater.compose('up', '-d', '--no-deps', 'app')
                updater.wait_healthy(updater.service_container('app'))
                checked('docker', 'save', '-o', str(image_file), next_image)
                manifest = {'image': next_image, 'commit': 'a' * 40}
                updater.update('v0.0.2', manifest, image_file)
                container = updater.service_container('app')
                assert updater.inspect(container)['Config']['Image'] == next_image
                assert json.loads(updater.state.read_text())['tag'] == 'v0.0.2'
                backups = list((directory / '.auto-update' / 'backups').glob('backup-demo-*.sql.gz'))
                assert len(backups) == 1 and backups[0].stat().st_size > 0
                print('Atualização completa validada no Compose descartável.', flush=True)
            finally:
                # Somente recursos criados acima, com nome exclusivo e dados sintéticos.
                updater.compose('down', '--volumes', '--remove-orphans')
    finally:
        subprocess.run(['docker', 'image', 'rm', next_image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Teste de atualização falhou: {error}', file=sys.stderr)
        sys.exit(1)
