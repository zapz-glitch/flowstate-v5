"""Alembic migration up/down verification on isolated PostgreSQL only.

Uses the shared session ``isolated_pg`` cold-start fixture from
``tests/conftest.py`` for container lifecycle: the migration suite
creates no containers itself and never issues an unconditional
``docker rm``. All per-test databases are unique and dropped with
``(FORCE)``. Container ownership is tracked by the harness (label
``flowstate.v4.harness=isolated-pg``); only harness-created
containers are ever removed.
"""
from __future__ import annotations

import os
import uuid

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from tests.conftest import _guard_maintenance_url as _shared_guard

ALEMBIC_INI = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
MAINT_URL = os.environ.get(
    "V4_TEST_DATABASE_URL",
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test",
)
EXPECTED_TABLES = {
    "v4_settings_snapshots",
    "v4_batches",
    "v4_evaluations",
    "v4_evaluation_results",
    "v4_cotality_leases",
    "v4_cotality_calls",
}


TEST_CONTAINER = "v4-persist-pg-102"
TEST_PORT = 55440


def _guard(url: str) -> None:
    _shared_guard(url)


def _config(url: str) -> Config:
    cfg = Config(ALEMBIC_INI)
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    cfg.set_main_option("url", url)
    return cfg


def test_database_major_version_matches_staging(isolated_pg):
    engine = create_engine(MAINT_URL)
    try:
        with engine.connect() as conn:
            assert int(conn.execute(text("SHOW server_version_num")).scalar()) // 10000 == 17
    finally:
        engine.dispose()


