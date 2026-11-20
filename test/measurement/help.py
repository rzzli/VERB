import json
import click


def help_text(text):
    cli = click.Command("demo", help=text)
    return cli.main(["--help"], standalone_mode=False)


if __name__ == "__main__":
    # The actual help command writes to stdout and returns normally.
    from contextlib import redirect_stdout
    from io import StringIO

    def render(text):
        stream = StringIO()
        with redirect_stdout(stream):
            help_text(text)
        return stream.getvalue()

    output = render("\n        \f\n\n        hidden\n        ")
    print(json.dumps({"origin": click.__file__, "observations": {
        "blank lines": str(output.splitlines().count("")),
        "visible help": str("visible" in render("visible\fhidden")),
    }}))
