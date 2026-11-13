"""Text normalisation applied to every page before the extraction regexes run."""

from __future__ import annotations

import unicodedata

# Characters that PDF text layers use instead of the ASCII the regexes expect.
_TRANSLATE = str.maketrans(
    {
        "­": "",  # soft hyphen
        "​": "",  # zero-width space
        "‌": "",
        "‍": "",
        "﻿": "",
        "‐": "-",  # hyphen
        "‑": "-",  # non-breaking hyphen
        "−": "-",  # minus sign
        "⁄": "/",  # fraction slash
        "∕": "/",  # division slash
        "⋅": "·",  # dot operator -> middle dot
        "∙": "·",  # bullet operator -> middle dot
    }
)


def normalize_text(text: str | None) -> str:
    """Fold ligatures, superscripts/subscripts and exotic dashes; line and column layout is preserved.

    NFKC turns "ﬂ" into "fl", "⁻¹" into "−1" and "E₁" into "E1"; the translation table then maps the
    remaining minus/hyphen variants to ASCII so unit patterns such as ``kcal mol-1`` match. Runs of
    spaces are left alone because the layout-table heuristic relies on them.
    """
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text).translate(_TRANSLATE)


def normalize_cell(cell: str | None) -> str:
    return normalize_text(cell).replace("\n", " ").strip()
