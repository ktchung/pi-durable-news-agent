#!/usr/bin/env python3
"""Configured-channel Discord sender with durable claims and exact readback.

Uses the active Hermes profile's existing bot credential in memory only. Never
initiates research, invokes an LLM, changes news settings, or retries a POST.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

from publisher import (GetClient, NoRedirect, digest, require, PublisherError, units,
                       load_config, configured_publisher, validate_target)

EMPTY_MENTIONS = {'parse': [], 'users': [], 'roles': [], 'replied_user': False}


def bot_credential():
    # Use Hermes' supported, profile-aware secret resolver, including managed
    # policy precedence. Never print/export the mapping or copy bot credentials.
    try:
        from agent.secret_scope import build_profile_secret_scope
        from hermes_constants import get_hermes_home
    except ModuleNotFoundError as error:
        # Standalone mode only when Hermes itself is absent. Broken installed
        # dependencies and managed-policy denials must not silently fall back.
        if error.name not in {'agent', 'agent.secret_scope', 'hermes_constants'}:
            raise
        token = os.environ.get('DISCORD_BOT_TOKEN', '')
    else:
        scope = build_profile_secret_scope(get_hermes_home())
        token = scope.get('DISCORD_BOT_TOKEN', '')
    require(isinstance(token, str) and 0 < len(token) <= 4096
            and not any(c.isspace() for c in token), 'No valid Discord bot credential available')
    return token


class Discord:
    def __init__(self, target, token=None):
        self.target = validate_target(target)
        self.channel = self.target.split(':', 1)[1]
        self.token = bot_credential() if token is None else token
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        valid = ((method == 'GET' and path == '/users/@me') or
                 (method == 'POST' and path == f'/channels/{self.channel}/messages') or
                 (method == 'GET' and re.fullmatch(rf'/channels/{self.channel}/messages/[0-9]{{17,20}}', path)))
        require(valid, 'Discord operation is outside the configured publisher scope')
        req = Request('https://discord.com/api/v10' + path, method=method,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={'Authorization': 'Bot ' + self.token,
                               'Content-Type': 'application/json',
                               'User-Agent': 'Hermes-News-Publisher/1.0'})
        try:
            with self.opener.open(req, timeout=10) as response:
                raw = response.read(1024 * 1024 + 1)
                require(len(raw) <= 1024 * 1024, 'Discord response exceeds limit')
                return json.loads(raw)
        except HTTPError as error:
            code = error.code
            error.close()
            raise PublisherError(f'Discord returned HTTP {code}; no send was retried') from None
        except OSError:
            raise PublisherError('Discord transport failed; outcome may be unknown; no send was retried') from None

    def identity(self):
        row = self.request('GET', '/users/@me')
        require(isinstance(row, dict) and row.get('bot') is True, 'Discord credential is not a bot')
        require(isinstance(row.get('id'), str) and re.fullmatch(r'[0-9]{17,20}', row['id']),
                'Invalid bot identity')
        return row['id']

    def send(self, content, nonce):
        return self.request('POST', f'/channels/{self.channel}/messages',
                            {'content': content, 'allowed_mentions': EMPTY_MENTIONS,
                             'nonce': nonce, 'enforce_nonce': True, 'flags': 4})

    def read(self, message_id):
        return self.request('GET', f'/channels/{self.channel}/messages/{message_id}')


def save_journal(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify_readback(row, expected, message_id, bot_id, target):
    channel = validate_target(target).split(':', 1)[1]
    require(isinstance(row, dict) and row.get('id') == message_id and row.get('channel_id') == channel,
            'Discord message/channel readback mismatch')
    require((row.get('author') or {}).get('id') == bot_id, 'Discord readback has a different author')
    require(row.get('content') == expected['content'], 'Discord content readback mismatch')
    require(not row.get('mention_everyone') and not row.get('mentions') and not row.get('mention_roles'),
            'Discord readback contains an unexpected mention')
    require(digest(row['content']) == expected['content_sha256'], 'Discord readback checksum mismatch')
    return digest(row['content'])


def receipt(claim, evidence):
    return {'outbox_id': claim['outbox_id'], 'claim_token': claim['claim_token'],
            'target': claim['target'], 'status': 'delivered', 'verified': True,
            'verification': 'discord-readback', 'messages': evidence}


def deliver(publisher, discord, state_dir):
    manifest = publisher.prepare()
    if manifest['status'] == 'idle':
        return manifest
    if manifest['status'] == 'blocked' and manifest.get('outbox_status') == 'prepared':
        # An operator may have prepared and inspected this immutable outbox.
        # Only a never-claimed prepared record can proceed to the one-shot claim.
        manifest = publisher.show(manifest['outbox_id'])
    require(manifest['status'] == 'prepared',
            'Explicit historical baseline required, or unresolved delivery blocks publishing')
    require(discord.target == publisher.target, 'Configured Discord destination mismatch')
    bot_id = discord.identity()  # Fail before claiming if the bot is unavailable.
    claim = publisher.claim(manifest['outbox_id'])
    require(claim['target'] == discord.target, 'Outbox destination mismatch')
    path = Path(state_dir) / (claim['outbox_id'] + '.receipt.json')
    journal = {'claim': claim, 'evidence': [], 'phase': 'claimed'}
    deadline = time.monotonic() + 90
    acknowledged = False
    try:
        require(not path.exists(), 'Existing receipt journal; no automatic resend')
        save_journal(path, journal)
        for index, message in enumerate(claim['messages']):
            require(time.monotonic() < deadline, 'Sender deadline exceeded; no automatic retry')
            require(message['allowed_mentions'] == EMPTY_MENTIONS and units(message['content']) <= 1800,
                    'Outbox message safety contract mismatch')
            require(digest(message['content']) == message['content_sha256'], 'Outbox checksum mismatch')
            journal.update(phase='sending', sending_index=index)
            save_journal(path, journal)  # Durable intent before any POST.
            posted = discord.send(message['content'], digest(claim['outbox_id'] + ':' + str(index))[:24])
            mid = str(posted.get('id', '')) if isinstance(posted, dict) else ''
            require(re.fullmatch(r'[0-9]{17,20}', mid) is not None, 'Discord returned no usable message ID')
            evidence = {'index': index, 'message_id': mid, 'content_sha256': message['content_sha256']}
            journal['evidence'].append(evidence)
            journal['phase'] = 'awaiting_readback'
            save_journal(path, journal)  # Persist the ID even if the GET fails.
            evidence['readback_content_sha256'] = verify_readback(
                discord.read(mid), message, mid, bot_id, claim['target'])
            journal['phase'] = 'readback_verified'
            save_journal(path, journal)
        result = publisher.ack(receipt(claim, journal['evidence']))
        acknowledged = True
        journal['phase'] = 'confirmed'
        save_journal(path, journal)
        return result
    except BaseException:
        # Includes process interruption and database/readback failures. A later
        # tick cannot claim this outbox again. Reconciliation never sends.
        if not acknowledged:
            publisher.record_failure(claim['outbox_id'], claim['claim_token'],
                                     'Send/readback interrupted or failed; inspect durable receipt journal; do not resend')
        raise


def reconcile(publisher, discord, state_dir, outbox_id):
    require(re.fullmatch(r'[0-9a-f]{64}', outbox_id) is not None, 'Invalid outbox identifier')
    path = Path(state_dir) / (outbox_id + '.receipt.json')
    journal = json.loads(path.read_text())
    claim = journal['claim']
    frozen = publisher.show(outbox_id)
    require(claim['outbox_id'] == outbox_id and claim['target'] == publisher.target == discord.target,
            'Journal target mismatch')
    require(frozen['status'] in ('claimed', 'unknown', 'confirmed'), 'Outbox was never claimed')
    for key in ('target', 'messages', 'card_ids', 'sweep_ids', 'scan'):
        require(claim[key] == frozen[key], 'Journal differs from immutable outbox')
    require(len(journal['evidence']) == len(claim['messages']),
            'Incomplete message IDs; manual reconciliation required, no sends allowed')
    bot_id = discord.identity()
    for index, (evidence, message) in enumerate(zip(journal['evidence'], claim['messages'])):
        require(evidence['index'] == index, 'Journal index mismatch')
        evidence['readback_content_sha256'] = verify_readback(
            discord.read(evidence['message_id']), message, evidence['message_id'], bot_id, claim['target'])
    result = publisher.ack(receipt(claim, journal['evidence']))
    journal['phase'] = 'confirmed'
    save_journal(path, journal)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Path to client settings JSON')
    parser.add_argument('command', choices=['tick', 'reconcile', 'check'], nargs='?', default='tick')
    parser.add_argument('outbox_id', nargs='?')
    args = parser.parse_args(argv)
    publisher = None
    try:
        config = load_config(args.config)
        state_dir = Path(config['state_dir'])
        client = GetClient(args.config) if args.command == 'tick' else None
        publisher = configured_publisher(config, client)
        with (state_dir / 'sender.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            if args.command == 'check':
                result = {'status': 'bot_authenticated', 'target': config['target']}
                Discord(config['target']).identity()
            elif args.command == 'reconcile':
                result = reconcile(publisher, Discord(config['target']), state_dir, args.outbox_id or '')
            else:
                result = deliver(publisher, Discord(config['target']), state_dir)
            print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        return 0
    except Exception as error:
        # Never print request objects, credentials, external response bodies, or
        # exception tracebacks to cron delivery. Empty stdout prevents auto-send.
        print(json.dumps({'status': 'error', 'category': type(error).__name__,
                          'message': str(error) if isinstance(error, PublisherError) else 'Publisher operation failed'}),
              file=sys.stderr)
        return 1
    finally:
        if publisher is not None:
            publisher.close()


if __name__ == '__main__':
    raise SystemExit(main())
