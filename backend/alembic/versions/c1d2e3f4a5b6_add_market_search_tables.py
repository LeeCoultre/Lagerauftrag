"""market_searches + market_products: external Amazon market analysis cache

Revision ID: c1d2e3f4a5b6
Revises: a9b0c1d2e3f4
Create Date: 2026-05-28 12:00:00.000000

Two tables backing the new "Marktanalyse" tab:

* `market_searches` — one row per (query, marketplace, fetched_at). Holds
  the raw provider payload (JSONB) plus aggregate metadata so the UI can
  show "Aktualisiert vor 3h" without recomputing. Cache lookup:
  `WHERE query=:q AND marketplace=:m AND fetched_at > now() - interval '24h'`.
* `market_products` — denormalised rows extracted from the provider
  response; one per Amazon result. `ON DELETE CASCADE` so wiping a stale
  search also discards the children.

The provider (RainforestAPI today) is configurable per row via
`provider` for future swap-out (Apify, Keepa, PA-API). `is_sponsored` /
`is_prime` are nullable bools because not every provider populates them.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, Sequence[str], None] = 'a9b0c1d2e3f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'market_searches',
        sa.Column(
            'id',
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text('gen_random_uuid()'),
        ),
        sa.Column('query', sa.Text(), nullable=False),
        sa.Column(
            'marketplace',
            sa.String(length=8),
            nullable=False,
            server_default=sa.text("'de'"),
        ),
        sa.Column(
            'provider',
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'rainforest'"),
        ),
        sa.Column(
            'fetched_at',
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('now()'),
        ),
        sa.Column(
            'result_count',
            sa.Integer(),
            nullable=False,
            server_default=sa.text('0'),
        ),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column(
            'raw_payload',
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            'user_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('users.id', ondelete='SET NULL'),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'idx_market_searches_query_recent',
        'market_searches',
        ['query', 'marketplace', sa.text('fetched_at DESC')],
    )
    op.create_index(
        'idx_market_searches_fetched',
        'market_searches',
        [sa.text('fetched_at DESC')],
    )

    op.create_table(
        'market_products',
        sa.Column(
            'id',
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text('gen_random_uuid()'),
        ),
        sa.Column(
            'search_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('market_searches.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('asin', sa.String(length=20), nullable=True),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('seller', sa.Text(), nullable=True),
        sa.Column('brand', sa.Text(), nullable=True),
        sa.Column('price_cents', sa.Integer(), nullable=True),
        sa.Column(
            'currency',
            sa.String(length=8),
            nullable=False,
            server_default=sa.text("'EUR'"),
        ),
        sa.Column('rating', sa.Numeric(precision=2, scale=1), nullable=True),
        sa.Column('reviews_count', sa.Integer(), nullable=True),
        sa.Column('url', sa.Text(), nullable=False),
        sa.Column('image_url', sa.Text(), nullable=True),
        sa.Column('is_prime', sa.Boolean(), nullable=True),
        sa.Column('is_sponsored', sa.Boolean(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'idx_market_products_search_position',
        'market_products',
        ['search_id', 'position'],
    )
    op.create_index('idx_market_products_asin', 'market_products', ['asin'])


def downgrade() -> None:
    op.drop_index('idx_market_products_asin', table_name='market_products')
    op.drop_index('idx_market_products_search_position', table_name='market_products')
    op.drop_table('market_products')
    op.drop_index('idx_market_searches_fetched', table_name='market_searches')
    op.drop_index('idx_market_searches_query_recent', table_name='market_searches')
    op.drop_table('market_searches')
