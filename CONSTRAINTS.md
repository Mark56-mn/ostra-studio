# Ostra Studio — Non-Negotiable Constraints

1. NO MOCK MODE.
2. NO FAKE AI RESULTS.
3. NO FAKE SUCCESS STATES.
4. Real integrations must report real availability and task state.
5. Providers must be replaceable through adapters.
6. Kaggle is an initial runtime, not a permanent dependency.
7. Colab is an initial runtime, not a permanent dependency.
8. ElevenLabs is optional, not required.
9. Kokoro-82M is the initial free voice target.
10. Human approval is required before publishing by default.
11. Auto-publish defaults to false.
12. Failed tasks must not destroy successful artifacts.
13. Important assets are versioned.
14. Large binaries belong in object storage, not database rows.
15. Secrets never go into frontend code or committed source.
16. The dashboard is mobile-first.
17. Agent communication is controlled by the orchestrator.
18. Agents cannot silently bypass workflow state.
19. Story continuity is persistent.
20. Important operations are auditable.
21. External-service failures have explicit states.
22. Do not add unnecessary features before the core pipeline works.
23. Do not rewrite working systems without a documented reason.
24. Do not lock workflow logic to one model/provider.
25. Human override always exists.
26. Every repository-working agent must leave a handover.
27. Handover must be written before the agent declares completion.
28. Never claim tests passed unless they were actually run.
29. Never claim an integration works unless it was actually exercised or explicitly marked unverified.
30. Documentation must reflect actual repository state, not intended future state.
