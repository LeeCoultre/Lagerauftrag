"""auftraege: drop unused pg_trgm GIN indexes

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-05-26 18:45:00.000000

`idx_auftraege_parsed_trgm` (2.2 MB on 47 rows ≈ 19% of the whole DB)
and `idx_auftraege_file_name_trgm` (88 kB) — neither was used by the
query planner (`pg_stat_user_indexes.idx_scan = 0`). `/api/search`
falls back to a sequential scan, which is sub-millisecond at this row
count and well under the 200 ms client-side debounce in CommandPalette.

If `/api/search` ever needs to scale, the cheaper replacement is a
functional btree on the specific JSONB paths that callers actually
hit (`((parsed->'meta'->>'sendungsnummer'))` etc.) — that's ~10× more
compact than a trigram index on `parsed::text`.

Reversal recreates both indexes verbatim from migration e4f5a6b7c8d9.
The `pg_trgm` extension itself is intentionally left in place (other
features may pick it up; the extension is essentially weightless).
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'f8a9b0c1d2e3'
down_revision: Union[str, Sequence[str], None] = 'e7f8a9b0c1d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_auftraege_parsed_trgm")
    op.execute("DROP INDEX IF EXISTS idx_auftraege_file_name_trgm")


def downgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_auftraege_file_name_trgm "
        "ON auftraege USING gin (file_name gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_auftraege_parsed_trgm "
        "ON auftraege USING gin ((parsed::text) gin_trgm_ops)"
    )
