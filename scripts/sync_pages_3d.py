"""Copy web/lib/marina3d.js into the GitHub Pages site (index.html) between its marina3d markers."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
eng = (root / "web/lib/marina3d.js").read_text().replace("export function createMarina3D(", "window.createMarina3D = function createMarina3D(")
page = root / "index.html"
s = page.read_text()
a = s.index("/* marina3d:start (generated from web/lib/marina3d.js) */\n") + len("/* marina3d:start (generated from web/lib/marina3d.js) */\n")
b = s.index(";\n/* marina3d:end */")
page.write_text(s[:a] + eng.rstrip() + s[b:])
print("synced", len(eng), "bytes")
