#!/usr/bin/python3
"""Prepare a private per-project signing identity without installing a trusted root.

The keychain password travels over stdin, never in argv or logs. The private key
and keychain remain outside the checkout; no privacy database is modified.
"""
from pathlib import Path
import os,secrets,subprocess,shlex
folder=Path.home()/'.local/share/mini-archipel/signing'
folder.mkdir(parents=True,exist_ok=True,mode=0o700)
keychain=Path.home()/'Library/Keychains/mini-archipel-signing.keychain-db'
password=folder/'keychain-password'
def security(*args):
    command=' '.join(shlex.quote(str(v)) for v in args)
    result=subprocess.run(['/usr/bin/security','-i'],input=command+'\n',text=True,capture_output=True)
    if result.returncode and 'already exists' not in result.stderr:
        raise SystemExit('Code signing step failed: '+str(args[0])+' (private diagnostics withheld)')
if not password.exists():
    password.write_text(secrets.token_urlsafe(40));password.chmod(0o600)
pw=password.read_text()
if not keychain.exists():security('create-keychain','-p',pw,keychain)
security('unlock-keychain','-p',pw,keychain)
cert=folder/'identity.pem';key=folder/'identity-key.pem'
if not cert.exists():
    subprocess.run(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-days','3650','-subj','/CN=Mini Archipel Local Code Signing/','-addext','keyUsage=critical,digitalSignature','-addext','extendedKeyUsage=critical,codeSigning','-addext','basicConstraints=critical,CA:FALSE','-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
    key.chmod(0o600);cert.chmod(0o644)
legacy=folder/'identity-rsa.pem'
if not legacy.exists():
    subprocess.run(['openssl','rsa','-in',str(key),'-traditional','-out',str(legacy)],check=True,capture_output=True)
    legacy.chmod(0o600)
security('import',cert,'-k',keychain,'-t','cert','-f','x509')
security('import',legacy,'-k',keychain,'-t','priv','-f','openssl','-T','/usr/bin/codesign','-x')
security('set-key-partition-list','-S','apple-tool:,apple:','-s','-k',pw,keychain)
print('Scoped local signing identity prepared; no trust roots or privacy permissions changed.')
