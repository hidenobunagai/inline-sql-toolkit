"""Tests for exact masking and restoration of Python source regions."""

from collections.abc import Callable

import pytest
from inline_sql_helper.detection import detect_sql
from inline_sql_helper.literals import analyze_document
from inline_sql_helper.positions import SourceSpan
from inline_sql_helper.protection import (
    ProtectedKind,
    ProtectionPlan,
    UnsafeRestore,
    allocate_nonce,
    build_protection_plan,
    restore_protected,
)


def protection_plan_for(source: str, nonce: str = "11" * 16) -> ProtectionPlan:
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    detection = detect_sql(literal, analysis.source_map)
    return build_protection_plan(analysis.source_map, literal, detection, nonce)


def test_module_missing_red() -> None:
    """The protection implementation is introduced by this task."""
    assert ProtectedKind.FIELD.value == "field"


def test_nonce_retries_collision_and_marker_crlf_is_exact() -> None:
    random_values = iter([bytes(16), b"\x01" * 16])
    nonce = allocate_nonce(
        "prefix-" + bytes(16).hex(),
        lambda size: next(random_values),
    )
    assert nonce == (b"\x01" * 16).hex()
    plan = protection_plan_for('query = """--sql\r\nselect 1"""', nonce)
    assert restore_protected(plan.protected_sql, plan) == "--sql\r\nselect 1"


@pytest.mark.parametrize(
    "source",
    [
        'query = f"SELECT {value!r:>{width}}"',
        'query = f"SELECT {mapping["key"]}, {value=}"',
        'query = f"SELECT {{literal}}, {f"{value}"}"',
    ],
)
def test_fields_are_complete_and_restore_byte_exact(source: str) -> None:
    plan = protection_plan_for(source)
    assert any(fragment.kind is ProtectedKind.FIELD for fragment in plan.fragments)
    assert restore_protected(plan.protected_sql, plan) == source.split("= ", 1)[1][2:-1]


def test_normal_escapes_and_doubled_braces_are_protected() -> None:
    plan = protection_plan_for(r'query = f"SELECT \N{SNOWMAN} \x41 {{value}}"')
    kinds = tuple(fragment.kind for fragment in plan.fragments)
    assert ProtectedKind.PYTHON_ESCAPE in kinds
    assert ProtectedKind.ESCAPED_BRACE in kinds
    assert ProtectedKind.FIELD not in kinds
    assert (
        restore_protected(plan.protected_sql, plan)
        == r"SELECT \N{SNOWMAN} \x41 {{value}}"
    )


@pytest.mark.parametrize(
    "escape",
    [r"\x41", r"\u1234", r"\U0001F600", r"\123", r"\q"],
)
def test_normal_python_escape_spellings_are_single_fragments(escape: str) -> None:
    source = f'query = "SELECT {escape}"'
    plan = protection_plan_for(source)
    assert tuple(fragment.source_text for fragment in plan.fragments) == (escape,)
    assert plan.fragments[0].kind is ProtectedKind.PYTHON_ESCAPE


def test_python_line_continuation_escape_is_single_fragment() -> None:
    escape = "\\\n"
    source = f'query = "SELECT {escape}1"'
    plan = protection_plan_for(source)
    assert tuple(fragment.source_text for fragment in plan.fragments) == (escape,)
    assert restore_protected(plan.protected_sql, plan) == "SELECT " + escape + "1"


@pytest.mark.parametrize("prefix", ["r", "rf", "fr", "R", "RF", "FR"])
def test_raw_literals_omit_python_escape_fragments(prefix: str) -> None:
    plan = protection_plan_for(f'query = {prefix}"SELECT \\n {{value}}"')
    assert all(
        fragment.kind is not ProtectedKind.PYTHON_ESCAPE for fragment in plan.fragments
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda plan: plan.protected_sql.replace(plan.fragments[0].marker, "SWAP", 1),
        lambda plan: plan.protected_sql + plan.fragments[0].marker,
        lambda plan: plan.protected_sql.replace(
            plan.fragments[0].marker,
            plan.fragments[0].marker + plan.fragments[0].marker,
            1,
        ),
    ],
)
def test_restore_rejects_malformed_marker_namespace(
    mutate: Callable[[ProtectionPlan], str],
) -> None:
    plan = protection_plan_for('query = f"SELECT {left}, {right}"')
    with pytest.raises(UnsafeRestore):
        restore_protected(mutate(plan), plan)


@pytest.mark.parametrize(
    "embedded",
    [
        lambda marker: "'" + marker + "'",
        lambda marker: '"' + marker + '"',
        lambda marker: "-- " + marker,
    ],
)
def test_restore_allows_marker_embedded_in_sql_quote_or_comment(
    embedded: Callable[[str], str],
) -> None:
    """An intact marker inside an SQL quote or comment restores exactly."""
    plan = protection_plan_for('query = f"SELECT {value}"')
    marker = plan.fragments[0].marker
    formatted = plan.protected_sql.replace(marker, embedded(marker), 1)
    restored = restore_protected(formatted, plan)
    assert marker not in restored
    assert plan.nonce not in restored


