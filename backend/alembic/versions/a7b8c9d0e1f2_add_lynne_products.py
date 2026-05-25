"""add lynne_products table

Revision ID: a7b8c9d0e1f2
Revises: c5d6e7f8a9b0
Create Date: 2026-05-25 12:00:00.000000

Standalone catalog of LYNNE products fed from the weekly
Produktaufstellung_KWxx.xlsx. One row = one ASIN×SKU×channel triple.
Independent from Marathon's operational tables (auftraege, history).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'c5d6e7f8a9b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'lynne_products',
        sa.Column('id', sa.String(length=80), primary_key=True),
        sa.Column('asin', sa.String(length=20), nullable=False),
        sa.Column('channel', sa.String(length=16), nullable=False),
        sa.Column('sku', sa.String(length=50), nullable=False),
        sa.Column('ean', sa.String(length=20), nullable=True),
        sa.Column('description', sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column('brand', sa.String(length=80), nullable=False, server_default=sa.text("''")),
        sa.Column('weekly_sales', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('graz_stock', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('per_pallet', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('source', sa.String(length=50), nullable=True),
        sa.Column(
            'updated_at', sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
    )
    op.create_index('ix_lynne_products_asin', 'lynne_products', ['asin'])
    op.create_index('ix_lynne_products_sku', 'lynne_products', ['sku'])
    op.create_index('ix_lynne_products_brand', 'lynne_products', ['brand'])


def downgrade() -> None:
    op.drop_index('ix_lynne_products_brand', table_name='lynne_products')
    op.drop_index('ix_lynne_products_sku', table_name='lynne_products')
    op.drop_index('ix_lynne_products_asin', table_name='lynne_products')
    op.drop_table('lynne_products')
