import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / 'deploy/ops/update-standalone.py'
SPEC = importlib.util.spec_from_file_location('update_standalone', MODULE_PATH)
updater_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater_module)

COMPOSE = 'name: magisform-demo\nservices:\n  app:\n    image: magisform:anterior\n  ingress:\n    image: nginx:alpine\n'
MANIFEST = {'format': 1, 'tag': 'v0.2.9', 'commit': 'a' * 40,
            'image': 'magisform:release-v0.2.9', 'file': 'magisform-image.tar.gz', 'sha256': 'b' * 64}


class ReleaseTests(unittest.TestCase):
    def test_version_order_and_invalid_tags(self):
        self.assertGreater(updater_module.version('v0.2.10'), updater_module.version('v0.2.9'))
        for tag in ['v0.02.9', '0.2.9', 'v0.2.9-rc1', 'v0.2', 'v1.2.3;rm']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                updater_module.version(tag)

    def test_assets_and_manifest_are_bound_to_release(self):
        prefix = 'https://github.com/laravinicius/magisform/releases/download/v0.2.9/'
        assets = [{'name': name, 'browser_download_url': prefix + name}
                  for name in ['magisform-release.json', 'magisform-image.tar.gz']]
        release = {'tag_name': 'v0.2.9', 'assets': assets, 'draft': False, 'prerelease': False}
        self.assertEqual(updater_module.release_assets(release)[0], 'v0.2.9')
        updater_module.validate_manifest(MANIFEST, 'v0.2.9')
        with self.assertRaises(ValueError):
            updater_module.validate_manifest({**MANIFEST, 'image': 'outra'}, 'v0.2.9')
        assets[1]['browser_download_url'] = 'https://exemplo.invalid/imagem'
        with self.assertRaises(ValueError):
            updater_module.release_assets(release)

    def test_only_app_image_is_replaced(self):
        result = updater_module.replace_app_image(COMPOSE, 'magisform:anterior', MANIFEST['image'])
        self.assertIn('image: magisform:release-v0.2.9', result)
        self.assertIn('image: nginx:alpine', result)
        with self.assertRaises(ValueError):
            updater_module.replace_app_image(COMPOSE, 'imagem-diferente', MANIFEST['image'])

    def test_download_rejects_a_different_checksum(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
                updater_module, 'urlopen', side_effect=lambda *args, **kwargs: io.BytesIO(b'imagem de teste')):
            good = Path(tmp) / 'good.tar.gz'
            digest = hashlib.sha256(b'imagem de teste').hexdigest()
            updater_module.download_image('https://exemplo.invalid/imagem', good, digest)
            self.assertEqual(good.read_bytes(), b'imagem de teste')
            with self.assertRaisesRegex(ValueError, 'Checksum'):
                updater_module.download_image('https://exemplo.invalid/imagem', Path(tmp) / 'bad.tar.gz', 'a' * 64)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.compose = self.root / 'compose.yaml'
        self.compose.write_text(COMPOSE, encoding='utf8')
        self.hook = self.root / 'backup'
        self.hook.write_text('#!/bin/sh\nexit 0\n', encoding='utf8')
        os.chmod(self.hook, 0o700)
        self.subject = updater_module.Updater(self.root, self.hook)
        self.subject.service_container = mock.Mock(return_value='app-id')
        self.subject.inspect = mock.Mock(return_value={'Config': {'Image': 'magisform:anterior'}})
        self.subject.wait_healthy = mock.Mock()
        self.subject.check_ready = mock.Mock()
        self.commands = []

        def compose(*args, **kwargs):
            self.commands.append(args)
            if args == ('config', '--format', 'json'):
                return json.dumps({'services': {'app': {'image': 'magisform:anterior'}}})
            return ''

        self.subject.compose = mock.Mock(side_effect=compose)
        def inspect(_container):
            image = MANIFEST['image'] if MANIFEST['image'] in self.compose.read_text(encoding='utf8') else 'magisform:anterior'
            return {'Config': {'Image': image}}
        self.subject.inspect.side_effect = inspect
        self.run_patch = mock.patch.object(updater_module, 'run', return_value='')
        self.run_mock = self.run_patch.start()
        self.addCleanup(self.run_patch.stop)
        self.subprocess_patch = mock.patch.object(updater_module.subprocess, 'run')
        self.subprocess_patch.start()
        self.addCleanup(self.subprocess_patch.stop)

    def test_success_commits_version_after_backup_and_health(self):
        self.subject.update('v0.2.9', MANIFEST, self.root / 'image.tar.gz')
        self.assertIn('image: magisform:release-v0.2.9', self.compose.read_text(encoding='utf8'))
        self.assertEqual(json.loads(self.subject.state.read_text())['tag'], 'v0.2.9')
        self.assertFalse(self.subject.journal.exists())
        self.assertTrue(any(call.args[0] == str(self.hook) for call in self.run_mock.call_args_list))
        self.assertEqual(self.subject.check_ready.call_count, 2)

    def test_backup_failure_does_not_change_compose(self):
        def run(*args, **kwargs):
            if args[0] == str(self.hook):
                raise RuntimeError('backup falhou')
            return ''
        self.run_mock.side_effect = run
        with self.assertRaisesRegex(RuntimeError, 'backup falhou'):
            self.subject.update('v0.2.9', MANIFEST, self.root / 'image.tar.gz')
        self.assertEqual(self.compose.read_text(encoding='utf8'), COMPOSE)
        self.assertFalse(self.subject.journal.exists())

    def test_failed_new_app_restores_previous_image_and_blocks_retry(self):
        self.subject.wait_healthy.side_effect = [None, RuntimeError('app falhou'), None]
        with self.assertRaisesRegex(RuntimeError, 'app falhou'):
            self.subject.update('v0.2.9', MANIFEST, self.root / 'image.tar.gz')
        self.assertEqual(self.compose.read_text(encoding='utf8'), COMPOSE)
        self.assertEqual(self.subject.failed.read_text(encoding='utf8').strip(), 'v0.2.9')
        self.assertFalse(self.subject.journal.exists())
        self.assertFalse(self.subject.state.exists())

    def test_candidate_failure_never_changes_compose(self):
        self.subject.check_ready.side_effect = RuntimeError('schema incompatível')
        with self.assertRaisesRegex(RuntimeError, 'schema incompatível'):
            self.subject.update('v0.2.9', MANIFEST, self.root / 'image.tar.gz')
        self.assertEqual(self.compose.read_text(encoding='utf8'), COMPOSE)
        self.assertFalse(self.subject.journal.exists())
        self.assertFalse(any(call.args[0] == str(self.hook) for call in self.run_mock.call_args_list))


if __name__ == '__main__':
    unittest.main()
