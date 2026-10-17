#!/usr/bin/python3
"""Local fan-control authority. Root owns hardware; callers submit typed jobs over UDS."""
from __future__ import annotations

import argparse
import copy
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import subprocess
import threading
import time
import tempfile
import uuid

BASE = Path('/Library/MacMiniFanControl')
SETTINGS = Path('/Library/MiniArchipel/FanControl/control.json')
SOCKET = Path('/var/run/mini-archipel/fan-control.sock')
STATE = Path('/Library/Application Support/MiniArchipel/FanControl/state.json')
ACTIVE = {'queued', 'running', 'cancelling', 'restoring'}
NUMBERS = {
    'poll_interval': (.5, 10), 'alpha_up': (.01, 1), 'alpha_down': (.01, 1),
    'hysteresis': (0, 15), 'down_delay': (0, 300), 'up_delay': (0, 0),
    'slew_up': (0, 20000), 'slew_down': (0, 20000),
    'min_rpm': (100, 20000), 'max_rpm': (100, 20000), 'critical_temp': (40, 100),
}
POLICY_KEYS = set(NUMBERS) | {'curve', 'mode', 'aggregate', 'fans', 'sensors'}


class Failure(Exception):
    def __init__(self, code, detail='', status=400):
        super().__init__(detail or code)
        self.code, self.detail, self.status = code, detail, status


def now():
    return round(time.time() * 1000)


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise Failure('invalid_policy', f'number must be between {low} and {high}')
    return value


def keys(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise Failure('invalid_request', 'unexpected or missing fields')


def validate_policy(value, hardware=None):
    keys(value, POLICY_KEYS)
    for key, limits in NUMBERS.items():
        number(value[key], *limits)
    if value['mode'] != 'force' or value['aggregate'] not in ('max', 'mean'):
        raise Failure('unsupported_policy', 'this adapter requires force mode')
    if value['min_rpm'] > value['max_rpm']:
        raise Failure('invalid_policy', 'minimum exceeds maximum RPM')
    sensors = value['sensors']
    fans = value['fans']
    if not isinstance(sensors, list) or not 1 <= len(sensors) <= 64 or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z0-9]{4}', k) for k in sensors) or len(set(sensors)) != len(sensors):
        raise Failure('invalid_policy', 'select distinct explicit temperature keys')
    if not isinstance(fans, list) or not 1 <= len(fans) <= 8 or any(type(i) is not int or not 0 <= i < 8 for i in fans) or len(set(fans)) != len(fans):
        raise Failure('invalid_policy', 'select distinct fan indices')
    curve = value['curve']
    if not isinstance(curve, list) or not 2 <= len(curve) <= 16:
        raise Failure('invalid_policy', 'curve requires 2–16 steps')
    previous_t, previous_rpm = -1, -1
    for point in curve:
        keys(point, ('t', 'rpm'))
        t = number(point['t'], 0, value['critical_temp'])
        rpm = number(point['rpm'], value['min_rpm'], value['max_rpm'])
        if t <= previous_t or rpm < previous_rpm:
            raise Failure('invalid_policy', 'temperatures must increase; RPM must not decrease')
        previous_t, previous_rpm = t, rpm
    if curve[0] != {'t': 0, 'rpm': value['min_rpm']} or curve[-1]['rpm'] != value['max_rpm']:
        raise Failure('invalid_policy', 'curve must start at the system handback step and reach maximum RPM')
    if hardware:
        available = {f['idx']: f for f in hardware['fans']}
        if not set(fans) <= available.keys():
            raise Failure('invalid_policy', 'selected fan is unavailable')
        if value['min_rpm'] < 1000 or value['max_rpm'] > max(available[i]['max'] for i in fans):
            raise Failure('invalid_policy', 'RPM exceeds this node’s hardware limits')
        if not hardware.get('have_temp'):
            raise Failure('sensor_unavailable', status=409)
    return copy.deepcopy(value)


