"""Reproduce the larger-checkout benchmark with a local CPython v3.11.9 clone."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

here = Path(__file__).resolve().parent
if sys.version_info[:2] != (3, 11) or len(sys.argv) != 2:
    sys.exit("Use Python 3.11 and supply the path to a local CPython v3.11.9 clone")
for key in list(os.environ):
    if key.upper().startswith("GIT_"):
        del os.environ[key]
os.environ.update(GIT_CONFIG_NOSYSTEM="1", GIT_ATTR_NOSYSTEM="1",
                  GIT_CONFIG_GLOBAL=str(here.parent / "git-defaults.conf"))
revision = "de54cf5be371a6f5e2e9f208c38def5f81d3ef02"
with tempfile.TemporaryDirectory(prefix="verb-cpython-") as area:
    root = Path(area)
    repo = root / "cpython"
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", sys.argv[1], repo], check=True)

    def git(*args):
        return subprocess.check_output(["git", "-C", repo, *args]).decode().strip()

    git("checkout", "-q", "--detach", revision)
    module = repo / "Lib/textwrap.py"
    good = module.read_bytes()
    original = b"w = TextWrapper(width=width, max_lines=1, **kwargs)"
    assert good.count(original) == 1
    module.write_bytes(good.replace(original, b"w = TextWrapper(width=width, max_lines=1)"))
    git("add", "Lib/textwrap.py")
    git("-c", "user.name=VERB pilot", "-c", "user.email=pilot@localhost",
        "-c", "commit.gpgSign=false", "commit", "-qm", "Seed ignored shorten options")
    probe = root / "observe.py"
    probe.write_text("import json, textwrap\nprint(json.dumps({'origin':textwrap.__file__, 'observations':{"
                     "'placeholder':textwrap.shorten('alpha beta gamma', width=10, placeholder='!'),"
                     "'short':textwrap.shorten('ok', width=10, placeholder='!')}}))\n")
    broken = json.loads(subprocess.check_output([sys.executable, "-B", probe], cwd=repo,
                        env={**os.environ, "PYTHONPATH": str(repo / "Lib")}))["observations"]["placeholder"]
    assert broken != "alpha!"
    module.write_bytes(good)
    claim = root / "claim.json"
    claim.write_text(json.dumps(dict(claim="Honor the explicit textwrap placeholder",
        env={"PYTHONPATH":"{root}/Lib","PYTHONDONTWRITEBYTECODE":"1"},
        probe=["{python}","{bundle}/observe.py"], fixtures=["observe.py"],
        assertions=[dict(key="placeholder", base=broken, fixed="alpha!"), dict(key="short",base="ok",fixed="ok")],
        required=[["{python}", "-m", "unittest", "test.test_textwrap"]])))
    files = subprocess.check_output(["git", "-C", repo, "ls-files", "-z"]).split(b"\0")[:-1]
    report = subprocess.check_output([sys.executable, here / "checkout.py", here.parents[1] / "bin/verb.js",
        claim, "HEAD"], cwd=repo, env={**os.environ, "VERB_PYTHON":sys.executable})
    print(json.dumps(dict(revision=revision, files=len(files),
        trackedBytes=sum((repo / os.fsdecode(f)).lstat().st_size for f in files),
        python=sys.version.split()[0], node=subprocess.check_output(["node","-v"]).decode().strip(),
        runs=json.loads(report)), indent=2))
