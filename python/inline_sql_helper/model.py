"""Frozen protocol model shared by the helper modules."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class FormatMode(StrEnum):
    """Request target selection mode."""

    CURSOR = "cursor"
    SELECTION = "selection"
    ALL = "all"


class ProtocolOperation(StrEnum):
    """Helper operation selected by a request."""

    LOCATE = "locate"
    FORMAT = "format"


class ReasonCode(StrEnum):
    """Stable reason codes exposed across the process boundary."""

    PYTHON_NOT_FOUND = "PYTHON_NOT_FOUND"
    PYTHON_VERSION_UNSUPPORTED = "PYTHON_VERSION_UNSUPPORTED"
    WORKSPACE_UNTRUSTED = "WORKSPACE_UNTRUSTED"
    INVALID_CONFIGURATION = "INVALID_CONFIGURATION"
    DOCUMENT_PARSE_FAILED = "DOCUMENT_PARSE_FAILED"
    NO_SQL_CANDIDATE = "NO_SQL_CANDIDATE"
    UNSUPPORTED_LITERAL = "UNSUPPORTED_LITERAL"
    UNSAFE_FSTRING_RESTORE = "UNSAFE_FSTRING_RESTORE"
    UNSAFE_RAW_STRING = "UNSAFE_RAW_STRING"
    FORMATTER_FAILED = "FORMATTER_FAILED"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    PROCESS_TIMEOUT = "PROCESS_TIMEOUT"
    PROCESS_CANCELLED = "PROCESS_CANCELLED"
    PROCESS_FAILED = "PROCESS_FAILED"
    DOCUMENT_CHANGED = "DOCUMENT_CHANGED"
    APPLY_EDIT_FAILED = "APPLY_EDIT_FAILED"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"


@dataclass(frozen=True, slots=True)
class Position:
    """Zero-based UTF-16 document position."""

    line: int
    character: int


@dataclass(frozen=True, slots=True)
class TextRange:
    """Half-open document range."""

    start: Position
    end: Position


@dataclass(frozen=True, slots=True)
class FormatOptions:
    """Validated SQL formatting options."""

    keyword_case: Literal["upper", "lower", "preserve"]
    indent_width: int
    wrap_after: int
    use_space_around_operators: bool


@dataclass(frozen=True, slots=True)
class FormatTarget:
    """Mode-specific formatting target."""

    mode: FormatMode
    cursor: Position | None = None
    selection: TextRange | None = None


@dataclass(frozen=True, slots=True)
class HelperRequest:
    """One validated helper request."""

    protocol_version: Literal[1]
    operation: ProtocolOperation
    source: str
    target: FormatTarget
    options: FormatOptions


@dataclass(frozen=True, slots=True)
class FormatEdit:
    """One guarded replacement returned by the formatter."""

    range: TextRange
    expected_text: str
    new_text: str


@dataclass(frozen=True, slots=True)
class CandidateSkipPayload:
    """One candidate that could not be formatted safely."""

    range: TextRange
    reason: ReasonCode


@dataclass(frozen=True, slots=True)
class FormatSummary:
    """Counts describing a formatting operation."""

    discovered: int
    selected: int
    changed: int
    unchanged: int
    skipped: int


@dataclass(frozen=True, slots=True)
class LocateSuccess:
    """Successful locate response."""

    protocol_version: Literal[1]
    operation: Literal[ProtocolOperation.LOCATE]
    ok: Literal[True]
    candidates: tuple[TextRange, ...]


@dataclass(frozen=True, slots=True)
class FormatSuccess:
    """Successful format response."""

    protocol_version: Literal[1]
    operation: Literal[ProtocolOperation.FORMAT]
    ok: Literal[True]
    edits: tuple[FormatEdit, ...]
    skips: tuple[CandidateSkipPayload, ...]
    summary: FormatSummary


@dataclass(frozen=True, slots=True)
class ErrorPayload:
    """Stable source-free error data."""

    code: ReasonCode


@dataclass(frozen=True, slots=True)
class ErrorResponse:
    """Failed helper response."""

    protocol_version: Literal[1]
    operation: ProtocolOperation | Literal["unknown"]
    ok: Literal[False]
    error: ErrorPayload


type LocateResponse = LocateSuccess | ErrorResponse
type FormatResponse = FormatSuccess | ErrorResponse
type HelperResponse = LocateSuccess | FormatSuccess | ErrorResponse