def test_restore_field_originally_inside_sql_string() -> None:
    """A field marker placed inside an SQL string restores to its source."""
    plan = protection_plan_for('query = f"SELECT \'{value}\'"')
    assert restore_protected(plan.protected_sql, plan) == "SELECT '{value}'"


def test_restore_rejects_genuine_marker_reordering() -> None:
    plan = protection_plan_for('query = f"SELECT {left}, {right}"')
    first, second = (fragment.marker for fragment in plan.fragments)
    swapped = plan.protected_sql.replace(first, "TEMP", 1)
    swapped = swapped.replace(second, first, 1).replace("TEMP", second, 1)
    with pytest.raises(UnsafeRestore):
        restore_protected(swapped, plan)


@pytest.mark.parametrize("escaped", [r"\{{", r"\}}"])
def test_fstring_escape_brace_union_preserves_exact_span(escaped: str) -> None:
    plan = protection_plan_for(f'query = f"SELECT {escaped}"')
    assert len(plan.fragments) == 1
    assert plan.fragments[0].kind is ProtectedKind.PYTHON_ESCAPE
    assert plan.fragments[0].source_text == escaped
    assert restore_protected(plan.protected_sql, plan) == "SELECT " + escaped


def test_all_fragment_kinds_are_ordered_and_restore_is_repeatable() -> None:
    source = 'query = f"""\n--sql\r\nSELECT \\x41 {{x}} {value}"""'
    nonce = "11" * 16
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    detection = detect_sql(literal, analysis.source_map)
    plan = build_protection_plan(analysis.source_map, literal, detection, nonce)
    content = analysis.source_map.slice(literal.content_span)
    expected = (
        (
            ProtectedKind.SQL_MARKER,
            SourceSpan(
                literal.content_span.start,
                literal.content_span.start + len("\n--sql\r\n"),
            ),
            "\n--sql\r\n",
            f"-- __INLINE_SQL_{nonce}_SQL_MARKER_0__\n",
            0,
        ),
        (
            ProtectedKind.PYTHON_ESCAPE,
            SourceSpan(source.index("\\x41"), source.index("\\x41") + 4),
            r"\x41",
            f"\"__INLINE_SQL_{nonce}_PYTHON_ESCAPE_1__\"",
            None,
        ),
        (
            ProtectedKind.ESCAPED_BRACE,
            SourceSpan(source.index("{{"), source.index("{{") + 2),
            "{{",
            f"\"__INLINE_SQL_{nonce}_ESCAPED_BRACE_2__\"",
            None,
        ),
        (
            ProtectedKind.ESCAPED_BRACE,
            SourceSpan(source.index("}}"), source.index("}}") + 2),
            "}}",
            f"\"__INLINE_SQL_{nonce}_ESCAPED_BRACE_3__\"",
            None,
        ),
        (
            ProtectedKind.FIELD,
            SourceSpan(source.index("{value}"), source.index("{value}") + 7),
            "{value}",
            f"\"__INLINE_SQL_{nonce}_FIELD_4__\"",
            None,
        ),
    )
    assert (
        tuple(
            (
                fragment.kind,
                fragment.source_span,
                fragment.source_text,
                fragment.marker,
                fragment.required_offset,
            )
            for fragment in plan.fragments
        )
        == expected
    )
    assert content == "\n--sql\r\nSELECT \\x41 {{x}} {value}"
    assert restore_protected(plan.protected_sql, plan) == content
    assert restore_protected(plan.protected_sql, plan) == content


@pytest.mark.parametrize(
    ("marker", "terminator"),
    [("--sql", "\r\n"), (" -- SQL ", "\n")],
)
def test_sql_marker_restores_original_line(marker: str, terminator: str) -> None:
    source = f'query = """\n{marker}{terminator}SELECT 1"""'
    plan = protection_plan_for(source)
    assert plan.fragments[0].kind is ProtectedKind.SQL_MARKER
    assert plan.fragments[0].required_offset == 0
    assert (
        restore_protected(plan.protected_sql, plan)
        == "\n" + marker + terminator + "SELECT 1"
    )


def test_sql_marker_lone_cr_is_restored_byte_exactly() -> None:
    source = 'query = """\n -- SQL \rSELECT 1"""'
    plan = protection_plan_for(source)
    assert plan.fragments[0].marker.endswith("\n")
    assert restore_protected(plan.protected_sql, plan) == "\n -- SQL \rSELECT 1"


def test_final_unterminated_sql_marker_line_is_restored_byte_exactly() -> None:
    source = 'query = """\n -- SQL """'
    plan = protection_plan_for(source)
    assert not plan.fragments[0].marker.endswith("\n")
    assert restore_protected(plan.protected_sql, plan) == "\n -- SQL "


def test_nonce_must_be_absent_and_source_free() -> None:
    source = 'query = "SELECT 11111111111111111111111111111111"'
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    detection = detect_sql(literal, analysis.source_map)
    with pytest.raises(UnsafeRestore) as caught:
        build_protection_plan(analysis.source_map, literal, detection, "11" * 16)
    assert "SELECT" not in str(caught.value)
