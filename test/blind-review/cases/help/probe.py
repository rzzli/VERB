import json

import click
from click.testing import CliRunner


def render(description):
    @click.command(name="catalog", help=description, epilog="End of public help.")
    @click.option("--label", help="Choose a label.")
    def catalog(label):
        pass

    result = CliRunner().invoke(catalog, ["--help"], terminal_width=80)
    if result.exit_code != 0:
        raise RuntimeError(result.output) from result.exception
    return result.output


omitted = render(None)
hidden = render("\n\f\nPrivate implementation detail.")
public = "Browse the catalog.\n\nLabels select a shelf."
mixed = render(public + "\n\f\nPrivate implementation detail.")
visible_block = "  Browse the catalog.\n\n  Labels select a shelf.\n\nOptions:"

print(json.dumps({
    "origin": click.__file__,
    "observations": {
        "empty_help_matches_omitted": str(hidden == omitted),
        "public_paragraphs_survive": str(visible_block in mixed),
        "mixed_help_matches_public": str(mixed == render(public)),
    },
}))
