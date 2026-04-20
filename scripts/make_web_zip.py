from __future__ import annotations

from pathlib import Path
import zipfile


def add_path(zf: zipfile.ZipFile, p: Path) -> None:
    if p.is_dir():
        for child in p.rglob("*"):
            if child.is_dir():
                continue
            zf.write(child, arcname=child.as_posix())
    else:
        zf.write(p, arcname=p.as_posix())


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    out = root / ".deploy" / "web.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    include = [
        root / "package.json",
        root / "server.js",
        root / "anamnesis_q.json",
        root / "public",
        root / "scripts",
    ]

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in include:
            add_path(zf, p)

    print(out)


if __name__ == "__main__":
    main()
