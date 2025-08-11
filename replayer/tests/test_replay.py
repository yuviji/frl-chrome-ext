from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from replayer import ReplayOptions, replay_trace


FAKE_TRACE = {
    "version": 1,
    "steps": [
        {
            "action": {
                "kind": "setContent",
                "html": """
<!DOCTYPE html>
<html><body>
  <a id=link href="#b">Go</a>
  <div id=b style="margin-top: 2000px">Target</div>
  <script>
    document.getElementById('link').addEventListener('click', () => {
      const el = document.getElementById('b');
      el.textContent = 'Target (arrived)';
    });
  </script>
</body></html>
                """,
            }
        },
        {
            "action": {
                "kind": "click",
                "selector": {"text": {"contains": "Go"}},
                "waiters": [
                    {"kind": "urlChanged"},
                    {"kind": "textChanged", "selector": {"text": {"contains": "Target (arrived)"}}},
                    {"kind": "layoutStable", "durationMs": 200},
                ],
            }
        },
    ],
}


@pytest.mark.parametrize("headed", [False, True])
def test_replay_basic(headed: bool) -> None:
    with TemporaryDirectory() as td:
        path = Path(td) / "trace.json"
        path.write_text(json.dumps(FAKE_TRACE), encoding="utf-8")
        opts = ReplayOptions(headed=headed, timeout_ms=5000)
        replay_trace(json.loads(path.read_text("utf-8")), opts)


