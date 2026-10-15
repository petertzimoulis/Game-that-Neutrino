#!/usr/bin/env python3
"""Package only the independent deployment, excluding credentials and legacy hosting output."""
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / 'release' / 'neutrino-independent-20261015.tar.gz'
output.parent.mkdir(exist_ok=True)
files = ['Dockerfile', 'compose.yaml', '.dockerignore', '.env.example', '.gitignore',
         'requirements.txt', 'requirements-dev.txt', 'gunicorn.conf.py',
         'production.py', 'database.py', 'manage.py', 'server.py',
         'index.html', '4.0.html', 'app.js', 'styles.css', 'coin.png', 'site-config.js',
         'DEPLOYMENT.md', 'LOAD_TEST_REPORT.md', 'scripts/backup.sh', 'scripts/load_test.py',
         'scripts/package-independent.py']
for folder, patterns in [('deploy', ['*']), ('migrations', ['*.sql']), ('tests', ['*.py', '*.cjs']),
                         ('videos', ['**/*.mp4', '**/*.csv']), ('data', ['*.json'])]:
    for pattern in patterns:
        files.extend(str(path.relative_to(root)) for path in (root / folder).glob(pattern) if path.is_file())
with tarfile.open(output, 'w:gz') as archive:
    for name in sorted(set(files)):
        archive.add(root / name, arcname='neutrino-independent/' + name, recursive=False)
print(f'Independent deployment package: {output}')
print(f'{len(set(files))} files, {output.stat().st_size / 1024 / 1024:.1f} MiB')
