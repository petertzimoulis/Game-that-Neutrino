#!/usr/bin/env python3
"""Repeatable traffic bursts. Write phases require explicit --allow-writes on a test deployment."""
import argparse
import asyncio
import json
import math
import os
import platform
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import aiohttp


def percentile(values, quantile):
    return round(sorted(values)[min(len(values) - 1, math.ceil(len(values) * quantile) - 1)] * 1000, 2)


async def run(args):
    base = args.base_url.rstrip('/')
    prefix = 'load-' + uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    semaphore = asyncio.Semaphore(args.concurrency)
    connector = aiohttp.TCPConnector(limit=args.concurrency)
    results = []
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=60)) as session:
        async def phase(name, method, route, payload=None, headers=None, expected=200):
            latencies, statuses, errors = [], Counter(), Counter()
            async def request(index):
                started = time.perf_counter()
                try:
                    async with semaphore:
                        async with session.request(method, base + route, json=payload(index) if payload else None, headers=headers) as response:
                            data = await response.read()
                            statuses[str(response.status)] += 1
                            if response.status != expected:
                                errors[data[:120].decode(errors='replace')] += 1
                except Exception as error:
                    statuses['exception'] += 1
                    errors[type(error).__name__] += 1
                latencies.append(time.perf_counter() - started)
            started = time.perf_counter()
            await asyncio.gather(*(request(index) for index in range(args.users)))
            elapsed = time.perf_counter() - started
            result = {'phase': name, 'requests': args.users, 'statuses': dict(statuses), 'seconds': round(elapsed, 3),
                      'requests_per_second': round(args.users / elapsed, 1), 'p50_ms': percentile(latencies, .5),
                      'p95_ms': percentile(latencies, .95), 'p99_ms': percentile(latencies, .99), 'errors': dict(errors)}
            results.append(result)
            print(json.dumps(result), flush=True)

        # Warm the connection, then exercise a simultaneous arrival burst.
        async with session.get(base + '/api/ready') as response:
            if response.status != 200:
                raise RuntimeError('Target is not ready')
        await phase('leaderboard_burst', 'GET', '/api/collaborator-players')
        if args.allow_writes:
            def score(index):
                return {'id': f'{prefix}-{index}', 'name': f'{prefix}-{index}', 'completedAt': now, 'finalCoins': 15,
                        'answers': [{'videoId': f'load-clip-{i}', 'choice': 'track', 'correct': True} for i in range(5)]}
            await phase('score_submissions', 'POST', '/api/collaborator-players', score)
            await phase('duplicate_retries', 'POST', '/api/collaborator-players', score)
            await phase('trophy_submissions', 'POST', '/api/achievements', lambda index:
                        {'name': f'{prefix}-{index}', 'unlocked': ['first-call', 'finisher']})
            await phase('telemetry_batches', 'POST', '/api/analytics-events', lambda index:
                        {'events': [{'id': f'{prefix}-event-{index}-{i}', 'type': 'load_test', 'timestamp': now,
                                     'sessionId': f'{prefix}-{index}', 'mode': 'demo'} for i in range(3)]})
        if args.video_path:
            await phase('video_byte_ranges', 'GET', args.video_path, headers={'Range': 'bytes=0-65535'}, expected=206)
        await phase('leaderboard_after_writes', 'GET', '/api/collaborator-players')
    report = {'started_at': now, 'target': base, 'users': args.users, 'concurrency': args.concurrency, 'prefix': prefix,
              'environment': {'system': platform.system(), 'architecture': platform.machine(), 'cpu_count': os.cpu_count()},
              'phases': results, 'passed': all(not result['errors'] and 'exception' not in result['statuses'] for result in results)}
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--users', type=int, default=1500)
    parser.add_argument('--concurrency', type=int, default=1500)
    parser.add_argument('--allow-writes', action='store_true', help='Creates test scores, trophies, and events. Use a disposable deployment.')
    parser.add_argument('--video-path')
    parser.add_argument('--output')
    args = parser.parse_args()
    if min(args.users, args.concurrency) < 1:
        parser.error('User and concurrency counts must be positive')
    report = asyncio.run(run(args))
    raise SystemExit(0 if report['passed'] else 1)