def parse_policy(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if '=' not in line:
            raise Failure('invalid_policy', 'invalid configuration line')
        key, value = (s.strip() for s in line.split('=', 1))
        if key in values or key not in POLICY_KEYS:
            raise Failure('invalid_policy', 'duplicate or unknown configuration field')
        if key in NUMBERS:
            try:
                values[key] = float(value)
            except ValueError as error:
                raise Failure('invalid_policy', 'invalid numeric field') from error
        elif key == 'curve':
            try:
                values[key] = [dict(zip(('t', 'rpm'), map(float, part.split(':')))) for part in value.split(',')]
            except ValueError as error:
                raise Failure('invalid_policy', 'invalid curve') from error
        elif key in ('sensors', 'fans'):
            values[key] = [int(v) if key == 'fans' else v for v in value.split(',')]
        else:
            values[key] = value
    return validate_policy(values)


def render_policy(policy):
    validate_policy(policy)
    values = dict(policy)
    values['curve'] = ','.join(f"{p['t']:g}:{p['rpm']:g}" for p in policy['curve'])
    values['sensors'] = ','.join(policy['sensors'])
    values['fans'] = ','.join(map(str, policy['fans']))
    return '# Managed by Mini Archipel fan-control\n' + ''.join(f'{k} = {values[k]}\n' for k in sorted(values))


def revision(text):
    return hashlib.sha256(text.encode()).hexdigest()


def identity(path):
    s = path.stat()
    return f'{s.st_ino}:{s.st_mtime_ns // 1_000_000_000}:{s.st_mtime_ns % 1_000_000_000}:{s.st_size}'


def atomic(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    temp = Path(name)
    os.fchmod(descriptor, mode)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def trusted(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise Failure('untrusted_installation', str(path), 503)


class Hardware:
    """Fixed-path local adapter. Its methods are also implemented by the test hardware."""
    def __init__(self):
        self.config = BASE / 'fanctl.conf'
        self.binary = BASE / 'fanctl'
        self.paused = BASE / 'fanctl.paused'
        self.runtime = BASE / 'fanctl.runtime.json'
        self.label = 'system/com.macmini.fan-control'
        self.plist = '/Library/LaunchDaemons/com.macmini.fan-control.plist'
        for path in (self.binary, self.config, Path(self.plist)):
            trusted(path)

    def command(self, *args, timeout=8):
        result = subprocess.run([str(self.binary), '-c', str(self.config), *map(str, args)],
                                capture_output=True, text=True, timeout=timeout, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})
        if result.returncode:
            raise Failure('hardware_command_failed', result.stderr[-2000:] or result.stdout[-2000:], 502)
        return result.stdout

    def read(self):
        reading = json.loads(self.command('-j', 'status'))
        sensors = json.loads(self.command('-j', 'temps'))
        pid = self.pid()
        try:
            runtime = json.loads(self.runtime.read_text())
            if runtime['pid'] != pid or now() - runtime['ts'] > 15000:
                runtime = None
        except (OSError, ValueError, KeyError):
            runtime = None
        return {'reading': reading, 'sensors': sensors, 'runtime': runtime, 'daemon_pid': pid,
                'service_running': pid is not None, 'paused': self.paused.exists()}

    def pid(self):
        result = subprocess.run(['/bin/launchctl', 'print', self.label], capture_output=True, text=True, timeout=5)
        found = re.search(r'\bpid = (\d+)', result.stdout)
        return int(found.group(1)) if found else None

    def service(self, action):
        loaded = subprocess.run(['/bin/launchctl', 'print', self.label], capture_output=True, timeout=5).returncode == 0
        if action == 'reload':
            subprocess.run(['/bin/launchctl', 'enable', self.label], check=True, timeout=5)
            args = ['kickstart', '-k', self.label] if loaded else ['bootstrap', 'system', self.plist]
        elif action == 'stop':
            self.command('auto')
            subprocess.run(['/bin/launchctl', 'disable', self.label], check=True, timeout=5)
            if loaded:
                subprocess.run(['/bin/launchctl', 'bootout', self.label], check=True, timeout=10)
            return
        else:
            subprocess.run(['/bin/launchctl', 'enable', self.label], check=True, timeout=5)
            if self.pid():
                return
            args = ['kickstart', self.label] if loaded else ['bootstrap', 'system', self.plist]
        subprocess.run(['/bin/launchctl', *args], check=True, timeout=10)

    def pause(self):
        self.command('pause')
        time.sleep(.05)
        self.command('auto')
        # Acknowledged by the actual control loop, not just the pause file.
        until = time.monotonic() + 12
        while self.pid() and time.monotonic() < until:
            data = self.read()
            if data['runtime'] and data['runtime']['paused']:
                return
            time.sleep(.1)
        if self.pid():
            raise Failure('daemon_unresponsive', status=503)

    def restore(self, was_paused):
        self.command('auto')
        reading = json.loads(self.command('-j', 'status'))
        if reading.get('forced'):
            raise Failure('restore_failed', status=502)
        if not was_paused:
            self.command('resume')

    def applied(self):
        data = self.read()
        return bool(data['runtime'] and data['runtime']['config_identity'] == identity(self.config))

    def process(self, args):
        return subprocess.Popen([str(self.binary), '-c', str(self.config), '-j', *map(str, args)],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                start_new_session=False, env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'})


class Controller:
    def __init__(self, hardware, state_path, settings):
        self.hardware, self.path, self.settings = hardware, state_path, settings
        self.lock = threading.RLock()
        self.cancelled = threading.Event()
        self.stop = threading.Event()
        self.worker = None
        self.child = None
        self.telemetry = None
        self.last_error = None
        self.samples = []
        self.state = {'jobs': [], 'revisions': [], 'events': []}
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text())
                if not isinstance(state, dict) or any(not isinstance(state.get(k), list) for k in self.state):
                    raise ValueError('invalid state')
                self.state = state
            except (ValueError, OSError):
                # A damaged journal must not leave a bounded override running indefinitely.
                hardware.restore(False)
                hardware.service('start')
                state_path.rename(state_path.with_name(f'state.corrupt.{now()}.json'))
                self.state['events'].append({'ts': now(), 'kind': 'journal_recovered', 'job_id': None})
        for job in self.state['jobs']:
            if job['status'] in ACTIVE:
                # launchd kills remaining process-group children before restarting this helper.
                if job.get('previous_config') is not None:
                    atomic(hardware.config, job['previous_config'], 0o644)
                    hardware.service('reload')
                if job.get('was_paused') is not None:
                    hardware.restore(job['was_paused'])
                job.update(status='interrupted', finished_at=now(), restored=True)
        self.save()
        self.refresh()

    def save(self):
        atomic(self.path, json.dumps(self.state, allow_nan=False))

    def event(self, kind, job_id=None):
        with self.lock:
            self.state['events'].append({'ts': now(), 'kind': kind, 'job_id': job_id})
            self.state['events'] = self.state['events'][-128:]
            self.save()

    def refresh(self):
        try:
            data = self.hardware.read()
            with self.lock:
                self.telemetry, self.last_error = data, None
                r = data['reading']
                self.samples.append({'ts': now(), 'temp': (data.get('runtime') or {}).get('control_temp') if r.get('have_temp') else None,
                                     'peak': r.get('peak') if r.get('have_temp') else None,
                                     'rpm': r.get('rpm'), 'target': r.get('target')})
                self.samples = self.samples[-300:]
        except Exception as error:
            with self.lock:
                self.last_error = str(error)[:500]

    def read(self):
        with self.lock:
            text = self.hardware.config.read_text()
            jobs = copy.deepcopy(self.state['jobs'][-32:])
            for job in jobs:
                job.pop('previous_config', None)
                job.pop('digest', None)
                job['log'] = job['log'][-8192:]
                if job is not jobs[-1] and job['action'] in ('dump', 'keyinfo', 'trywrite'):
                    job['result'] = None
            return copy.deepcopy({
                'availability': 'ready', 'reason': None, 'revision': revision(text),
                'policy': parse_policy(text), 'telemetry': self.telemetry,
                'telemetry_error': self.last_error, 'sampled_at': self.samples[-1]['ts'] if self.samples else 0,
                'samples': self.samples, 'jobs': jobs,
                'revisions': [{'revision': r['revision'], 'ts': r['ts'], 'policy': parse_policy(r['text'])} for r in self.state['revisions'][-20:]],
                'events': self.state['events'][-64:],
                'capabilities': {'curve_modes': ['force'], 'rise_delay': False,
                                 'sensor_auto': False, 'floor': False,
                                 'write_keys': self.settings.get('write_keys', []),
                                 'max_steps': 16, 'manual_max_seconds': 900},
            })

    def validate(self, action, data):
        if action == 'apply':
            keys(data, ('policy',))
            validate_policy(data['policy'], (self.telemetry or {}).get('reading'))
        elif action == 'rollback':
            keys(data, ('revision',))
            if not any(r['revision'] == data['revision'] for r in self.state['revisions']):
                raise Failure('revision_not_found', status=404)
        elif action in ('system', 'curve'):
            keys(data, ())
        elif action == 'service':
            keys(data, ('operation',))
            if data['operation'] not in ('start', 'stop', 'reload'):
                raise Failure('invalid_request')
        elif action == 'manual':
            keys(data, ('rpm', 'seconds', 'method'))
            policy = parse_policy(self.hardware.config.read_text())
            number(data['rpm'], policy['min_rpm'], policy['max_rpm'])
            number(data['seconds'], 5, 900)
            if data['method'] != 'force':
                raise Failure('unsupported_policy', 'floor mode is unavailable on the M6 adapter')
        elif action in ('selftest', 'calibrate', 'calibrate-dry', 'simulate'):
            keys(data, ('cap',) if action.startswith('calibrate') else ('seconds',) if action == 'simulate' else ())
            if action.startswith('calibrate'):
                number(data['cap'], 40, min(95, parse_policy(self.hardware.config.read_text())['critical_temp'] - 5))
            if action == 'simulate':
                number(data['seconds'], 5, 60)
        elif action == 'dump':
            keys(data, ('prefix',))
            if not isinstance(data['prefix'], str) or not re.fullmatch(r'[A-Za-z0-9]{2}', data['prefix']):
                raise Failure('invalid_request')
        elif action == 'keyinfo':
            keys(data, ('keys',))
            if not isinstance(data['keys'], list) or not 1 <= len(data['keys']) <= 32 or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z0-9#]{4}', k) for k in data['keys']):
                raise Failure('invalid_request')
        elif action == 'trywrite':
            keys(data, ('key', 'value', 'expected_value'))
            if data['key'] not in self.settings.get('write_keys', []):
                raise Failure('diagnostic_write_denied', status=403)
            policy = parse_policy(self.hardware.config.read_text())
            if re.fullmatch(r'F[0-7](?:Md|md)', data['key']):
                number(data['value'], 0, 1)
            elif re.fullmatch(r'F[0-7]Tg', data['key']):
                number(data['value'], policy['min_rpm'], policy['max_rpm'])
            else:
                raise Failure('diagnostic_write_denied', status=403)
            number(data['expected_value'], 0, 20000)
        else:
            raise Failure('unknown_action', status=404)

    def submit(self, request):
        keys(request, ('op', 'request_id', 'expected_revision', 'action', 'data'))
        if not isinstance(request['request_id'], str) or not re.fullmatch(r'[A-Za-z0-9-]{8,80}', request['request_id']):
            raise Failure('invalid_request')
        digest = revision(json.dumps(request, sort_keys=True))
        with self.lock:
            for job in self.state['jobs']:
                if job['id'] == request['request_id']:
                    if job['digest'] != digest:
                        raise Failure('request_id_conflict', status=409)
                    return {'ok': True, 'job_id': job['id']}
            if self.stop.is_set():
                raise Failure('shutting_down', status=503)
            if any(j['status'] in ACTIVE for j in self.state['jobs']):
                raise Failure('task_active', status=409)
            text = self.hardware.config.read_text()
            if revision(text) != request['expected_revision']:
                raise Failure('revision_conflict', status=409)
            self.validate(request['action'], request['data'])
            job = {'id': request['request_id'], 'digest': digest, 'action': request['action'],
                   'status': 'queued', 'requested_at': now(), 'started_at': None, 'finished_at': None,
                   'phase': 'queued', 'progress': 0, 'total': 0, 'log': '', 'result': None,
                   'error': None, 'restored': None, 'was_paused': None, 'expires_at': None}
            self.state['jobs'] = (self.state['jobs'] + [job])[-32:]
            self.cancelled.clear()
            try:
                self.save()
            except OSError as error:
                self.state['jobs'].remove(job)
                raise Failure('state_save_failed', status=503) from error
            self.worker = threading.Thread(target=self.execute, args=(job, copy.deepcopy(request)), daemon=True)
            self.worker.start()
            return {'ok': True, 'job_id': job['id']}

    def cancel(self, request):
        keys(request, ('op', 'job_id'), ('system',))
        with self.lock:
            job = next((j for j in self.state['jobs'] if j['id'] == request['job_id']), None)
            if job is None:
                raise Failure('job_not_found', status=404)
            if job['status'] in ACTIVE:
                job['status'] = 'cancelling'
                if request.get('system') is True:
                    job['return_system'] = True
                self.cancelled.set()
                try:
                    self.save()
                except OSError:
                    job['log'] += '\nstate_save_failed during cancellation'
            return {'ok': True, 'job_id': job['id']}

    def checked(self):
        if self.cancelled.is_set() or self.stop.is_set():
            raise Failure('cancelled', status=409)
        if self.last_error or not self.telemetry or now() - self.samples[-1]['ts'] > 15000 or not self.telemetry['reading'].get('have_temp'):
            raise Failure('sensor_unavailable', status=503)
        if self.telemetry['reading']['peak'] >= self.telemetry['reading']['critical_temp']:
            raise Failure('thermal_guard', status=409)

    def update(self, job, **fields):
        with self.lock:
            job.update(fields)
            self.save()

    def run_process(self, job, args, seconds):
        child = self.hardware.process(args)
        self.child = child
        output = []
        def drain():
            for line in child.stdout:
                with self.lock:
                    job['log'] = (job['log'] + line)[-64000:]
                try:
                    event = json.loads(line)
                    if isinstance(event, dict):
                        output.append(event)
                        if event.get('type') == 'progress':
                            self.update(job, phase=event.get('phase', 'running'), progress=event.get('step', 0), total=event.get('total', 0))
                except ValueError:
                    pass
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        deadline = time.monotonic() + seconds
        try:
            while child.poll() is None:
                self.checked()
                if time.monotonic() > deadline:
                    raise Failure('task_timeout', status=504)
                time.sleep(.1)
            reader.join(timeout=2)
            if child.returncode:
                raise Failure('task_failed', f'exit {child.returncode}', 502)
            return output
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=4)
            reader.join(timeout=2)
            child.stdout.close()
            self.child = None

    def apply(self, job, text):
        original = self.hardware.config.read_text()
        validate_policy(parse_policy(text), self.telemetry['reading'])
        with self.lock:
            self.state['revisions'].append({'revision': revision(original), 'text': original, 'ts': now()})
            self.state['revisions'] = self.state['revisions'][-20:]
            job['previous_config'] = original
            self.save()
        try:
            atomic(self.hardware.config, text, 0o644)
            self.hardware.service('reload')
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if self.cancelled.is_set():
                    raise Failure('cancelled', status=409)
                if self.hardware.applied():
                    return {'revision': revision(text)}
                time.sleep(.1)
            raise Failure('apply_not_confirmed', status=502)
        except Exception:
            atomic(self.hardware.config, original, 0o644)
            self.hardware.service('reload')
            raise

    def execute(self, job, request):
        paused_for_task = False
        error = None
        result = None
        try:
            self.update(job, status='running', phase='starting', started_at=now())
            action, data = request['action'], request['data']
            if revision(self.hardware.config.read_text()) != request['expected_revision']:
                raise Failure('revision_conflict', status=409)
            if self.cancelled.is_set():
                raise Failure('cancelled', status=409)
            if action in ('manual', 'selftest', 'calibrate', 'calibrate-dry', 'trywrite'):
                self.checked()
            if action in ('apply', 'rollback'):
                text = render_policy(data['policy']) if action == 'apply' else next(r['text'] for r in self.state['revisions'] if r['revision'] == data['revision'])
                result = self.apply(job, text)
            elif action in ('system', 'curve'):
                if action == 'system':
                    self.hardware.pause()
                else:
                    self.hardware.service('start')
                    self.hardware.command('resume')
                result = {'mode': action}
            elif action == 'service':
                self.hardware.service(data['operation'])
                result = {'operation': data['operation']}
            elif action in ('dump', 'keyinfo', 'simulate', 'calibrate-dry'):
                args = ['dump', data['prefix']] if action == 'dump' else ['keyinfo', *data['keys']] if action == 'keyinfo' else ['-n', 'calibrate', str(data['cap'])] if action == 'calibrate-dry' else ['-n', '-v', 'daemon']
                if action == 'simulate':
                    try:
                        result = self.run_process(job, args, data['seconds'])
                    except Failure as failure:
                        if failure.code != 'task_timeout':
                            raise
                        result = {'seconds': data['seconds'], 'writes_hardware': False}
                else:
                    result = self.run_process(job, args, 120 if action == 'calibrate-dry' else 30)
            else:
                previous = self.hardware.paused.exists()
                self.update(job, was_paused=previous)
                paused_for_task = True
                self.hardware.pause()
                if action == 'manual':
                    expires = now() + round(data['seconds'] * 1000)
                    self.update(job, phase='manual', expires_at=expires)
                    self.hardware.command('force', str(data['rpm']))
                    while now() < expires:
                        self.checked()
                        time.sleep(.1)
                    result = {'rpm': data['rpm'], 'seconds': data['seconds']}
                elif action == 'trywrite':
                    current = json.loads(self.hardware.command('-j', 'keyinfo', data['key']))[0]
                    if current.get('value') is None or abs(current['value'] - data['expected_value']) > 1:
                        raise Failure('key_value_changed', status=409)
                    result = self.run_process(job, ['trywrite', data['key'], str(data['value'])], 15)
                else:
                    args = ['selftest'] if action == 'selftest' else (['-n'] if action == 'calibrate-dry' else []) + ['calibrate', str(data['cap'])]
                    result = self.run_process(job, args, 480 if action == 'calibrate' else 120 if action == 'calibrate-dry' else 240)
        except Exception as failure:
            error = failure.code if isinstance(failure, Failure) else 'operation_failed'
            with self.lock:
                job['log'] = (job['log'] + '\n' + str(failure))[-64000:]
        finally:
            # Never make hardware recovery depend on a working filesystem.
            if paused_for_task:
                with self.lock:
                    job.update(status='restoring', phase='restoring')
                try:
                    self.hardware.restore(job.get('return_system', False) or job.get('was_paused', False))
                    job['restored'] = True
                except Exception as failure:
                    error = 'restore_failed'
                    job.update(restored=False, log=(job['log'] + '\n' + str(failure))[-64000:])
            if job.get('return_system'):
                try:
                    self.hardware.pause()
                    job['restored'] = True
                except Exception:
                    error = 'restore_failed'
                    job['restored'] = False
            self.refresh()
            with self.lock:
                job.update(status='cancelled' if error == 'cancelled' else 'failed' if error else 'completed',
                           phase='finished', error=error, result=result, finished_at=now())
                try:
                    self.event(job['status'], job['id'])
                except OSError:
                    job.update(status='failed', error='state_save_failed')

    def close(self):
        self.stop.set()
        self.cancelled.set()
        if self.worker:
            self.worker.join(timeout=12)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, controller, path, uid, gid):
        self.controller, self.uid = controller, uid
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
            raise Failure('untrusted_installation', 'socket directory ownership or permissions')
        # launchd uses umask 077; mkdir(mode=0755) alone would leave this 0700.
        os.chmod(path.parent, 0o755)
        if path.exists():
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise Failure('untrusted_installation', 'socket path is not a socket')
            path.unlink()
        super().__init__(str(path), Handler)
        os.chmod(path, 0o660)
        os.chown(path, os.geteuid(), gid)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        lib = ctypes.CDLL(None, use_errno=True)
        lib.getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        if lib.getpeereid(self.connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0 or uid.value not in (0, self.server.uid):
            return
        try:
            raw = self.rfile.readline(65537)
            if len(raw) > 65536 or not raw.endswith(b'\n'):
                raise Failure('invalid_request')
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise Failure('invalid_request')
            if request.get('op') == 'read':
                keys(request, ('op',))
                result = {'ok': True, 'data': self.server.controller.read()}
            elif request.get('op') == 'command':
                result = self.server.controller.submit(request)
            elif request.get('op') == 'cancel':
                result = self.server.controller.cancel(request)
            else:
                raise Failure('invalid_request')
            response = result
        except Failure as failure:
            response = {'ok': False, 'status': failure.status, 'error': failure.code, 'detail': failure.detail}
        except Exception:
            response = {'ok': False, 'status': 500, 'error': 'operation_failed'}
        self.wfile.write(json.dumps(response, allow_nan=False).encode() + b'\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--settings', type=Path, default=SETTINGS)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('fan-control authority requires root installation')
    trusted(args.settings)
    settings = json.loads(args.settings.read_text())
    controller = Controller(Hardware(), STATE, settings)
    server = Server(controller, SOCKET, settings['agent_uid'], settings['agent_gid'])
    def finish(_sig, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    def poll():
        while not controller.stop.wait(1):
            controller.refresh()
    threading.Thread(target=poll, daemon=True).start()
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        controller.close()
        server.server_close()
        SOCKET.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
