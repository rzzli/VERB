"""Observe Click's actual help rendering in a fresh CLI process."""
import json
import re
import subprocess
import sys
from pathlib import Path


def launch_cli():
    import click

    @click.command()
    @click.option("--empty", default="", show_default=True)
    @click.option("--unset", show_default=True)
    def app(empty, unset):
        pass

    print(Path(click.__file__).resolve(), file=sys.stderr)
    app()


def label(help_output, option):
    rows = [line for line in help_output.splitlines()
            if re.match(r"^\s*" + re.escape(option) + r"\s", line)]
    if len(rows) != 1:
        raise ValueError(f"Expected one {option} row, observed {len(rows)}")
    labels = re.findall(r"\[default: [^\]]*\]", rows[0])
    if rows[0].count("[default:") != len(labels) or len(labels) > 1:
        raise ValueError(f"Ambiguous default for {option}: {rows[0]}")
    return labels[0] if labels else "unlabeled"


if __name__ == "__main__":
    if "--help" in sys.argv:
        launch_cli()
    else:
        child = subprocess.run([sys.executable, __file__, "--help"], check=True,
                               capture_output=True, text=True)
        print(json.dumps({"origin": child.stderr.strip(), "observations": {
            "empty default": label(child.stdout, "--empty"),
            "unset default": label(child.stdout, "--unset"),
        }}))
