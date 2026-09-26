# Ostra Studio — Agent Handover Protocol

## Mandatory rule

Every coding/repository agent must leave a handover before finishing.

No exceptions for completed, partial, failed, or blocked work.

## File location

Create/update:

`handoffs/HANDOFF-YYYY-MM-DD-<short-task-name>.md`

If the same task is being continued, update its existing handover rather than creating contradictory documents.

## Required sections

Every handover must contain:

### 1. Task
What the agent was asked to do.

### 2. Result
What was actually completed.

### 3. Repository state
Current branch/ref and relevant files.

### 4. Files changed
List each important file and what changed.

### 5. Tests/checks
Commands actually run and their real results.

### 6. Integration status
For each touched external service:
- connected/verified
- configured but unverified
- unavailable
- not attempted

Never label an integration verified without actually testing it.

### 7. Known issues
Known bugs, limitations, blockers, or technical debt.

### 8. Decisions
Important architectural or implementation decisions made during the task.

### 9. Environment/configuration
Required environment variables, secrets, runtime assumptions, migrations, or setup.

Never put secret values in the handover.

### 10. Next agent
Give the next agent one clear recommended task, including prerequisites.

### 11. Do not redo
List completed work that the next agent should not repeat.

### 12. Verification
State exactly what remains unverified.

## Handover quality rule

The next agent must be able to start from the handover without asking the previous agent to reconstruct its work.

## Conflict rule

If repository code and an older handover disagree, inspect the current code and tests first. Update the handover to match reality.

## Completion rule

An agent should not say "done" until:
1. implementation is complete for its assigned scope,
2. checks have been run where possible,
3. documentation is updated where required,
4. handover is written.
