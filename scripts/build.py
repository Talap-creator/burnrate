"""Builds the plugins under plugins/ from the one source in src/.

    python scripts/build.py

src/burnrate.tsx holds every feature behind FEATURES; each plugin below is
that file with FEATURES and the state namespace set for it, plus its tests.
"""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
VERSION = (ROOT / "VERSION").read_text(encoding="utf8").strip()
REPO = "https://github.com/Talap-creator/burnrate"

PLUGINS = {
    "burnrate": {
        "features": {"band": True, "guard": True},
        "tests": ["band.test.tsx", "guard.test.ts"],
        "description": "Full mod: live limits band above the prompt plus the guard (cache watchdog and limit brake).",
    },
    "limits-band": {
        "features": {"band": True, "guard": False},
        "tests": ["band.test.tsx"],
        "description": "Band above the prompt: 5h/7d limits with reset timers, context fill, cache hit rate and what fills your context.",
    },
    "limit-guard": {
        "features": {"band": False, "guard": True},
        "tests": ["guard.test.ts"],
        "description": "Warns when the prompt cache is invalidated; near the 5h cap blocks subagents and wide scans and asks Claude for short answers.",
    },
}

FEATURES_LINE = "const FEATURES = { band: true, guard: true }"


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf8", newline="\n")


def build(name: str, spec: dict) -> None:
    out = ROOT / "plugins" / name
    if out.exists():
        shutil.rmtree(out)

    source = (SRC / "burnrate.tsx").read_text(encoding="utf8")
    assert FEATURES_LINE in source, "FEATURES line changed; update scripts/build.py"
    flags = ", ".join(f"{k}: {'true' if v else 'false'}" for k, v in spec["features"].items())
    source = source.replace(FEATURES_LINE, f"const FEATURES = {{ {flags} }}")

    rename = lambda text: text.replace("'burnrate'", f"'{name}'")
    manifest = {
        "name": name,
        "version": VERSION,
        "description": spec["description"],
        "author": {"name": "Talap-creator"},
        "homepage": REPO,
        "repository": REPO,
        "license": "MIT",
        "keywords": ["usage", "limits", "rate-limit", "prompt-cache", "tokens"],
        "types": "./types/index.d.ts",
    }
    write(out / ".claude-plugin" / "plugin.json", json.dumps(manifest, indent=2) + "\n")
    write(out / "hooks" / "hooks.json", '{ "modules": ["./register.tsx"] }\n')
    write(out / "hooks" / "register.tsx", rename(source))
    write(out / "types" / "index.d.ts", rename((SRC / "state.d.ts").read_text(encoding="utf8")))
    for test in spec["tests"]:
        write(out / "hooks" / test, rename((SRC / test).read_text(encoding="utf8")))
    print(f"built plugins/{name}")


if __name__ == "__main__":
    for name, spec in PLUGINS.items():
        build(name, spec)
