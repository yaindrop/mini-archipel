import importlib.util
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "signing_backup", Path(__file__).parents[1] / "backup-signing.py"
)
signing_backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing_backup)


class SigningBackupTests(unittest.TestCase):
    def test_encrypted_archive_restores_all_material_without_plaintext_archives(self):
        with tempfile.TemporaryDirectory() as work:
            home = Path(work)
            material = home / ".local/share/mini-archipel/signing"
            material.mkdir(parents=True)
            files = {
                name: ("fixture-only-" + name).encode()
                for name in ("identity.pem", "identity-key.pem", "keychain-password")
            }
            for name, value in files.items():
                (material / name).write_bytes(value)
            keychain = home / "Library/Keychains/mini-archipel-signing.keychain-db"
            keychain.parent.mkdir(parents=True)
            keychain.write_bytes(b"fixture-keychain")
            cert, key = home / "recipient.crt", home / "recipient.key"
            subprocess.run(
                [
                    "/usr/bin/openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "1",
                    "-subj",
                    "/CN=Fixture/",
                    "-keyout",
                    str(key),
                    "-out",
                    str(cert),
                ],
                check=True,
                capture_output=True,
            )
            destination = home / "encrypted"
            archive = signing_backup.backup(home, cert, destination)
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(destination.iterdir()), [archive])
            self.assertNotIn(b"fixture-only", archive.read_bytes())
            plain = subprocess.check_output(
                [
                    "/usr/bin/openssl",
                    "cms",
                    "-decrypt",
                    "-binary",
                    "-inform",
                    "DER",
                    "-in",
                    str(archive),
                    "-inkey",
                    str(key),
                ],
                stderr=subprocess.DEVNULL,
            )
            with tarfile.open(fileobj=io.BytesIO(plain), mode="r:gz") as restored:
                for name, value in files.items():
                    self.assertEqual(
                        restored.extractfile(
                            ".local/share/mini-archipel/signing/" + name
                        ).read(),
                        value,
                    )
                self.assertEqual(
                    restored.extractfile(
                        "Library/Keychains/mini-archipel-signing.keychain-db"
                    ).read(),
                    b"fixture-keychain",
                )

    def test_missing_material_does_not_create_an_empty_successful_backup(self):
        with tempfile.TemporaryDirectory() as work:
            home = Path(work)
            destination = home / "encrypted"
            with self.assertRaises(RuntimeError):
                signing_backup.backup(home, home / "missing.crt", destination)
            self.assertFalse(destination.exists())
