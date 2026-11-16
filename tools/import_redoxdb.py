"""Convert a local clone of RedoxDB (github.com/alebusso12/RedoxDB, used with permission) into a
batch of pending redox_entries rows for the PhotoreDBox review page (photoredbox/admin.html).

    python tools/import_redoxdb.py /path/to/RedoxDB -o extracted/redoxdb-batch.json

Values without a DOI, a SMILES or an assigned excited state go to extracted/needs_review_redox.json.
The logic lives in src/trendb/redoxdb.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from trendb.redoxdb import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
