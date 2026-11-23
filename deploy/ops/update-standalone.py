#!/usr/bin/env python3
"""Atualiza uma instalação Compose independente a partir de releases públicas."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = 'laravinicius/magisform'
API = f'https://api.github.com/repos/{REPOSITORY}/releases/latest'
TAG = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
SHA256 = re.compile(r'^[a-f0-9]{64}$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')


def version(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError('Tag de versão final inválida.')
    return tuple(map(int, match.groups()))


def atomic_write(path, content, mode=0o600):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w', encoding='utf8', newline='\n') as output:
        os.fchmod(output.fileno(), mode)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def run(*args, cwd=None, capture=True):
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, check=False)
    if result.returncode:
        raise RuntimeError(f'Falha ao executar {args[0]}: {(result.stderr or "").strip()}')
    return (result.stdout or '').strip()


def request(url, limit):
    req = Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'MagisForm-Updater'})
    with urlopen(req, timeout=30) as response:
        body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Resposta do GitHub excede o tamanho permitido.')
    return body


def release_assets(release):
    tag = release.get('tag_name', '')
    version(tag)
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('A versão ainda não é uma release final.')
    assets = {item['name']: item.get('browser_download_url') for item in release.get('assets', [])}
    prefix = f'https://github.com/{REPOSITORY}/releases/download/{tag}/'
    for name in ('magisform-release.json', 'magisform-image.tar.gz'):
        if assets.get(name) != prefix + name:
            raise ValueError('Os arquivos esperados da release estão ausentes ou têm URL inválida.')
    return tag, assets


def validate_manifest(data, tag):
    expected = {'format': 1, 'tag': tag, 'image': f'magisform:release-{tag}', 'file': 'magisform-image.tar.gz'}
    if any(data.get(key) != value for key, value in expected.items()):
        raise ValueError('Manifesto incompatível com a release.')
    if not SHA256.fullmatch(data.get('sha256', '')) or not COMMIT.fullmatch(data.get('commit', '')):
        raise ValueError('Checksum ou commit inválido no manifesto.')


def download_image(url, destination, expected):
    digest = hashlib.sha256()
    req = Request(url, headers={'User-Agent': 'MagisForm-Updater'})
    with urlopen(req, timeout=60) as response, open(destination, 'xb') as output:
        os.fchmod(output.fileno(), 0o600)
        size = 0
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > 2 * 1024**3:
                raise ValueError('Imagem excede 2 GiB.')
            digest.update(block)
            output.write(block)
    if digest.hexdigest() != expected:
        raise ValueError('Checksum da imagem não corresponde ao manifesto.')


def replace_app_image(compose, old_image, new_image):
    lines = compose.splitlines(keepends=True)
    in_app = False
    found = []
    for index, line in enumerate(lines):
        if re.match(r'^  [a-zA-Z0-9_-]+:\s*(?:#.*)?$', line.rstrip('\r\n')):
            in_app = bool(re.match(r'^  app:\s*(?:#.*)?$', line.rstrip('\r\n')))
        if in_app and re.match(r'^    image:', line):
            found.append(index)
    if len(found) != 1 or lines[found[0]].strip() != f'image: {old_image}':
        raise ValueError('A imagem do serviço app não está no formato esperado; revise o Compose.')
    ending = '\r\n' if lines[found[0]].endswith('\r\n') else '\n'
    lines[found[0]] = f'    image: {new_image}{ending}'
    return ''.join(lines)


class Updater:
    def __init__(self, directory, backup_hook):
        self.directory = Path(directory).resolve(strict=True)
        self.compose_file = self.directory / 'compose.yaml'
        self.state_dir = self.directory / '.auto-update'
        self.state_dir.mkdir(mode=0o700, exist_ok=True)
        self.backup_hook = Path(backup_hook).resolve() if backup_hook else None
        self.journal = self.state_dir / 'previous-compose.yaml'
        self.state = self.state_dir / 'state.json'
        self.failed = self.state_dir / 'failed-tag'

    def compose(self, *args, override=None):
        command = ['docker', 'compose', '--project-directory', str(self.directory), '-f', str(self.compose_file)]
        if override:
            command += ['-f', str(override)]
        return run(*command, *args, cwd=self.directory)

    def inspect(self, container):
        return json.loads(run('docker', 'inspect', container))[0]

    def service_container(self, service):
        container = self.compose('ps', '-q', service)
        if not container or '\n' in container:
            raise RuntimeError(f'O serviço {service} não possui exatamente um container em execução.')
        return container

    def wait_healthy(self, container):
        for _ in range(60):
            info = self.inspect(container)
            status = info['State'].get('Health', {}).get('Status')
            if status == 'healthy':
                return
            if status == 'unhealthy' or not info['State']['Running']:
                break
            time.sleep(2)
        raise RuntimeError('A aplicação não ficou saudável no prazo esperado.')

    def require_backup(self):
        if not self.backup_hook or not self.backup_hook.is_file() or not os.access(self.backup_hook, os.X_OK):
            raise RuntimeError('Configure um backup executável com restauração QA verificada antes da atualização.')

    def check_ready(self, container, image):
        info = self.inspect(container)
        env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
        origin = env.get('MAGISFORM_SERVER_ORIGIN', '')
        if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?', origin):
            raise RuntimeError('Origem HTTPS do aplicativo é inválida.')
        host = origin.removeprefix('https://')
        name = info['Name'].lstrip('/')
        ingress = self.service_container('ingress')
        probe = ("const http=require('node:http');const [name,host]=process.argv.slice(1);"
                 "const req=http.request({hostname:name,port:3001,path:'/api/v1/health/ready',"
                 "headers:{Host:host,'X-Forwarded-Host':host,'X-Forwarded-Proto':'https',"
                 "'X-Forwarded-For':'192.0.2.1'}},res=>{res.resume();"
                 "process.exitCode=res.statusCode===200?0:1});"
                 "req.on('error',()=>{process.exitCode=1});req.setTimeout(5000,()=>req.destroy());req.end()")
        run('docker', 'run', '--rm', '--network', f'container:{ingress}', '--entrypoint', 'node',
            image, '-e', probe, name, host)

    def recover(self):
        if not self.journal.exists():
            return
        print('Recuperando a imagem anterior após uma atualização interrompida.', flush=True)
        original = self.journal.read_text(encoding='utf8')
        atomic_write(self.compose_file, original, self.compose_file.stat().st_mode & 0o777)
        self.compose('up', '-d', '--no-deps', 'app')
        container = self.service_container('app')
        self.wait_healthy(container)
        image = self.inspect(container)['Config']['Image']
        self.check_ready(container, image)
        self.journal.unlink()

    def update(self, tag, manifest, image_path):
        self.require_backup()
        config = json.loads(self.compose('config', '--format', 'json'))
        old_image = config['services']['app']['image']
        current = self.service_container('app')
        if self.inspect(current)['Config']['Image'] != old_image:
            raise RuntimeError('A imagem em execução difere do Compose; atualização recusada.')
        original = self.compose_file.read_text(encoding='utf8')
        updated = replace_app_image(original, old_image, manifest['image'])
        run('docker', 'load', '-i', str(image_path))
        run('docker', 'image', 'inspect', manifest['image'])
        with tempfile.TemporaryDirectory(prefix='candidate-', dir=self.state_dir) as tmp:
            override = Path(tmp) / 'compose.yaml'
            override.write_text(f"services:\n  app:\n    image: {manifest['image']}\n", encoding='utf8')
            self.compose('run', '--rm', '--no-deps', '-T', 'app', 'node', 'scripts/database-schema.mjs', 'preflight', override=override)
            candidate = f'magisform-update-{secrets.token_hex(8)}'
            try:
                self.compose('run', '-d', '--rm', '--no-deps', '--name', candidate, 'app', override=override)
                self.wait_healthy(candidate)
                self.check_ready(candidate, manifest['image'])
            finally:
                subprocess.run(['docker', 'rm', '-f', candidate], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        print('Executando backup e restauração de verificação.', flush=True)
        run(str(self.backup_hook), cwd=self.directory, capture=False)
        atomic_write(self.journal, original)
        try:
            atomic_write(self.compose_file, updated, self.compose_file.stat().st_mode & 0o777)
            self.compose('up', '-d', '--no-deps', 'app')
            container = self.service_container('app')
            if self.inspect(container)['Config']['Image'] != manifest['image']:
                raise RuntimeError('O container iniciado não usa a imagem da release.')
            self.wait_healthy(container)
            self.check_ready(container, manifest['image'])
        except Exception:
            self.recover()
            atomic_write(self.failed, tag + '\n')
            raise
        self.journal.unlink()
        atomic_write(self.state, json.dumps({'tag': tag, 'commit': manifest['commit']}) + '\n')
        if self.failed.exists():
            self.failed.unlink()
        print(f'Atualização {tag} concluída.', flush=True)

    def poll(self):
        self.recover()
        current = json.loads(self.state.read_text(encoding='utf8'))['tag']
        version(current)
        try:
            release = json.loads(request(API, 1024 * 1024))
        except HTTPError as error:
            if error.code == 404:
                return
            raise
        tag, assets = release_assets(release)
        if version(tag) <= version(current) or (self.failed.exists() and self.failed.read_text(encoding='utf8').strip() == tag):
            return
        self.require_backup()
        manifest = json.loads(request(assets['magisform-release.json'], 32 * 1024))
        validate_manifest(manifest, tag)
        with tempfile.TemporaryDirectory(prefix='release-', dir=self.state_dir) as tmp:
            image_path = Path(tmp) / manifest['file']
            download_image(assets[manifest['file']], image_path, manifest['sha256'])
            self.update(tag, manifest, image_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir', required=True, help='Diretório da instalação Compose independente.')
    parser.add_argument('--backup-hook', help='Executável que cria backup e valida restauração em QA.')
    parser.add_argument('--initial-version', help='Registra a versão já instalada, uma única vez, sem atualizar.')
    args = parser.parse_args()
    updater = Updater(args.dir, args.backup_hook)
    with open(updater.state_dir / 'lock', 'a', encoding='utf8') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if args.initial_version:
            version(args.initial_version)
            if updater.state.exists() or updater.journal.exists():
                raise RuntimeError('A versão inicial já foi registrada ou há recuperação pendente.')
            atomic_write(updater.state, json.dumps({'tag': args.initial_version}) + '\n')
            print(f'Versão inicial {args.initial_version} registrada; nenhuma atualização executada.')
            return
        updater.poll()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Atualização interrompida: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
