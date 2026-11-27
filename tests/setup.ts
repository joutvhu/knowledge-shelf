// Ensure git commit operations in tests have a deterministic RFC 2606 identity
// when running on environments without global git config (e.g. CI runners).
process.env.GIT_AUTHOR_NAME ??= 'Test User';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test User';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';
