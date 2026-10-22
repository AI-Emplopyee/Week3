"""Export application source as a real ZIP, excluding client documents and credentials."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
output = root / 'outputs' / 'AICD-source.zip'
output.parent.mkdir(exist_ok=True)
blocked = {'.git', 'node_modules', 'dist', '.next', '.vinext', 'outputs', '.wrangler', '.aicd-local', '.sites-runtime', '.codex', '.agents', 'work', '__pycache__'}
manifest = []
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(files)):
        if not name:
            continue
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or any(part in blocked for part in relative.parts):
            continue
        if relative.name.startswith(('.env', '.dev.vars')) and relative.name not in {'.env.example', '.dev.vars.example'}:
            continue
        if relative.name == 'aicd.standalone.json' or relative.suffix.lower() in {'.pem', '.key', '.tsbuildinfo', '.pyc', '.pyo', '.pyd'}:
            continue
        source = root / relative
        if source.is_symlink() or not source.is_file():
            continue
        content = source.read_bytes()
        archive.writestr('aicd/' + relative.as_posix(), content)
        manifest.append({'path': relative.as_posix(), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    archive.writestr('aicd/SOURCE-MANIFEST.json', json.dumps(manifest, indent=2))
with zipfile.ZipFile(output) as archive:
    failure = archive.testzip()
    if failure:
        raise RuntimeError('ZIP verification failed: ' + failure)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum + '  AICD-source.zip\n')
print(json.dumps({'file': str(output), 'files': len(manifest), 'bytes': output.stat().st_size, 'sha256': checksum}))