@pytest.mark.parametrize("bare_url", [False, True])
def test_alembic_up_and_down_on_isolated_database(isolated_pg, bare_url):
    from alembic import command

    _guard(MAINT_URL)
    db_name = f"v4mig_{uuid.uuid4().hex[:12]}"
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    with maint.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = MAINT_URL.rsplit("/", 1)[0] + f"/{db_name}"
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url.replace("postgresql+psycopg://", "postgresql://") if bare_url else url
    try:
        command.upgrade(_config(url), "head")
        engine = create_engine(url)
        tables = set(inspect(engine).get_table_names())
        assert EXPECTED_TABLES.issubset(tables)
        insp = inspect(engine)
        eval_fks = {fk["name"] for fk in insp.get_foreign_keys("v4_evaluations")}
        assert "fk_v4_eval_tenant_batch" not in eval_fks
        result_fks = {
            fk["name"] for fk in insp.get_foreign_keys("v4_evaluation_results")
        }
        assert "fk_v4_result_tenant_eval" not in result_fks
        assert "fk_v4_result_tenant_snapshot" in result_fks
        result_uq = {
            uq["name"] for uq in insp.get_unique_constraints("v4_evaluation_results")
        }
        assert "uq_v4_result_identity" in result_uq
        batch_uq = {uq["name"] for uq in insp.get_unique_constraints("v4_batches")}
        assert "uq_v4_batch_owner_idem" in batch_uq
        assert "uq_v4_batch_owner" in batch_uq
        eval_uq = {uq["name"] for uq in insp.get_unique_constraints("v4_evaluations")}
        assert "uq_v4_eval_owner_idem" in eval_uq
        assert "uq_v4_eval_owner" in eval_uq
        assert "fk_v4_eval_owner_batch" in eval_fks
        assert "fk_v4_result_owner_eval" in result_fks
        assert "fk_v4_result_tenant_snapshot" in result_fks
        for table, check in (
            ("v4_batches", "ck_v4_batches_owner_nonempty"),
            ("v4_evaluations", "ck_v4_evaluations_owner_nonempty"),
            ("v4_evaluation_results", "ck_v4_evaluation_results_owner_nonempty"),
        ):
            checks = {ck["name"] for ck in insp.get_check_constraints(table)}
            assert check in checks
        for table, column in (
            ("v4_batches", "requested_by_user_id"),
            ("v4_evaluations", "requested_by_user_id"),
            ("v4_evaluation_results", "requested_by_user_id"),
        ):
            cols = {c["name"] for c in insp.get_columns(table)}
            assert column in cols
        owner_indexes = {idx["name"] for idx in insp.get_indexes("v4_batches")}
        assert "ix_v4_batch_owner" in owner_indexes
        with engine.begin() as conn:
            rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
            assert rev == "0004_v4_provider_limiter"
        for table in ("v4_cotality_leases", "v4_cotality_calls"):
            assert table in tables
        lease_uq = {uq["name"] for uq in insp.get_unique_constraints("v4_cotality_leases")}
        assert "uq_v4_cotality_lease_token" in lease_uq
        lease_ck = {ck["name"] for ck in insp.get_check_constraints("v4_cotality_leases")}
        assert "ck_v4_cotality_lease_owner_nonempty" in lease_ck
        call_ck = {ck["name"] for ck in insp.get_check_constraints("v4_cotality_calls")}
        assert "ck_v4_cotality_call_attempt_pos" in call_ck
        lease_ix = {ix["name"] for ix in insp.get_indexes("v4_cotality_leases")}
        assert "ix_v4_cotality_lease_expiry" in lease_ix
        call_ix = {ix["name"] for ix in insp.get_indexes("v4_cotality_calls")}
        assert "ix_v4_cotality_call_window" in call_ix
        command.downgrade(_config(url), "0003_v4_owner")
        head_tables = set(inspect(create_engine(url)).get_table_names())
        assert "v4_cotality_leases" not in head_tables
        assert "v4_cotality_calls" not in head_tables
        command.upgrade(_config(url), "head")
        with create_engine(url).begin() as conn:
            rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
            assert rev == "0004_v4_provider_limiter"
        batch_ck = {
            ck["name"] for ck in insp.get_check_constraints("v4_batches")
        }
        assert "ck_v4_batch_total_range" in batch_ck
        assert "ck_v4_batch_counts_sum" in batch_ck
        assert "ck_v4_batch_status_counts" in batch_ck
        eval_ck = {
            ck["name"] for ck in insp.get_check_constraints("v4_evaluations")
        }
        assert "ck_v4_eval_running_lease" in eval_ck
        assert "ck_v4_eval_terminal_no_lease" in eval_ck
        with engine.begin() as conn:
            trig = conn.execute(
                text(
                    "SELECT count(*) FROM pg_trigger "
                    "WHERE tgname = 'trg_v4_snapshot_no_update'"
                )
            ).scalar()
            assert trig == 1
        engine.dispose()
        command.downgrade(_config(url), "0002_v4_repair")
        _seed_populated_0002(url)
        with pytest.raises(Exception, match="0003 preflight"):
            command.upgrade(_config(url), "0004_v4_provider_limiter")
        _assert_still_at_0002(url)
        command.downgrade(_config(url), "base")
        command.upgrade(_config(url), "0002_v4_repair")
        _assert_still_at_0002(url)
        command.downgrade(_config(url), "base")
        command.upgrade(_config(url), "head")
        _assert_clean_head(url)
        _assert_owner_valid_rows(url)
        _assert_owner_mismatch_rejects(url)
        command.downgrade(_config(url), "0002_v4_repair")
        _assert_no_owner_columns(url)
        command.downgrade(_config(url), "base")
        command.upgrade(_config(url), "head")
        _assert_cross_user_same_key_roundtrip(url)
        _delete_roundtrip_rows(url)
        command.downgrade(_config(url), "base")
        command.upgrade(_config(url), "0001_v4_initial")
        _seed_populated_0001(url)
        command.upgrade(_config(url), "0002_v4_repair")
        _assert_populated_0002_head(url)
        with pytest.raises(Exception, match="0003 preflight"):
            command.upgrade(_config(url), "0004_v4_provider_limiter")
        _assert_still_at_0002(url)
        command.downgrade(_config(url), "0001_v4_initial")
        _assert_populated_0001(url)
        command.downgrade(_config(url), "base")
        remaining = set(inspect(create_engine(url)).get_table_names())
        assert EXPECTED_TABLES.isdisjoint(remaining)
        command.upgrade(_config(url), "head")
        again = set(inspect(create_engine(url)).get_table_names())
        assert EXPECTED_TABLES.issubset(again)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
        with maint.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        maint.dispose()


