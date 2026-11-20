import json

import click
from click.testing import CliRunner


@click.command()
@click.option("--empty", default="", show_default=True, help="Explicit value.")
@click.option("--unset", show_default=True, help="Unset value.")
@click.option("--hidden", default="", show_default=False, help="Hidden value.")
def sample(empty, unset, hidden):
    pass


def default_label(help_text, option):
    rows = [line for line in help_text.splitlines() if line.split()[:1] == [option]]
    if len(rows) != 1:
        raise ValueError(f"Expected one help row for {option}, found {len(rows)}")
    start = rows[0].find("[default:")
    if start == -1:
        return "absent"
    return rows[0][start:].rstrip()


if __name__ == "__main__":
    result = CliRunner().invoke(sample, ["--help"], terminal_width=120)
    if result.exit_code != 0:
        raise RuntimeError(f"Help failed with exit code {result.exit_code}") from result.exception
    print(json.dumps({
        "origin": click.__file__,
        "observations": {
            "explicit_empty": default_label(result.output, "--empty"),
            "unset": default_label(result.output, "--unset"),
            "hidden_empty": default_label(result.output, "--hidden"),
        },
    }))
