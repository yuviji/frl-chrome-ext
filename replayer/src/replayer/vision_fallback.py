from __future__ import annotations

from typing import Any, Dict, Optional


class VisionFallbackClient:
    """Placeholder client for OCR/vision-based element finding.

    For the base implementation, this is a stub returning None.
    """

    def __init__(self, endpoint: Optional[str] = None, api_key: Optional[str] = None) -> None:
        self.endpoint = endpoint
        self.api_key = api_key

    def find(self, image_base64: str, query: str) -> Optional[Dict[str, Any]]:
        """Return bbox or similar when implemented. Currently returns None."""
        return None


