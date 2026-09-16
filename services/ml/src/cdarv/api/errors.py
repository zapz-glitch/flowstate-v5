"""Machine-typed API failures without DB/auth disclosure."""

from __future__ import annotations


class ApiFailure(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 400,
                 retriable: bool = False):
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.status_code = status_code
        self.retriable = retriable


__all__ = ["ApiFailure"]
