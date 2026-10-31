"""Sender invariants with real private SQLite/journals, no network/credentials."""
import copy
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import types
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publisher import Publisher, PublisherError
from sender import Discord, deliver, reconcile, bot_credential

TARGET = 'discord:100000000000000001'
CHANNEL = TARGET.split(':', 1)[1]
NEWS_URL = 'https://news.example.test/'


class Client:
    def __init__(self):
        self.sweeps = []
        self.cards = []

    def get(self, path, params=None):
        if path == '/v1/sweeps':
            return copy.deepcopy(self.sweeps)
        if path == '/v1/feed':
            return {'items': copy.deepcopy(self.cards)}
        if path.startswith('/v1/cards/'):
            card = next(c for c in self.cards if c['id'] == int(path.rsplit('/', 1)[1]))
            return {'card': copy.deepcopy(card), 'item': {'url': card['url'], 'title': card['title']}}
        raise AssertionError(path)

    def add(self, count=1, long=False):
        self.sweeps = [{'id': 1, 'status': 'completed', 'presented': count, 'audit': {'missing': []},
                        'endedAt': '2026-10-30T08:00:00Z'}]
        self.cards = [{'id': n + 1, 'kind': 'news', 'sweepId': 1, 'component': 'brief',
                       'publishedAt': '2026-10-30T08:00:00Z',
                       'hfs': {'facts': 90, 'signal': 60, 'hype': 5},
                       'title': 'Original title', 'url': f'https://example.test/news/{n}',
                       'props': {'title': 'Original title', 'summary': 'Verified source summary. ' * (150 if long else 1)}}
                      for n in range(count)]


class Bot:
    def __init__(self):
        self.target = TARGET
        self.sent = []
        self.rows = {}
        self.reads = 0
        self.fail_read = False
        self.fail_send_at = None
        self.corruption = None

    def identity(self):
        return '1560000000000000001'

    def send(self, content, nonce):
        if len(self.sent) == self.fail_send_at:
            raise OSError('synthetic send interruption')
        mid = str(1560000000000000100 + len(self.sent))
        self.sent.append((content, nonce))
        self.rows[mid] = {'id': mid, 'content': content, 'channel_id': CHANNEL,
                          'author': {'id': self.identity()}, 'mentions': [], 'mention_roles': [],
                          'mention_everyone': False}
        return {'id': mid}

    def read(self, mid):
        self.reads += 1
        if self.fail_read:
            raise OSError('synthetic readback interruption')
        row = copy.deepcopy(self.rows[mid])
        if self.corruption == 'channel':
            row['channel_id'] = '1560000000000000999'
        elif self.corruption == 'author':
            row['author']['id'] = '1560000000000000999'
        elif self.corruption == 'content':
            row['content'] += ' changed'
        elif self.corruption == 'mention':
            row['mention_everyone'] = True
        return row


