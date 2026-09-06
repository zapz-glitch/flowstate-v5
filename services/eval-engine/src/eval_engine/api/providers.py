"""Provider port: typed evidence acquisition/checkpoint interface only.

No live implementation exists in this package. Submission may accept
preloaded evidence only under the explicit ``candidate_evidence_mode``
setting (``preloaded`` for the candidate/test path, ``provider_pending``
to queue items awaiting a future provider). No OpenAI/Firecrawl imports
or calls are permitted anywhere in the request path.
"""

from __future__ import annotations

from typing import Any, Protocol


class EvidenceProvider(Protocol):
    def acquire_subject(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def acquire_comps(self, request: dict[str, Any]) -> list[dict[str, Any]]: ...
    def acquire_permits(self, request: dict[str, Any]) -> list[dict[str, Any]]: ...
    def checkpoint(self, evaluation_id: str, state: dict[str, Any]) -> None: ...


class NoLiveProvider:
    def acquire_subject(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError("no live evidence provider is configured")

    def acquire_comps(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        raise NotImplementedError("no live evidence provider is configured")

    def acquire_permits(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        raise NotImplementedError("no live evidence provider is configured")

    def checkpoint(self, evaluation_id: str, state: dict[str, Any]) -> None:
        raise NotImplementedError("no live evidence provider is configured")


__all__ = ["EvidenceProvider", "NoLiveProvider"]