def _seed_populated_0001(url: str) -> dict:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = "t-mig"
    snap = uuid.uuid4()
    batch_done = uuid.uuid4()
    batch_open = uuid.uuid4()
    eval_done = uuid.uuid4()
    eval_open = uuid.uuid4()
    res_ok = uuid.uuid4()
    res_null_snap = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_batches (id, tenant_id, idempotency_key, "
                " request_hash, status, total_count, succeeded_count, "
                " failed_count, snapshot_id, created_at, updated_at) "
                "VALUES (:id, :t, 'b-done', 'h1', 'pending', 1, 0, 0, "
                " :snap, now(), now()), (:id2, :t, 'b-open', 'h2', "
                " 'pending', 1, 0, 0, :snap, now(), now())"
            ),
            {"id": batch_done, "id2": batch_open, "t": tenant, "snap": snap},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluations (id, tenant_id, batch_id, "
                " idempotency_key, request_hash, status, attempts, "
                " max_attempts, created_at, updated_at) "
                "VALUES (:e1, :t, :b1, 'e-done', 'h', 'succeeded', 1, 5, "
                " now(), now()), (:e2, :t, :b2, 'e-open', 'h', 'queued', "
                " 0, 5, now(), now())"
            ),
            {"e1": eval_done, "e2": eval_open, "t": tenant,
             "b1": batch_done, "b2": batch_open},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:r1, :t, :e1, 1, 'm', :snap, 'succeeded', "
                " CAST(:p1 AS jsonb), :h1, now())"
            ),
            {"r1": res_ok, "t": tenant, "e1": eval_done, "snap": snap,
             "p1": '{"v": 1}', "h1": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:r2, :t, :e1, 2, 'm', NULL, "
                " 'incomplete', CAST(:p2 AS jsonb), :h2, now())"
            ),
            {"r2": res_null_snap, "t": tenant, "e1": eval_done,
             "p2": '{"v": 2}', "h2": f"h-{uuid.uuid4().hex[:8]}"},
        )
    engine.dispose()
    return {
        "tenant": tenant, "snapshot": snap, "batch_done": batch_done,
        "batch_open": batch_open, "eval_done": eval_done,
        "eval_open": eval_open, "res_ok": res_ok,
        "res_null_snap": res_null_snap,
    }




