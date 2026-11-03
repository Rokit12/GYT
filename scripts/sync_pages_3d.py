"""Copy the shared browser modules into the GitHub Pages site (index.html), between their markers:
web/lib/marina3d.js (the 3D marina) and web/lib/berthplan.js (berth plan image -> berths -> 3D).
Run after editing either file."""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
page = root / "index.html"
s = page.read_text()

eng = (root / "web/lib/marina3d.js").read_text().replace("export function createMarina3D(", "window.createMarina3D = function createMarina3D(")
a = s.index("/* marina3d:start (generated from web/lib/marina3d.js) */\n") + len("/* marina3d:start (generated from web/lib/marina3d.js) */\n")
b = s.index(";\n/* marina3d:end */")
s = s[:a] + eng.rstrip() + s[b:]

bp = re.sub(r"^export function ", "function ", (root / "web/lib/berthplan.js").read_text(), flags=re.M)
block = ("/* berthplan:start (generated from web/lib/berthplan.js) */\n(function () {\n" + bp.rstrip()
         + "\nwindow.createBerthPlanImporter = createBerthPlanImporter;\n})();\n/* berthplan:end */")
if "/* berthplan:start" in s:
    a = s.index("/* berthplan:start"); b = s.index("/* berthplan:end */") + len("/* berthplan:end */")
    s = s[:a] + block + s[b:]
else:
    a = s.index("/* marina3d:end */") + len("/* marina3d:end */")
    s = s[:a] + "\n\n" + block + s[a:]
page.write_text(s)
print("synced", len(eng), "+", len(bp), "bytes")
