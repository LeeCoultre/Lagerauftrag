"""multi-user session: pallet_claims + session_users + user_progress

Revision ID: e7f8a9b0c1d2
Revises: d4e5f6a7b8c9
Create Date: 2026-05-26 19:00:00.000000

Adds infrastructure for multi-user Focus sessions:
  * pallet_claims — per-pallet ownership row. Partial unique index on
    (auftrag_id, pallet_idx) WHERE state='active' guarantees that two
    parallel claims cannot succeed (ON CONFLICT DO NOTHING returns 0
    rows for the loser).
  * auftraege.session_users JSONB — array of session members
    [{user_id, name, role, joined_at, last_seen_at}], capped at 5.
  * auftraege.user_progress JSONB — per-user current pallet/item and
    copied_keys map { "<user_uuid>": {...} }.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7f8a9b0c1d2'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── pallet_claims table ──────────────────────────────────────────
    # The pallet_claim_state ENUM is created implicitly by create_table
    # the first time a column references it (default create_type=True).
    op.create_table(
        'pallet_claims',
        sa.Column(
            'id', sa.UUID(),
            server_default=sa.text('gen_random_uuid()'),
            nullable=False,
        ),
        sa.Column('auftrag_id', sa.UUID(), nullable=False),
        sa.Column('pallet_idx', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column(
            'state',
            sa.Enum(
                'active', 'released', 'completed', 'taken_over',
                name='pallet_claim_state',
            ),
            nullable=False,
            server_default=sa.text("'active'::pallet_claim_state"),
        ),
        sa.Column(
            'claimed_at', sa.DateTime(timezone=True),
            server_default=sa.text('now()'), nullable=False,
        ),
        sa.Column(
            'heartbeat_at', sa.DateTime(timezone=True),
            server_default=sa.text('now()'), nullable=False,
        ),
        sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ['auftrag_id'], ['auftraege.id'], ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )

    # Partial unique index — the load-bearing claim guarantee. Two
    # parallel INSERTs targeting the same (auftrag, pallet) collide here
    # and the conflict-handler returns 0 rows to the loser.
    op.create_index(
        'uq_active_claim',
        'pallet_claims',
        ['auftrag_id', 'pallet_idx'],
        unique=True,
        postgresql_where=sa.text("state = 'active'"),
    )
    op.create_index(
        'idx_claims_auftrag_state',
        'pallet_claims',
        ['auftrag_id', 'state'],
    )
    op.create_index(
        'idx_claims_user_active',
        'pallet_claims',
        ['user_id'],
        postgresql_where=sa.text("state = 'active'"),
    )

    # ── auftraege new JSONB columns ──────────────────────────────────
    op.add_column(
        'auftraege',
        sa.Column(
            'session_users', sa.dialects.postgresql.JSONB(),
            nullable=False, server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        'auftraege',
        sa.Column(
            'user_progress', sa.dialects.postgresql.JSONB(),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column('auftraege', 'user_progress')
    op.drop_column('auftraege', 'session_users')
    op.drop_index('idx_claims_user_active', table_name='pallet_claims')
    op.drop_index('idx_claims_auftrag_state', table_name='pallet_claims')
    op.drop_index('uq_active_claim', table_name='pallet_claims')
    op.drop_table('pallet_claims')
    sa.Enum(name='pallet_claim_state').drop(op.get_bind(), checkfirst=True)