def _seed_populated_0002(url: str) -> dict:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = "t-mig2"
    snap = uuid.uuid4()
    batch = uuid.uuid4()
    evaluation = uuid.uuid4()
    result = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_batches (id, tenant_id, idempotency_key, "
                " request_hash, status, total_count, succeeded_count, "
                " failed_count, snapshot_id, created_at, updated_at) "
                "VALUES (:id, :t, 'b-0002', 'h1', 'pending', 1, 0, 0, "
                " :snap, now(), now())"
            ),
            {"id": batch, "t": tenant, "snap": snap},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluations (id, tenant_id, batch_id, "
                " idempotency_key, request_hash, status, attempts, "
                " max_attempts, lease_generation, retriable, created_at, updated_at) "
                "VALUES (:e, :t, :b, 'e-0002', 'h', 'queued', 0, 5, 0, true, "
                " now(), now())"
            ),
            {"e": evaluation, "t": tenant, "b": batch},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:r, :t, :e, 1, 'm', :snap, 'VALUED', "
                " CAST(:p AS jsonb), :h, now())"
            ),
            {"r": result, "t": tenant, "e": evaluation, "snap": snap,
             "p": '{"v": 1}', "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
    engine.dispose()
    return {"tenant": tenant, "batch": batch, "evaluation": evaluation}


def _assert_still_at_0002(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert rev == "0002_v4_repair"
        cols = {c["name"] for c in inspect(engine).get_columns("v4_batches")}
        assert "requested_by_user_id" not in cols
    engine.dispose()


def _assert_populated_0002_head(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        statuses = {
            row[0]: row[1] for row in conn.execute(
                text("SELECT id, status FROM v4_evaluation_results")
            ).fetchall()
        }
        assert set(statuses.values()) == {"VALUED", "INCOMPLETE"}
        nulls = conn.execute(
            text("SELECT count(*) FROM v4_evaluation_results "
                 "WHERE snapshot_id IS NULL")
        ).scalar()
        assert nulls == 0
    engine.dispose()






def _assert_no_owner_columns(url: str) -> None:
    engine = create_engine(url)
    cols = {c["name"] for c in inspect(engine).get_columns("v4_batches")}
    assert "requested_by_user_id" not in cols
    engine.dispose()


def _assert_clean_head(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert rev == "0004_v4_provider_limiter"
    engine.dispose()


def _assert_owner_valid_rows(url: str) -> None:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = f"t-own-{uuid.uuid4().hex[:6]}"
    snap = uuid.uuid4()
    batch = uuid.uuid4()
    evaluation = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_batches (id, tenant_id, requested_by_user_id, "
                " idempotency_key, request_hash, status, total_count, "
                " succeeded_count, failed_count, snapshot_id, created_at, "
                " updated_at) VALUES (:id, :t, 'u-valid', 'b-valid', 'h', "
                " 'pending', 1, 0, 0, :snap, now(), now())"
            ),
            {"id": batch, "t": tenant, "snap": snap},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluations (id, tenant_id, "
                " requested_by_user_id, batch_id, idempotency_key, "
                " request_hash, status, attempts, max_attempts, "
                " lease_generation, retriable, created_at, updated_at) "
                "VALUES (:e, :t, 'u-valid', :b, 'e-valid', 'h', 'queued', "
                " 0, 5, 0, true, now(), now())"
            ),
            {"e": evaluation, "t": tenant, "b": batch},
        )
        with_fp = conn.execute(
            text(
                "SELECT count(*) FROM v4_evaluations WHERE id = :e "
                "AND tenant_id = :t AND requested_by_user_id = 'u-valid' "
                "AND batch_id = :b"
            ),
            {"e": evaluation, "t": tenant, "b": batch},
        ).scalar()
        assert with_fp == 1
    engine.dispose()


def _assert_owner_mismatch_rejects(url: str) -> None:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = f"t-mis-{uuid.uuid4().hex[:6]}"
    snap = uuid.uuid4()
    batch = uuid.uuid4()
    other_batch = uuid.uuid4()
    evaluation = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_batches (id, tenant_id, requested_by_user_id, "
                " idempotency_key, request_hash, status, total_count, "
                " succeeded_count, failed_count, snapshot_id, created_at, "
                " updated_at) VALUES (:id, :t, 'u-1', 'b-1', 'h', 'pending', "
                " 1, 0, 0, :snap, now(), now()), (:id2, :t, 'u-2', 'b-2', "
                " 'h', 'pending', 1, 0, 0, :snap, now(), now())"
            ),
            {"id": batch, "id2": other_batch, "t": tenant, "snap": snap},
        )
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO v4_evaluations (id, tenant_id, "
                    " requested_by_user_id, batch_id, idempotency_key, "
                    " request_hash, status, attempts, max_attempts, "
                    " lease_generation, retriable, created_at, updated_at) "
                    "VALUES (:e, :t, 'u-2', :b, 'e-mis', 'h', 'queued', "
                    " 0, 5, 0, true, now(), now())"
                ),
                {"e": evaluation, "t": tenant, "b": batch},
            )
    except Exception:
        pass
    else:
        raise AssertionError("mismatched evaluation owner must fail")
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO v4_batches (id, tenant_id, "
                    " requested_by_user_id, idempotency_key, request_hash, "
                    " status, total_count, succeeded_count, failed_count, "
                    " snapshot_id, created_at, updated_at) "
                    "VALUES (:id, :t, '', 'b-empty', 'h', 'pending', 1, 0, "
                    " 0, :snap, now(), now())"
                ),
                {"id": uuid.uuid4(), "t": tenant, "snap": snap},
            )
    except Exception:
        pass
    else:
        raise AssertionError("empty owner insert must fail")
    engine.dispose()






