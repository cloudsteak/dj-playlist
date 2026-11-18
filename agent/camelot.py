"""Hangnem -> Camelot kód (a js/camelot.js párja)."""
import re

_MAJOR = {"B": 1, "F#": 2, "Gb": 2, "Db": 3, "C#": 3, "Ab": 4, "G#": 4, "Eb": 5, "D#": 5, "Bb": 6, "A#": 6,
          "F": 7, "C": 8, "G": 9, "D": 10, "A": 11, "E": 12}
_MINOR = {"Ab": 1, "G#": 1, "Eb": 2, "D#": 2, "Bb": 3, "A#": 3, "F": 4, "C": 5, "G": 6, "D": 7, "A": 8,
          "E": 9, "B": 10, "F#": 11, "Gb": 11, "C#": 12, "Db": 12}


def to_camelot(value) -> str:
    if not value:
        return ""
    s = str(value).strip().replace("♯", "#").replace("♭", "b")
    m = re.fullmatch(r"(\d{1,2})\s*([ABab])", s)
    if m:
        n = int(m.group(1))
        return f"{n}{m.group(2).upper()}" if 1 <= n <= 12 else ""
    m = re.fullmatch(r"([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?", s)
    if not m:
        return ""
    note = m.group(1).upper() + m.group(2)
    minor = (m.group(3) or "") in ("m", "min", "minor")
    n = (_MINOR if minor else _MAJOR).get(note)
    return f"{n}{'A' if minor else 'B'}" if n else ""
