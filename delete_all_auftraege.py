"""Delete ALL Auftraege from the prod DB.

This wipes the entire `auftraege` table (every status — queued,
in_progress, completed, cancelled, error) plus every dependent
pallet_claims row. Audit log keeps its rows but auftrag_id becomes
NULL via the existing ON DELETE SET NULL constraint.

Users, sku_dimensions, lynne_products, work_schedule, alembic_version
are untouched.

Usage:
    .venv/bin/python delete_all_auftraege.py           # dry-run, prints counts
    .venv/bin/python delete_all_auftraege.py --apply   # actually delete
"""
import asyncio
import os
import sys

from dotenv import load_dotenv
load_dotenv()
import asyncpg


async def main(apply: bool) -> None:
    c = await asyncpg.connect(os.getenv('DATABASE_URL'))

    n_auf = await c.fetchval("SELECT count(*) FROM auftraege")
    by_status = await c.fetch(
        "SELECT status, count(*) AS n FROM auftraege GROUP BY status ORDER BY status"
    )
    n_claims = await c.fetchval("SELECT count(*) FROM pallet_claims")
    n_audit_linked = await c.fetchval(
        "SELECT count(*) FROM audit_log WHERE auftrag_id IS NOT NULL"
    )

    print(f'Auftraege total: {n_auf}')
    for r in by_status:
        print(f'  {r["status"]:13} {r["n"]}')
    print(f'Pallet claims to delete: {n_claims}')
    print(f'Audit rows that will have auftrag_id set to NULL: {n_audit_linked}')

    if not apply:
        print('\n(dry-run; pass --apply to actually delete)')
        await c.close()
        return

    print('\nApplying delete …')
    async with c.transaction():
        # ON DELETE CASCADE on pallet_claims.auftrag_id would handle it,
        # but explicit makes the count visible.
        deleted_claims = await c.execute("DELETE FROM pallet_claims")
        deleted_auftrag = await c.execute("DELETE FROM auftraege")
        # audit_log.auftrag_id has ON DELETE SET NULL — no manual UPDATE needed
    print(f'Done. Deleted: {deleted_claims}; {deleted_auftrag}')
    await c.close()


if __name__ == '__main__':
    asyncio.run(main(apply='--apply' in sys.argv))
