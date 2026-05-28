"""SQLAlchemy ORM models for Marathon.

Three tables:
  - users        — auth subjects (admin/user roles)
  - auftraege    — single row covers the full lifecycle:
                   queued → in_progress → completed (or → error)
  - audit_log    — append-only trail of user actions

`parsed`, `validation`, `completed_keys`, `pallet_timings` are JSONB —
hierarchical data always read together with the row, no SQL queries
into them planned for Sprint 1.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, time as time_t
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    Time,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.database import Base


# ─── Enums (mapped to native PostgreSQL enum types) ──────────────────

class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class AuftragStatus(str, enum.Enum):
    queued = "queued"
    in_progress = "in_progress"
    completed = "completed"
    error = "error"
    cancelled = "cancelled"


class WorkflowStep(str, enum.Enum):
    upload = "upload"
    pruefen = "pruefen"
    focus = "focus"
    abschluss = "abschluss"


class PalletClaimState(str, enum.Enum):
    active = "active"
    released = "released"
    completed = "completed"
    taken_over = "taken_over"


# ─── users ───────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Clerk's user ID (e.g. "user_2abc..."). Nullable so legacy seeded
    # rows or test fixtures without a Clerk identity still validate.
    clerk_id: Mapped[Optional[str]] = mapped_column(
        String(255), unique=True, nullable=True, index=True
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        SAEnum(UserRole, name="user_role"),
        nullable=False,
        default=UserRole.user,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<User {self.name} ({self.role.value})>"


# ─── auftraege ───────────────────────────────────────────────────────

class Auftrag(Base):
    __tablename__ = "auftraege"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Source
    file_name: Mapped[str] = mapped_column(String(500), nullable=False)
    raw_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    parsed: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    validation: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)

    # Lifecycle
    status: Mapped[AuftragStatus] = mapped_column(
        SAEnum(AuftragStatus, name="auftrag_status"),
        nullable=False,
        default=AuftragStatus.queued,
    )
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Provenance
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    queue_position: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Workflow state — null until 'start', filled while in_progress, kept after complete
    assigned_to_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    duration_sec: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    step: Mapped[Optional[WorkflowStep]] = mapped_column(
        SAEnum(WorkflowStep, name="workflow_step"), nullable=True
    )
    current_pallet_idx: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    current_item_idx: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    completed_keys: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    # NOTE: copied_keys was previously a server-side mirror of the green-
    # chip state in Focus. Reverted to per-device localStorage (UX hint
    # only, no audit value) — column dropped in migration b9c0d1e2f3a4.
    pallet_timings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    # Multi-user session state (migration e7f8a9b0c1d2).
    # session_users: [{user_id, name, role: 'primary'|'participant',
    #                  joined_at, last_seen_at}], capped at 5 entries.
    # user_progress: { "<user_uuid>": {current_pallet_idx, current_item_idx,
    #                                  copied_keys: {...}} } — per-user
    # cursor and copied-chip state for the Focus screen.
    session_users: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    user_progress: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index("idx_auftraege_status", "status"),
        Index(
            "idx_auftraege_assigned",
            "assigned_to_user_id",
            postgresql_where=text("status = 'in_progress'"),
        ),
        Index(
            "idx_auftraege_finished",
            "finished_at",
            postgresql_where=text("status = 'completed'"),
        ),
    )

    def __repr__(self) -> str:
        return f"<Auftrag {self.file_name} [{self.status.value}]>"


# ─── pallet_claims ───────────────────────────────────────────────────
# Per-pallet ownership row for multi-user Focus sessions. The partial
# unique index on (auftrag_id, pallet_idx) WHERE state='active' is the
# load-bearing concurrency primitive: parallel INSERTs collide so the
# loser sees ON CONFLICT DO NOTHING return 0 rows.

class PalletClaim(Base):
    __tablename__ = "pallet_claims"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    auftrag_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("auftraege.id", ondelete="CASCADE"),
        nullable=False,
    )
    pallet_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    state: Mapped[PalletClaimState] = mapped_column(
        SAEnum(PalletClaimState, name="pallet_claim_state"),
        nullable=False,
        default=PalletClaimState.active,
        server_default=text("'active'::pallet_claim_state"),
    )
    claimed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    heartbeat_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    released_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index(
            "uq_active_claim",
            "auftrag_id", "pallet_idx",
            unique=True,
            postgresql_where=text("state = 'active'"),
        ),
        Index("idx_claims_auftrag_state", "auftrag_id", "state"),
        Index(
            "idx_claims_user_active",
            "user_id",
            postgresql_where=text("state = 'active'"),
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<PalletClaim {self.auftrag_id}#{self.pallet_idx} "
            f"by {self.user_id} [{self.state.value}]>"
        )


# ─── audit_log ───────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    auftrag_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("auftraege.id", ondelete="SET NULL"),
        nullable=True,
    )
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("idx_audit_user_created", "user_id", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<AuditLog {self.action} by {self.user_id}>"


# ─── sku_dimensions ──────────────────────────────────────────────────
# Source of truth for L×B×H (cm) and weight (kg) per Einheit, used by
# the Einzelne-SKU distributor to compute exact carton volumes/weights.
# Loaded by the admin via xlsx upload. Lookup waterfall: fnsku → sku → ean.

class SkuDimension(Base):
    __tablename__ = "sku_dimensions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # One row = one physical product. Each key type is an array because
    # the same packaging often ships under several Amazon FNSKUs and
    # several merchant SKUs (e.g. PRIME vs EV channels).
    fnskus: Mapped[list[str]] = mapped_column(
        ARRAY(String(20)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    skus: Mapped[list[str]] = mapped_column(
        ARRAY(String(50)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    eans: Mapped[list[str]] = mapped_column(
        ARRAY(String(20)), nullable=False, server_default=text("'{}'::varchar[]")
    )
    title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    length_cm: Mapped[float] = mapped_column(Float, nullable=False)
    width_cm: Mapped[float] = mapped_column(Float, nullable=False)
    height_cm: Mapped[float] = mapped_column(Float, nullable=False)
    weight_kg: Mapped[float] = mapped_column(Float, nullable=False)
    # Empirical max cartons of THIS format on one EUR pallet, factoring
    # stack height + footprint voids. Distributor uses this to compute
    # a normalised capacity fraction across all formats on the pallet
    # (sum of count/max ≤ 1.0 = within physical capacity).
    pallet_load_max: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Purchase price per VPE (Einheit) in EUR — source of truth for the
    # Warenwert column in Berichte. Imported from xlsx sheet "Preise +
    # Infos" via `python -m backend.import_prices`; admins can override
    # per-row through Admin → Dimensions. Nullable: items without a row
    # here are skipped in the cost aggregation and surface via
    # `items_value_coverage_pct` so the user knows the % is partial.
    price_per_einheit_eur: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    source: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "cardinality(fnskus) + cardinality(skus) + cardinality(eans) >= 1",
            name="ck_sku_dimensions_has_any_key",
        ),
        Index("ix_sku_dimensions_fnskus", "fnskus", postgresql_using="gin"),
        Index("ix_sku_dimensions_skus", "skus", postgresql_using="gin"),
        Index("ix_sku_dimensions_eans", "eans", postgresql_using="gin"),
    )

    def __repr__(self) -> str:
        key = (
            (self.fnskus and self.fnskus[0])
            or (self.skus and self.skus[0])
            or (self.eans and self.eans[0])
            or "?"
        )
        return f"<SkuDimension {key} {self.length_cm}×{self.width_cm}×{self.height_cm} cm>"


# ─── lynne_products ──────────────────────────────────────────────────
# Master catalog of LYNNE products, fed from the weekly
# Produktaufstellung_KWxx.xlsx (sheet "Verkäufe"). One row = one
# ASIN × SKU × channel triple. Lives independently of Marathon's
# operational tables — auftraege can be wiped without affecting the
# catalog.

class LynneProduct(Base):
    __tablename__ = "lynne_products"

    # Composite key as a single string: "<asin>__<sku>" — matches the
    # convention used by the lynne-verkaeufe project's seed.json.
    id: Mapped[str] = mapped_column(String(80), primary_key=True)

    asin: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(16), nullable=False)  # PRIME|EV|EV-PRIME|OTHER
    sku: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    ean: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    brand: Mapped[str] = mapped_column(String(80), nullable=False, server_default=text("''"), index=True)

    weekly_sales: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    graz_stock: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    per_pallet: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    source: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<LynneProduct {self.asin} {self.sku} [{self.channel}]>"


# ─── work_schedule ───────────────────────────────────────────────────
# Singleton row (id=1) holding the warehouse working window: hours,
# break, working days and IANA timezone. Drives `effective_seconds`
# everywhere (Auftrag duration on /complete, live timer on Focus, KPI
# breakdowns in Historie/Admin). Admins edit via Admin → Arbeitszeit.

class WorkSchedule(Base):
    __tablename__ = "work_schedule"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    work_start: Mapped[time_t] = mapped_column(Time, nullable=False)
    work_end: Mapped[time_t] = mapped_column(Time, nullable=False)
    break_start: Mapped[time_t] = mapped_column(Time, nullable=False)
    break_end: Mapped[time_t] = mapped_column(Time, nullable=False)
    # ISO weekday: Mon=1, Sun=7. Default Mon–Fri.
    working_days: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), nullable=False, server_default=text("'{1,2,3,4,5}'::integer[]")
    )
    timezone_name: Mapped[str] = mapped_column(
        String(50), nullable=False, server_default=text("'Europe/Berlin'")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    updated_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="ck_work_schedule_singleton"),
        CheckConstraint(
            "work_start < break_start AND break_start < break_end "
            "AND break_end < work_end",
            name="ck_work_schedule_window_order",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<WorkSchedule {self.work_start}–{self.work_end} "
            f"break {self.break_start}–{self.break_end} "
            f"days={self.working_days} tz={self.timezone_name}>"
        )


# ─── market_searches / market_products ───────────────────────────────
# External Amazon.de market analysis. One MarketSearch row = one cached
# call to a third-party search provider (RainforestAPI by default);
# children rows live in market_products. Cache TTL is enforced in the
# router via `fetched_at > now() - interval '24h'` — not as a DB CHECK,
# because we want to keep historical rows for audit/debug.

class MarketSearch(Base):
    __tablename__ = "market_searches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    query: Mapped[str] = mapped_column(Text, nullable=False)
    marketplace: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'de'")
    )
    provider: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'rainforest'")
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    result_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # The provider's untouched response body. Stored so a future schema
    # change in market_products can be re-derived without another API call.
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    __table_args__ = (
        Index(
            "idx_market_searches_query_recent",
            "query", "marketplace", text("fetched_at DESC"),
        ),
        Index("idx_market_searches_fetched", text("fetched_at DESC")),
    )

    def __repr__(self) -> str:
        return (
            f"<MarketSearch {self.query!r} [{self.marketplace}] "
            f"n={self.result_count}>"
        )


class MarketProduct(Base):
    __tablename__ = "market_products"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    search_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("market_searches.id", ondelete="CASCADE"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    asin: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    seller: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    brand: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    price_cents: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(
        String(8), nullable=False, server_default=text("'EUR'")
    )
    rating: Mapped[Optional[float]] = mapped_column(
        Numeric(precision=2, scale=1), nullable=True
    )
    reviews_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    image_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_prime: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    is_sponsored: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    __table_args__ = (
        Index("idx_market_products_search_position", "search_id", "position"),
        Index("idx_market_products_asin", "asin"),
    )

    def __repr__(self) -> str:
        return f"<MarketProduct #{self.position} {self.asin or '-'} {self.title[:40]!r}>"
