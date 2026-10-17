import paasConfig from '@paas/eslint-config';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.d.ts',
    ],
  },
  ...paasConfig,
];
