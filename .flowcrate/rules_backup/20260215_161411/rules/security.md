## 🔒 Data Safety Rules

> **CRITICAL**: Backup before ANY destructive operation.

### Before These Operations (MANDATORY BACKUP):
- `DELETE` queries (single or bulk)
- `UPDATE` queries that modify existing data
- Database restore operations
- Schema migrations
- Any API/CLI that removes data

### ❌ DO NOT
- Run delete/update without backup
- Restore backup without backing up current state first
- Assume backups exist

### ✅ DO
- Create timestamped backup before destructive ops
- Verify backup size/content before proceeding
- Document backup location in comments

---

## 🔧 Build & Test Verification Rules

> **CRITICAL**: Always verify code compiles AND tests pass after changes.

### After Code Changes (MANDATORY):
```bash
# TypeScript projects
pnpm typecheck    # Type checking
pnpm test         # Run tests

# Rust projects  
cargo build       # Compile check
cargo test --lib  # Run unit tests

# General - verify production build
pnpm build
```

### Test Requirements by Change Type
| Change Type | Required Tests |
|-------------|---------------|
| Bug fix | Unit test for the specific fix |
| New feature | Unit/integration tests for new code |
| Refactor | Existing tests must still pass |
| Config change | Build verification only |

### ❌ DO NOT
- Commit without running tests (if code changed)
- Commit without running typecheck/build
- Leave failing tests for next session
- Skip verification for "small" changes

### ✅ DO
- Run typecheck after EVERY code change
- Run tests before moving task to Done
- Fix failing tests immediately
- Verify all tests pass: `test result: ok. N passed; 0 failed`

---

## Feature Preservation Rules

> **CRITICAL**: New features MUST preserve all existing functionality.

### ❌ DO NOT
- Remove or disable existing features when adding new ones
- Break existing data persistence
- Skip calling service methods that were previously called
- "Simplify" by removing functionality

### ✅ DO
- Review existing code flow before refactoring
- Ensure all persistence calls are preserved
- Test that old features still work after changes
