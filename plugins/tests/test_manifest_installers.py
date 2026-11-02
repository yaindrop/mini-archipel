import contextlib
import importlib.util
import io
import json
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import manifest_reader as reader


class Installers(unittest.TestCase):
    def test_five_standalone_payloads_read_manifest_on_python39_any_cwd(self):
        entries={'proxy':'install.py','automation':'install.py','runners':'scripts/install-node-runners.py',
                 'screen-recording':'scripts/install.sh','fan-control':'install-plugin.sh'}
        with tempfile.TemporaryDirectory(prefix='manifest payload spaces ') as temp:
            base=Path(temp)
            for plugin,entry in entries.items():
                with self.subTest(plugin=plugin):
                    payload=base/plugin;payload.mkdir()
                    for file in [entry,'manifest.toml']+(['backend.py','fetch.py','assets.lock.json'] if plugin=='proxy' else []):
                        dest=payload/file;dest.parent.mkdir(exist_ok=True)
                        shutil.copy2(ROOT/plugin/file,dest)
                    shutil.copy2(ROOT/'manifest_reader.py',payload/'manifest_reader.py')
                    exe='/bin/bash' if entry.endswith('.sh') else '/usr/bin/python3'
                    cmd=[exe,str(payload/entry),'--check-manifest']
                    env={**os.environ,'HOME':str(base/'fake home'),'PYTHONPATH':'','PYTHONDONTWRITEBYTECODE':'1'}
                    r=subprocess.run(cmd,cwd='/',env=env,capture_output=True,text=True)
                    self.assertEqual(r.returncode,0,r.stderr)
                    self.assertEqual(json.loads(r.stdout)['id'],plugin)
                    (payload/'manifest.toml').unlink()
                    r=subprocess.run(cmd,cwd='/',env=env,capture_output=True,text=True)
                    self.assertNotEqual(r.returncode,0)
                    self.assertFalse((base/'fake home').exists())

    def test_strict_subset_rejects_unsupported_syntax(self):
        source=(ROOT/'proxy/manifest.toml').read_text()
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'manifest.toml'
            for invalid in ['schema_version = 1.0', 'schema_version = true', 'id = \'proxy\'',
                            'id = "proxy" # inline', 'id = "pro\\/xy"', '[paths]']:
                with self.subTest(invalid=invalid):
                    p.write_text(source+'\n'+invalid+'\n')
                    with self.assertRaises(ValueError):reader.load(p,'proxy')

    def test_canonical_automation_upgrade_failure_and_rollback_keep_state_aliases(self):
        spec=importlib.util.spec_from_file_location('automation_install_phase4',ROOT/'automation/install.py')
        install=importlib.util.module_from_spec(spec);spec.loader.exec_module(install)
        with tempfile.TemporaryDirectory() as d:
            h=Path(d).resolve();program=h/'.local/libexec/mini-archipel/automation'
            state=h/'.local/share/mini-archipel/automation';previous=state/'backups/previous'
            for p in [program,state,previous]:p.mkdir(parents=True,exist_ok=True)
            for p,label in [(program,'current'),(previous,'previous')]:
                (p/'desktop-automation').write_text(label)
            legacy=h/'.local/libexec/mini-archipel-desktop';legacy.symlink_to(program)
            oldstate=state.with_name('desktop-automation');oldstate.symlink_to(state)
            oldprevious=legacy.with_name(legacy.name+'.previous');oldprevious.symlink_to(previous)
            (state/'job.json').write_text('{"status":"completed"}')
            (previous/'agent-script-runner').write_text('old launcher')
            (h/'agent-script-runner').write_text('old launcher')
            app=h/'Applications/Mini Archipel Plugin - Automation.app/Contents';app.mkdir(parents=True)
            (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'local.yaindrop.agent-script-runner'}))
            def run(argv,**kwargs):
                if argv[0]=='/usr/bin/osascript':return subprocess.CompletedProcess(argv,0,'0')
                if argv[0]=='/usr/bin/xcrun':raise subprocess.CalledProcessError(1,argv)
                return subprocess.CompletedProcess(argv,0,'{"data":{"jobs":[]}}')
            with patch.object(Path,'home',return_value=h),patch('sys.platform','darwin'),patch('subprocess.run',side_effect=run),patch('sys.argv',['install.py']):
                with self.assertRaises(subprocess.CalledProcessError):install.install()
            self.assertEqual((program/'desktop-automation').read_text(),'current')
            with patch.object(Path,'home',return_value=h),patch('sys.platform','darwin'),patch('subprocess.run',side_effect=run),patch('sys.argv',['install.py','--rollback']),contextlib.redirect_stdout(io.StringIO()):
                install.install()
            self.assertEqual((program/'desktop-automation').read_text(),'previous')
            self.assertEqual((program/'agent-script-runner').read_bytes(),(ROOT/'automation/runtime/agent-script-runner').read_bytes())
            self.assertTrue(legacy.is_symlink());self.assertTrue(oldprevious.is_symlink());self.assertTrue(oldstate.is_symlink())
            self.assertEqual((state/'job.json').read_text(),'{"status":"completed"}')

    def test_screen_install_repeat_failed_upgrade_and_rollback_in_isolation(self):
        import plistlib
        with tempfile.TemporaryDirectory(prefix='recorder installer ') as d:
            h=Path(d).resolve();payload=h/'payload';(payload/'scripts').mkdir(parents=True)
            tools=h/'tools';tools.mkdir()
            source=(ROOT/'screen-recording/scripts/install.sh').read_text().replace('/usr/bin/osascript','"$FIXTURE_OSASCRIPT"').replace('register=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister','register=/nonexistent-fixture-lsregister')
            script=payload/'scripts/install.sh';script.write_text(source)
            shutil.copy2(ROOT/'screen-recording/manifest.toml',payload/'manifest.toml')
            shutil.copy2(ROOT/'manifest_reader.py',payload/'manifest_reader.py')
            for name,body in {'codesign':'exit 0','osascript':'exit 0','ditto':'''if [[ -f "$FAIL_FLAG" && ( "$1" == */build/* || "$1" == build/* ) ]]; then rm "$FAIL_FLAG"; exit 1; fi
mkdir -p "$(dirname "$2")"
cp -R "$1" "$2"'''} .items():
                p=tools/name;p.write_text('#!/bin/bash\n'+body+'\n');p.chmod(0o700)
            app=payload/'build/Mini Archipel Plugin - Screen Recorder.app';(app/'Contents').mkdir(parents=True)
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'org.agent-screen-recorder.app'}))
            (app/'marker').write_text('original');(payload/'build/agent-screen-recorder').write_text('wrapper')
            env={**os.environ,'HOME':str(h),'PATH':str(tools)+':'+os.environ['PATH'],'FIXTURE_OSASCRIPT':str(tools/'osascript'),'FAIL_FLAG':str(h/'fail'),'PYTHONDONTWRITEBYTECODE':'1'}
            def run(*args):return subprocess.run(['/bin/bash',str(script),*args],cwd='/',env=env,capture_output=True,text=True)
            target=h/'Applications/Mini Archipel Plugin - Screen Recorder.app'
            self.assertEqual(run().returncode,0)
            self.assertEqual(run().returncode,0)
            (app/'marker').write_text('upgraded');(h/'fail').touch()
            self.assertNotEqual(run('--upgrade').returncode,0)
            self.assertEqual((target/'marker').read_text(),'original')
            r=run('--upgrade');self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual((target/'marker').read_text(),'upgraded')
            line=next(x for x in r.stdout.splitlines() if x.startswith('Installation completed.'))
            backup=line.split('Previous installation: ',1)[1]
            r=run('--rollback',backup);self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual((target/'marker').read_text(),'original')
            self.assertFalse((h/'.local/share/mini-archipel/screen-recording').exists())

    def test_agent_fan_payload_reinstall_and_failed_swap_preserve_alias(self):
        source=(ROOT.parent/'agent/install.sh').read_text()
        config=source[source.index('FAN_SOURCE='):source.index('BIN=')]
        stage=source[source.index('FAN_STAGE='):source.index('install -m 755 allow-firewall.sh')]
        with tempfile.TemporaryDirectory(prefix='fan payload ') as d:
            h=Path(d).resolve();env={**os.environ,'HOME':str(h),'PYTHONDONTWRITEBYTECODE':'1'}
            def run(fail=False):
                override='mv() { if [[ "$1" == *.next-* ]]; then return 1; fi; command mv "$@"; }\n' if fail else ''
                return subprocess.run(['/bin/bash','-c','set -euo pipefail\n'+override+config+stage],cwd=ROOT.parent/'agent',env=env,capture_output=True,text=True)
            for _ in range(2):
                r=run();self.assertEqual(r.returncode,0,r.stderr)
            program=h/'.local/libexec/mini-archipel/fan-control'
            legacy=h/'.local/share/mini-archipel/plugins/fan-control'
            self.assertTrue(legacy.is_symlink());self.assertEqual(legacy.resolve(),program)
            self.assertTrue((program/'manifest_reader.py').is_file())
            self.assertEqual(reader.load(program/'manifest.toml','fan-control').data['id'],'fan-control')
            before=(program/'install.command').read_bytes()
            r=run(True);self.assertNotEqual(r.returncode,0)
            self.assertEqual((program/'install.command').read_bytes(),before)
            self.assertTrue(legacy.is_symlink())
