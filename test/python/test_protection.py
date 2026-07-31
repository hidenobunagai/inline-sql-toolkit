"""Tests for exact masking and restoration of Python source regions."""

from collections.abc import Callable

import pytest
from inline_sql_helper.detection import detect_sql
from inline_sql_helper.literals import analyze_document
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
        lambda plan: plan.protected_sql.replace(
            plan.fragments[0].marker,
            "'" + plan.fragments[0].marker + "'",
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


def test_nonce_must_be_absent_and_source_free() -> None:
    source = 'query = "SELECT 11111111111111111111111111111111"'
    analysis = analyze_document(source)
    literal = analysis.supported[0]
    detection = detect_sql(literal, analysis.source_map)
    with pytest.raises(UnsafeRestore) as caught:
        build_protection_plan(analysis.source_map, literal, detection, "11" * 16)
    assert "SELECT" not in str(caught.value)
