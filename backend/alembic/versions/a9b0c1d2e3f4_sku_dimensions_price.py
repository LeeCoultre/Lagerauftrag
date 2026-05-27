"""sku_dimensions: add price_per_einheit_eur

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-05-26 19:30:00.000000

Adds purchase price per VPE (Einheit) in EUR — Warenwert column in
the Berichte redesign. Source: xlsx sheet "Preise + Infos", column
"Rollenpreis Total je VPE in €", matched by EAN. Nullable so SKUs
without an upstream price stay valid; the report endpoint surfaces
coverage % so users see when the figure is partial.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a9b0c1d2e3f4'
down_revision: Union[str, Sequence[str], None] = 'f8a9b0c1d2e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'sku_dimensions',
        sa.Column('price_per_einheit_eur', sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('sku_dimensions', 'price_per_einheit_eur')
