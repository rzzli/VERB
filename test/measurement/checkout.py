"""Measure a working fix on Linux. Run in the target checkout with a frozen claim."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("cli", type=Path)
parser.add_argument("claim", type=Path)
parser.add_argument("base")
parser.add_argument("--repeat", type=int, default=3)
args = parser.parse_args()
if args.repeat < 1 or not Path("/proc/self/statm").exists():
    parser.error("requires Linux /proc and at least one repeat")
cli, claim = args.cli.resolve(), args.claim.resolve()


def tree_rss(pid):
    """Sum resident pages for the live process and descendants; shared pages can repeat."""
    procs = [pid]
    seen = set()
    pages = 0
    while procs:
        current = procs.pop()
        if current in seen:
            continue
        seen.add(current)
        proc = Path("/proc") / str(current)
        try:
            pages += int((proc / "statm").read_text().split()[1])
            for children in (proc / "task").glob("*/children"):
                procs.extend(map(int, children.read_text().split()))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return pages * os.sysconf("SC_PAGE_SIZE")


def allocated(root):
    size = 0
    dirs = [root]
    while dirs:
        try:
            with os.scandir(dirs.pop()) as entries:
                for entry in entries:
                    try:
                        size += entry.stat(follow_symlinks=False).st_blocks * 512
                        if entry.is_dir(follow_symlinks=False):
                            dirs.append(entry.path)
                    except FileNotFoundError:
                        continue
        except FileNotFoundError:
            continue
    return size


def run(temp, action, sample=False):
    cmd = ["node", str(cli), action, str(claim), "--json"]
    if action != "check":
        cmd.extend(["--base", args.base])
    with tempfile.TemporaryFile() as output:
        start = time.monotonic()
        with subprocess.Popen(cmd, stdout=output, env={**os.environ, "TMPDIR": temp}) as proc:
            if sample:
                rss = disk = samples = 0
                while proc.poll() is None:
                    rss = max(rss, tree_rss(proc.pid))
                    disk = max(disk, allocated(temp))
                    samples += 1
                    time.sleep(0.01)
            if proc.wait() != 0:
                output.seek(0)
                raise RuntimeError(output.read().decode())
        wall = round((time.monotonic() - start) * 1000)
        output.seek(0)
        receipt = json.load(output)
    commands = [c for side in receipt["sides"].values() if not side.get("cached")
                for c in side["commands"]]
    project = sum(c["ms"] for c in commands)
    result = dict(wallMs=wall, projectMs=project, overheadMs=wall-project,
                  requiredMs=sum(c["ms"] for c in commands if c["phase"] == "required"))
    if sample:
        result.update(processTreeRssBytes=rss, scratchAllocatedBytes=disk, samples=samples)
    return result


with tempfile.TemporaryDirectory(prefix="verb-resource-") as scratch:
    run(scratch, "baseline")
    report = {}
    for action in ("check", "prove"):
        report[action] = {"timings": [run(scratch, action) for _ in range(args.repeat)],
                          "sampledRun": run(scratch, action, sample=True)}
    print(json.dumps(report, indent=2))
