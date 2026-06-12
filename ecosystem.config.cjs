module.exports = {
  apps: [
    {
      name: 'api',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: '--env-file=.env.local src/api.ts',
      cwd: __dirname,
      autorestart: false,
    },
  ],
};
