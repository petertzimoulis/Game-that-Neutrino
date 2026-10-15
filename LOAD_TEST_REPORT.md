# Local load test — October 15, 2026

This test ran against a disposable local PostgreSQL database through nginx and Gunicorn, with 1,500 simultaneous client connections per phase. No production site was load-tested or changed.

## Configuration

- macOS ARM64, 8 logical CPUs; load generator, nginx, app, and database on the same machine.
- nginx 1.28.0, two local workers; Gunicorn 23.0.0, four workers with eight threads each.
- PostgreSQL 18.6 locally. The packaged deployment uses PostgreSQL 17; all queries use features supported by 17.
- Shared read cache enabled; writes queued at 500 requests/second, with room for 2,000 queued requests.
- Local HTTP: no public network, CDN, or TLS termination in these latency measurements.

## Results

| Phase | Requests | Successful | p95 latency | Total phase |
| --- | ---: | ---: | ---: | ---: |
| leaderboard burst | 1,500 | 1,500 | 814 ms | 0.932 s |
| score submissions | 1,500 | 1,500 | 2,751 ms | 2.965 s |
| duplicate retries | 1,500 | 1,500 | 2,772 ms | 3.000 s |
| trophy submissions | 1,500 | 1,500 | 2,788 ms | 2.999 s |
| telemetry batches | 1,500 | 1,500 | 2,746 ms | 3.000 s |
| video byte ranges | 1,500 | 1,500 | 117 ms | 0.139 s |
| leaderboard after writes | 1,500 | 1,500 | 784 ms | 0.883 s |

All 10,500 requests completed with the expected HTTP status: 200 for API operations and 206 for partial video delivery. Database queries independently verified 1,500 unique runs, 1,500 player profiles, 3,000 unique trophies, and 4,500 unique activity events for the successful run. Repeating each of the 1,500 run IDs did not add duplicate runs.

An initial unqueued write burst exposed upstream connection resets. Adding the bounded nginx write queue resolved the failures in the subsequent complete seven-phase test. The queue deliberately trades a short wait for reliable acceptance during simultaneous submissions.

## Other checks

- 15 Python checks passed, including PostgreSQL concurrency, idempotent retries, achievement unions, report pagination, validation, import replay, HTTP caching, and media configuration.
- Game-rule checks and browser synchronization checks passed in Node.
- nginx configuration validation passed; static clips returned byte ranges and cache headers; repeated public reads hit the shared cache.
- The local browser completed a five-question game, confirmed the saved result against PostgreSQL, played a clip from the local nginx origin, and opened the learning-quiz analysis with full answer history. Browser error logs were empty.

## Limits

This is a series of request bursts, not 1,500 real people playing continuously. Video requests fetch 64 KiB byte ranges, not entire sessions. The result establishes application behavior on this local machine and does not certify a future server, its internet link, or a CDN. Full video delivery, sustained mixed traffic, HTTPS, and cross-region latency must be checked on the selected hosting setup. Docker is not installed on the test machine, so the container lifecycle and public certificate provisioning have not been exercised; the core services were tested natively.

The source and deployment files are ready locally. A host and domain have not been selected, and no independent production deployment has been performed.