class SenderTests(unittest.TestCase):
    def setup_publisher(self, root):
        client = Client()
        publisher = Publisher(client, root, target=TARGET, news_url=NEWS_URL)
        publisher.baseline()
        return client, publisher, Bot()

    def test_multichunk_confirmed_only_after_exact_readback_and_idle_does_not_send(self):
        with tempfile.TemporaryDirectory() as directory:
            client, p, bot = self.setup_publisher(directory)
            try:
                client.add(count=2, long=True)
                prepared = p.prepare()
                frozen = p.show(prepared['outbox_id'])
                result = deliver(p, bot, directory)
                self.assertEqual(result['status'], 'confirmed')
                self.assertEqual(result['delivered_cards'], 2)
                self.assertGreater(len(bot.sent), 2)
                self.assertEqual(bot.reads, len(bot.sent))
                self.assertEqual(len({nonce for _, nonce in bot.sent}), len(bot.sent))
                journal_path = next(Path(directory).glob('*.receipt.json'))
                self.assertEqual(stat.S_IMODE(journal_path.stat().st_mode), 0o600)
                self.assertEqual(json.loads(journal_path.read_text())['phase'], 'confirmed')
                self.assertEqual(p.show(prepared['outbox_id'])['messages'], frozen['messages'])
                before = len(bot.sent)
                self.assertEqual(deliver(p, bot, directory)['status'], 'idle')
                self.assertEqual(len(bot.sent), before)
            finally:
                p.close()

    def test_readback_failure_blocks_resend_but_get_only_reconciliation_can_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            client, p, bot = self.setup_publisher(directory)
            try:
                client.add()
                bot.fail_read = True
                with self.assertRaises(OSError):
                    deliver(p, bot, directory)
                self.assertEqual(p.status()['delivered_cards'], 0)
                outbox = p.status()['outboxes'][0]
                self.assertEqual(outbox['status'], 'unknown')
                with self.assertRaises(PublisherError):
                    deliver(p, bot, directory)
                self.assertEqual(len(bot.sent), 1)
                bot.fail_read = False
                journal_path = Path(directory) / (outbox['outbox_id'] + '.receipt.json')
                journal = json.loads(journal_path.read_text())
                tampered = copy.deepcopy(journal)
                tampered['claim']['messages'][0]['content'] += ' changed'
                journal_path.write_text(json.dumps(tampered))
                reads = bot.reads
                with self.assertRaises(PublisherError):
                    reconcile(p, bot, directory, outbox['outbox_id'])
                self.assertEqual(bot.reads, reads)
                journal_path.write_text(json.dumps(journal))
                self.assertEqual(reconcile(p, bot, directory, outbox['outbox_id'])['status'], 'confirmed')
                self.assertEqual(len(bot.sent), 1)
            finally:
                p.close()

    def test_wrong_readback_and_partial_send_never_advance_ledger(self):
        for corruption in ('channel', 'author', 'content', 'mention', 'partial'):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                client, p, bot = self.setup_publisher(directory)
                try:
                    partial = corruption == 'partial'
                    client.add(long=partial)
                    if partial:
                        bot.fail_send_at = 1
                    else:
                        bot.corruption = corruption
                    with self.assertRaises((OSError, PublisherError)):
                        deliver(p, bot, directory)
                    self.assertEqual(p.status()['delivered_cards'], 0)
                    before = len(bot.sent)
                    if partial:
                        with self.assertRaises(PublisherError):
                            reconcile(p, bot, directory, p.status()['outboxes'][0]['outbox_id'])
                    self.assertEqual(len(bot.sent), before)
                finally:
                    p.close()

    def test_secret_resolver_profile_precedence_and_standalone_environment(self):
        agent = types.ModuleType('agent')
        agent.__path__ = []
        secret = types.ModuleType('agent.secret_scope')
        constants = types.ModuleType('hermes_constants')
        calls = []
        class Scope:
            token = 'synthetic-profile-token'

            def get(self, key, default):
                calls.append(key)
                return self.token

        scope = Scope()
        def build(home):
            self.assertEqual(home, Path('synthetic-profile'))
            return scope

        secret.build_profile_secret_scope = build
        constants.get_hermes_home = lambda: Path('synthetic-profile')
        modules = {'agent': agent, 'agent.secret_scope': secret, 'hermes_constants': constants}
        with patch.dict(sys.modules, modules), patch('sender.os.environ', {
                'DISCORD_BOT_TOKEN': 'synthetic-env-token'}):
            self.assertEqual(bot_credential(), 'synthetic-profile-token')
            self.assertEqual(calls, ['DISCORD_BOT_TOKEN'])
            scope.token = ''  # Managed-profile absence must not use environment fallback.
            with self.assertRaises(PublisherError):
                bot_credential()
        with patch.dict(sys.modules, {'agent': None}), patch('sender.os.environ', {
                'DISCORD_BOT_TOKEN': 'synthetic-env-token'}):
            self.assertEqual(bot_credential(), 'synthetic-env-token')
        with patch.dict(sys.modules, {'agent': None}), patch('sender.os.environ', {}):
            with self.assertRaises(PublisherError):
                bot_credential()

    def test_transport_scope_rejects_other_channels_and_provider_endpoints(self):
        bot = Discord(TARGET, token='synthetic-not-a-live-credential')
        for method, path in [('POST', '/channels/123/messages'), ('PATCH', '/v1/schedule'),
                             ('GET', '/users/123'), ('POST', '/users/@me')]:
            with self.subTest(method=method, path=path), self.assertRaises(PublisherError):
                bot.request(method, path)
        # Exercise the actual request construction without opening a socket.
        response = Mock()
        response.read.return_value = b'{"id":"100000000000000099"}'
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        bot.opener = Mock()
        bot.opener.open.return_value = context
        bot.send('Synthetic message', 'synthetic-nonce')
        request = bot.opener.open.call_args.args[0]
        self.assertEqual(request.method, 'POST')
        self.assertEqual(request.full_url, f'https://discord.com/api/v10/channels/{CHANNEL}/messages')
        body = json.loads(request.data)
        self.assertEqual(body['allowed_mentions']['parse'], [])
        self.assertIs(body['allowed_mentions']['replied_user'], False)
        self.assertIs(body['enforce_nonce'], True)
        self.assertEqual(body['flags'], 4)
        bot.opener.open.reset_mock()
        bot.opener.open.side_effect = HTTPError(request.full_url, 429, 'synthetic', {}, None)
        with self.assertRaises(PublisherError):
            bot.send('Synthetic message', 'synthetic-nonce')
        self.assertEqual(bot.opener.open.call_count, 1)


if __name__ == '__main__':
    unittest.main()
