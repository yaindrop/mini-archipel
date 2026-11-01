"""No browser/network/render dependency: verify optional template compilation."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='renderer-', dir=root / 'test-results') as folder:
    folder = Path(folder)
    for name in ('compile.mjs', 'effects.json'):
        shutil.copy2(root / 'examples/hyperframes' / name, folder / name)
    data = json.loads((root / 'examples/pointer.json').read_text())
    data['width'], data['height'] = 800, 600
    data['events'][-1]['t'] = 1.8
    (folder / 'pointer-events.json').write_text(json.dumps(data))
    subprocess.run(['node', folder / 'compile.mjs'], check=True, capture_output=True)
    html = (folder / 'index.html').read_text()
    assert 'data-width="800" data-height="600"' in html
    assert 'viewBox="0 0 800 600"' in html
    assert 'immediateRender:false' in html and 'opacity="0"' in html
    assert 'source.mp4' in html
    cfg = json.loads((folder / 'effects.json').read_text()); cfg['enabled'] = False
    (folder / 'effects.json').write_text(json.dumps(cfg))
    subprocess.run(['node', folder / 'compile.mjs'], check=True, capture_output=True)
    assert 'display:none' in (folder / 'index.html').read_text()
    for opacity in (0, .2, 1):
        cfg['holdOpacity'] = opacity
        (folder / 'effects.json').write_text(json.dumps(cfg))
        subprocess.run(['node', folder / 'compile.mjs'], check=True, capture_output=True)
        assert 'stroke:none' in (folder / 'index.html').read_text()
    for opacity in (-.1, 1.1, None):
        cfg['holdOpacity'] = opacity
        (folder / 'effects.json').write_text(json.dumps(cfg))
        assert subprocess.run(['node', folder / 'compile.mjs'], capture_output=True).returncode != 0
    cfg['holdOpacity'] = .2
    (folder / 'effects.json').write_text(json.dumps(cfg))
    data['events'].pop()
    (folder / 'pointer-events.json').write_text(json.dumps(data))
    result = subprocess.run(['node', folder / 'compile.mjs'], capture_output=True)
    assert result.returncode != 0
print('PASS: optional renderer dimensions, initial transparency, disabled layer, incomplete drag rejection; no browser or actual rendering.')