def _delete_roundtrip_rows(url: str) -> None:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM v4_evaluation_results WHERE tenant_id LIKE 't-rt-%'")
        )
        conn.execute(
            text("DELETE FROM v4_evaluations WHERE tenant_id LIKE 't-rt-%'")
        )
        conn.execute(
            text("DELETE FROM v4_batches WHERE idempotency_key = 'roundtrip-key'")
        )
    engine.dispose()


def _assert_cross_user_same_key_roundtrip(url: str) -> None:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = f"t-rt-{uuid.uuid4().hex[:6]}"
    snap = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        for user in ("u-1", "u-2"):
            conn.execute(
                text(
                    "INSERT INTO v4_batches (id, tenant_id, "
                    " requested_by_user_id, idempotency_key, request_hash, "
                    " status, total_count, succeeded_count, failed_count, "
                    " snapshot_id, created_at, updated_at) "
                    "VALUES (:id, :t, :u, 'roundtrip-key', 'h', 'pending', "
                    " 1, 0, 0, :snap, now(), now())"
                ),
                {"id": uuid.uuid4(), "t": tenant, "u": user, "snap": snap},
            )
    engine.dispose()
    from alembic import command as _command

    with pytest.raises(Exception, match="downgrade preflight"):
        _command.downgrade(_config(url), "0002_v4_repair")
    engine = create_engine(url)
    with engine.begin() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert rev == "0004_v4_provider_limiter"
    engine.dispose()


def _assert_downgrade_preflight_legitimate_cross_user(url: str) -> None:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = f"t-xu-{uuid.uuid4().hex[:6]}"
    snap = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        for user, key in (("u-1", "shared-key"), ("u-2", "shared-key")):
            batch = uuid.uuid4()
            conn.execute(
                text(
                    "INSERT INTO v4_batches (id, tenant_id, "
                    " requested_by_user_id, idempotency_key, request_hash, "
                    " status, total_count, succeeded_count, failed_count, "
                    " snapshot_id, created_at, updated_at) "
                    "VALUES (:id, :t, :u, :k, 'h', 'pending', 1, 0, 0, "
                    " :snap, now(), now())"
                ),
                {"id": batch, "t": tenant, "u": user, "k": key, "snap": snap},
            )
    from alembic import command as _command

    with pytest.raises(Exception, match="downgrade preflight"):
        _command.downgrade(_config(url), "0002_v4_repair")
    with engine.begin() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert rev == "0004_v4_provider_limiter"
    engine.dispose()


def _assert_populated_head(url: str, expect_backfilled: int = 1) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        statuses = {
            row[0]: row[1] for row in conn.execute(
                text("SELECT id, status FROM v4_evaluation_results")
            ).fetchall()
        }
        assert set(statuses.values()) == {"VALUED", "INCOMPLETE"}
        nulls = conn.execute(
            text("SELECT count(*) FROM v4_evaluation_results "
                 "WHERE snapshot_id IS NULL")
        ).scalar()
        assert nulls == 0
        backfilled = conn.execute(
            text("SELECT count(*) FROM v4_result_snapshot_backfill")
        ).scalar()
        assert backfilled == expect_backfilled
        eval_status = {
            row[0]: (row[1], row[2]) for row in conn.execute(
                text("SELECT id, status, result_status FROM v4_evaluations")
            ).fetchall()
        }
        done = [row for row in eval_status.values() if row[0] == "succeeded"]
        assert done and all(outcome == "VALUED" for _, outcome in done)
    engine.dispose()


def _assert_populated_0001(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        statuses = {
            row[1] for row in conn.execute(
                text("SELECT id, status FROM v4_evaluation_results")
            ).fetchall()
        }
        assert statuses == {"succeeded", "incomplete"}
    engine.dispose()


def test_alembic_env_rejects_non_postgresql():
    from eval_engine.persistence.db import NonPostgreSQLError, require_postgresql_url

    with pytest.raises((NonPostgreSQLError, RuntimeError)):
        require_postgresql_url("sqlite:///:memory:")
