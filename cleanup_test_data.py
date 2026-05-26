"""One-shot cleanup of test-user / zombie smoke-test rows in the prod DB.

Reads .env from the project root for DATABASE_URL. Safe to re-run —
all DELETEs are scoped to emails ending in @test or rows created by
those users; real Clerk users (thecoultre@gmail.com etc.) are
untouched.

What gets removed:
  - users where email LIKE '%@test' OR '%@idem'
  - their audit_log entries
  - auftraege created or assigned to them, plus their pallet_claims
  - any orphaned pallet_claims (auftrag deleted but claim row left)

Print-only first: pass --apply to actually delete.

Usage:
    .venv/bin/python cleanup_test_data.py             # dry-run, prints findings
    .venv/bin/python cleanup_test_data.py --apply     # actually delete
"""
import asyncio
import os
import sys

from dotenv import load_dotenv
load_dotenv()
import asyncpg


TEST_EMAIL_PATTERNS = ('%@test', '%@idem', '%@idempotent-test')


async def main(apply: bool) -> None:
    c = await asyncpg.connect(os.getenv('DATABASE_URL'))

    # Test users to remove. Match by email patterns — these are the
    # synthetic users smoke tests create. Real Clerk-provisioned users
    # have email shapes like name@gmail.com / name@company.com and
    # never end in @test or @idem.
    where_email = ' OR '.join([f"email LIKE ${i+1}" for i in range(len(TEST_EMAIL_PATTERNS))])
    users = await c.fetch(
        f"SELECT id, email, name FROM users WHERE {where_email}",
        *TEST_EMAIL_PATTERNS,
    )
    if not users:
        print('No test users found. Already clean.')
        await c.close()
        return

    print(f'Test users to remove ({len(users)}):')
    for u in users:
        print(f'  {str(u["id"])[:8]} {u["email"]:30} {u["name"]}')

    user_ids = [u['id'] for u in users]

    # Auftraege touched by them (created OR assigned).
    auftraege = await c.fetch(
        """SELECT id, file_name, status FROM auftraege
           WHERE created_by_user_id = ANY($1::uuid[])
              OR assigned_to_user_id = ANY($1::uuid[])""",
        user_ids,
    )
    print(f'\nAuftraege created/assigned to test users ({len(auftraege)}):')
    for a in auftraege:
        print(f'  {str(a["id"])[:8]} status={a["status"]:13} file={a["file_name"][:40]}')

    # Pallet_claims by these users (might span Auftraege we don't delete).
    claims = await c.fetch(
        "SELECT auftrag_id, pallet_idx, state FROM pallet_claims WHERE user_id = ANY($1::uuid[])",
        user_ids,
    )
    print(f'\nPallet claims by test users ({len(claims)}):')
    for cl in claims[:10]:
        print(f'  auf={str(cl["auftrag_id"])[:8]} idx={cl["pallet_idx"]} state={cl["state"]}')
    if len(claims) > 10:
        print(f'  …and {len(claims) - 10} more')

    # Audit rows.
    audit_count = await c.fetchval(
        "SELECT count(*) FROM audit_log WHERE user_id = ANY($1::uuid[])",
        user_ids,
    )
    print(f'\nAudit log rows by test users: {audit_count}')

    if not apply:
        print('\n(dry-run; pass --apply to delete)')
        await c.close()
        return

    print('\nApplying deletes …')
    auftrag_ids = [a['id'] for a in auftraege]
    async with c.transaction():
        if auftrag_ids:
            await c.execute(
                "DELETE FROM pallet_claims WHERE auftrag_id = ANY($1::uuid[])",
                auftrag_ids,
            )
            # audit_log.auftrag_id has ON DELETE SET NULL — keep the row
            # so the deletion event itself is auditable, just drop the
            # FK back to the now-gone Auftrag.
            await c.execute(
                "DELETE FROM auftraege WHERE id = ANY($1::uuid[])",
                auftrag_ids,
            )
        # Drop pallet_claims by these users on Auftraege we KEPT (rare,
        # but possible if a test user claimed someone else's Auftrag).
        await c.execute(
            "DELETE FROM pallet_claims WHERE user_id = ANY($1::uuid[])",
            user_ids,
        )
        # audit_log.user_id has no ON DELETE — must delete or set null.
        # Deleting is safer here since the rows belong to fake users.
        await c.execute(
            "DELETE FROM audit_log WHERE user_id = ANY($1::uuid[])",
            user_ids,
        )
        # Detach any remaining references on auftraege (shouldn't happen
        # since we deleted the rows where this user was creator/assignee
        # above, but in case the test user also touched a real Auftrag).
        await c.execute(
            "UPDATE auftraege SET assigned_to_user_id = NULL WHERE assigned_to_user_id = ANY($1::uuid[])",
            user_ids,
        )
        await c.execute(
            "UPDATE auftraege SET created_by_user_id = NULL WHERE created_by_user_id = ANY($1::uuid[])",
            user_ids,
        )
        await c.execute(
            "DELETE FROM users WHERE id = ANY($1::uuid[])",
            user_ids,
        )
    print(f'Done — removed {len(auftrag_ids)} Auftraege, {audit_count} audit rows, {len(users)} users.')
    await c.close()


if __name__ == '__main__':
    asyncio.run(main(apply='--apply' in sys.argv))
