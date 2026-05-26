"""work_schedule: singleton config table

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-26 12:00:00.000000

Adds the warehouse working-schedule singleton row used to compute
effective working seconds in /complete, live Focus timer, and analytics.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'work_schedule',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('work_start', sa.Time(), nullable=False),
        sa.Column('work_end', sa.Time(), nullable=False),
        sa.Column('break_start', sa.Time(), nullable=False),
        sa.Column('break_end', sa.Time(), nullable=False),
        sa.Column(
            'working_days',
            sa.ARRAY(sa.Integer()),
            nullable=False,
            server_default=sa.text("'{1,2,3,4,5}'::integer[]"),
        ),
        sa.Column(
            'timezone_name',
            sa.String(length=50),
            nullable=False,
            server_default=sa.text("'Europe/Berlin'"),
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column('updated_by_user_id', sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(['updated_by_user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('id = 1', name='ck_work_schedule_singleton'),
        sa.CheckConstraint(
            'work_start < break_start AND break_start < break_end '
            'AND break_end < work_end',
            name='ck_work_schedule_window_order',
        ),
    )
    # Insert the default singleton row. Idempotent via ON CONFLICT so
    # re-running the migration on an already-seeded DB is safe.
    op.execute(
        """
        INSERT INTO work_schedule
          (id, work_start, work_end, break_start, break_end,
           working_days, timezone_name)
        VALUES
          (1, '07:00:00', '15:30:00', '12:00:00', '12:30:00',
           '{1,2,3,4,5}'::integer[], 'Europe/Berlin')
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_table('work_schedule')
