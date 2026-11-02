#!/usr/bin/env python3
"""Installer manifest v1: one-line JSON-compatible TOML literals, no dependencies."""
import json
import os
from pathlib import Path
import re
import sys


def load(path, plugin):
    result = {}
    table = result
    seen = set()
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'\[(services|paths|commands)\.([a-z][a-z0-9_]*)\]', line)
        if match:
            name = '.'.join(match.groups())
            if name in seen:
                raise ValueError('Duplicate manifest table')
            seen.add(name)
            if match[1] in result and not isinstance(result[match[1]],dict):
                raise ValueError('Conflicting manifest table')
            table = result.setdefault(match[1], {}).setdefault(match[2], {})
            continue
        match = re.fullmatch(r'([a-z][a-z0-9_]*)\s*=\s*(.+)', line)
        if not match or match[1] in table:
            raise ValueError('Unsupported or duplicate manifest syntax')
        try:
            value = json.loads(match[2])
        except ValueError:
            raise ValueError('Manifest v1 requires single-line JSON-compatible literals') from None
        if '\\/' in match[2]: raise ValueError('JSON-only escape is not TOML')
        if not (type(value) in (str, int) or isinstance(value,list) and all(type(v) is str for v in value)):
            raise ValueError('Unsupported manifest value')
        for text in ([value] if isinstance(value,str) else value if isinstance(value,list) else []):
            if any(ord(c)<32 or 0xD800<=ord(c)<=0xDFFF for c in text):
                raise ValueError('Invalid manifest string')
        table[match[1]] = value
    if result.get('schema_version') != 1 or result.get('id') != plugin:
        raise ValueError('Wrong manifest schema or plugin ID')
    if set(result) - {'schema_version','id','legacy_ids','bundle_id','paths','commands','services'}:
        raise ValueError('Unknown manifest root field')
    allowed = {'paths': {'path','legacy_paths','kind','owner','migration'},
               'commands': {'path','legacy_paths','owner','target'},
               'services': {'label','legacy_labels','label_pattern','domain','owner'}}
    for category, keys in allowed.items():
        if not isinstance(result.get(category,{}),dict): raise ValueError('Invalid resource table')
        for entry in result.get(category, {}).values():
            for key,value in entry.items():
                if key in {'legacy_paths','legacy_labels'}:
                    if not isinstance(value,list): raise ValueError('Expected string array')
                elif not isinstance(value,str): raise ValueError('Expected string resource field')
            if set(entry)-keys or entry.get('owner') not in {'plugin','external'}:
                raise ValueError('Invalid manifest resource')
            if category == 'services':
                if entry.get('domain') not in {'gui','system'} or bool(entry.get('label')) == bool(entry.get('label_pattern')):
                    raise ValueError('Invalid service declaration')
                if entry.get('label_pattern') and entry['owner'] != 'external':
                    raise ValueError('Only external service patterns are supported')
                continue
            for key in ('path','target','legacy_paths'):
                values = entry.get(key, [])
                if isinstance(values,str): values=[values]
                if not isinstance(values,list): raise ValueError('Invalid resource path')
                for value in values:
                    if not isinstance(value,str) or not (value.startswith('/') or value.startswith('~/')) or any(c in value for c in '$`*\n\r\x00') or any(p in {'.','..',''} for p in value.split('/')[1:]):
                        raise ValueError('Unsafe manifest path')
            if not isinstance(entry.get('path'),str): raise ValueError('Resource path missing')
            if category == 'paths':
                if entry.get('migration') not in {'move','fixed'} or entry.get('kind') not in {'program','state','backup','log','app','socket'}:
                    raise ValueError('Invalid path declaration')
                if entry['migration']=='move':
                    prefixes={'program':'~/.local/libexec/mini-archipel/'+plugin,'state':'~/.local/share/mini-archipel/'+plugin,'backup':'~/.local/share/mini-archipel/'+plugin,'log':'~/Library/Logs/MiniArchipel/'+plugin}
                    prefix=prefixes.get(entry['kind'])
                    if entry['owner']!='plugin' or not prefix or not (entry['path']==prefix or entry['path'].startswith(prefix+'/')):
                        raise ValueError('Moved resource outside plugin boundary')
    return Manifest(result, Path(path))


class Manifest:
    def __init__(self, data, source):
        self.data, self.source = data, source

    def value(self, key):
        value=self.data
        for part in key.split('.'): value=value[part]
        return value

    def path(self, key, home=None):
        value=self.value(key)
        return (Path.home() if home is None else Path(home))/value[2:] if value.startswith('~/') else Path(value)

    def installed(self, name, legacy=False):
        entry=self.data['paths'][name]
        canonical=self.path('paths.'+name+'.path')
        olds=[Path.home()/p[2:] if p.startswith('~/') else Path(p) for p in entry.get('legacy_paths',[])]
        if legacy:
            if canonical.exists() or canonical.is_symlink(): raise ValueError('Canonical state not supported by installed App')
            return olds[0]
        if canonical.is_symlink(): raise ValueError('Canonical path must be a real object')
        for old in olds:
            if old.is_symlink():
                if os.readlink(old)!=str(canonical): raise ValueError('Unexpected legacy alias')
            elif old.exists():
                if canonical.exists(): raise ValueError('Duplicate real layouts')
                return old
        return canonical


def alias(old, target):
    if old == target: return
    if old.is_symlink():
        if os.readlink(old) != str(target): raise ValueError('Unexpected compatibility alias')
    elif old.exists():
        raise ValueError('Compatibility path is a real object; migrate layout first')
    else:
        old.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        old.symlink_to(target)


if __name__=='__main__':
    try:
        m=load(sys.argv[1],sys.argv[2])
        key=sys.argv[3] if len(sys.argv)>3 else None
        value=m.value(key) if key else m.data
        print(str(m.path(key)) if key and (key.endswith('.path') or key.endswith('.target')) else (value if isinstance(value,str) else json.dumps(value)))
    except (ValueError,KeyError,IndexError,OSError):
        raise SystemExit('Invalid or unsupported installer manifest')


def for_script(script, plugin):
    directory=Path(script).resolve().parent
    source=directory/'manifest.toml'
    if not source.is_file(): source=directory.parent/'manifest.toml'
    return load(source,plugin)


def bundle(directory, manifest):
    import shutil
    shutil.copy2(manifest.source,directory/'manifest.toml')
    shutil.copy2(Path(__file__),directory/'manifest_reader.py')
