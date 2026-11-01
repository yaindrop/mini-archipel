"""Runs the authority against real files/processes and substituted hardware; no SMC access."""
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import socket
import threading
import unittest
from unittest.mock import patch

spec = spec_from_file_location('fan_control', Path(__file__).parents[1] / 'control.py')
control = module_from_spec(spec)
spec.loader.exec_module(control)
BASELINE = (Path(__file__).parents[1] / 'config/fanctl.conf').read_text()


class Hardware:
    def __init__(self, root):
        self.config = root / 'fanctl.conf'
        self.config.write_text(BASELINE)
        self.paused = root / 'paused'
        self.forced = False
        self.rpm = 1000
        self.peak = 34
        self.fail_apply = False
        self.restores = 0
        self.processes = []

    def read(self):
        p = control.parse_policy(self.config.read_text())
        r = dict(ok=True, have_temp=True, peak=self.peak, temp=self.peak, peak_sensor='Tp05', nsensors=len(p['sensors']),
                 rpm=self.rpm, target=self.rpm, min_rpm=1000, max_rpm=4900, forced=self.forced,
                 paused=self.paused.exists(), level=0, critical_temp=70,
                 fans=[dict(idx=0, rpm=self.rpm, target=self.rpm, max=4900)])
        return dict(reading=r, sensors=[dict(key=k, temp=self.peak) for k in p['sensors']],
                    runtime=dict(pid=1, ts=control.now(), config_identity=control.identity(self.config), control_temp=self.peak,
                                 raw_temp=self.peak, peak=self.peak, level=0, command_rpm=1000, target_rpm=1000,
                                 emergency=False, paused=self.paused.exists(), down_remaining=[30]*4),
                    daemon_pid=1, service_running=True, paused=self.paused.exists())

    def command(self, *args):
        if args[0] == 'force':
            self.forced, self.rpm = True, float(args[1])
        elif args[0] == 'resume':
            self.paused.unlink(missing_ok=True)
        elif args[0] == 'auto':
            self.forced = False
        elif args[0] == '-j' and args[1] == 'keyinfo':
            return json.dumps([dict(key=args[2], value=self.rpm)])
        return ''

    def pause(self):
        self.paused.touch()
        self.forced = False

    def restore(self, paused):
        self.restores += 1
        self.forced = False
        if paused:
            self.paused.touch()
        else:
            self.paused.unlink(missing_ok=True)

    def applied(self):
        return not self.fail_apply

    def service(self, action):
        if action == 'reload' and self.fail_apply:
            self.fail_apply = False
            raise RuntimeError('injected reload failure')

    def process(self, args):
        if args[0] == 'selftest':
            code = 'import time,json; print(json.dumps({"type":"progress","phase":"selftest","step":1,"total":4}),flush=True); time.sleep(30)'
        else:
            code = 'import json; print(json.dumps({"type":"calibration","valid":False,"dry_run":True,"curve":None}),flush=True)'
        child = subprocess.Popen([sys.executable, '-I', '-u', '-c', code], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True)
        self.processes.append(child)
        return child


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.hardware = Hardware(self.root)
        self.controller = control.Controller(self.hardware, self.root/'state.json', {'write_keys': ['F0Tg', 'F0md']})
        self.counter = 0

    def tearDown(self):
        self.controller.close()
        self.temp.cleanup()

    def request(self, action, data=None, **changes):
        self.counter += 1
        r = dict(op='command', request_id=f'request-{self.counter:04}', expected_revision=control.revision(self.hardware.config.read_text()),
                 action=action, data={} if data is None else data)
        return {**r, **changes}

    def finished(self):
        until = time.monotonic() + 5
        while time.monotonic() < until:
            job = self.controller.read()['jobs'][-1]
            if job['status'] not in control.ACTIVE:
                return job
            time.sleep(.01)
        self.fail('task did not finish')

    def test_strict_policy_roundtrip_and_boundaries(self):
        policy = control.parse_policy(BASELINE)
        self.assertEqual(control.parse_policy(control.render_policy(policy)), policy)
        for patch in [dict(curve=[{'t': 0, 'rpm': 1000}, {'t': 50, 'rpm': 4900}, {'t': 40, 'rpm': 4900}]),
                      dict(critical_temp=float('nan')), dict(min_rpm=True), dict(sensors=['Tp05', 'Tp05']),
                      dict(mode='floor'), dict(up_delay=1), dict(max_rpm=float('inf')), dict(fans=[-1]),
                      dict(curve=[{'t': 0, 'rpm': 1000}, {'t': 70, 'rpm': 2950}])]:
            with self.subTest(patch=patch), self.assertRaises(control.Failure):
                control.validate_policy({**policy, **patch})
        self.assertEqual(self.hardware.config.read_text(), BASELINE)

    def test_revision_idempotency_apply_and_rollback(self):
        policy = control.parse_policy(BASELINE)
        policy['down_delay'] = 25
        request = self.request('apply', {'policy': policy})
        receipt = self.controller.submit(request)
        self.assertEqual(self.controller.submit(request), receipt)
        job = self.finished()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(control.parse_policy(self.hardware.config.read_text())['down_delay'], 25)
        with self.assertRaises(control.Failure) as conflict:
            self.controller.submit(self.request('apply', {'policy': policy}, expected_revision='stale'))
        self.assertEqual(conflict.exception.code, 'revision_conflict')
        self.controller.submit(self.request('rollback', {'revision': control.revision(BASELINE)}))
        self.assertEqual(self.finished()['status'], 'completed')
        self.assertEqual(self.hardware.config.read_text(), BASELINE)
        self.assertEqual((self.root/'state.json').stat().st_mode & 0o777, 0o600)

    def test_failed_reload_restores_exact_original(self):
        policy = control.parse_policy(BASELINE)
        policy['down_delay'] = 25
        self.hardware.fail_apply = True
        self.controller.submit(self.request('apply', {'policy': policy}))
        self.assertEqual(self.finished()['status'], 'failed')
        self.assertEqual(self.hardware.config.read_text(), BASELINE)

    def test_long_task_is_nonblocking_cancellable_and_reaped(self):
        started = time.monotonic()
        receipt = self.controller.submit(self.request('selftest'))
        self.assertLess(time.monotonic()-started, .2)
        until = time.monotonic()+2
        while not self.hardware.processes and time.monotonic() < until:
            time.sleep(.01)
        with self.assertRaises(control.Failure) as busy:
            self.controller.submit(self.request('manual', {'method': 'force', 'rpm': 2170, 'seconds': 5}))
        self.assertEqual(busy.exception.code, 'task_active')
        self.assertEqual(control.Controller(self.hardware, self.root/'reader.json', {}).read()['revision'], control.revision(BASELINE))
        self.controller.cancel(dict(op='cancel', job_id=receipt['job_id']))
        done = self.finished()
        self.assertEqual(done['status'], 'cancelled')
        self.assertTrue(done['restored'])
        self.assertFalse(self.hardware.forced)
        self.assertIsNotNone(self.hardware.processes[0].poll())
        self.assertFalse(self.hardware.paused.exists())

    def test_manual_lease_thermal_guard_and_system_recovery(self):
        receipt = self.controller.submit(self.request('manual', {'method': 'force', 'rpm': 2170, 'seconds': 5}))
        until = time.monotonic()+2
        while not self.hardware.forced and time.monotonic() < until:
            time.sleep(.01)
        self.assertTrue(self.hardware.forced)
        self.hardware.peak = 71
        self.controller.refresh()
        done = self.finished()
        self.assertEqual(done['error'], 'thermal_guard')
        self.assertTrue(done['restored'])
        self.assertFalse(self.hardware.forced)
        self.controller.submit(self.request('system'))
        self.assertEqual(self.finished()['status'], 'completed')
        self.assertTrue(self.hardware.paused.exists())
        self.controller.cancel(dict(op='cancel', job_id=receipt['job_id']))

    def test_crash_recovery_restores_interrupted_operation(self):
        self.hardware.paused.touch()
        state = self.controller.state
        state['jobs'].append(dict(id='crashed-job', status='running', action='manual', was_paused=False))
        self.controller.save()
        recovered = control.Controller(self.hardware, self.root/'state.json', {})
        self.assertEqual(recovered.state['jobs'][-1]['status'], 'interrupted')
        self.assertFalse(self.hardware.paused.exists())
        recovered.close()

    def test_disk_failure_cannot_prevent_cancellation_or_hardware_restore(self):
        receipt = self.controller.submit(self.request('manual', {'method': 'force', 'rpm': 2170, 'seconds': 5}))
        until = time.monotonic()+2
        while not self.hardware.forced and time.monotonic() < until:
            time.sleep(.01)
        self.assertTrue(self.hardware.forced)
        with patch.object(self.controller, 'save', side_effect=OSError('disk full')):
            self.controller.cancel(dict(op='cancel', job_id=receipt['job_id']))
            done = self.finished()
        self.assertTrue(done['restored'])
        self.assertFalse(self.hardware.forced)
        self.assertFalse(self.hardware.paused.exists())
        self.assertEqual(done['status'], 'failed')
        self.assertEqual(done['error'], 'state_save_failed')

    def test_unpersisted_submission_does_not_leave_a_ghost_job(self):
        with patch.object(self.controller, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(control.Failure):
                self.controller.submit(self.request('selftest'))
        self.assertFalse(self.controller.state['jobs'])
        self.assertFalse(self.hardware.processes)

    def test_pause_failure_still_restores_hardware(self):
        def fail():
            self.hardware.paused.touch()
            raise control.Failure('daemon_unresponsive')
        with patch.object(self.hardware, 'pause', side_effect=fail):
            self.controller.submit(self.request('selftest'))
            done = self.finished()
        self.assertTrue(done['restored'])
        self.assertFalse(self.hardware.paused.exists())

    def test_corrupt_journal_recovers_curve_instead_of_leaving_manual_mode(self):
        self.hardware.forced = True
        self.hardware.paused.touch()
        path = self.root/'broken.json'
        path.write_text('{')
        recovered = control.Controller(self.hardware, path, {})
        self.assertFalse(self.hardware.forced)
        self.assertFalse(self.hardware.paused.exists())
        self.assertEqual(recovered.state['events'][-1]['kind'], 'journal_recovered')
        recovered.close()

    def test_manual_lease_expires_without_a_browser(self):
        self.controller.submit(self.request('manual', {'method': 'force', 'rpm': 2170, 'seconds': 5}))
        until = time.monotonic()+2
        while not self.hardware.forced and time.monotonic() < until:
            time.sleep(.01)
        self.assertTrue(self.hardware.forced)
        with patch.object(control, 'now', return_value=control.now()+6000):
            done = self.finished()
        self.assertEqual(done['status'], 'completed')
        self.assertTrue(done['restored'])
        self.assertFalse(self.hardware.forced)

    def test_rpc_peer_identity_and_bounded_request_frames(self):
        path = self.root/'ipc'/'control.sock'
        mask = os.umask(0o077)
        try:
            server = control.Server(self.controller, path, os.getuid(), os.getgid())
        finally:
            os.umask(mask)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o755)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def call(payload, send=True):
            with socket.socket(socket.AF_UNIX) as peer:
                peer.settimeout(2)
                peer.connect(str(path))
                if send:
                    peer.sendall(payload)
                response = b''
                while True:
                    part = peer.recv(65536)
                    if not part: break
                    response += part
                return response
        try:
            self.assertTrue(json.loads(call(b'{"op":"read"}\n'))['ok'])
            self.assertEqual(path.stat().st_mode & 0o777, 0o660)
            self.assertEqual(json.loads(call(b'{"op":"shell"}\n'))['error'], 'invalid_request')
            self.assertEqual(json.loads(call(b'x'*65537+b'\n'))['error'], 'invalid_request')
            server.uid = os.getuid()+1
            # Identity rejection must close before receiving any request bytes.
            self.assertEqual(call(b'', send=False), b'')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_launchd_replacement_waits_for_asynchronous_removal(self):
        helper = Path(__file__).parents[1]/'deploy/services.sh'
        script = r'''
set -euo pipefail
source "$1"
root="$2"
echo 4 > "$root/count"
launchctl() {
    case "$1" in
      print) local count; count=$(cat "$root/count"); if ((count>0)); then echo $((count-1)) > "$root/count"; return 0; else return 1; fi ;;
      bootstrap) test "$(cat "$root/count")" = 0; echo started > "$root/started" ;;
      enable|bootout) return 0 ;;
    esac
}
sleep() { :; }
stop_service test.service
start_service test.service
test -f "$root/started"
'''
        subprocess.run(['/bin/bash', '-c', script, 'test', str(helper), str(self.root)], check=True)

    def test_higher_policy_minimum_does_not_prevent_rollback_to_hardware_minimum(self):
        policy = control.parse_policy(BASELINE)
        reading = self.hardware.read()['reading']
        reading['min_rpm'] = 2000
        self.assertEqual(control.validate_policy(policy, reading)['min_rpm'], 1000)

    def test_diagnostics_are_scoped_and_numeric_inputs_reject_nan(self):
        for action, data in [('trywrite', dict(key='F0Mn', value=1000, expected_value=1000)),
                             ('trywrite', dict(key='F0Tg', value=float('nan'), expected_value=1000)),
                             ('dump', dict(prefix=';x')), ('keyinfo', dict(keys=['../../etc'])),
                             ('service', dict(operation='shell'))]:
            with self.subTest(action=action), self.assertRaises(control.Failure):
                self.controller.submit(self.request(action, data))
        self.controller.submit(self.request('calibrate-dry', {'cap': 65}))
        self.assertEqual(self.finished()['status'], 'completed')
        self.assertEqual(self.hardware.restores, 0)


if __name__ == '__main__':
    unittest.main()
