/** Conventional Commits, enforced on every commit (Section 13.1). */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['app', 'api', 'contracts', 'shared', 'docs', 'ci', 'repo', 'deps'],
    ],
  },
};
