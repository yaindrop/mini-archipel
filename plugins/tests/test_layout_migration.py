import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('layout', Path(__file__).resolve().parents[1]/'migrate-layout.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class Layout(unittest.TestCase):
    def home(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return Path(temp.name).resolve()

    def put(self, p, data=b'original'):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def fixture(self, plugin):
        h = self.home()
        if plugin == 'proxy':
            root=h/'.local/mini-proxy'
            for n in ('bin/xray','backend.py','nodes.json','deployment.json','.operation.lock','service-label-migration.json'):
                self.put(root/n)
            self.put(h/'.config/mini-proxy/config.json')
            self.put(h/'.local/bin/mini-proxy-select')
            p=m.backend.Paths(h)
            self.put(p.plist,m.proxy_install.service_plist(p))
            self.put(p.logs/'xray.log')
        elif plugin == 'automation':
            root=h/'.local/libexec/mini-archipel-desktop'
            self.put(root/'agent-script-runner')
            self.put(h/'agent-script-runner')
            self.put(root/'companion-backup.json')
            self.put(root.with_name(root.name+'.previous')/'previous')
            state=h/'.local/share/mini-archipel/desktop-automation'
            self.put(state/'job.json',b'{"status":"needs_user"}')
            for n in ('.admission.lock','.install.lock','.desktop-worker.lock','.chat-worker.lock'):
                self.put(state/n,b'')
            for n in ('.codex-chat.lock','.agent-chat-native.lock'):
                self.put(h/n,b'')
            self.put(h/'.agent-chat-requests/codex-old.json',b'{"result":{"status":"completed"}}')
        elif plugin == 'screen-recording':
            self.put(h/'.local/libexec/mini-archipel-screen-recorder/scripts/install.sh')
            self.put(h/'Library/Application Support/Agent Screen Recorder/state.json',b'{"state":"idle"}')
        else:
            self.put(h/'.local/share/mini-archipel/plugins/fan-control/install.command')
            self.put(h/'.local/share/mini-archipel/plugins/fan-control.previous-20261102-120000/install.command')
        return h

    def transaction(self,h,plugin):
        t=m.Transaction(h,plugin)
        t.directory.mkdir(parents=True,mode=0o700,exist_ok=True)
        self.assertTrue(m.plan(t))
        t.save()
        return t

    def test_all_roundtrip_and_current_state_preserved(self):
        for plugin in m.PLUGINS:
            with self.subTest(plugin=plugin):
                h=self.fixture(plugin)
                t=self.transaction(h,plugin)
                t.run()
                self.assertEqual(t.state['phase'],'migrated')
                if plugin=='automation':
                    canonical=h/'.local/share/mini-archipel/automation'
                    (canonical/'job.json').write_text('{"status":"completed"}')
                    self.assertEqual(os.stat(h/'.agent-chat-native.lock').st_ino,os.stat(canonical/'.agent-chat-native.lock').st_ino)
                    fd=os.open(h/'.agent-chat-native.lock',os.O_RDWR|os.O_NOFOLLOW);os.close(fd)
                if plugin=='proxy':
                    old=h/'.config/mini-proxy/config.json'
                    m.backend.atomic_write(old,b'new state')
                    self.assertTrue(old.is_symlink())
                t=m.Transaction(h,plugin).load();t.run(reverse=True)
                self.assertEqual(t.state['phase'],'rolled_back')
                if plugin=='automation':
                    self.assertEqual((h/'.local/share/mini-archipel/desktop-automation/job.json').read_text(),'{"status":"completed"}')
                if plugin=='proxy':
                    self.assertEqual((h/'.config/mini-proxy/config.json').read_bytes(),b'new state')
                t.run()

    def test_deployment_record_moves_and_rollback_keeps_latest_metadata(self):
        h=self.fixture('proxy')
        old=self.put(h/'.local/mini-proxy/deployment.json',b'{"fixture":"initial"}\n')
        old.chmod(0o600)
        t=self.transaction(h,'proxy')
        target=h/'.local/share/mini-archipel/proxy/deployment.json'
        moves=[a for a in t.actions if a.get('src')==str(old)]
        self.assertEqual(len(moves),1)
        self.assertTrue(moves[0]['mutable'])
        t.run()
        self.assertTrue(old.is_symlink())
        self.assertEqual(os.readlink(old),str(target))
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        self.assertEqual(target.read_bytes(),b'{"fixture":"initial"}\n')
        m.backend.atomic_write(old,b'{"fixture":"updated"}\n')
        self.assertTrue(old.is_symlink())
        t=m.Transaction(h,'proxy').load();t.run(reverse=True)
        self.assertFalse(old.is_symlink())
        self.assertEqual(old.read_bytes(),b'{"fixture":"updated"}\n')
        self.assertFalse(target.exists())

    def test_deployment_registration_does_not_allow_unknown_files_or_aliases(self):
        h=self.fixture('proxy')
        unknown=self.put(h/'.local/mini-proxy/unowned.json')
        with self.assertRaises(m.Failure):m.plan(m.Transaction(h,'proxy'))
        self.assertEqual(unknown.read_bytes(),b'original')
        unknown.unlink()
        old=h/'.local/mini-proxy/deployment.json'
        old.unlink();outside=self.put(h/'outside.json')
        old.symlink_to(outside)
        with self.assertRaises(m.Failure):m.plan(m.Transaction(h,'proxy'))
        with self.assertRaises(m.Failure):m.backend.atomic_write(old,b'bad')
        self.assertTrue(old.is_symlink())
        self.assertEqual(outside.read_bytes(),b'original')

    def test_every_filesystem_crash_gap_resume_and_reverse(self):
        for plugin in m.PLUGINS:
            base=self.transaction(self.fixture(plugin),plugin)
            count=[0]
            base.after_action=lambda:count.__setitem__(0,count[0]+1)
            base.run()
            for cut in range(1,count[0]+1):
                for reverse in (False,True):
                    with self.subTest(plugin=plugin,cut=cut,reverse=reverse):
                        h=self.fixture(plugin);t=self.transaction(h,plugin);n=[0]
                        def crash():
                            n[0]+=1
                            if n[0]==cut:raise InterruptedError('simulated process loss')
                        t.after_action=crash
                        with self.assertRaises(InterruptedError):t.run()
                        t=m.Transaction(h,plugin).load()
                        t.run(reverse=reverse)
                        self.assertEqual(t.state['phase'],'rolled_back' if reverse else 'migrated')

    def test_conflict_and_external_edit_preserved(self):
        h=self.fixture('fan-control')
        dst=h/'.local/libexec/mini-archipel/fan-control'
        self.put(dst/'foreign')
        with self.assertRaises(m.Failure):m.plan(m.Transaction(h,'fan-control'))
        h=self.fixture('proxy');t=self.transaction(h,'proxy');t.run()
        p=h/'.local/libexec/mini-archipel/proxy/backend.py';p.write_bytes(b'external edit')
        with self.assertRaises(m.Failure):t.run(reverse=True)
        self.assertEqual(p.read_bytes(),b'external edit')

    def test_unknown_alias_is_not_replaced(self):
        h=self.home();target=self.put(h/'target');alias=h/'alias';alias.symlink_to(target)
        with self.assertRaises(m.Failure):m.backend.atomic_write(alias,b'bad')
        self.assertTrue(alias.is_symlink());self.assertEqual(target.read_bytes(),b'original')

    def test_lock_contention_through_both_names(self):
        h=self.fixture('automation');t=self.transaction(h,'automation');t.run()
        import fcntl
        with (h/'.agent-chat-native.lock').open('r+') as fd:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            r=subprocess.run([os.sys.executable,'-c','import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(h/'.local/share/mini-archipel/automation/.agent-chat-native.lock')],capture_output=True)
            self.assertNotEqual(r.returncode,0)

    def test_screen_support_is_never_in_plan(self):
        h=self.fixture('screen-recording');t=self.transaction(h,'screen-recording')
        self.assertFalse(any('Application Support' in json.dumps(a) for a in t.actions))
        t.run();self.assertFalse((h/'.local/share/mini-archipel/screen-recording').exists())

    def test_uninstalled_plugin_remains_absent(self):
        for plugin in m.PLUGINS:
            h=self.home();self.assertFalse(m.plan(m.Transaction(h,plugin)));self.assertEqual(list(h.iterdir()),[])



class RuntimeGuards(unittest.TestCase):
    home = Layout.home
    put = Layout.put
    fixture = Layout.fixture
    transaction = Layout.transaction
    def test_busy_lock_rejects_without_renaming(self):
        import fcntl
        h=self.fixture('automation');t=self.transaction(h,'automation')
        with (h/'.agent-chat-native.lock').open('r+') as fd:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(m.Failure):
                with m.locks(t):pass
        self.assertFalse((h/'.local/libexec/mini-archipel/automation').exists())

    def test_active_job_is_not_recovered(self):
        h=self.fixture('automation');t=self.transaction(h,'automation')
        p=h/'.local/share/mini-archipel/desktop-automation/job.json'
        p.write_text('{"status":"queued"}')
        with self.assertRaises(m.Failure):
            with m.locks(t):pass
        self.assertEqual(p.read_text(),'{"status":"queued"}')

    def test_native_runner_keeps_legacy_job_url(self):
        from unittest.mock import patch
        import types
        runner_path=Path(__file__).resolve().parents[1]/'automation/runtime/agent-script-runner'
        ns={'__name__':'runner_test'}
        exec(compile(runner_path.read_text(),str(runner_path),'exec'),ns)
        h=self.fixture('automation');t=self.transaction(h,'automation');t.run()
        (h/'Applications/Mini Archipel Plugin - Automation.app').mkdir(parents=True)
        old=h/'.local/share/mini-archipel/desktop-automation/job.json'
        captured=[]
        def opened(argv,**kwargs):
            request=Path(argv[-1]);captured.append(json.loads(request.read_text()))
            (request.parent/'result.json').write_text('{"ok":true,"exit_code":0}')
            return types.SimpleNamespace(stderr='')
        with patch.object(Path,'home',return_value=h),patch.object(ns['subprocess'],'run',side_effect=opened):
            ns['launch'](types.SimpleNamespace(mode='input',job=str(old)))
        self.assertEqual(captured[0]['path'],str(old))

    def test_proxy_service_state_is_restored_on_retry(self):
        from unittest.mock import patch
        h=self.fixture('proxy');t=self.transaction(h,'proxy')
        with patch.object(m,'maintenance'),patch.object(m.backend,'service_info',return_value=None),patch.object(m.service_migration,'disabled',return_value=True),patch.object(m.proxy_install,'stop_service'),patch.object(m.proxy_install,'require_free_port'),patch.object(m.service_migration,'set_disabled') as disabled:
            m.migrate(t)
            disabled.assert_called_once()
            self.assertTrue(t.state['service_restored'])
            m.migrate(t,reverse=True)
            self.assertEqual(disabled.call_count,2)

    def test_missing_optional_worker_lock_stays_absent(self):
        h=self.fixture('automation')
        lock=h/'.local/share/mini-archipel/desktop-automation/.chat-worker.lock'
        lock.unlink()
        t=self.transaction(h,'automation')
        with m.locks(t):t.run()
        self.assertFalse(lock.exists())
        self.assertFalse((h/'.local/share/mini-archipel/automation/.chat-worker.lock').exists())

    def test_journal_cannot_write_or_move_ancestors(self):
        for op in ('write','move','hardlink'):
            h=self.fixture('fan-control');t=self.transaction(h,'fan-control')
            a={'op':op,'path':str(h.parent)} if op=='write' else {'op':op,'src':str(h.parent),'dst':str(h/'.local/libexec/mini-archipel/fan-control')}
            t.state['actions']=[a];t.save()
            with self.assertRaises(m.Failure):m.Transaction(h,'fan-control').load()

    def test_inherited_ci_fd_reuses_same_lock_and_rejects_foreign_inode(self):
        import fcntl
        h=self.fixture('automation');t=self.transaction(h,'automation')
        mutex=self.put(h/'.local/state/mini-archipel/ci/mutex',b'')
        with mutex.open('r+') as fd:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with m.locks(t,fd.fileno()):pass
            foreign=self.put(h/'other',b'')
            with foreign.open('r+') as bad:
                with self.assertRaises(m.Failure):
                    with m.locks(t,bad.fileno()):pass

if __name__=='__main__':unittest.main()
